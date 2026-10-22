import {
  FLEET_DICTATION_FEATURE,
  type FleetDictationKeyResponse,
  type FleetDictationStatus,
} from '@maestrly/bot-fleet-protocol'
import type { DictationApiProvider, DictationConfig, DictationEngine } from '../../../shared/dictation'
import type { FleetServerId } from '../../../shared/fleet-servers'

/** What the Dictation settings use of the preload API; the keys themselves never come back from it. */
export interface DictationSettingsApi {
  chatDictationConfig(): Promise<DictationConfig>
  chatSetDictationEngine(engine: DictationEngine): Promise<{ ok: boolean }>
  chatSetDictationKey(
    provider: DictationApiProvider,
    key: string
  ): Promise<{ ok: true; storage: 'secure' | 'memory' } | { ok: false; error: 'key-rejected' | 'unchecked' }>
  chatClearDictationKey(provider: DictationApiProvider): Promise<{ ok: boolean }>
  fleetServers(): Promise<
    Array<{
      id: FleetServerId
      installed: boolean
      connection: { state: string; features: string[]; hostname?: string | null; url?: string | null }
    }>
  >
  fleetDictation(serverId: FleetServerId): Promise<FleetDictationStatus | null>
  fleetDictationUseLocal(serverId: FleetServerId): Promise<FleetDictationKeyResponse>
  fleetDictationRemove(serverId: FleetServerId): Promise<void>
}

/** A bot server as Dictation settings see it: absent, too old to dictate through, or with its key's state. */
export type DictationServerView = { kind: 'none' } | { kind: 'old' } | { kind: 'ready'; status: FleetDictationStatus }

/** One paired server and the dictation key its phones use. */
export type DictationServerRow = { id: FleetServerId; name: string; view: DictationServerView }

/** The outcome of the last action worth saying, for one key row or for one server's row. */
export type DictationSettingsNotice = {
  scope: DictationApiProvider | `server:${string}`
  kind: 'key-rejected' | 'unchecked' | 'memory'
}

const serverName = (connection: { hostname?: string | null; url?: string | null }): string => {
  if (connection.hostname) return connection.hostname
  try {
    return connection.url ? new URL(connection.url).host : ''
  } catch {
    return connection.url ?? ''
  }
}

/** Every paired server, in pairing order: each server's phones dictate with the key that server keeps. */
export async function loadDictationServers(api: DictationSettingsApi): Promise<DictationServerRow[]> {
  const servers = await api.fleetServers().catch(() => [])
  return Promise.all(
    servers.map(async (server): Promise<DictationServerRow> => {
      const row = { id: server.id, name: serverName(server.connection) }
      if (server.connection.state !== 'connected') return { ...row, view: { kind: 'none' } }
      if (!server.connection.features.includes(FLEET_DICTATION_FEATURE)) return { ...row, view: { kind: 'old' } }
      const status = await api.fleetDictation(server.id).catch(() => null)
      return { ...row, view: status ? { kind: 'ready', status } : { kind: 'none' } }
    })
  )
}

export function createDictationSettingsActions(api: DictationSettingsApi) {
  return {
    async setEngine(engine: DictationEngine): Promise<DictationSettingsNotice | null> {
      await api.chatSetDictationEngine(engine)
      return null
    },
    async saveKey(provider: DictationApiProvider, key: string): Promise<DictationSettingsNotice | null> {
      const result = await api.chatSetDictationKey(provider, key)
      if (!result.ok) return { scope: provider, kind: result.error }
      return result.storage === 'memory' ? { scope: provider, kind: 'memory' } : null
    },
    async clearKey(provider: DictationApiProvider): Promise<DictationSettingsNotice | null> {
      await api.chatClearDictationKey(provider)
      return null
    },
    async useOnPhone(serverId: FleetServerId): Promise<DictationSettingsNotice | null> {
      const result = await api.fleetDictationUseLocal(serverId)
      return 'error' in result ? { scope: `server:${serverId}`, kind: result.error } : null
    },
    async removeFromServer(serverId: FleetServerId): Promise<DictationSettingsNotice | null> {
      await api.fleetDictationRemove(serverId)
      return null
    },
  }
}

export const DICTATION_NOTICE_KEYS = {
  'key-rejected': 'settings.dictationKeyRejected',
  unchecked: 'settings.dictationKeyUnchecked',
  memory: 'settings.dictationKeyMemory',
} as const

/** What the screen shows, decided apart from React so it can be tested without a DOM. */
export function dictationSettingsModel(config: DictationConfig, server: DictationServerView) {
  const localKey = config.engine !== 'local' && config.keys[config.engine]
  if (server.kind !== 'ready') return { phone: server.kind, useOnPhone: false, removeFromServer: false, state: null }
  const { status } = server
  return {
    phone: 'ready' as const,
    useOnPhone: localKey,
    removeFromServer: status.configured,
    state:
      status.configured && status.provider
        ? { key: 'settings.dictationServerState' as const, provider: status.provider, hint: status.keyHint ?? '' }
        : { key: 'settings.dictationServerNone' as const },
  }
}
