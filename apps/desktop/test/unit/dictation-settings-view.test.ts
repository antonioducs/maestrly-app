import { describe, expect, it, vi } from 'vitest'
import {
  DICTATION_NOTICE_KEYS,
  createDictationSettingsActions,
  dictationSettingsModel,
  loadDictationServer,
  type DictationSettingsApi,
} from '../../src/renderer/components/chat/dictation-settings-model'
import enChat from '../../src/shared/i18n/en/chat'
import type { FleetServerId } from '../../src/shared/fleet-servers'
import ptBrChat from '../../src/shared/i18n/pt-BR/chat'

const SERVER = 'aaaaaaaa-0000-4000-8000-000000000001' as FleetServerId
const servers = (state: string, features: string[]) =>
  vi.fn(async () => [{ id: SERVER, installed: false, connection: { state, features } }])

function fakeApi(overrides: Partial<DictationSettingsApi> = {}): DictationSettingsApi {
  return {
    chatDictationConfig: vi.fn(async () => ({ engine: 'local' as const, keys: { openai: false, groq: false } })),
    chatSetDictationEngine: vi.fn(async () => ({ ok: true })),
    chatSetDictationKey: vi.fn(async () => ({ ok: true as const, storage: 'secure' as const })),
    chatClearDictationKey: vi.fn(async () => ({ ok: true })),
    fleetServers: servers('connected', ['dictation']),
    fleetDictation: vi.fn(async () => ({ configured: false, provider: null, keyHint: null })),
    fleetDictationUseLocal: vi.fn(async () => ({ provider: 'openai' as const, keyHint: '1234' })),
    fleetDictationRemove: vi.fn(async () => {}),
    ...overrides,
  }
}

const openaiKey = { engine: 'openai' as const, keys: { openai: true, groq: false } }

describe('dictation settings', () => {
  it('changes the engine', async () => {
    const api = fakeApi()
    expect(await createDictationSettingsActions(api).setEngine('groq')).toBeNull()
    expect(api.chatSetDictationEngine).toHaveBeenCalledExactlyOnceWith('groq')
  })

  it('says when the provider refuses a key, could not check it, or it is kept for the session only', async () => {
    const rejected = fakeApi({
      chatSetDictationKey: vi.fn(async () => ({ ok: false as const, error: 'key-rejected' as const })),
    })
    expect(await createDictationSettingsActions(rejected).saveKey('openai', 'sk-bad')).toEqual({
      scope: 'openai',
      kind: 'key-rejected',
    })
    const memory = fakeApi({
      chatSetDictationKey: vi.fn(async () => ({ ok: true as const, storage: 'memory' as const })),
    })
    expect(await createDictationSettingsActions(memory).saveKey('groq', 'gsk')).toEqual({
      scope: 'groq',
      kind: 'memory',
    })
    expect(DICTATION_NOTICE_KEYS['key-rejected']).toBe('settings.dictationKeyRejected')
    expect(enChat.settings.dictationKeyRejected).toBe('The provider refused this key.')
    expect(ptBrChat.settings.dictationKeyRejected).toBe('O provedor recusou esta chave.')
  })

  it('hides the phone section without a connected server that supports dictation', async () => {
    expect(await loadDictationServer(fakeApi({ fleetServers: servers('unconfigured', []) }))).toEqual({
      kind: 'none',
    })
    const old = fakeApi({ fleetServers: servers('connected', ['phones']) })
    expect(await loadDictationServer(old)).toEqual({ kind: 'old' })
    expect(old.fleetDictation).not.toHaveBeenCalled()
    expect(dictationSettingsModel(openaiKey, { kind: 'none' }).phone).toBe('none')
    expect(dictationSettingsModel(openaiKey, { kind: 'old' })).toMatchObject({ phone: 'old', useOnPhone: false })
  })

  it("shows the server's key hint and removes it", async () => {
    const status = { configured: true, provider: 'openai' as const, keyHint: '1234' }
    const api = fakeApi({ fleetDictation: vi.fn(async () => status) })
    const server = await loadDictationServer(api)
    expect(server).toEqual({ kind: 'ready', status })
    expect(api.fleetDictation).toHaveBeenCalledExactlyOnceWith(SERVER)
    expect(dictationSettingsModel(openaiKey, server)).toEqual({
      phone: 'ready',
      useOnPhone: true,
      removeFromServer: true,
      state: { key: 'settings.dictationServerState', provider: 'openai', hint: '1234' },
    })
    await createDictationSettingsActions(api).removeFromServer()
    expect(api.fleetDictationRemove).toHaveBeenCalledExactlyOnceWith(SERVER)
  })

  it('offers to use the key on the phone only with an API engine and its key', () => {
    const server = { kind: 'ready' as const, status: { configured: false, provider: null, keyHint: null } }
    expect(dictationSettingsModel({ engine: 'local', keys: { openai: true, groq: true } }, server)).toMatchObject({
      useOnPhone: false,
      removeFromServer: false,
      state: { key: 'settings.dictationServerNone' },
    })
    expect(dictationSettingsModel({ engine: 'groq', keys: { openai: true, groq: false } }, server).useOnPhone).toBe(
      false
    )
    expect(dictationSettingsModel(openaiKey, server).useOnPhone).toBe(true)
  })

  it("reports a key the server's check refused", async () => {
    const api = fakeApi({ fleetDictationUseLocal: vi.fn(async () => ({ error: 'unchecked' as const })) })
    expect(await createDictationSettingsActions(api).useOnPhone()).toEqual({ scope: 'server', kind: 'unchecked' })
  })
})
