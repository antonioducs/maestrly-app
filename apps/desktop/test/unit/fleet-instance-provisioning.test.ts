import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { freshDb, closeDb } from '../helpers/db'
import { listProviders, listSubscriptionAccounts, subscriptionProviderIdFor } from '../../src/main/chat/catalog'
import { getAppSetting } from '../../src/main/store'
import { getApiKey } from '../../src/main/chat/credentials'
import {
  importBotAccounts,
  listBotAccounts,
  removeBotSubscription,
} from '../../src/main/fleet/instance/provisioning/accounts'
import { installBotSkill, listBotSkills, removeBotSkill } from '../../src/main/fleet/instance/provisioning/skills'
import {
  importBotMcpServers,
  listBotMcpServers,
  removeBotMcpServer,
} from '../../src/main/fleet/instance/provisioning/mcp'
import { BotRuntime } from '../../src/main/fleet/instance/runtime'
import { EnvironmentRuntime } from '../../src/main/fleet/instance/environment'

const state = vi.hoisted(() => ({
  secure: true,
  writable: true,
  secrets: new Map<string, string>(),
  tokens: new Map<string | null, string>(),
  cursors: new Map<string | null, { apiKey: string; expiresAtMs: number | null }>(),
  logout: vi.fn(),
  cleanup: vi.fn(),
  admitCursor: vi.fn(),
}))
vi.mock('../../src/main/secure-store', () => ({
  secureStorageMode: () => (state.secure ? 'secure' : 'unavailable'),
  isSecureStorageAvailable: () => state.secure,
  secureGet: (key: string) => state.secrets.get(key) ?? null,
  secureSet: (key: string, value: string) => {
    if (!state.secure || !state.writable) return false
    state.secrets.set(key, value)
    return true
  },
  secureRemove: (key: string) => state.secrets.delete(key),
}))
vi.mock('../../src/main/chat/github-copilot/manager', () => ({
  getGitHubCopilotSubscriptionManager: (id: string | null = null) => ({
    exportToken: () => state.tokens.get(id) ?? null,
    admitToken: async (token: string, options?: { requireSecure?: boolean }) => {
      if (options?.requireSecure && !state.writable) throw new Error('Secure credential storage is unavailable.')
      if (token.startsWith('refused')) throw new Error('Refused token ' + token)
      state.tokens.set(id, token)
      return { authenticated: true }
    },
    peekStatus: () => null,
    logout: state.logout,
  }),
}))
vi.mock('../../src/main/chat/cursor-subscription/manager', () => ({
  getCursorSubscriptionManager: (id: string | null = null) => ({
    exportCredential: () => state.cursors.get(id) ?? null,
    admitApiKey: async (apiKey: string, options: { expiresAtMs: number | null; requireSecure?: boolean }) => {
      if (options.requireSecure && !state.writable) throw new Error('Secure credential storage is unavailable.')
      state.admitCursor(apiKey, options)
      state.cursors.set(id, { apiKey, ...options })
      return { authenticated: true }
    },
    peekStatus: () => null,
    logout: state.logout,
  }),
}))
vi.mock('../../src/main/chat/service', () => ({
  removeSubscriptionAccountSlot: async (id: string) => {
    state.cleanup(id)
    const { removeSubscriptionAccount } = await import('../../src/main/chat/catalog')
    removeSubscriptionAccount(id)
    return { ok: true }
  },
}))
vi.mock('../../src/main/chat/provider', () => ({ invalidateProvider: vi.fn() }))
vi.mock('../../src/main/chat/models', () => ({ invalidateModels: vi.fn() }))
let home = ''
beforeEach(async () => {
  freshDb()
  state.secure = true
  state.writable = true
  state.secrets.clear()
  state.tokens.clear()
  state.cursors.clear()
  vi.clearAllMocks()
  home = await mkdtemp(path.join(os.tmpdir(), 'fleet-provisioning-'))
  vi.spyOn(os, 'homedir').mockReturnValue(home)
})
afterEach(async () => {
  vi.restoreAllMocks()
  closeDb()
  await rm(home, { recursive: true, force: true })
})
const api = {
  type: 'api-key' as const,
  kind: 'openai' as const,
  name: 'Synthetic',
  key: 'synthetic-key-one',
  baseURL: 'https://example.test/v1',
}
const outcome = async (item: Parameters<typeof importBotAccounts>[0][number]) =>
  (await importBotAccounts([item])).results[0]
it('upserts API keys by kind, normalized URL, key and name, refreshing only mutations', async () => {
  const runtime = Object.create(EnvironmentRuntime.prototype) as EnvironmentRuntime
  const changed = vi.fn()
  Object.assign(runtime, { accountsChanged: changed })
  const first = (await runtime.importAccounts({ items: [api] })).results[0]
  expect(first.outcome).toBe('added')
  expect(changed).toHaveBeenCalledTimes(1)
  expect((await runtime.importAccounts({ items: [{ ...api, baseURL: api.baseURL + '/' }] })).results[0].outcome).toBe(
    'unchanged'
  )
  expect(changed).toHaveBeenCalledTimes(1)
  expect((await runtime.importAccounts({ items: [{ ...api, key: 'synthetic-key-two' }] })).results[0].outcome).toBe(
    'updated'
  )
  expect(getApiKey(first.target!)).toBe('synthetic-key-two')
  expect(changed).toHaveBeenCalledTimes(2)
  expect((await outcome({ ...api, name: 'Another' })).outcome).toBe('added')
  state.secure = false
  const before = listProviders().length
  expect((await runtime.importAccounts({ items: [api] })).results[0]).toMatchObject({
    outcome: 'failed',
    error: 'Secure credential storage is unavailable.',
  })
  expect(changed).toHaveBeenCalledTimes(2)
  expect(listProviders()).toHaveLength(before)
})
it('rolls back a new provider when storage stops accepting writes', async () => {
  state.writable = false
  const before = listProviders().length
  expect((await outcome(api)).outcome).toBe('failed')
  expect(listProviders()).toHaveLength(before)
})
it('uses the default Copilot slot, adds extras, deduplicates and cleans refused slots without leaking tokens', async () => {
  const item = { type: 'github-copilot' as const, label: 'Synthetic', token: 'synthetic-token-one' }
  expect(await outcome(item)).toMatchObject({ target: 'github-copilot:default', outcome: 'added' })
  expect((await outcome(item)).outcome).toBe('unchanged')
  expect((await outcome({ ...item, token: 'synthetic-token-two' })).target).toMatch(/^github-copilot:acc_/)
  const failed = await outcome({ ...item, token: 'refused-private-token' })
  expect(failed.outcome).toBe('failed')
  expect(JSON.stringify(failed)).not.toContain('refused-private-token')
  expect(state.cleanup).toHaveBeenCalledOnce()
  expect(listSubscriptionAccounts()).toHaveLength(1)
})
it('passes Cursor expiry and deduplicates the full credential', async () => {
  const item = {
    type: 'cursor' as const,
    label: 'Synthetic',
    apiKey: 'synthetic-cursor-key',
    expiresAt: '2027-01-01T00:00:00.000Z',
  }
  expect((await outcome(item)).outcome).toBe('added')
  expect(state.admitCursor).toHaveBeenCalledWith(item.apiKey, {
    expiresAtMs: Date.parse(item.expiresAt),
    requireSecure: true,
  })
  expect((await outcome(item)).outcome).toBe('unchanged')
})
it('lists hints and cached subscription identities without returning secrets', async () => {
  await outcome(api)
  const accounts = listBotAccounts({
    connectedProviderIds: new Set([subscriptionProviderIdFor('codex-subscription', null)]),
    signingIn: [{ kind: 'claude', accountId: null }],
  })
  expect(accounts.apiKeys[0].keyHint).toBe('-one')
  expect(JSON.stringify(accounts)).not.toContain(api.key)
  expect(accounts.subscriptions).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: 'codex', state: 'connected' }),
      expect.objectContaining({ kind: 'claude', state: 'signing-in' }),
    ])
  )
})
it('rejects unknown or wrong-kind slots and logs out the default slot', async () => {
  await expect(removeBotSubscription('codex', 'acc_missing')).rejects.toMatchObject({ status: 404 })
  await outcome({ type: 'github-copilot', label: 'One', token: 'one' })
  const extra = await outcome({ type: 'github-copilot', label: 'Two', token: 'two' })
  const id = extra.target!.split(':')[1]
  await expect(removeBotSubscription('cursor', id)).rejects.toMatchObject({ status: 404 })
  await removeBotSubscription('github-copilot', id)
  expect(listSubscriptionAccounts()).toHaveLength(0)
  await removeBotSubscription('cursor', 'default')
  expect(state.logout).toHaveBeenCalledOnce()
})
const skill = (name = 'sample') => ({
  name: 'sample',
  files: [
    {
      path: 'SKILL.md',
      executable: false,
      data: Buffer.from('---\nname: ' + name + '\n---\nSynthetic instructions.').toString('base64'),
    },
  ],
})
it('installs, deduplicates, lists fleet provenance and removes only existing global skills', async () => {
  expect(await installBotSkill(skill())).toEqual({ name: 'sample', outcome: 'added' })
  expect(await installBotSkill(skill())).toEqual({ name: 'sample', outcome: 'unchanged' })
  expect((await listBotSkills()).skills).toEqual([
    expect.objectContaining({ name: 'sample', files: 1, source: 'fleet' }),
  ])
  await removeBotSkill('sample')
  expect((await listBotSkills()).skills).toEqual([])
  await expect(removeBotSkill('sample')).rejects.toMatchObject({ status: 404 })
})
it('rejects traversal and mismatched manifest names', async () => {
  await expect(
    installBotSkill({ ...skill(), files: [...skill().files, { path: '../x', data: '', executable: false }] })
  ).rejects.toMatchObject({ status: 400 })
  await expect(installBotSkill(skill('other'))).rejects.toMatchObject({
    status: 400,
    message: 'The skill name does not match SKILL.md.',
  })
})
it('upserts MCP servers and projects names instead of secret values', () => {
  const server = {
    name: 'Echo',
    transport: 'stdio' as const,
    enabled: true,
    command: 'node',
    args: ['s.mjs'],
    env: { K: 'private-env-value' },
  }
  const first = importBotMcpServers([server]).results[0]
  expect(first.outcome).toBe('added')
  expect(importBotMcpServers([{ ...server, name: 'echo' }]).results[0].outcome).toBe('unchanged')
  expect(importBotMcpServers([{ ...server, args: ['changed.mjs'] }]).results[0].outcome).toBe('updated')
  expect(listBotMcpServers().servers[0]).toMatchObject({ envKeys: ['K'], command: 'node', host: null })
  expect(JSON.stringify(listBotMcpServers())).not.toContain('private-env-value')
  removeBotMcpServer(first.target!)
  expect(() => removeBotMcpServer(first.target!)).toThrow('does not exist')
})

it('advertises provisioning in runtime status', async () => {
  const runtime = Object.create(BotRuntime.prototype) as BotRuntime
  Object.assign(runtime, {
    refreshAccounts: async () => {},
    pending: () => [],
    queue: { list: () => [] },
    holdManager: { state: { state: 'none', reason: null, since: null, interruptedTurn: false } },
    events: { lastSeq: 0 },
    accountOptions: [],
    stored: null,
    compactionProblem: 'missing',
    turning: false,
    cancelling: false,
    ready: true,
    usage: null,
  })
  expect((await runtime.status()).capabilities).toEqual(['provisioning'])
})

it.each(['   ', ''])(
  'rejects empty key %j without changing an existing provider and trims matching keys',
  async (key) => {
    const first = await outcome(api)
    expect(await outcome({ ...api, key })).toMatchObject({ outcome: 'failed', error: 'The API key is empty.' })
    expect(getApiKey(first.target!)).toBe(api.key)
    expect((await outcome({ ...api, key: '  ' + api.key + '  ' })).outcome).toBe('unchanged')
  }
)
it.each(['abcd', '12345678901', '123456789012'])('limits the hint for key %s', async (key) => {
  await outcome({ ...api, key })
  expect(listBotAccounts({ connectedProviderIds: new Set(), signingIn: [] }).apiKeys[0].keyHint).toBe(
    key.length < 12 ? null : key.slice(-4)
  )
})
it('refuses MCP details when encryption fails without changing raw settings', () => {
  const before = getAppSetting('chat.mcpServers')
  state.writable = false
  expect(
    importBotMcpServers([
      {
        name: 'Synthetic',
        transport: 'http',
        enabled: true,
        url: 'https://example.test',
        headers: { Authorization: 'synthetic-secret' },
      },
    ]).results[0]
  ).toMatchObject({ outcome: 'failed', error: 'Secure credential storage is unavailable.' })
  expect(getAppSetting('chat.mcpServers')).toBe(before)
  expect(getAppSetting('chat.mcpServers') ?? '').not.toContain('synthetic-secret')
})
it.each(['github-copilot', 'cursor'] as const)('cleans the new %s slot when secure admission fails', async (type) => {
  state.tokens.set(null, 'existing')
  state.cursors.set(null, { apiKey: 'existing', expiresAtMs: null })
  state.writable = false
  const item =
    type === 'github-copilot'
      ? { type, label: 'Synthetic', token: 'new-token' }
      : { type, label: 'Synthetic', apiKey: 'new-key', expiresAt: null }
  expect(await outcome(item)).toMatchObject({ outcome: 'failed', error: 'Secure credential storage is unavailable.' })
  expect(state.cleanup).toHaveBeenCalledOnce()
  expect(listSubscriptionAccounts()).toHaveLength(0)
})

it.each([
  'https://example.test/v1?token=synthetic-url-secret#private',
  'https://synthetic-user:synthetic-password@example.test/v1',
])('projects only origin and pathname for account URL %s', async (baseURL) => {
  await outcome({ ...api, baseURL })
  const accounts = listBotAccounts({ connectedProviderIds: new Set(), signingIn: [] })
  expect(accounts.apiKeys[0].baseURL).toBe('https://example.test/v1')
  expect(listProviders().find((provider) => provider.id === accounts.apiKeys[0].providerId)?.baseURL).toBe(baseURL)
})
