import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import type { SharedAccount, AccountPeerIdentity, AccountGrant } from '@maestrly/host-protocol'
import type { HostTarget } from '../src/shared/types'
import { GlobalAccounts } from '../src/main/global-accounts'
import { validateBotCall } from '../src/main/validation'
const dirs: string[] = []
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }) })
async function context() {
  const dir = await mkdtemp(join(tmpdir(), 'bot-global-accounts-')); dirs.push(dir)
  const a: HostTarget = { kind: 'ssh', id: 'ssh:a', alias: 'a', displayName: 'A', hostId: randomUUID() }
  const b: HostTarget = { kind: 'ssh', id: 'ssh:b', alias: 'b', displayName: 'B', hostId: randomUUID() }
  const time = new Date().toISOString()
  const account: SharedAccount = { id: randomUUID(), authorityHostId: a.hostId!, name: 'General', provider: 'codex', role: 'authority', status: { state: 'connected', provider: 'codex', method: 'device' }, available: true, isDefault: true, revision: 0, createdAt: time, updatedAt: time }
  const accounts = new Map<string, SharedAccount[]>([[a.id, [account]], [b.id, []]])
  const calls: { target: string; method: string; params: Record<string, unknown> }[] = []
  let failOwner = false
  const global = new GlobalAccounts(join(dir, 'accounts.json'), {
    targets: async () => [a, b], endpoint: async owner => `https://${owner.id.slice(4)}.test:44953/`,
    request: async (target, method, params) => {
      calls.push({ target: target.id, method, params })
      if (failOwner && target.id === a.id) throw new Error('unavailable')
      const list = accounts.get(target.id)!
      if (method === 'account.list') return list
      if (method === 'account.inspect') return list.find(account => account.id === params.accountId)!
      if (method === 'account.peer.identity') return { hostId: target.hostId, publicKey: 'p'.repeat(80) }
      if (method === 'account.peer.grant') return { id: randomUUID(), account, authority: { hostId: a.hostId, publicKey: 'p'.repeat(80), certificate: 'c'.repeat(200), port: 44953 }, peerHostId: (params.peer as AccountPeerIdentity).hostId, expiresAt: params.expiresAt }
      if (method === 'account.peer.link') { const linked = { ...(params.grant as AccountGrant).account, role: 'linked' as const, isDefault: false }; accounts.set(target.id, [...list, linked]); return linked }
      if (method === 'account.default') { list.forEach(account => { account.isDefault = account.id === params.accountId }); return list.find(account => account.isDefault)! }
      if (method === 'account.setApiKey') return { ...account, status: { state: 'connected', provider: 'codex', method: 'apiKey' } }
      throw new Error('Unexpected account request: ' + method)
    },
  })
  return { global, a, b, account, accounts, calls, file: join(dir, 'accounts.json'), failOwner: () => { failOwner = true } }
}
it('shares the same account with another registered Host without repeating login', async () => {
  const ctx = await context()
  await ctx.global.discover(ctx.a)
  await Promise.all([ctx.global.ensure(ctx.account.id, ctx.b), ctx.global.ensure(ctx.account.id, ctx.b)])
  expect(ctx.calls.filter(call => call.method === 'account.peer.grant')).toHaveLength(1)
  expect(ctx.calls.find(call => call.method === 'account.peer.link')?.params.endpoint).toBe('https://a.test:44953/')
  expect(ctx.accounts.get(ctx.b.id)?.[0]).toMatchObject({ id: ctx.account.id, role: 'linked', isDefault: true })
  expect(ctx.calls.some(call => call.method === 'account.start')).toBe(false)
  await ctx.global.ensure(ctx.account.id, ctx.b)
  expect(ctx.calls.filter(call => call.method === 'account.peer.grant')).toHaveLength(1)
})
it('routes account management to its owner and keeps secrets out of the public directory', async () => {
  const ctx = await context()
  await ctx.global.discover(ctx.a)
  await ctx.global.call({ method: 'account.setApiKey', params: { accountId: ctx.account.id, apiKey: 'secret-never-persisted' } }, ctx.b)
  expect(ctx.calls.find(call => call.method === 'account.setApiKey')?.target).toBe(ctx.a.id)
  expect(await readFile(ctx.file, 'utf8')).not.toContain('secret-never-persisted')
  ctx.failOwner()
  expect(await ctx.global.call({ method: 'account.inspect', params: { accountId: ctx.account.id } }, ctx.b)).toMatchObject({ id: ctx.account.id, available: false })
  expect(() => validateBotCall({ method: 'account.peer.link', params: {} })).toThrow('internal')
})
