import * as Crypto from 'expo-crypto'
import * as Device from 'expo-device'
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { AppState, Platform } from 'react-native'
import { createDemoSource, DEMO_SERVER } from '../demo/demo-source'
import { createFleetController, type FleetController } from '../fleet/controller'
import { createHttpSource, gatewayClientFor, nativeFetch } from '../fleet/http-source'
import { FleetProvider } from '../fleet/react'
import { GatewayError } from '../gateway/client'
import { useI18n } from '../i18n'
import { asyncKeyValue, secureSecrets } from './adapters'
import { pairWithServer } from './pairing'
import { memoryStores, ServerRegistry, type KeyValueStore, type PairedServer } from './registry'

type Servers = {
  ready: boolean
  servers: PairedServer[]
  active: PairedServer | null
  controller: FleetController | null
  deviceName: string
  activate(id: string): Promise<void>
  pair(input: { address: string; code: string }): Promise<PairedServer>
  exploreDemo(): Promise<void>
  /** Removes a server from this phone; `remote` first unpairs it on the server, and throws if that fails. */
  forget(id: string, options: { remote: boolean }): Promise<void>
  /** The bot open on the home screen. */
  currentBotId: string | null
  setCurrentBotId(id: string | null): void
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
  const { t } = useI18n()
  const [{ registry, kv }] = useState(stores)
  const [ready, setReady] = useState(false)
  const [servers, setServers] = useState<PairedServer[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [controller, setController] = useState<FleetController | null>(null)
  const [currentBotId, setCurrentBotId] = useState<string | null>(null)
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

  // One controller for the active server, replaced when another server becomes active.
  useEffect(() => {
    setCurrentBotId(null)
    if (!active) {
      setController(null)
      return
    }
    let cancelled = false
    let created: FleetController | null = null
    void (async () => {
      const source =
        active.id === DEMO_SERVER.id ? createDemoSource() : createHttpSource(active, (await registry.token(active.id)) ?? '')
      if (cancelled) return
      created = createFleetController(source, kv, {
        uuid: Crypto.randomUUID,
        onFeatures: (features) => void registry.updateFeatures(active.id, features),
      })
      await created.start()
      if (cancelled) created.stop()
      else setController(created)
    })()
    return () => {
      cancelled = true
      created?.stop()
      setController(null)
    }
    // The controller follows the server's identity; a features update must not restart it.
  }, [active?.id, registry, kv])

  useEffect(() => {
    if (!controller) return
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') controller.foreground()
      else if (state === 'background') controller.background()
    })
    return () => subscription.remove()
  }, [controller])

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
      await reload()
    },
    [kv, registry, reload, servers]
  )

  const value = useMemo<Servers>(
    () => ({
      ready,
      servers,
      active,
      controller,
      deviceName,
      activate,
      pair,
      exploreDemo,
      forget,
      currentBotId,
      setCurrentBotId,
    }),
    [ready, servers, active, controller, deviceName, activate, pair, exploreDemo, forget, currentBotId]
  )
  return (
    <ServersContext.Provider value={value}>
      <FleetProvider controller={controller}>{children}</FleetProvider>
    </ServersContext.Provider>
  )
}

export function useServers(): Servers {
  const value = useContext(ServersContext)
  if (!value) throw new Error('useServers must be used inside ServersProvider')
  return value
}
