import {
  FLEET_DICTATION_FEATURE,
  type FleetDictationKeyResponse,
  type FleetDictationStatus,
} from '@maestrly/bot-fleet-protocol'
import type { DictationApiProvider, DictationConfig, DictationEngine } from '../../../shared/dictation'

/** What the Dictation settings use of the preload API; the keys themselves never come back from it. */
export interface DictationSettingsApi {
  chatDictationConfig(): Promise<DictationConfig>
  chatSetDictationEngine(engine: DictationEngine): Promise<{ ok: boolean }>
  chatSetDictationKey(
    provider: DictationApiProvider,
    key: string
  ): Promise<{ ok: true; storage: 'secure' | 'memory' } | { ok: false; error: 'key-rejected' | 'unchecked' }>
  chatClearDictationKey(provider: DictationApiProvider): Promise<{ ok: boolean }>
  fleetGetConnection(): Promise<{ state: string; features: string[] }>
  fleetDictation(): Promise<FleetDictationStatus | null>
  fleetDictationUseLocal(): Promise<FleetDictationKeyResponse>
  fleetDictationRemove(): Promise<void>
}

/** The bot server as Dictation settings see it: absent, too old to dictate through, or with its key's state. */
export type DictationServerView = { kind: 'none' } | { kind: 'old' } | { kind: 'ready'; status: FleetDictationStatus }

/** The outcome of the last action worth saying, for one key row or for the server. */
export type DictationSettingsNotice = {
  scope: DictationApiProvider | 'server'
  kind: 'key-rejected' | 'unchecked' | 'memory'
}

export async function loadDictationServer(api: DictationSettingsApi): Promise<DictationServerView> {
  const connection = await api.fleetGetConnection().catch(() => null)
  if (connection?.state !== 'connected') return { kind: 'none' }
  if (!connection.features.includes(FLEET_DICTATION_FEATURE)) return { kind: 'old' }
  const status = await api.fleetDictation().catch(() => null)
  return status ? { kind: 'ready', status } : { kind: 'none' }
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
    async useOnPhone(): Promise<DictationSettingsNotice | null> {
      const result = await api.fleetDictationUseLocal()
      return 'error' in result ? { scope: 'server', kind: result.error } : null
    },
    async removeFromServer(): Promise<DictationSettingsNotice | null> {
      await api.fleetDictationRemove()
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
