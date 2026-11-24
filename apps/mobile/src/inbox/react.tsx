import {
  FLEET_ATTENTION_FEATURE,
  FLEET_ENVIRONMENTS_FEATURE,
  type FleetAttentionEntry,
  type FleetEnvironment,
} from '@maestrly/bot-fleet-protocol'
import type { InboxObservation } from '@maestrly/bot-fleet-protocol/inbox'
import { router, useFocusEffect } from 'expo-router'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import { AppState } from 'react-native'
import type { ChatsController } from '../chats/controller'
import { DEMO_SERVER, demoInitialReadEntries } from '../demo/demo-source'
import type { FleetController } from '../fleet/controller'
import { nativeStreamingFetch } from '../fleet/http-source'
import { useNotifications } from '../notifications/NotificationsProvider'
import type { PairedServer } from '../servers/registry'
import { useServers } from '../servers/ServersProvider'
import { createBadgeSync, setAppBadgeCount } from './badge'
import { createInboxController, type InboxController, type InboxServerInput } from './controller'
import { environmentNeedsChatFallback, fallbackChatObservations, fallbackObservations } from './fallback'
import { sameFallbackObservations, subscribeInboxStoreSlices } from './sync'
import { openInboxItem, type InboxUndo, type MobileInbox, type MobileInboxItem } from './types'
import { createAttentionWatcher, type AttentionWatcher } from './watcher'

export type { InboxUndo, MobileInbox, MobileInboxItem, MobileInboxServer } from './types'

const EMPTY_ENTRIES: ReadonlyMap<string, FleetAttentionEntry> = new Map()
const EMPTY_ENVIRONMENTS: ReadonlyMap<string, string> = new Map()
const environmentMapCache = new WeakMap<readonly FleetEnvironment[], ReadonlyMap<string, string>>()

const InboxContext = createContext<MobileInbox | null>(null)
const InboxControllerContext = createContext<InboxController | null>(null)

function environmentsMap(list: readonly FleetEnvironment[]): ReadonlyMap<string, string> {
  if (list.length === 0) return EMPTY_ENVIRONMENTS
  let cached = environmentMapCache.get(list)
  if (!cached) {
    cached = new Map(list.map((env) => [env.id, env.name]))
    environmentMapCache.set(list, cached)
  }
  return cached
}

function sameServerInput(a: InboxServerInput, b: InboxServerInput): boolean {
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.features === b.features &&
    a.supportsAttention === b.supportsAttention &&
    a.reachable === b.reachable &&
    a.loaded === b.loaded &&
    a.snapshotSeq === b.snapshotSeq &&
    a.lastSyncedAt === b.lastSyncedAt &&
    a.entries === b.entries &&
    a.environments === b.environments &&
    a.bots === b.bots &&
    a.inbox === b.inbox &&
    a.activeEnvironmentId === b.activeEnvironmentId &&
    a.chatLists === b.chatLists &&
    sameFallbackObservations(a.fallback, b.fallback)
  )
}

function sameServerInputs(a: readonly InboxServerInput[] | null, b: readonly InboxServerInput[]): boolean {
  if (!a || a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (!sameServerInput(a[i], b[i])) return false
  return true
}

interface ManagedWatcher {
  descriptor: string
  watcher: AttentionWatcher | null
  unsubscribe: (() => void) | null
  cancelled: boolean
}

function isFleetReachable(controller: FleetController | null): boolean {
  if (!controller) return true
  const state = controller.store.getState().connection
  return state !== 'retrying' && state !== 'unauthorized' && state !== 'incompatible'
}

/**
 * Provides the unified cross-server notifications center (`useInbox()`), orchestrating per-server attention watchers
 * (reusing the active server's fleet stream), fallback observations for older gateways, ledger persistence, and
 * native/push badge synchronization. Must be mounted inside `ServersProvider` and `NotificationsProvider`.
 */
export function InboxProvider({ children }: { children: ReactNode }) {
  const {
    servers,
    active,
    controller: fleetController,
    chats,
    environmentId,
    activate,
    setEnvironment,
    clientFor,
    kv,
  } = useServers()
  const notifications = useNotifications()

  const serversRef = useRef<readonly PairedServer[]>(servers)
  serversRef.current = servers
  const activeRef = useRef<PairedServer | null>(active)
  activeRef.current = active
  const fleetRef = useRef<FleetController | null>(fleetController)
  fleetRef.current = fleetController
  const chatsRef = useRef<ChatsController | null>(chats)
  chatsRef.current = chats
  const environmentIdRef = useRef<string | null>(environmentId)
  environmentIdRef.current = environmentId
  const clientForRef = useRef(clientFor)
  clientForRef.current = clientFor
  const notificationsRef = useRef(notifications)
  notificationsRef.current = notifications

  const watchersRef = useRef(new Map<string, ManagedWatcher>())
  const fallbackSyncRef = useRef(
    new Map<string, { fallback: readonly InboxObservation<string>[]; wasOpen: boolean; at: number }>()
  )
  const lastInputsRef = useRef<readonly InboxServerInput[] | null>(null)
  const backgroundedRef = useRef(AppState.currentState === 'background')

  // One stable fleet-controller identity counter so switching active server or restarting its controller reattaches
  // the shared attention watcher without churning on unrelated re-renders.
  const fleetIdsRef = useRef(new WeakMap<FleetController, number>())
  const nextFleetIdRef = useRef(1)
  const fleetInstanceId = (fc: FleetController | null): number => {
    if (!fc) return 0
    let id = fleetIdsRef.current.get(fc)
    if (!id) {
      id = nextFleetIdRef.current++
      fleetIdsRef.current.set(fc, id)
    }
    return id
  }

  const inboxController = useMemo(
    () =>
      createInboxController({
        kv,
        seedEntries: (serverId, now) => (serverId === DEMO_SERVER.id ? demoInitialReadEntries(now) : null),
        sendSeen: async (serverId, keys) => {
          const activeFleet = fleetRef.current
          if (activeFleet && activeFleet.source.serverId === serverId) {
            await activeFleet.source.call('attentionSeen', { body: { keys } })
            return
          }
          const server = serversRef.current.find((item) => item.id === serverId)
          if (!server) return
          const client = await clientForRef.current(server)
          if (!client) return
          await client.call('attentionSeen', { body: { keys } })
        },
      }),
    [kv]
  )

  const badgeSync = useMemo(
    () =>
      createBadgeSync({
        setBadge: setAppBadgeCount,
        syncPushBadge: (badgeOthers) => notificationsRef.current.syncBadgeOthers(badgeOthers),
      }),
    []
  )

  const syncServers = useCallback(() => {
    const currentServers = serversRef.current
    const currentActive = activeRef.current
    const activeFleet = fleetRef.current
    const activeChats = chatsRef.current
    const activeEnvId = environmentIdRef.current
    const currentById = new Map(currentServers.map((server) => [server.id, server]))
    for (const id of fallbackSyncRef.current.keys()) {
      const server = currentById.get(id)
      if (!server || server.features.includes(FLEET_ATTENTION_FEATURE)) fallbackSyncRef.current.delete(id)
    }
    const inputs: InboxServerInput[] = currentServers.map((server) => {
      const isActive = currentActive?.id === server.id && activeFleet?.source.serverId === server.id
      const supportsAttention = server.features.includes(FLEET_ATTENTION_FEATURE)
      const activeFleetState = isActive && activeFleet ? activeFleet.store.getState() : null
      const activeChatsState = isActive && activeChats ? activeChats.store.getState() : null

      if (supportsAttention) {
        const watched = watchersRef.current.get(server.id)?.watcher?.getState()
        const environments =
          isActive && activeFleetState && activeFleetState.environments.length > 0
            ? environmentsMap(activeFleetState.environments)
            : (watched?.environments ?? EMPTY_ENVIRONMENTS)
        const chatFallback =
          isActive && activeFleetState && environmentNeedsChatFallback(activeFleetState.environments, activeEnvId)
            ? fallbackChatObservations({
                serverId: server.id,
                serverName: server.name,
                environments: activeFleetState.environments,
                environmentId: activeEnvId,
                chatLists: activeChatsState?.lists ?? null,
              })
            : undefined
        return {
          id: server.id,
          name: server.name,
          features: server.features,
          supportsAttention: true,
          reachable: watched ? watched.reachable : isActive ? isFleetReachable(activeFleet) : true,
          loaded: watched?.loaded ?? false,
          snapshotSeq: watched?.snapshotSeq ?? 0,
          lastSyncedAt: watched?.lastSyncedAt ?? null,
          entries: watched?.entries ?? EMPTY_ENTRIES,
          environments,
          ...(activeFleetState ? { bots: activeFleetState.bots, inbox: activeFleetState.inbox } : {}),
          ...(isActive ? { activeEnvironmentId: activeEnvId, chatLists: activeChatsState?.lists ?? null } : {}),
          ...(chatFallback ? { fallback: chatFallback } : {}),
        }
      }

      if (isActive && activeFleetState) {
        const fallback = fallbackObservations({
          serverId: server.id,
          serverName: server.name,
          bots: activeFleetState.bots,
          environments: activeFleetState.environments,
          inbox: activeFleetState.inbox,
          environmentId: activeEnvId,
          chatLists: activeChatsState?.lists ?? null,
        })
        const prev = fallbackSyncRef.current.get(server.id)
        const isOpen = activeFleetState.loaded && activeFleetState.connection === 'open'
        let lastSyncedAt: number | null = prev?.at ?? null
        if (isOpen && (!prev?.wasOpen || !sameFallbackObservations(prev.fallback, fallback))) {
          lastSyncedAt = Date.now()
          fallbackSyncRef.current.set(server.id, { fallback, wasOpen: true, at: lastSyncedAt })
        } else if (!isOpen && prev?.wasOpen) {
          fallbackSyncRef.current.set(server.id, { ...prev, wasOpen: false })
        }
        return {
          id: server.id,
          name: server.name,
          features: server.features,
          supportsAttention: false,
          reachable: isFleetReachable(activeFleet),
          loaded: activeFleetState.loaded,
          lastSyncedAt,
          entries: EMPTY_ENTRIES,
          environments: environmentsMap(activeFleetState.environments),
          bots: activeFleetState.bots,
          inbox: activeFleetState.inbox,
          activeEnvironmentId: activeEnvId,
          chatLists: activeChatsState?.lists ?? null,
          fallback,
        }
      }

      return {
        id: server.id,
        name: server.name,
        features: server.features,
        supportsAttention: false,
        reachable: true,
        loaded: false,
        lastSyncedAt: null,
        entries: EMPTY_ENTRIES,
        environments: EMPTY_ENVIRONMENTS,
      }
    })
    if (sameServerInputs(lastInputsRef.current, inputs)) return
    lastInputsRef.current = inputs
    inboxController.setServers(inputs)
  }, [inboxController])

  // Start the inbox controller, wire OS + push badge sync, and stop cleanly on unmount.
  useEffect(() => {
    const unsubscribe = inboxController.subscribe(() => {
      const next = inboxController.getState()
      badgeSync.update(next.counts.total, next.badgeOthers)
    })
    void inboxController.start().then(() => {
      const next = inboxController.getState()
      badgeSync.update(next.counts.total, next.badgeOthers)
    })
    return () => {
      unsubscribe()
      badgeSync.stop()
      inboxController.stop()
      for (const managed of watchersRef.current.values()) {
        managed.cancelled = true
        managed.unsubscribe?.()
        managed.watcher?.stop()
      }
      watchersRef.current.clear()
    }
  }, [inboxController, badgeSync])

  // Reconcile per-server attention watchers: shared stream (`?attention=1`) for the active server, standalone
  // attention-only (`?attention=2`) stream for non-active servers with the feature, and immediate cleanup on unpair.
  const serverSignature = servers
    .map(
      (server) =>
        `${server.id}:${server.origin}:${server.features.includes(FLEET_ATTENTION_FEATURE) ? 1 : 0}:${server.features.includes(FLEET_ENVIRONMENTS_FEATURE) ? 1 : 0}`
    )
    .join('|')
  const activeFleetId = fleetInstanceId(fleetController)

  useEffect(() => {
    const managed = watchersRef.current
    const desired = new Map<string, { server: PairedServer; descriptor: string; shared: boolean }>()

    for (const server of servers) {
      if (!server.features.includes(FLEET_ATTENTION_FEATURE)) continue
      const isActive = active?.id === server.id && fleetController?.source.serverId === server.id
      if (isActive && fleetController) {
        desired.set(server.id, {
          server,
          descriptor: `shared:${server.id}:${activeFleetId}`,
          shared: true,
        })
      } else if (server.id !== DEMO_SERVER.id) {
        desired.set(server.id, {
          server,
          descriptor: `standalone:${server.id}:${server.origin}:${server.features.includes(FLEET_ENVIRONMENTS_FEATURE) ? 1 : 0}`,
          shared: false,
        })
      }
    }

    // Stop watchers for unpaired servers or servers whose transport mode changed.
    for (const [serverId, entry] of managed) {
      const target = desired.get(serverId)
      if (!target || target.descriptor !== entry.descriptor) {
        entry.cancelled = true
        entry.unsubscribe?.()
        entry.watcher?.stop()
        managed.delete(serverId)
      }
    }

    // Start watchers for newly added or switched servers.
    for (const [serverId, target] of desired) {
      if (managed.has(serverId)) continue
      const record: ManagedWatcher = {
        descriptor: target.descriptor,
        watcher: null,
        unsubscribe: null,
        cancelled: false,
      }
      managed.set(serverId, record)

      if (target.shared && fleetController) {
        const fc = fleetController
        const watcher = createAttentionWatcher({
          serverId,
          features: target.server.features,
          call: fc.source.call,
          transport: {
            mode: 'shared',
            stream: {
              getConnection: () => fc.store.getState().connection,
              getEnvironments: () => fc.store.getState().environments,
              subscribeStore: (listener) => fc.store.subscribe(listener),
              onAttentionStream: (handlers) => fc.onAttentionStream(handlers),
              reconnectNow: () => fc.foreground(),
            },
          },
        })
        record.watcher = watcher
        record.unsubscribe = watcher.subscribe(() => syncServers())
        if (backgroundedRef.current) watcher.background()
        watcher.start()
      } else {
        void clientForRef.current(target.server).then((client) => {
          if (record.cancelled || !client) return
          const watcher = createAttentionWatcher({
            serverId,
            features: target.server.features,
            call: client.call,
            transport: {
              mode: 'standalone',
              origin: client.origin,
              headers: client.headers,
              fetchStream: nativeStreamingFetch,
            },
          })
          record.watcher = watcher
          record.unsubscribe = watcher.subscribe(() => syncServers())
          if (backgroundedRef.current) watcher.background()
          watcher.start()
          syncServers()
        })
      }
    }

    syncServers()
  }, [serverSignature, active?.id, activeFleetId, syncServers])

  // Keep active server's inbox-relevant slices (`connection`, `loaded`, `bots`, `inbox`, `environments`, `lists`)
  // synced into the inbox controller without rebuilding on streamed transcript/view/runtime updates.
  useEffect(() => {
    const unsubscribe = subscribeInboxStoreSlices(fleetController?.store, chats?.store, syncServers)
    syncServers()
    return unsubscribe
  }, [fleetController, chats, environmentId, servers, active?.id, syncServers])

  // Re-apply the local icon badge total whenever a foreground push notification arrives so the OS badge stays in sync.
  useEffect(() => {
    return notifications.onNotificationReceived(() => badgeSync.reapplyBadge())
  }, [notifications, badgeSync])

  // Pause watchers + flush changed badgeOthers and ledger on background; resume + refetch + re-apply badge on active.
  useEffect(() => {
    inboxController.setForeground(AppState.currentState === 'active')
    const subscription = AppState.addEventListener('change', (nextState) => {
      inboxController.setForeground(nextState === 'active')
      if (nextState === 'background') {
        backgroundedRef.current = true
        for (const entry of watchersRef.current.values()) entry.watcher?.background()
        badgeSync.flushOnBackground()
        void inboxController.flushPersist()
      } else if (nextState === 'active') {
        backgroundedRef.current = false
        for (const entry of watchersRef.current.values()) entry.watcher?.foreground()
        inboxController.tick()
        badgeSync.reapplyBadge()
      }
    })
    return () => subscription.remove()
  }, [badgeSync, inboxController])

  const snapshot = useSyncExternalStore(inboxController.subscribe, inboxController.getState)

  const open = useCallback(
    (item: MobileInboxItem): Promise<void> =>
      openInboxItem(item, {
        activeServerId: activeRef.current?.id ?? null,
        activeEnvironmentId: environmentIdRef.current,
        activateServer: activate,
        setEnvironment,
        pushRoute: (href) => router.push(href as never),
        markRead: (keys) => inboxController.markRead(keys),
      }),
    [inboxController, activate, setEnvironment]
  )

  const markRead = useCallback((keys: string[]) => inboxController.markRead(keys), [inboxController])
  const markAllRead = useCallback(() => inboxController.markAllRead(), [inboxController])
  const dismiss = useCallback((key: string): InboxUndo => inboxController.dismiss(key), [inboxController])
  const restore = useCallback((undo: InboxUndo) => inboxController.restore(undo), [inboxController])
  const retry = useCallback((serverId: string) => {
    const managed = watchersRef.current.get(serverId)
    if (managed?.watcher) {
      managed.watcher.retryNow()
      return
    }
    const activeFleet = fleetRef.current
    if (activeFleet && activeFleet.source.serverId === serverId) {
      activeFleet.foreground()
    }
  }, [])

  const value = useMemo<MobileInbox>(
    () => ({
      items: snapshot.items,
      counts: snapshot.counts,
      servers: snapshot.servers,
      open,
      markRead,
      markAllRead,
      dismiss,
      restore,
      retry,
    }),
    [snapshot.items, snapshot.counts, snapshot.servers, open, markRead, markAllRead, dismiss, restore, retry]
  )

  return (
    <InboxControllerContext.Provider value={inboxController}>
      <InboxContext.Provider value={value}>{children}</InboxContext.Provider>
    </InboxControllerContext.Provider>
  )
}

export function useInbox(): MobileInbox {
  const value = useContext(InboxContext)
  if (!value) throw new Error('useInbox must be used inside InboxProvider')
  return value
}

/**
 * Keeps `bot:<botId>` marked read (local ledger + gateway `POST /v1/attention/seen`) while the calling bot or lane
 * screen is focused and the app is foregrounded, both on open and when new replies arrive while focused.
 */
export function useBotAttentionSeen(serverId: string | null | undefined, botId: string | null | undefined): void {
  const controller = useContext(InboxControllerContext)
  useFocusEffect(
    useCallback(() => {
      if (!controller || !serverId || !botId) return
      return controller.focusBot(serverId, botId)
    }, [controller, serverId, botId])
  )
}
