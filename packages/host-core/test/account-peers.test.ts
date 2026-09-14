import { afterEach, expect, it } from 'vitest'
import { rm } from 'node:fs/promises'
import { AccountAuthority } from '../src/accounts/authority.js'
import { AccountPeers } from '../src/accounts/peers.js'
import { HostStore } from '../src/persistence/store.js'
import type { AccountProvider } from '../src/accounts/provider.js'
import type { AuthStatus, DelegatedCredential } from '@maestrly/host-protocol'
import { directory } from './bot-helpers.js'
import { callAccountPeer, peerRequestSchema } from '../src/accounts/peer-transport.js'
import { readPrivate } from '../src/accounts/private-files.js'
import { randomUUID } from 'node:crypto'
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })
async function host() {
  const dir = await directory(), store = new HostStore(dir)
  let status: AuthStatus = { state: 'connected', provider: 'codex', method: 'device' }
  let refreshes = 0
  const provider: AccountProvider = {
    status: async () => status, startDevice: async () => status, startApiKey: async () => status, cancel: async () => status,
    logout: async () => { status = { state: 'disconnected', provider: 'codex' }; return status },
    models: async () => [{ id: 'model', displayName: 'Model', efforts: ['high'], recommended: true }],
    credential: async forced => { if (forced) refreshes++; await new Promise(resolve => setTimeout(resolve, 5)); return { type: 'chatgptAuthTokens', accessToken: 'private-short-token', chatgptAccountId: 'account' } }, close: async () => {},
  }
  const authority = new AccountAuthority({ store, directory: dir + '/accounts', provider: async () => provider })
  const peers = new AccountPeers(authority, dir + '/peers', { host: '127.0.0.1', port: 0 })
  cleanup.push(async () => { await peers.close(); await authority.close(); store.close(); await rm(dir, { recursive: true, force: true }) })
  await authority.ready(); await peers.ready()
  return { dir, store, authority, peers, refreshes: () => refreshes }
}
it('shares one account across two Hosts over pinned TLS, including refresh and active-task protection', async () => {
  const a = await host(), b = await host()
  const account = a.authority.create({ idempotencyKey: 'a', name: 'Shared' })
  await a.authority.inspect(account.id)
  const grant = await a.peers.grant({ accountId: account.id, peer: await b.peers.identity(), idempotencyKey: 'grant', expiresAt: new Date(Date.now() + 86400000).toISOString() })
  const linked = await b.peers.link({ grant, endpoint: `https://127.0.0.1:${grant.authority.port}/` })
  expect(linked).toMatchObject({ id: account.id, authorityHostId: a.store.hostId, role: 'linked', status: { state: 'connected' } })
  const tokens = await Promise.all([b.authority.credential(account.id, true), b.authority.credential(account.id, true)])
  expect((tokens[0] as Extract<DelegatedCredential, { type: 'chatgptAuthTokens' }>).accessToken).toBe('private-short-token')
  expect(a.refreshes()).toBe(1)
  expect(await b.authority.models(account.id)).toHaveLength(1)
  await b.authority.renewLease(account.id, { botId: 'remote-bot', name: 'Remote', turnId: 'remote-turn' })
  await expect(a.authority.logout(account.id)).rejects.toMatchObject({ code: 'ACCOUNT_BUSY' })
  expect(() => a.peers.revoke(grant.id)).toThrow(/tarefas/)
  await b.authority.releaseLease(account.id, 'remote-turn')
  a.peers.revoke(grant.id)
  await expect(b.authority.credential(account.id, false)).rejects.toMatchObject({ code: 'ACCOUNT_REVOKED' })
})
it('rejects an ungranted Host, wrong TLS identity, cross-host grant and account-selection fields', async () => {
  const a = await host(), b = await host(), attacker = await host()
  const account = a.authority.create({ idempotencyKey: 'a', name: 'Shared' })
  await a.authority.inspect(account.id)
  const grant = await a.peers.grant({ accountId: account.id, peer: await b.peers.identity(), idempotencyKey: 'grant', expiresAt: new Date(Date.now() + 86400000).toISOString() })
  const endpoint = `https://127.0.0.1:${grant.authority.port}/`
  await expect(attacker.peers.link({ grant, endpoint })).rejects.toMatchObject({ code: 'ACCOUNT_LINK_INVALID' })
  const keys = JSON.parse(await readPrivate(attacker.dir + '/peers/identity.json'))
  await expect(callAccountPeer({ grantId: grant.id, endpoint, certificate: grant.authority.certificate!, expiresAt: grant.expiresAt }, { hostId: b.store.hostId, privateKey: keys.privateKey }, a.store.hostId, 'credential', { forceRefresh: false })).rejects.toMatchObject({ code: 'ACCOUNT_UNAVAILABLE' })
  const foreign = await attacker.peers.identity()
  await expect(b.peers.link({ grant: { ...grant, authority: { ...grant.authority, certificate: foreign.certificate } }, endpoint })).rejects.toMatchObject({ code: 'ACCOUNT_UNAVAILABLE' })
  expect(peerRequestSchema.safeParse({ version: 1, authorityHostId: a.store.hostId, peerHostId: b.store.hostId, grantId: grant.id, timestamp: Date.now(), nonce: randomUUID(), method: 'credential', params: { forceRefresh: false, accountId: 'foreign-account' } }).success).toBe(false)
})
it('keeps linked account identity across service restart and reports authority failure without another login', async () => {
  const a = await host(), b = await host()
  const account = a.authority.create({ idempotencyKey: 'a', name: 'Shared' })
  await a.authority.inspect(account.id)
  const grant = await a.peers.grant({ accountId: account.id, peer: await b.peers.identity(), idempotencyKey: 'grant', expiresAt: new Date(Date.now() + 86400000).toISOString() })
  await b.peers.link({ grant, endpoint: `https://127.0.0.1:${grant.authority.port}/` })
  await b.peers.close(); await b.authority.close(); b.store.close()
  const store = new HostStore(b.dir)
  const authority = new AccountAuthority({ store, directory: b.dir + '/accounts' })
  const peers = new AccountPeers(authority, b.dir + '/peers')
  cleanup.push(async () => { await peers.close(); await authority.close(); store.close() })
  await authority.ready(); await peers.ready()
  expect(await authority.credential(account.id, false)).toMatchObject({ type: 'chatgptAuthTokens' })
  await a.peers.close()
  expect(await authority.inspect(account.id)).toMatchObject({ id: account.id, available: false, status: { state: 'connected' } })
  await expect(authority.credential(account.id, false)).rejects.toMatchObject({ code: 'ACCOUNT_UNAVAILABLE' })
})
