import { afterEach, expect, it } from 'vitest'
import { rm } from 'node:fs/promises'
import type { AuthStatus, DelegatedCredential, LegacyCredential } from '@maestrly/host-protocol'
import type { AccountProvider } from '../src/accounts/provider.js'
import { setup, FakeConnector, until, readyBot } from './bot-helpers.js'
const contexts: Awaited<ReturnType<typeof setup>>[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) { await ctx.service.close(); await rm(ctx.dir, { recursive: true, force: true }) } })
async function context() {
  const connector = new FakeConnector(); connector.managed = true
  let refreshes = 0
  let auth: AuthStatus = { state: 'disconnected', provider: 'codex' }
  const provider: AccountProvider = {
    status: async () => auth,
    startDevice: async () => auth,
    startApiKey: async () => { auth = { state: 'connected', provider: 'codex', method: 'apiKey' }; return auth },
    logout: async () => { auth = { state: 'disconnected', provider: 'codex' }; return auth }, cancel: async () => auth,
    models: async () => [{ id: 'fixture-small', displayName: 'Small', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium', recommended: true }, { id: 'fixture-large', displayName: 'Large', efforts: ['high'], recommended: false }],
    credential: async force => { if (force) refreshes++; return { type: 'apiKey', apiKey: 'fixture-global-secret' } },
    importCredential: async (_credential: LegacyCredential) => { auth = { state: 'connected', provider: 'codex', method: 'apiKey' } }, close: async () => {},
  }
  const ctx = await setup({ connector, accountProvider: async () => provider }); contexts.push(ctx)
  return { ...ctx, refreshes: () => refreshes }
}
async function vm(ctx: Awaited<ReturnType<typeof context>>, name: string) {
  const op = await ctx.call('vm.create', { idempotencyKey: name, name, imageId: 'image', runtimeId: 'qemu', cpus: 2, memoryMiB: 2048, diskGiB: 12 })
  await until(() => ctx.call('operation.get', { operationId: op.id }), result => result.status === 'succeeded')
  return ctx.call('vm.inspect', { vmId: op.vmId })
}
async function bot(ctx: Awaited<ReturnType<typeof context>>, vmId: string, name: string, model: string, effort: string) {
  const preview = await ctx.call('bot.setup.preview', { destination: { kind: 'shared-vm', vmId } })
  const op = await ctx.call('bot.setup.start', { idempotencyKey: name, previewId: preview.previewId, inventoryRevision: preview.inventoryRevision, name, model: { model, effort, source: 'custom' }, confirmations: { destination: true, permissions: true } })
  const result = await until(() => ctx.call('bot.setup.inspect', { operationId: op.id }), result => ['failed', 'succeeded'].includes(result.status))
  expect(result.status, JSON.stringify(result.error)).toBe('succeeded')
  expect(result.steps.some((step: any) => step.id === 'account')).toBe(false)
  return ctx.call('bot.inspect', { botId: op.botId })
}
it('creates bots in different VMs with one account, distinct model/effort and no per-bot login', async () => {
  const ctx = await context()
  const account = await ctx.call('account.create', { idempotencyKey: 'account', name: 'General' })
  await ctx.call('account.setApiKey', { accountId: account.id, apiKey: 'fixture-global-secret' })
  const [aVm, bVm] = await Promise.all([vm(ctx, 'vm-a'), vm(ctx, 'vm-b')])
  const a = await bot(ctx, aVm.id, 'A', 'fixture-small', 'low')
  const b = await bot(ctx, bVm.id, 'B', 'fixture-large', 'high')
  expect(a.accountId).toBe(account.id); expect(b.accountId).toBe(account.id)
  expect(a.model).toMatchObject({ model: 'fixture-small', effort: 'low' }); expect(b.model).toMatchObject({ model: 'fixture-large', effort: 'high' })
  const sa = await ctx.call('bot.session.inspect', { botId: a.id }), sb = await ctx.call('bot.session.inspect', { botId: b.id })
  const ga = ctx.connector.guest(a.vmId, sa.id), gb = ctx.connector.guest(b.vmId, sb.id)
  expect([...ga.requests, ...gb.requests].some(request => request.method === 'auth.start')).toBe(false)
  ga.emit({ kind: 'account.changed', summary: 'stale worker status', detail: { state: 'disconnected' } })
  expect((await ctx.call('bot.inspect', { botId: a.id })).accountState).toBe('connected')
  const turns = await Promise.all([a, b].map(bot => ctx.call('bot.messages.send', { botId: bot.id, clientMessageId: 'task', content: 'work' })))
  for (const receipt of turns) await until(() => ctx.call('bot.turn.get', { turnId: receipt.turn.id }), turn => turn.status === 'running')
  await Promise.all([ga.refreshAccount(), gb.refreshAccount()])
  expect(ctx.refreshes()).toBe(1)
  await expect(ctx.call('account.logout', { accountId: account.id })).rejects.toMatchObject({ code: 'ACCOUNT_BUSY' })
  ga.finish(turns[0].turn.id); gb.finish(turns[1].turn.id)
  for (const receipt of turns) await until(() => ctx.call('bot.turn.get', { turnId: receipt.turn.id }), turn => turn.status === 'succeeded')
  await until(() => ctx.call('account.impact', { accountId: account.id }), impact => impact.activeLeases === 0)
  await ctx.call('bot.archive', { botId: a.id, expectedRevision: (await ctx.call('bot.inspect', { botId: a.id })).revision, idempotencyKey: 'archive' })
  expect((await ctx.call('account.inspect', { accountId: account.id })).status.state).toBe('connected')
  expect((await ctx.call('bot.auth.status', { botId: b.id })).state).toBe('connected')
  await ctx.call('account.logout', { accountId: account.id })
  await expect(ctx.call('bot.messages.send', { botId: b.id, clientMessageId: 'after-logout', content: 'work' })).rejects.toMatchObject({ code: 'ACCOUNT_REQUIRED' })
  await expect(ctx.call('bot.auth.start', { botId: b.id, method: 'device' })).rejects.toMatchObject({ code: 'ACCOUNT_MANAGED' })
  const rows = JSON.stringify((ctx.service as any).store.db.prepare('SELECT body FROM bot_events').all())
  expect(rows).not.toContain('fixture-global-secret')
})
it('migrates an existing login once without changing its workspace, memory or model', async () => {
  const ctx = await context()
  const original = await readyBot(ctx, 'Existing')
  const session = await ctx.call('bot.session.inspect', { botId: original.id })
  const guest = ctx.connector.guest(original.vmId, session.id)
  guest.files.set('kept.txt', Buffer.from('kept'))
  await ctx.call('bot.memory.upsert', { botId: original.id, content: 'Keep this preference' })
  const memory = await ctx.call('bot.memory.list', { botId: original.id })
  const account = await ctx.call('account.migrate', { botId: original.id, idempotencyKey: 'migrate' })
  expect(await ctx.call('account.migrate', { botId: original.id, idempotencyKey: 'migrate' })).toMatchObject({ id: account.id })
  const migrated = await ctx.call('bot.inspect', { botId: original.id })
  expect(migrated).toMatchObject({ accountId: account.id, vmId: original.vmId, conversationId: original.conversationId, model: original.model, status: 'ready' })
  expect(await ctx.call('bot.memory.list', { botId: original.id })).toEqual(memory)
  expect(guest.files.get('kept.txt')?.toString()).toBe('kept')
  expect(guest.requests.filter(request => request.method === 'auth.exportLegacy')).toHaveLength(1)
  expect(ctx.provider.backups).toEqual([])
  expect(ctx.provider.prepared).toEqual([])
})
it('resumes a lost migration acknowledgement without exporting or importing the login again', async () => {
  const ctx = await context()
  const original = await readyBot(ctx, 'Existing')
  const session = await ctx.call('bot.session.inspect', { botId: original.id })
  const guest = ctx.connector.guest(original.vmId, session.id)
  let fail = true
  guest.handler = method => { if (method === 'auth.commitMigration' && fail) { fail = false; throw new Error('Lost response after commit') } }
  await expect(ctx.call('account.migrate', { botId: original.id, idempotencyKey: 'migrate' })).rejects.toBeDefined()
  expect(await ctx.call('bot.inspect', { botId: original.id })).toMatchObject({ status: 'needs_attention' })
  await ctx.call('account.migrate', { botId: original.id, idempotencyKey: 'migrate' })
  expect(guest.requests.filter(request => request.method === 'auth.exportLegacy')).toHaveLength(1)
  expect(await ctx.call('bot.inspect', { botId: original.id })).toMatchObject({ status: 'ready', accountId: expect.any(String) })
})

it('finishes a retained setup with a general account instead of creating another bot or VM', async () => {
  const ctx = await context()
  const preview = await ctx.call('bot.setup.preview', {})
  const op = await ctx.call('bot.setup.start', { idempotencyKey: 'old-setup', previewId: preview.previewId, inventoryRevision: preview.inventoryRevision, name: 'Retained', confirmations: { destination: true, permissions: true } })
  await until(() => ctx.call('bot.setup.inspect', { operationId: op.id }), value => value.status === 'waiting_user')
  const before = await ctx.call('vm.list')
  const retained = await ctx.call('bot.inspect', { botId: op.botId })
  const account = await ctx.call('account.create', { idempotencyKey: 'account', name: 'General' })
  await ctx.call('account.setApiKey', { accountId: account.id, apiKey: 'fixture-general-key' })
  const updated = await ctx.call('bot.update', { botId: retained.id, expectedRevision: retained.revision, accountId: account.id, model: { model: 'fixture-small', effort: 'low', source: 'custom' } })
  expect(updated).toMatchObject({ id: retained.id, vmId: retained.vmId, accountId: account.id, status: 'ready' })
  expect((await ctx.call('bot.setup.inspect', { operationId: op.id })).status).toBe('succeeded')
  expect(await ctx.call('bot.list')).toHaveLength(1)
  expect(await ctx.call('vm.list')).toEqual(before)
})
