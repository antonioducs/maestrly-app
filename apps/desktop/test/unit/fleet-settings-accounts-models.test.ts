import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { getDb } from '../../src/main/store/db'
import { freshDb, closeDb } from '../helpers/db'
import {
  addProvider,
  addSubscriptionAccount,
  getProvider,
  renameDefaultSubscriptionAccount,
  subscriptionProviderIdFor,
} from '../../src/main/chat/catalog'
import { getAppSetting, setAppSetting } from '../../src/main/store'
import { getHiddenChatModelsFor, setHiddenChatModels } from '../../src/main/store/settings'
import { createAccountsSettingsService } from '../../src/main/fleet/instance/settings/accounts'
import { createModelsSettingsService } from '../../src/main/fleet/instance/settings/models'
import { listBotAccounts } from '../../src/main/fleet/instance/provisioning/accounts'
import { getApiKey, setApiKey } from '../../src/main/chat/credentials'
import { settingsRevision } from '../../src/main/fleet/instance/settings/revisions'

const state = vi.hoisted(() => ({ secure: true, fail: false, keys: new Map<string, string>(), authenticated: true }))
vi.mock('../../src/main/secure-store', () => ({
  secureStorageMode: () => (state.secure ? 'secure' : 'unavailable'),
  secureGet: (key: string) => state.keys.get(key) ?? null,
  secureSet: (key: string, value: string) => {
    if (state.fail) return false
    state.keys.set(key, value)
    return true
  },
  secureRemove: (key: string) => state.keys.delete(key),
}))
vi.mock('../../src/main/chat/service', () => ({
  listChatProviderModels: async (_id: string, options: { includeHidden: boolean }) =>
    options.includeHidden ? ['one', 'two'] : [],
  effectiveModelMeta: async () => ({ meta: { contextWindow: 10000 } }),
  removeSubscriptionAccountSlot: vi.fn(),
}))
vi.mock('../../src/main/chat/provider', () => ({ invalidateProvider: vi.fn() }))
vi.mock('../../src/main/chat/models', () => ({ invalidateModels: vi.fn() }))
vi.mock('../../src/main/chat/codex-subscription/manager', () => ({
  getCodexSubscriptionManager: () => ({
    peekStatus: () => ({ authenticated: state.authenticated }),
    getStatus: async () => ({ authenticated: state.authenticated }),
  }),
}))
vi.mock('../../src/main/chat/claude-agent-sdk/manager', () => ({
  getClaudeSubscriptionManager: () => ({ peekStatus: () => null, status: async () => null }),
}))
vi.mock('../../src/main/chat/grok-subscription/manager', () => ({
  getGrokSubscriptionManager: () => ({ getStatusSnapshot: () => null, getStatus: async () => null }),
}))
vi.mock('../../src/main/chat/github-copilot/manager', () => ({
  getGitHubCopilotSubscriptionManager: () => ({ peekStatus: () => null, getStatus: async () => null }),
}))
vi.mock('../../src/main/chat/cursor-subscription/manager', () => ({
  getCursorSubscriptionManager: () => ({ peekStatus: () => null, getStatus: async () => null }),
}))
vi.mock('../../src/main/chat/antigravity-subscription/manager', () => ({
  getAntigravitySubscriptionManager: () => ({ getStatus: () => ({ authenticated: false }) }),
}))
beforeEach(() => {
  freshDb()
  state.keys.clear()
  state.secure = true
  state.fail = false
  state.authenticated = true
})
afterEach(() => closeDb())
const host = () => ({
  bots: () => [],
  signingIn: () => [],
  accountsChanged: vi.fn(),
  removeAccount: vi.fn(async () => {}),
  removeSubscription: vi.fn(async () => {}),
})
it('preserves private endpoint and omitted key, sanitizes summaries, rejects a second stale client', async () => {
  const provider = addProvider({ name: 'Example', baseURL: 'https://example.test/v1?token=private' })
  setApiKey(provider.id, 'synthetic-original')
  const service = createAccountsSettingsService(host())
  const before = await service.accounts({})
  const updated = await service.patchAccount({
    providerId: provider.id,
    expectedRevision: before.revision,
    name: 'Renamed',
  })
  expect(getProvider(provider.id)?.baseURL).toBe(provider.baseURL)
  expect(getApiKey(provider.id)).toBe('synthetic-original')
  expect(updated.apiKeys[0].baseURL).toBe('https://example.test/v1')
  expect(JSON.stringify(updated)).not.toContain('private')
  expect(JSON.stringify(updated)).not.toContain('synthetic-original')
  await expect(
    service.patchAccount({ providerId: provider.id, expectedRevision: before.revision, name: 'Stale' })
  ).rejects.toMatchObject({ status: 409 })
})
it('rejects insecure writes and restores credentials after a durable metadata failure', async () => {
  const provider = addProvider({ name: 'Original', baseURL: 'https://example.test' })
  setApiKey(provider.id, 'synthetic-original')
  const service = createAccountsSettingsService(host())
  const before = await service.accounts({})
  state.secure = false
  await expect(
    service.patchAccount({ providerId: provider.id, expectedRevision: before.revision, apiKey: 'synthetic-new' })
  ).rejects.toThrow('Secure credential')
  state.secure = true
  state.fail = true
  await expect(
    service.patchAccount({
      providerId: provider.id,
      expectedRevision: before.revision,
      apiKey: 'synthetic-new',
      name: 'Lost',
    })
  ).rejects.toThrow('could not be saved')
  expect(getApiKey(provider.id)).toBe('synthetic-original')
  expect(getProvider(provider.id)?.name).toBe('Original')
  state.fail = false
  getDb().exec(
    "CREATE TRIGGER reject_provider_update BEFORE UPDATE ON app_settings WHEN NEW.key = 'chat.providers' BEGIN SELECT RAISE(ABORT, 'synthetic write failure'); END"
  )
  await expect(
    service.patchAccount({
      providerId: provider.id,
      expectedRevision: before.revision,
      apiKey: 'synthetic-new',
      name: 'Lost',
    })
  ).rejects.toThrow('could not be saved')
  expect(getApiKey(provider.id)).toBe('synthetic-original')
  expect(getProvider(provider.id)?.name).toBe('Original')
})
it('renames default labels without moving credentials and delegates revision-aware removals', async () => {
  const context = host()
  const service = createAccountsSettingsService(context)
  const id = subscriptionProviderIdFor('codex-subscription', null)
  setAppSetting('synthetic.credential.location', id)
  const before = await service.accounts({})
  const after = await service.renameSubscription({
    kind: 'codex',
    slot: null,
    label: 'Work',
    expectedRevision: before.revision,
  })
  expect(getProvider(id)?.name).toBe('Work')
  expect(getAppSetting('synthetic.credential.location')).toBe(id)
  expect(after.subscriptions.find((account) => account.kind === 'codex')?.label).toBe('Work')
  await service.removeSubscription({ kind: 'codex', slot: null, expectedRevision: after.revision })
  expect(context.removeSubscription).toHaveBeenCalledWith('codex', 'default')
  const extra = addSubscriptionAccount('codex-subscription', 'Extra')
  const current = await service.accounts({})
  await service.renameSubscription({
    kind: 'codex',
    slot: extra.id,
    label: 'Other',
    expectedRevision: current.revision,
  })
  expect(getProvider(subscriptionProviderIdFor('codex-subscription', extra.id))?.accountLabel).toBe('Other')
})
it('hide-all retains authentication and the complete editable catalog with main and compaction usage', async () => {
  const id = subscriptionProviderIdFor('codex-subscription', null)
  const context = {
    bots: () => [
      {
        id: 'bot',
        name: 'Bot',
        selection: { providerId: id, modelId: 'one' },
        compaction: { providerId: id, modelId: 'two' },
      },
    ],
    accountsChanged: vi.fn(),
  }
  const service = createModelsSettingsService(context)
  const before = await service.models({})
  const revision = before.providers.find((provider) => provider.providerId === id)!.revision
  const after = await service.setModelFilter({
    providerId: id,
    hiddenModelIds: ['one', 'two'],
    expectedRevision: revision,
  })
  expect(after.providers.find((provider) => provider.providerId === id)).toMatchObject({
    hiddenModelIds: ['one', 'two'],
    models: [
      { id: 'one', bots: [{ id: 'bot', name: 'Bot' }] },
      { id: 'two', bots: [{ id: 'bot', name: 'Bot' }] },
    ],
  })
  expect(listBotAccounts({ connectedProviderIds: new Set(), signingIn: [] }).subscriptions[0].state).toBe('connected')
  await expect(
    service.setModelFilter({ providerId: id, hiddenModelIds: [], expectedRevision: revision })
  ).rejects.toThrow('Settings changed')
  expect(getHiddenChatModelsFor(id)).toEqual(['one', 'two'])
})
it('observes local provider edits and safely persists prototype-shaped model filter keys', async () => {
  const provider = addProvider({ name: 'First', baseURL: 'https://example.test' })
  const revision = settingsRevision('accounts')
  addProvider({ name: 'Second', baseURL: 'https://second.test' })
  expect(settingsRevision('accounts')).not.toBe(revision)
  setHiddenChatModels('__proto__', ['one'])
  expect(getHiddenChatModelsFor('__proto__')).toEqual(['one'])
  renameDefaultSubscriptionAccount('codex-subscription', 'Label')
  expect(getProvider(provider.id)?.name).toBe('First')
})
