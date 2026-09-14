import { createHash } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { rm } from 'node:fs/promises'
import { AccountAuthority } from '../src/accounts/authority.js'
import { HostStore } from '../src/persistence/store.js'
import type { AccountProvider } from '../src/accounts/provider.js'
import type { AuthStatus, DelegatedCredential, LegacyCredential } from '@maestrly/host-protocol'
import { directory } from './bot-helpers.js'

export class FakeAccountProvider implements AccountProvider {
  auth: AuthStatus = { state: 'disconnected', provider: 'codex' }
  credentials = 0
  refreshes = 0
  closed = false
  wait?: () => Promise<void>
  credentialValue: DelegatedCredential = { type: 'chatgptAuthTokens', accessToken: 'private-access-token', chatgptAccountId: 'provider-account' }
  async status() { return this.auth }
  async startDevice() { this.auth = { state: 'connecting', provider: 'codex', method: 'device', pending: { loginId: 'login', userCode: 'CODE-1234', verificationUrl: 'https://auth.openai.com/codex/device', expiresAt: new Date(Date.now() + 600000).toISOString() } }; return this.auth }
  async startApiKey(apiKey: string) { this.credentialValue = { type: 'apiKey', apiKey }; this.auth = { state: 'connected', provider: 'codex', method: 'apiKey' }; return this.auth }
  async cancel() { this.auth = { state: 'disconnected', provider: 'codex' }; return this.auth }
  async logout() { return this.cancel() }
  async models() { return [{ id: 'model-a', displayName: 'Model A', efforts: ['low' as const, 'high' as const], defaultEffort: 'low' as const, recommended: true }, { id: 'model-b', displayName: 'Model B', efforts: ['medium' as const], recommended: false }] }
  async credential(forceRefresh: boolean) { this.credentials++; if (forceRefresh) this.refreshes++; await this.wait?.(); return this.credentialValue }
  async importCredential(_credential: LegacyCredential) { this.auth = { state: 'connected', provider: 'codex', method: 'device' } }
  async close() { this.closed = true }
}
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })
async function context() {
  const dir = await directory(), store = new HostStore(dir)
  const providers = new Map<string, FakeAccountProvider>()
  const accounts = new AccountAuthority({ store, directory: dir + '/accounts', provider: async id => { let p = providers.get(id); if (!p) { p = new FakeAccountProvider(); providers.set(id, p) }; return p } })
  cleanup.push(async () => { await accounts.close(); store.close(); await rm(dir, { recursive: true, force: true }) })
  await accounts.ready()
  return { dir, store, accounts, providers }
}
it('creates an account without a bot and keeps create idempotent and metadata secret-free', async () => {
  const { accounts, store } = await context()
  const account = accounts.create({ idempotencyKey: 'create', name: 'Work' })
  expect(accounts.create({ idempotencyKey: 'create', name: 'Work' })).toEqual(account)
  expect(() => accounts.create({ idempotencyKey: 'create', name: 'Other' })).toThrow(/chave/i)
  expect(store.db.prepare('SELECT count(*) AS n FROM bots').get()!.n).toBe(0)
  expect(account.isDefault).toBe(true)
  const connected = await accounts.setApiKey(account.id, 'secret-key-that-must-not-leak')
  expect(connected.status.state).toBe('connected')
  const publicRows = JSON.stringify(store.db.prepare('SELECT body FROM shared_accounts').all())
  expect(publicRows).not.toContain('secret-key')
  expect(JSON.stringify(accounts.list())).not.toContain('secret-key')
})
it('coalesces concurrent refreshes and serializes logout behind credential work', async () => {
  const { accounts, providers } = await context()
  const account = accounts.create({ idempotencyKey: 'a', name: 'Work' })
  await accounts.setApiKey(account.id, 'secret-api-key')
  const provider = providers.get(account.id)!
  let release!: () => void
  provider.wait = () => new Promise(resolve => { release = resolve })
  const refreshes = Array.from({ length: 8 }, () => accounts.credential(account.id, true))
  while (!release) await new Promise(resolve => setTimeout(resolve, 1))
  release()
  expect(await Promise.all(refreshes)).toHaveLength(8)
  expect(provider.refreshes).toBe(1)
  provider.wait = undefined
  await accounts.logout(account.id)
  await expect(accounts.credential(account.id, false)).rejects.toMatchObject({ code: 'ACCOUNT_REQUIRED' })
})
it('blocks disconnect while another bot holds a lease and allows it after release', async () => {
  const { accounts, store } = await context()
  const account = accounts.create({ idempotencyKey: 'a', name: 'Work' })
  await accounts.setApiKey(account.id, 'private-api-key')
  const lease = { botId: 'bot-b', name: 'B', turnId: 'turn-b' }
  await accounts.renewLease(account.id, lease)
  await expect(accounts.logout(account.id)).rejects.toMatchObject({ code: 'ACCOUNT_BUSY' })
  expect(accounts.impact(account.id).bots).toContainEqual({ botId: 'bot-b', name: 'B', hostId: store.hostId, active: true })
  await accounts.releaseLease(account.id, lease.turnId)
  expect((await accounts.logout(account.id)).status.state).toBe('disconnected')
})
it('validates model and effort against the account catalogue', async () => {
  const { accounts } = await context()
  const account = accounts.create({ idempotencyKey: 'a', name: 'Work' })
  await accounts.setApiKey(account.id, 'private-api-key')
  await expect(accounts.validateModel(account.id, { model: 'model-a', effort: 'high', source: 'custom' })).resolves.toMatchObject({ model: 'model-a', effort: 'high' })
  await expect(accounts.validateModel(account.id, { model: 'model-a', effort: 'medium', source: 'custom' })).rejects.toMatchObject({ code: 'MODEL_UNAVAILABLE' })
  await expect(accounts.validateModel(account.id, { model: 'invented', source: 'custom' })).rejects.toMatchObject({ code: 'MODEL_UNAVAILABLE' })
})
it('keeps the shared account when an unrelated bot is archived and preserves default selection', async () => {
  const { accounts } = await context()
  const a = accounts.create({ idempotencyKey: 'a', name: 'A' })
  const b = accounts.create({ idempotencyKey: 'b', name: 'B' })
  accounts.setDefault(b.id)
  expect(accounts.list().filter(account => account.isDefault).map(account => account.id)).toEqual([b.id])
  await accounts.setApiKey(a.id, 'private-key-a')
  expect(accounts.list().find(account => account.id === a.id)?.status.state).toBe('connected')
})

it('does not rotate again when a later worker reports an already replaced token', async () => {
  const { accounts, providers } = await context()
  const account = accounts.create({ idempotencyKey: 'a', name: 'Shared' })
  await accounts.setApiKey(account.id, 'old-credential')
  const provider = providers.get(account.id)!
  provider.credential = async forced => {
    if (forced) { provider.refreshes++; provider.credentialValue = { type: 'apiKey', apiKey: 'rotated-credential' } }
    return provider.credentialValue
  }
  const hash = createHash('sha256').update('old-credential').digest('hex')
  expect(await accounts.credential(account.id, true, hash)).toEqual({ type: 'apiKey', apiKey: 'rotated-credential' })
  const time = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3000)
  try { expect(await accounts.credential(account.id, true, hash)).toEqual({ type: 'apiKey', apiKey: 'rotated-credential' }); expect(provider.refreshes).toBe(1) }
  finally { time.mockRestore() }
})
