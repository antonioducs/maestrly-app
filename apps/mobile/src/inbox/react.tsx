import {
  FLEET_ATTENTION_FEATURE,
  FLEET_ENVIRONMENTS_FEATURE,
  type FleetAttentionEntry,
} from '@maestrly/bot-fleet-protocol'
import { router } from 'expo-router'
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
import { createInboxController, type InboxServerInput } from './controller'
import { fallbackObservations } from './fallback'
import { openInboxItem, type InboxUndo, type MobileInbox, type MobileInboxItem } from './types'
import { createAttentionWatcher, type AttentionWatcher } from './watcher'

export type { InboxUndo, MobileInbox, MobileInboxItem, MobileInboxServer } from './types'

const EMPTY_ENTRIES: ReadonlyMap<string, FleetAttentionEntry> = new Map()
const EMPTY_ENVIRONMENTS: ReadonlyMap<string, string> = new Map()

const InboxContext = createContext<MobileInbox | null>(null)

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
    const inputs: InboxServerInput[] = currentServers.map((server) => {
      const isActive = currentActive?.id === server.id && activeFleet?.source.serverId === server.id
      const supportsAttention = server.features.includes(FLEET_ATTENTION_FEATURE)
      const activeFleetState = isActive && activeFleet ? activeFleet.store.getState() : null
      const activeChatsState = isActive && activeChats ? activeChats.store.getState() : null

      if (supportsAttention) {
        const watched = watchersRef.current.get(server.id)?.watcher?.getState()
        const environments =
          isActive && activeFleetState && activeFleetState.environments.length > 0
            ? new Map(activeFleetState.environments.map((env) => [env.id, env.name]))
            : (watched?.environments ?? EMPTY_ENVIRONMENTS)
        return {
          id: server.id,
          name: server.name,
          features: server.features,
          supportsAttention: true,
          reachable: watched ? watched.reachable : isActive ? isFleetReachable(activeFleet) : true,
          loaded: watched?.loaded ?? false,
          entries: watched?.entries ?? EMPTY_ENTRIES,
          environments,
          ...(activeFleetState ? { bots: activeFleetState.bots, inbox: activeFleetState.inbox } : {}),
          ...(isActive ? { activeEnvironmentId: activeEnvId, chatLists: activeChatsState?.lists ?? null } : {}),
        }
      }

      if (isActive && activeFleetState) {
        return {
          id: server.id,
          name: server.name,
          features: server.features,
          supportsAttention: false,
          reachable: isFleetReachable(activeFleet),
          loaded: activeFleetState.loaded,
          entries: EMPTY_ENTRIES,
          environments: new Map(activeFleetState.environments.map((env) => [env.id, env.name])),
          bots: activeFleetState.bots,
          inbox: activeFleetState.inbox,
          activeEnvironmentId: activeEnvId,
          chatLists: activeChatsState?.lists ?? null,
          fallback: fallbackObservations({
            serverId: server.id,
            serverName: server.name,
            bots: activeFleetState.bots,
            environments: activeFleetState.environments,
            inbox: activeFleetState.inbox,
            environmentId: activeEnvId,
            chatLists: activeChatsState?.lists ?? null,
          }),
        }
      }

      return {
        id: server.id,
        name: server.name,
        features: server.features,
        supportsAttention: false,
        reachable: true,
        loaded: false,
        entries: EMPTY_ENTRIES,
        environments: EMPTY_ENVIRONMENTS,
      }
    })
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

  // Reconcile per-server attention watchers: shared stream for the active server, standalone `?attention=1` stream
  // for non-active servers with the feature, and immediate cleanup on unpair or feature loss.
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

  // Keep active server's bots/environments/requests/chats synced into the inbox controller (both for fallback mode
  // and for enriching attention entries with bot tints, workspace names, and request summaries).
  useEffect(() => {
    const unsubFleet = fleetController?.store.subscribe(syncServers)
    const unsubChats = chats?.store.subscribe(syncServers)
    syncServers()
    return () => {
      unsubFleet?.()
      unsubChats?.()
    }
  }, [fleetController, chats, environmentId, servers, active?.id, syncServers])

  // Pause watchers + flush badgeOthers and ledger on background; resume + refetch on foreground.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'background') {
        backgroundedRef.current = true
        for (const entry of watchersRef.current.values()) entry.watcher?.background()
        badgeSync.flushOnBackground()
        void inboxController.flushPersist()
      } else if (nextState === 'active') {
        backgroundedRef.current = false
        for (const entry of watchersRef.current.values()) entry.watcher?.foreground()
        inboxController.tick()
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
    }),
    [snapshot.items, snapshot.counts, snapshot.servers, open, markRead, markAllRead, dismiss, restore]
  )

  return <InboxContext.Provider value={value}>{children}</InboxContext.Provider>
}

export function useInbox(): MobileInbox {
  const value = useContext(InboxContext)
  if (!value) throw new Error('useInbox must be used inside InboxProvider')
  return value
}
