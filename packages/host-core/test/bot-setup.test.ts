import { afterEach, describe, expect, it, vi } from 'vitest'
import { rm } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { HostService } from '../src/index.js'
import { recommendNewVm, assessExistingVm } from '../src/bots/recommendations.js'
import { FakeConnector, FakeProvider, readyBot, setup, template, until } from './bot-helpers.js'
const skipWindows = process.platform === 'win32'
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn()
})
async function context(options?: Parameters<typeof setup>[0]) {
  const ctx = await setup(options)
  cleanups.push(async () => {
    await ctx.service.close()
    await rm(ctx.dir, { recursive: true, force: true })
  })
  return ctx
}
describe('recommendations', () => {
  it('clamps recommended resources to remaining quota but never below the minimum', () => {
    const host = { capacity: { cpus: 4, memoryMiB: 8192, diskGiB: 40 }, allocated: { cpus: 2, memoryMiB: 2048, diskGiB: 12 } }
    const rec = recommendNewVm(template, host)
    expect(rec.resources).toEqual({ cpus: 2, memoryMiB: 4096, diskGiB: 24 })
    expect(rec.blockers).toEqual([])
    const full = recommendNewVm(template, { ...host, allocated: { cpus: 4, memoryMiB: 4096, diskGiB: 24 } })
    expect(full.resources.cpus).toBe(2)
    expect(full.blockers[0]).toMatchObject({ code: 'CAPACITY_APPROVAL_REQUIRED' })
    expect(full.blockers[0].alternatives.length).toBeGreaterThan(0)
    expect(() => recommendNewVm(template, host, { cpus: 1, memoryMiB: 512, diskGiB: 2 })).toThrow()
  })
  it('assesses an existing VM against the minimum and binding', () => {
    const vm: any = { id: 'v', cpus: 2, memoryMiB: 2048, diskGiB: 12, state: 'running' }
    expect(assessExistingVm(template, vm, false)).toEqual([])
    expect(assessExistingVm(template, { ...vm, memoryMiB: 1024 }, false)[0].code).toBe('CAPACITY_APPROVAL_REQUIRED')
    expect(assessExistingVm(template, vm, true).length).toBe(1)
  })
})
describe.skipIf(skipWindows)('guided bot setup', () => {
  it('reuses a prepared VM without inspecting installation assets or runtime binaries', async () => {
    const connector = new FakeConnector(); connector.managed = true
    const ctx = await context({ connector })
    const a = await readyBot(ctx, 'A')
    const inspect = vi.spyOn(ctx.provider, 'inspectRuntime')
    const images = vi.spyOn(ctx.service as any, 'listImages')
    const started = performance.now()
    const preview = await ctx.call('bot.setup.preview', { destination: { kind: 'shared-vm', vmId: a.vmId } })
    const params = { idempotencyKey: 'direct-B', previewId: preview.previewId, inventoryRevision: preview.inventoryRevision, name: 'B', confirmations: { destination: true, permissions: true } }
    const op = await ctx.call('bot.setup.start', params)
    const durationMs = performance.now() - started
    console.info('prepared VM admission', JSON.stringify({ durationMs, runtimeChecks: inspect.mock.calls.length, imageChecks: images.mock.calls.length }))
    expect(inspect).not.toHaveBeenCalled()
    expect(images).not.toHaveBeenCalled()
    expect(await ctx.call('bot.setup.start', params)).toMatchObject({ id: op.id })
    await until(() => ctx.call('bot.setup.inspect', { operationId: op.id }), (o: any) => o.status === 'waiting_user')
    expect(ctx.provider.prepared).toEqual([])
  })
  it('reserves the last prepared slot once under concurrent creation and rejects a stale inventory', async () => {
    const connector = new FakeConnector(); connector.managed = true
    const ctx = await context({ connector })
    const a = await readyBot(ctx, 'A')
    const preview = await ctx.call('bot.setup.preview', { destination: { kind: 'shared-vm', vmId: a.vmId } })
    const params = { previewId: preview.previewId, inventoryRevision: preview.inventoryRevision, name: 'B', confirmations: { destination: true, permissions: true } }
    const results = await Promise.allSettled(['slot-B', 'slot-C'].map(idempotencyKey => ctx.call('bot.setup.start', { ...params, idempotencyKey })))
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.find(r => r.status === 'rejected')).toMatchObject({ reason: { code: 'PREVIEW_STALE' } })
    expect(await ctx.call('bot.list')).toHaveLength(2)
    await expect(ctx.call('bot.setup.start', { ...params, idempotencyKey: 'stale-D' })).rejects.toMatchObject({ code: 'PREVIEW_STALE' })
    const op = (results.find(r => r.status === 'fulfilled') as PromiseFulfilledResult<any>).value
    await until(() => ctx.call('bot.setup.inspect', { operationId: op.id }), (o: any) => o.status === 'waiting_user')
  })
  it('refuses an unavailable guest after preview without creating a bot', async () => {
    const connector = new FakeConnector(); connector.managed = true
    const ctx = await context({ connector })
    const a = await readyBot(ctx, 'A')
    const preview = await ctx.call('bot.setup.preview', { destination: { kind: 'shared-vm', vmId: a.vmId } })
    vi.spyOn(connector, 'inspectVm').mockRejectedValue(new Error('disconnected'))
    await expect(ctx.call('bot.setup.start', { idempotencyKey: 'offline-B', previewId: preview.previewId, inventoryRevision: preview.inventoryRevision, name: 'B', confirmations: { destination: true, permissions: true } })).rejects.toMatchObject({ code: 'ENVIRONMENT_UNAVAILABLE' })
    expect(await ctx.call('bot.list')).toHaveLength(1)
  })
  async function failedPreparation(message = "Monitor rejected command: invalid file open mode 'wx'") {
    const provider = new FakeProvider()
    const prepare = provider.prepareGuestRuntime.bind(provider)
    provider.prepareGuestRuntime = async () => { throw new Error(message) }
    const ctx = await context({ provider })
    await ctx.call('vm.create', { name: 'existing', imageId: 'image', runtimeId: 'qemu', cpus: 2, memoryMiB: 2048, diskGiB: 12, idempotencyKey: 'vm' })
    const vm = (await until(() => ctx.call('vm.list'), (v: any[]) => v[0]?.state === 'running'))[0]
    const preview = await ctx.call('bot.setup.preview', { destination: { kind: 'existing-vm', vmId: vm.id } })
    const start = { idempotencyKey: 'failed-setup', previewId: preview.previewId, inventoryRevision: preview.inventoryRevision, name: 'Real setup retry', confirmations: { destination: true, permissions: true, prepareExisting: true, restartExisting: true } }
    const operation = await ctx.call('bot.setup.start', start)
    const failed = await until(() => ctx.call('bot.setup.inspect', { operationId: operation.id }), (o: any) => o.status === 'failed')
    provider.prepareGuestRuntime = prepare
    return { ...ctx, failed, vm, start, retry: { botId: operation.botId, idempotencyKey: 'retry', confirmBackup: true, confirmRestart: true } }
  }
  it('retries the proven pre-transfer QGA failure on the same bot and VM, retaining the failed operation and backup evidence', async () => {
    const ctx = await failedPreparation()
    const before = await ctx.call('bot.inspect', { botId: ctx.failed.botId })
    expect(before.status).toBe('needs_attention')
    expect(ctx.provider.backups).toHaveLength(1)
    const operation = await ctx.call('bot.runtime.prepare', ctx.retry)
    expect(operation.id).not.toBe(ctx.failed.id)
    expect(operation.botId).toBe(ctx.failed.botId)
    expect(await ctx.call('bot.runtime.prepare', ctx.retry)).toMatchObject({ id: operation.id })
    await expect(ctx.call('bot.runtime.prepare', { ...ctx.retry, idempotencyKey: 'parallel-retry' })).rejects.toMatchObject({ code: 'INVALID_STATE' })
    await until(() => ctx.call('bot.setup.inspect', { operationId: operation.id }), (o: any) => o.status === 'waiting_user')
    expect(await ctx.call('bot.setup.start', ctx.start)).toEqual(ctx.failed)
    expect(await ctx.call('bot.operation.get', { operationId: ctx.failed.id })).toEqual(ctx.failed)
    expect(await ctx.call('bot.operation.lookup', { idempotencyKey: 'retry' })).toMatchObject({ id: operation.id })
    expect(ctx.provider.backups).toEqual([ctx.vm.id, ctx.vm.id])
    expect(ctx.provider.prepared).toEqual([ctx.vm.id])
    expect(ctx.provider.calls.filter((c) => c === 'provision')).toHaveLength(1)
    expect(await ctx.call('vm.list')).toHaveLength(1)
    const events = await ctx.call('bot.events.list', { botId: ctx.failed.botId })
    expect(events.events.filter((e: any) => e.detail?.backup)).toHaveLength(2)
    const bot = await ctx.call('bot.inspect', { botId: ctx.failed.botId })
    expect(bot).toMatchObject({ vmId: ctx.vm.id, setupOperationId: operation.id, runtimeState: 'ready' })
    ctx.connector.guest(bot.vmId).auth = { state: 'connected', provider: 'codex', method: 'device' }
    await ctx.call('bot.auth.status', { botId: bot.id })
    expect((await ctx.call('bot.setup.inspect', { operationId: operation.id })).status).toBe('succeeded')
    expect((await ctx.call('bot.inspect', { botId: bot.id })).status).toBe('ready')
  })
  it('requires explicit retry confirmations and detects cross-method or changed-bot idempotency keys', async () => {
    const ctx = await failedPreparation()
    await expect(ctx.call('bot.runtime.prepare', { ...ctx.retry, confirmBackup: false })).rejects.toBeDefined()
    await expect(ctx.call('bot.runtime.prepare', { ...ctx.retry, confirmRestart: false })).rejects.toBeDefined()
    await expect(ctx.call('bot.runtime.prepare', { ...ctx.retry, idempotencyKey: ctx.start.idempotencyKey })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
    const operation = await ctx.call('bot.runtime.prepare', ctx.retry)
    await expect(ctx.call('bot.runtime.prepare', { ...ctx.retry, botId: 'different-bot' })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
    await until(() => ctx.call('bot.setup.inspect', { operationId: operation.id }), (o: any) => o.status === 'waiting_user')
  })
  it.each(['QGA disconnected', 'Guest step /bin/sh timed out', 'Guest installer marker mismatch', "invalid file open mode 'wb'"])(
    'refuses ambiguous preparation failure: %s', async (message) => {
      const ctx = await failedPreparation(message)
      const calls = [...ctx.provider.calls]
      await expect(ctx.call('bot.runtime.prepare', ctx.retry)).rejects.toMatchObject({ code: 'RUNTIME_RETRY_UNSAFE' })
      expect(ctx.provider.calls).toEqual(calls)
      expect(ctx.provider.backups).toHaveLength(1)
      expect(ctx.provider.prepared).toEqual([])
      expect(await ctx.call('bot.operation.get', { operationId: ctx.failed.id })).toEqual(ctx.failed)
    }
  )
  it('recognizes the retained pre-transfer failure after a Host restart', async () => {
    const ctx = await failedPreparation()
    await ctx.service.close()
    const reopened = await context({ dir: ctx.dir, provider: ctx.provider, connector: ctx.connector })
    const operation = await reopened.call('bot.runtime.prepare', ctx.retry)
    await until(() => reopened.call('bot.setup.inspect', { operationId: operation.id }), (o: any) => o.status === 'waiting_user')
    expect(await reopened.call('bot.operation.get', { operationId: ctx.failed.id })).toEqual(ctx.failed)
    expect(ctx.provider.prepared).toEqual([ctx.vm.id])
    expect(await reopened.call('vm.list')).toHaveLength(1)
  })
  it('does not replay an uncertain runtime step when recovering after a crash', async () => {
    const ctx = await failedPreparation()
    await ctx.service.close()
    // Model the durable state at crash: runtime admission saved, result unknown.
    const db = new DatabaseSync(join(ctx.dir, 'host.sqlite'))
    try {
      const interrupted = { ...ctx.failed, status: 'running', error: undefined,
        steps: ctx.failed.steps.map((step: any) => step.id === 'runtime' ? { ...step, status: 'running', error: undefined } : step) }
      db.prepare('UPDATE bot_operations SET body=? WHERE id=?').run(JSON.stringify(interrupted), ctx.failed.id)
    } finally {
      db.close()
    }
    const reopened = await context({ dir: ctx.dir, provider: ctx.provider, connector: ctx.connector })
    const recovered = await until(() => reopened.call('bot.setup.inspect', { operationId: ctx.failed.id }), (o: any) => o.status === 'failed')
    expect(recovered.error.code).toBe('RUNTIME_RETRY_UNSAFE')
    await expect(reopened.call('bot.runtime.prepare', ctx.retry)).rejects.toMatchObject({ code: 'RUNTIME_RETRY_UNSAFE' })
    expect(ctx.provider.backups).toHaveLength(1)
    expect(ctx.provider.prepared).toEqual([])
  })
  it('previews a recommended profile without allocating and blocks when quota is exhausted', async () => {
    const ctx = await context()
    const preview = await ctx.call('bot.setup.preview', {})
    expect(preview.feasible).toBe(true)
    expect(preview.profile.source).toBe('recommended')
    expect(preview.profile.resources).toEqual({ cpus: 2, memoryMiB: 4096, diskGiB: 24 })
    expect(preview.network).toEqual({ mode: 'blocklist', domains: [] })
    expect(preview.permissions.mode).toBe('ask')
    expect(await ctx.call('vm.list')).toEqual([])
    const host = await ctx.call('host.inspect')
    expect(host.capabilities).toContain('bot.runtime.v1')
    const tight = await context({ capacity: { cpus: 1, memoryMiB: 1024, diskGiB: 4 } })
    const blocked = await tight.call('bot.setup.preview', {})
    expect(blocked.feasible).toBe(false)
    expect(blocked.blockers[0].code).toBe('CAPACITY_APPROVAL_REQUIRED')
    await expect(
      tight.call('bot.setup.start', { idempotencyKey: 'k', previewId: blocked.previewId, inventoryRevision: blocked.inventoryRevision, name: 'x', confirmations: { destination: true, permissions: true } })
    ).rejects.toMatchObject({ code: 'CAPACITY_APPROVAL_REQUIRED' })
  })
  it('creates the VM once, resumes across restarts and finishes when the account connects', async () => {
    const ctx = await context()
    const preview = await ctx.call('bot.setup.preview', {})
    const params = { idempotencyKey: 'setup-1', previewId: preview.previewId, inventoryRevision: preview.inventoryRevision, name: 'Ana', purpose: 'Relatórios', confirmations: { destination: true, permissions: true } }
    const op = await ctx.call('bot.setup.start', params)
    expect(await ctx.call('bot.setup.start', params)).toMatchObject({ id: op.id })
    await expect(ctx.call('bot.setup.start', { ...params, name: 'Outro' })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
    const waiting = await until(() => ctx.call('bot.setup.inspect', { operationId: op.id }), (o: any) => o.status === 'waiting_user')
    expect(waiting.steps.map((s: any) => [s.id, s.status])).toEqual([
      ['computer', 'succeeded'], ['runtime', 'succeeded'], ['bot', 'succeeded'], ['account', 'waiting_user'], ['finish', 'pending'],
    ])
    const vms = await ctx.call('vm.list')
    expect(vms).toHaveLength(1)
    expect(vms[0].startupPolicy).toBe('always')
    expect(ctx.provider.profiles.get(vms[0].id)).toMatchObject({ botChannels: { control: expect.stringContaining('control') } })
    let bot = await ctx.call('bot.inspect', { botId: op.botId })
    expect(bot.status).toBe('setup')
    expect(bot.vmId).toBe(vms[0].id)
    expect(bot.runtimeState).toBe('ready')
    // Restart the Host: nothing is re-created; the operation stays waiting for the person.
    await ctx.service.close()
    const reopened = new HostService(ctx.serviceOptions)
    cleanups.push(() => reopened.close())
    const call = async (method: string, params: unknown = {}) => {
      const r = await reopened.dispatch({ version: 1, id: 'x', method, params })
      if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code })
      return r.result as any
    }
    await until(() => call('bot.setup.inspect', { operationId: op.id }), (o: any) => o.status === 'waiting_user')
    expect(await call('vm.list')).toHaveLength(1)
    expect(ctx.provider.calls.filter((c) => c === 'provision')).toHaveLength(1)
    // Device login: pending status is returned, then the runtime reports connected.
    const pending = await call('bot.auth.start', { botId: bot.id, method: 'device' })
    expect(pending.pending.verificationUrl).toMatch(/^https:\/\/auth\.openai\.com\//)
    ctx.connector.guest(bot.vmId).auth = { state: 'connected', provider: 'codex', method: 'device', account: { email: 'a@b.c', plan: 'plus' } }
    await call('bot.auth.status', { botId: bot.id })
    bot = await until(() => call('bot.inspect', { botId: bot.id }), (b: any) => b.status === 'ready')
    expect(bot.model).toEqual({ model: 'fixture-small', effort: 'medium', source: 'recommended' })
    expect((await call('bot.setup.inspect', { operationId: op.id })).status).toBe('succeeded')
    expect(bot.conversationId).toBeDefined()
  })
  it('refuses a stale preview, silent reuse of an existing VM and binding a VM twice', async () => {
    const ctx = await context()
    await ctx.call('vm.create', { name: 'existing', imageId: 'image', runtimeId: 'qemu', cpus: 2, memoryMiB: 2048, diskGiB: 12, idempotencyKey: 'vm' })
    const vm = (await until(() => ctx.call('vm.list'), (v: any[]) => v[0]?.state === 'running'))[0]
    const preview = await ctx.call('bot.setup.preview', { destination: { kind: 'existing-vm', vmId: vm.id } })
    expect(preview.destination).toMatchObject({ kind: 'existing-vm', requiresPreparation: true, backupRequired: true })
    await expect(
      ctx.call('bot.setup.start', { idempotencyKey: 'a', previewId: preview.previewId, inventoryRevision: preview.inventoryRevision, name: 'x', confirmations: { destination: true, permissions: true } })
    ).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' })
    const op = await ctx.call('bot.setup.start', { idempotencyKey: 'b', previewId: preview.previewId, inventoryRevision: preview.inventoryRevision, name: 'x', confirmations: { destination: true, permissions: true, prepareExisting: true, restartExisting: true } })
    await until(() => ctx.call('bot.setup.inspect', { operationId: op.id }), (o: any) => o.status === 'waiting_user')
    expect(ctx.provider.backups).toEqual([vm.id])
    expect(ctx.provider.prepared).toEqual([vm.id])
    expect(ctx.provider.calls).toContain('restart')
    // The same VM cannot be chosen again while bound.
    const again = await ctx.call('bot.setup.preview', { destination: { kind: 'existing-vm', vmId: vm.id } })
    expect(again.feasible).toBe(false)
    expect(again.blockers.map((b: any) => b.code)).toContain('VM_ALREADY_BOUND')
    // Inventory changes invalidate an older preview.
    const fresh = await ctx.call('bot.setup.preview', {})
    await ctx.call('vm.create', { name: 'other', imageId: 'image', runtimeId: 'qemu', cpus: 1, memoryMiB: 512, diskGiB: 12, idempotencyKey: 'vm2' })
    await expect(
      ctx.call('bot.setup.start', { idempotencyKey: 'c', previewId: fresh.previewId, inventoryRevision: fresh.inventoryRevision, name: 'y', confirmations: { destination: true, permissions: true } })
    ).rejects.toMatchObject({ code: 'PREVIEW_STALE' })
  })
  it('cancelling keeps the created computer and marks the bot for attention', async () => {
    const ctx = await context()
    const preview = await ctx.call('bot.setup.preview', {})
    const op = await ctx.call('bot.setup.start', { idempotencyKey: 'k', previewId: preview.previewId, inventoryRevision: preview.inventoryRevision, name: 'x', confirmations: { destination: true, permissions: true } })
    await until(() => ctx.call('bot.setup.inspect', { operationId: op.id }), (o: any) => o.status === 'waiting_user')
    const cancelled = await ctx.call('bot.setup.cancel', { operationId: op.id })
    expect(cancelled.status).toBe('cancelled')
    expect(cancelled.retained.diskRetained).toBe(true)
    expect(await ctx.call('vm.list')).toHaveLength(1)
    expect((await ctx.call('bot.inspect', { botId: op.botId })).status).toBe('needs_attention')
  })
  it('archiving requires an idle bot, keeps the VM and revokes egress; purge needs archive first', async () => {
    const ctx = await context()
    const bot = await readyBot(ctx)
    await expect(ctx.call('vm.remove', { vmId: bot.vmId, expectedRevision: (await ctx.call('vm.inspect', { vmId: bot.vmId })).revision, idempotencyKey: 'purge', deleteData: true })).rejects.toMatchObject({ code: 'BOT_BOUND' })
    const archived = await ctx.call('bot.archive', { botId: bot.id, expectedRevision: bot.revision, idempotencyKey: 'arch' })
    expect(archived.status).toBe('succeeded')
    expect((await ctx.call('bot.network.inspect', { botId: bot.id })).policy.mode).toBe('offline')
    expect(await ctx.call('vm.list')).toHaveLength(1)
    expect(await ctx.call('bot.list')).toEqual([])
    expect((await ctx.call('bot.list', { includeArchived: true }))[0].status).toBe('archived')
  })
  it('fails closed with a human blocker when no template or host support exists', async () => {
    const ctx = await context({ templates: [] })
    await expect(ctx.call('bot.setup.preview', {})).rejects.toMatchObject({ code: 'NO_BOT_TEMPLATE' })
    const connector = new FakeConnector()
    connector.fail = true
    const unreachable = await context({ connector })
    const preview = await unreachable.call('bot.setup.preview', {})
    const op = await unreachable.call('bot.setup.start', { idempotencyKey: 'k', previewId: preview.previewId, inventoryRevision: preview.inventoryRevision, name: 'x', confirmations: { destination: true, permissions: true } })
    const failed = await until(() => unreachable.call('bot.setup.inspect', { operationId: op.id }), (o: any) => o.status === 'failed')
    expect(failed.steps.find((s: any) => s.id === 'runtime').status).toBe('failed')
    expect(failed.retained.vmId).toBeDefined()
  })
})
