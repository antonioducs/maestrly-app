import Constants from 'expo-constants'
import * as Crypto from 'expo-crypto'
import * as Device from 'expo-device'
import { File } from 'expo-file-system'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AppState, Platform } from 'react-native'
import { createBridgeChatsSource } from '../chats/bridge-source'
import { createChatsController, type ChatsController } from '../chats/controller'
import {
  chooseEnvironment,
  environmentChoiceKey,
  forgetServerChats,
  prepareEnvironmentOutbox,
} from '../chats/environments'
import { ChatsProvider } from '../chats/react'
import { noChatsSource } from '../chats/source'
import { createDemoChatsSource } from '../demo/demo-chats'
import { createDemoSource, DEMO_SERVER } from '../demo/demo-source'
import { createFleetController, type FleetController } from '../fleet/controller'
import { createHttpSource, gatewayClientFor, nativeFetch } from '../fleet/http-source'
import { FleetProvider } from '../fleet/react'
import { FLEET_DICTATION_FEATURE, type FleetDictationStatus } from '@maestrly/bot-fleet-protocol'
import { dictationChoiceKey, isDictationChoice, type DictationChoice } from '../dictation/preference'
import { GatewayError, type GatewayClient } from '../gateway/client'
import { useI18n } from '../i18n'
import { asyncKeyValue, secureSecrets } from './adapters'
import { pairWithServer } from './pairing'
import { memoryStores, ServerRegistry, type KeyValueStore, type PairedServer } from './registry'

/** What the home screen shows: a bot, a chat, or a new chat about to start (in a workspace, or in none). */
export type Current =
  | { kind: 'bot'; id: string }
  | { kind: 'chat'; id: string }
  | { kind: 'new'; workspaceId: string | null }

const readFile = (uri: string) => new File(uri).base64()
const hostsChats = (controller: FleetController) =>
  controller.store.getState().environments.some((environment) => environment.kind === 'workspaces')

type Servers = {
  ready: boolean
  servers: PairedServer[]
  active: PairedServer | null
  controller: FleetController | null
  chats: ChatsController | null
  /** The workspaces environment whose chats the phone shows; null while the server is known to host none. */
  environmentId: string | null
  /** Shows the chats of another of the server's workspaces environments, and remembers the choice. */
  setEnvironment(id: string): void
  deviceName: string
  activate(id: string): Promise<void>
  pair(input: { address: string; code: string }): Promise<PairedServer>
  exploreDemo(): Promise<void>
  /** Removes a server from this phone; `remote` first unpairs it on the server, and throws if that fails. */
  forget(id: string, options: { remote: boolean }): Promise<void>
  /** What the home screen shows. */
  current: Current | null
  setCurrent(current: Current | null): void
  /** A gateway client for a paired server, such as to register for notifications; null for the demo server. */
  clientFor(server: PairedServer): Promise<GatewayClient | null>
  /**
   * The active server's dictation: the engine this phone chose for it (null until chosen), and the server's key as
   * it last said (null when it cannot transcribe or has not answered yet).
   */
  dictation: { choice: DictationChoice | null; status: FleetDictationStatus | null }
  setDictationChoice(choice: DictationChoice): void
  /** Asks the active server for its dictation key again, after it changed. */
  refreshDictation(): Promise<void>
}

const ServersContext = createContext<Servers | null>(null)

/** Tokens never go to the browser's storage: the web preview keeps everything in memory. */
function stores(): { registry: ServerRegistry; kv: KeyValueStore } {
  if (Platform.OS === 'web') {
    const { secrets, kv } = memoryStores()
    return { registry: new ServerRegistry(secrets, kv), kv }
  }
  const kv = asyncKeyValue()
  return { registry: new ServerRegistry(secureSecrets(), kv), kv }
}

export function ServersProvider({ children }: { children: ReactNode }) {
  const { t, locale } = useI18n()
  const [{ registry, kv }] = useState(stores)
  const [ready, setReady] = useState(false)
  const [servers, setServers] = useState<PairedServer[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [session, setSession] = useState<{ fleet: FleetController; token: string } | null>(null)
  const controller = session?.fleet ?? null
  const [chats, setChats] = useState<ChatsController | null>(null)
  const [environmentId, setEnvironmentId] = useState<string | null>(null)
  /** The environment the person chose on the active server, read from storage when the server becomes active. */
  const chosen = useRef<string | null>(null)
  const [current, setCurrent] = useState<Current | null>(null)
  const deviceName = Device.deviceName ?? Device.modelName ?? t('pair.defaultDeviceName')

  const reload = useCallback(async () => {
    const [list, active] = await Promise.all([registry.list(), registry.activeId()])
    setServers(list)
    setActiveId(active)
  }, [registry])

  useEffect(() => {
    // Storage that cannot be read leaves the app on its first screen rather than on a blank one.
    void reload()
      .catch(() => {})
      .finally(() => setReady(true))
  }, [reload])

  const active = servers.find((server) => server.id === activeId) ?? null

  // The active server's fleet controller, replaced when another server is active.
  useEffect(() => {
    setCurrent(null)
    setEnvironmentId(null)
    chosen.current = null
    if (!active) {
      setSession(null)
      return
    }
    let cancelled = false
    let created: FleetController | null = null
    let unsubscribe: (() => void) | null = null
    void (async () => {
      const demo = active.id === DEMO_SERVER.id
      let token = 'demo'
      // The Keychain can refuse reads for a moment, such as right after the phone restarts: try again until it answers.
      for (let attempt = 0; !demo; attempt++) {
        try {
          token = (await registry.token(active.id)) ?? ''
          break
        } catch {
          await new Promise<void>((resolve) => setTimeout(resolve, Math.min(30_000, 1_000 * 2 ** attempt)))
          if (cancelled) return
        }
      }
      if (cancelled) return
      const fleet = createFleetController(demo ? createDemoSource() : createHttpSource(active, token), kv, {
        uuid: Crypto.randomUUID,
        onFeatures: (features) => void registry.updateFeatures(active.id, features),
      })
      created = fleet
      const [saved] = await Promise.all([kv.get(environmentChoiceKey(active.id)).catch(() => null), fleet.start()])
      if (cancelled) {
        fleet.stop()
        return
      }
      chosen.current = saved
      // Until the fleet lists its environments, the phone keeps to the one chosen before.
      const sync = () => {
        const state = fleet.store.getState()
        setEnvironmentId(state.loaded ? chooseEnvironment(state.environments, chosen.current) : chosen.current)
      }
      unsubscribe = fleet.store.subscribe(sync)
      sync()
      setSession({ fleet, token })
    })()
    return () => {
      cancelled = true
      unsubscribe?.()
      created?.stop()
      setSession(null)
    }
    // The controller follows the server's identity; a features update must not restart it.
  }, [active?.id, registry, kv])

  // The chats of the chosen workspaces environment, through its host; replaced when the person picks another. A server
  // that hosts none still gets a controller, which never connects, so the screens read a server without chats.
  useEffect(() => {
    if (!session || !active) {
      setChats(null)
      return
    }
    const { fleet, token } = session
    let cancelled = false
    let created: ChatsController | null = null
    let unsubscribe: (() => void) | null = null
    void (async () => {
      const source = !environmentId
        ? noChatsSource(active.id)
        : active.id === DEMO_SERVER.id
          ? createDemoChatsSource({ readFile, environmentId })
          : createBridgeChatsSource(
              active,
              gatewayClientFor(active, token),
              () => fleet.store.getState().features,
              environmentId,
              {
                appVersion: Constants.expoConfig?.version ?? '0.0.0',
                deviceName,
                os: Platform.OS === 'android' ? 'android' : 'ios',
                locale,
              },
              readFile
            )
      if (environmentId) await prepareEnvironmentOutbox(kv, active.id, environmentId).catch(() => {})
      if (cancelled) return
      const next = createChatsController(source, kv, { uuid: Crypto.randomUUID })
      created = next
      await next.start()
      if (cancelled) return
      // The bridge runs while the server lists a workspaces environment.
      const sync = () => next.setHosted(!!environmentId && hostsChats(fleet))
      unsubscribe = fleet.store.subscribe(sync)
      sync()
      setChats(next)
    })()
    return () => {
      cancelled = true
      unsubscribe?.()
      created?.stop()
    }
    // A new language or device name reaches the host on the next connection, not by restarting the chats.
  }, [session, environmentId, kv])

  const setEnvironment = useCallback(
    (id: string) => {
      if (!active || !controller) return
      chosen.current = id
      void kv.set(environmentChoiceKey(active.id), id).catch(() => {})
      const state = controller.store.getState()
      const next = state.loaded ? chooseEnvironment(state.environments, id) : id
      // What is on screen belongs to the other environment's chats.
      if (next !== environmentId) setCurrent(null)
      setEnvironmentId(next)
    },
    [active, controller, environmentId, kv]
  )

  useEffect(() => {
    if (!controller) return
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        controller.foreground()
        chats?.foreground()
      } else if (state === 'background') {
        controller.background()
        chats?.background()
      }
    })
    return () => subscription.remove()
  }, [controller, chats])

  const activate = useCallback(
    async (id: string) => {
      await registry.setActive(id)
      setActiveId(id)
    },
    [registry]
  )

  const pair = useCallback(
    async (input: { address: string; code: string }) => {
      const client =
        Platform.OS === 'ios' || Platform.OS === 'android'
          ? { kind: 'phone' as const, platform: Platform.OS }
          : undefined
      const { server, token } = await pairWithServer(
        { ...input, deviceName, allowLoopback: __DEV__, client },
        nativeFetch
      )
      await registry.add(server, token)
      await reload()
      return server
    },
    [deviceName, registry, reload]
  )

  const exploreDemo = useCallback(async () => {
    await registry.add({ ...DEMO_SERVER, deviceName }, 'demo')
    await reload()
  }, [deviceName, registry, reload])

  const forget = useCallback(
    async (id: string, options: { remote: boolean }) => {
      const server = servers.find((item) => item.id === id)
      if (!server) return
      if (options.remote && server.id !== DEMO_SERVER.id) {
        const token = await registry.token(id)
        try {
          if (token) await gatewayClientFor(server, token).call('devicesSelfDelete')
        } catch (error) {
          // A server that already removed this phone answers 401: there is nothing left to unpair there.
          if (!(error instanceof GatewayError && error.code === 'UNAUTHORIZED')) throw error
        }
      }
      await registry.remove(id)
      await kv.delete(`outbox.${id}`).catch(() => {})
      await kv.delete(dictationChoiceKey(id)).catch(() => {})
      await forgetServerChats(kv, id)
      await reload()
    },
    [kv, registry, reload, servers]
  )

  const clientFor = useCallback(
    async (server: PairedServer) => {
      if (server.id === DEMO_SERVER.id) return null
      const token = await registry.token(server.id)
      return token ? gatewayClientFor(server, token) : null
    },
    [registry]
  )

  const [dictationChoice, setDictationChoiceState] = useState<DictationChoice | null>(null)
  const [dictationStatus, setDictationStatus] = useState<FleetDictationStatus | null>(null)
  const dictationCapable = !!active && active.id !== DEMO_SERVER.id && active.features.includes(FLEET_DICTATION_FEATURE)
  useEffect(() => {
    setDictationChoiceState(null)
    if (!active) return
    let alive = true
    kv.get(dictationChoiceKey(active.id))
      .then((value) => {
        if (alive) setDictationChoiceState(isDictationChoice(value) ? value : null)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [active?.id, kv])
  const refreshDictation = useCallback(async () => {
    if (!controller || !dictationCapable) return setDictationStatus(null)
    try {
      setDictationStatus(await controller.source.call('dictationGet'))
    } catch {
      // Unreachable for now: the last state it said stands.
    }
  }, [controller, dictationCapable])
  useEffect(() => {
    setDictationStatus(null)
    void refreshDictation()
  }, [refreshDictation])
  const setDictationChoice = useCallback(
    (choice: DictationChoice) => {
      setDictationChoiceState(choice)
      if (active) void kv.set(dictationChoiceKey(active.id), choice).catch(() => {})
    },
    [active, kv]
  )
  const dictation = useMemo(
    () => ({ choice: dictationChoice, status: dictationStatus }),
    [dictationChoice, dictationStatus]
  )

  const value = useMemo<Servers>(
    () => ({
      ready,
      servers,
      active,
      controller,
      chats,
      environmentId,
      setEnvironment,
      deviceName,
      activate,
      pair,
      exploreDemo,
      forget,
      current,
      setCurrent,
      clientFor,
      dictation,
      setDictationChoice,
      refreshDictation,
    }),
    [
      ready,
      servers,
      active,
      controller,
      chats,
      environmentId,
      setEnvironment,
      deviceName,
      activate,
      pair,
      exploreDemo,
      forget,
      current,
      clientFor,
      dictation,
      setDictationChoice,
      refreshDictation,
    ]
  )
  return (
    <ServersContext.Provider value={value}>
      <FleetProvider controller={controller}>
        <ChatsProvider controller={chats}>{children}</ChatsProvider>
      </FleetProvider>
    </ServersContext.Provider>
  )
}

export function useServers(): Servers {
  const value = useContext(ServersContext)
  if (!value) throw new Error('useServers must be used inside ServersProvider')
  return value
}
