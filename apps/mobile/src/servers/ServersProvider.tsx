import Constants from 'expo-constants'
import * as Crypto from 'expo-crypto'
import * as Device from 'expo-device'
import { File } from 'expo-file-system'
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { AppState, Platform } from 'react-native'
import { createBridgeChatsSource } from '../chats/bridge-source'
import { chatOutboxKey, createChatsController, type ChatsController } from '../chats/controller'
import { ChatsProvider } from '../chats/react'
import { createDemoChatsSource } from '../demo/demo-chats'
import { createDemoSource, DEMO_SERVER } from '../demo/demo-source'
import { createFleetController, type FleetController } from '../fleet/controller'
import { createHttpSource, gatewayClientFor, nativeFetch } from '../fleet/http-source'
import { FleetProvider } from '../fleet/react'
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
  const [controller, setController] = useState<FleetController | null>(null)
  const [chats, setChats] = useState<ChatsController | null>(null)
  const [current, setCurrent] = useState<Current | null>(null)
  const deviceName = Device.deviceName ?? Device.modelName ?? t('pair.defaultDeviceName')

  const reload = useCallback(async () => {
    const [list, active] = await Promise.all([registry.list(), registry.activeId()])
    setServers(list)
    setActiveId(active)
  }, [registry])

  useEffect(() => {
    void reload().finally(() => setReady(true))
  }, [reload])

  const active = servers.find((server) => server.id === activeId) ?? null

  // One pair of controllers for the active server, its bots and its chats, replaced when another server is active.
  useEffect(() => {
    setCurrent(null)
    if (!active) {
      setController(null)
      setChats(null)
      return
    }
    let cancelled = false
    let created: FleetController | null = null
    let createdChats: ChatsController | null = null
    let unsubscribe: (() => void) | null = null
    void (async () => {
      const demo = active.id === DEMO_SERVER.id
      const token = demo ? 'demo' : ((await registry.token(active.id)) ?? '')
      if (cancelled) return
      const fleet = createFleetController(demo ? createDemoSource() : createHttpSource(active, token), kv, {
        uuid: Crypto.randomUUID,
        onFeatures: (features) => void registry.updateFeatures(active.id, features),
      })
      created = fleet
      const chatSource = demo
        ? createDemoChatsSource({ readFile })
        : createBridgeChatsSource(
            active,
            gatewayClientFor(active, token),
            () => fleet.store.getState().features,
            {
              appVersion: Constants.expoConfig?.version ?? '0.0.0',
              deviceName,
              os: Platform.OS === 'android' ? 'android' : 'ios',
              locale,
            },
            readFile
          )
      createdChats = createChatsController(chatSource, kv, { uuid: Crypto.randomUUID })
      await Promise.all([fleet.start(), createdChats.start()])
      if (cancelled) {
        fleet.stop()
        createdChats.stop()
        return
      }
      // Chats run on the server's workspaces host: the bridge opens once the fleet lists one.
      const sync = () => createdChats?.setHosted(hostsChats(fleet))
      unsubscribe = fleet.store.subscribe(sync)
      sync()
      setController(fleet)
      setChats(createdChats)
    })()
    return () => {
      cancelled = true
      unsubscribe?.()
      created?.stop()
      createdChats?.stop()
      setController(null)
      setChats(null)
    }
    // The controllers follow the server's identity; a features update must not restart them.
  }, [active?.id, registry, kv])

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
      const { server, token } = await pairWithServer({ ...input, deviceName, allowLoopback: __DEV__ }, nativeFetch)
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
      await kv.delete(chatOutboxKey(id)).catch(() => {})
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

  const value = useMemo<Servers>(
    () => ({
      ready,
      servers,
      active,
      controller,
      chats,
      deviceName,
      activate,
      pair,
      exploreDemo,
      forget,
      current,
      setCurrent,
      clientFor,
    }),
    [ready, servers, active, controller, chats, deviceName, activate, pair, exploreDemo, forget, current, clientFor]
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
