import { afterEach, expect, it, vi } from 'vitest'
import { rm } from 'node:fs/promises'
import { setup, FakeConnector, until, template } from './bot-helpers.js'
import { HostError } from '../src/errors.js'
const contexts: Awaited<ReturnType<typeof setup>>[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) { await ctx.service.close(); await rm(ctx.dir, { recursive: true, force: true }) } })
async function context() { const connector = new FakeConnector(); connector.managed = true; const ctx = await setup({ connector }); contexts.push(ctx); return ctx }
it('prepares an environment independently without creating a bot or an account', async () => {
  const ctx = await context()
  const op = await ctx.call('environment.create', { idempotencyKey: 'environment', name: 'Work' })
  const result = await until(() => ctx.call('environment.operation', { operationId: op.id }), value => ['succeeded', 'failed'].includes(value.status))
  expect(result.status, JSON.stringify(result.error)).toBe('succeeded')
  expect(await ctx.call('bot.list')).toEqual([])
  expect(await ctx.call('account.list')).toEqual([])
  expect(await ctx.call('environment.list')).toMatchObject([{ status: 'ready', vm: { id: result.vmId, name: 'Work' } }])
  expect(ctx.provider.profiles.get(result.vmId)).toMatchObject({ botChannels: expect.any(Object) })
  expect(await ctx.call('environment.create', { idempotencyKey: 'environment', name: 'Work' })).toMatchObject({ id: op.id })
  expect(ctx.provider.calls.filter(call => call === 'provision')).toHaveLength(1)
})
it('lists promptly without hashing images or waiting for a known but unreachable guest', async () => {
  const ctx = await context()
  const op = await ctx.call('environment.create', { idempotencyKey: 'environment', name: 'Work' })
  await until(() => ctx.call('environment.operation', { operationId: op.id }), value => value.status === 'succeeded')
  const images = vi.spyOn(ctx.service as any, 'listImages')
  const runtime = vi.spyOn(ctx.provider, 'inspectRuntime')
  let finish!: (value: {}) => void
  ctx.connector.inspectVm = () => new Promise(resolve => { finish = resolve })
  const environments = await ctx.call('environment.list')
  expect(environments[0].status).toBe('ready')
  expect(images).not.toHaveBeenCalled(); expect(runtime).not.toHaveBeenCalled()
  finish({})
})
it('offers the live screen as an optional update: the environment stays ready, then updates with backup and restart once', async () => {
  const connector = new FakeConnector()
  connector.managed = true
  const ctx = await setup({ connector, templates: [{ ...template, capabilities: [...template.capabilities, 'desktop.live.v1', 'desktop.handoff.v1'] }] })
  contexts.push(ctx)
  const op = await ctx.call('environment.create', { idempotencyKey: 'environment', name: 'Work' })
  const created = await until(() => ctx.call('environment.operation', { operationId: op.id }), value => value.status === 'succeeded')
  const [before] = await ctx.call('environment.list')
  expect(before).toMatchObject({ status: 'ready', updateAvailable: 'desktop' })
  let updated = false
  const inspect = ctx.connector.inspectVm.bind(ctx.connector)
  ctx.connector.inspectVm = async (...args: Parameters<typeof inspect>) => {
    const result = await inspect(...args) as { capabilities?: string[] }
    return updated ? { ...result, capabilities: [...(result.capabilities ?? []), 'desktop.live.v1', 'desktop.handoff.v1'] } : result
  }
  const prepare = ctx.provider.prepareGuestRuntime.bind(ctx.provider)
  ctx.provider.prepareGuestRuntime = async (...args) => { const result = await prepare(...args); updated = true; return result }
  const update = await ctx.call('environment.prepare', { vmId: created.vmId, idempotencyKey: 'desktop-update', confirmBackup: true, confirmRestart: true })
  const result = await until(() => ctx.call('environment.operation', { operationId: update.id }), value => ['succeeded', 'failed'].includes(value.status))
  expect(result.status, JSON.stringify(result.error)).toBe('succeeded')
  expect(ctx.provider.backups).toEqual([created.vmId])
  expect(ctx.provider.prepared).toEqual([created.vmId])
  expect((await ctx.call('vm.list')).map((vm: any) => vm.id)).toEqual([created.vmId])
  const [after] = await ctx.call('environment.list')
  expect(after.status).toBe('ready')
  expect(after.updateAvailable).toBeUndefined()
  // Already up to date: no second backup or reinstall.
  const again = await ctx.call('environment.prepare', { vmId: created.vmId, idempotencyKey: 'desktop-update-again', confirmBackup: true, confirmRestart: true })
  expect(again.status).toBe('succeeded')
  expect(ctx.provider.backups).toEqual([created.vmId])
})
it('offers a newer live-screen runtime to an environment that already has the screen, and only then', async () => {
  const connector = new FakeConnector()
  connector.managed = true
  const desktopTemplate = { ...template, runtimeBundle: { ...template.runtimeBundle!, version: '0.1.0-desktop-r3' }, capabilities: [...template.capabilities, 'desktop.live.v1', 'desktop.handoff.v1'] }
  const ctx = await setup({ connector, templates: [desktopTemplate] })
  contexts.push(ctx)
  const op = await ctx.call('environment.create', { idempotencyKey: 'environment', name: 'Work' })
  const created = await until(() => ctx.call('environment.operation', { operationId: op.id }), value => value.status === 'succeeded')
  let version = '0.1.0-desktop-r2'
  const inspect = ctx.connector.inspectVm.bind(ctx.connector)
  ctx.connector.inspectVm = async (...args: Parameters<typeof inspect>) => {
    const result = await inspect(...args) as { capabilities?: string[] }
    return { ...result, capabilities: [...(result.capabilities ?? []), 'desktop.live.v1', 'desktop.handoff.v1'], runtimeVersion: version }
  }
  // The version is learned from the supervisor; until then nothing is offered.
  await ctx.call('bot.sessions.list', { vmId: created.vmId })
  const [before] = await ctx.call('environment.list')
  expect(before).toMatchObject({ status: 'ready', updateAvailable: 'desktop' })
  // The version never reaches clients: the inventory keeps its strict public shape.
  expect(JSON.stringify(before)).not.toContain('0.1.0-desktop-r2')
  const prepare = ctx.provider.prepareGuestRuntime.bind(ctx.provider)
  ctx.provider.prepareGuestRuntime = async (...args) => { const result = await prepare(...args); version = '0.1.0-desktop-r3'; return result }
  const update = await ctx.call('environment.prepare', { vmId: created.vmId, idempotencyKey: 'screen-fix', confirmBackup: true, confirmRestart: true })
  const result = await until(() => ctx.call('environment.operation', { operationId: update.id }), value => ['succeeded', 'failed'].includes(value.status))
  expect(result.status, JSON.stringify(result.error)).toBe('succeeded')
  expect(ctx.provider.backups).toEqual([created.vmId])
  expect(ctx.provider.prepared).toEqual([created.vmId])
  const [after] = await ctx.call('environment.list')
  expect(after.updateAvailable).toBeUndefined()
  // Same version as the Host: no backup, no reinstall.
  expect((await ctx.call('environment.prepare', { vmId: created.vmId, idempotencyKey: 'screen-fix-again', confirmBackup: true, confirmRestart: true })).status).toBe('succeeded')
  expect(ctx.provider.backups).toEqual([created.vmId])
})
it('a failed update keeps a working environment usable and can be repeated with a new backup', async () => {
  const connector = new FakeConnector()
  connector.managed = true
  const desktopTemplate = { ...template, runtimeBundle: { ...template.runtimeBundle!, version: '0.1.0-desktop-r5' }, capabilities: [...template.capabilities, 'desktop.live.v1', 'desktop.handoff.v1'] }
  const ctx = await setup({ connector, templates: [desktopTemplate] })
  contexts.push(ctx)
  const op = await ctx.call('environment.create', { idempotencyKey: 'environment', name: 'Work' })
  const created = await until(() => ctx.call('environment.operation', { operationId: op.id }), value => value.status === 'succeeded')
  let version = '0.1.0-desktop-r4'
  let unreachable = false
  const inspect = ctx.connector.inspectVm.bind(ctx.connector)
  ctx.connector.inspectVm = async (...args: Parameters<typeof inspect>) => {
    if (unreachable) return {}
    const result = await inspect(...args) as { capabilities?: string[] }
    return { ...result, capabilities: [...(result.capabilities ?? []), 'desktop.live.v1', 'desktop.handoff.v1'], runtimeVersion: version }
  }
  await ctx.call('bot.sessions.list', { vmId: created.vmId })
  const prepare = ctx.provider.prepareGuestRuntime.bind(ctx.provider)
  // The guest refuses the first attempt (disk full); the earlier runtime keeps running.
  ctx.provider.prepareGuestRuntime = async () => { throw new HostError('GUEST_DISK_SPACE', 'O disco do ambiente tem 0,4 GiB livres e a atualização precisa de 2,7 GiB.') }
  const failed = await ctx.call('environment.prepare', { vmId: created.vmId, idempotencyKey: 'update-1', confirmBackup: true, confirmRestart: true })
  const first = await until(() => ctx.call('environment.operation', { operationId: failed.id }), value => ['succeeded', 'failed'].includes(value.status))
  expect(first).toMatchObject({ status: 'failed', error: { code: 'GUEST_DISK_SPACE' } })
  const [after] = await ctx.call('environment.list')
  expect(after).toMatchObject({ status: 'ready', updateAvailable: 'desktop', reason: expect.stringContaining('0,4 GiB') })
  // Bots of a usable environment are not blocked by the failed update.
  expect(await ctx.call('bot.sessions.list', { vmId: created.vmId })).toMatchObject({ supported: true })
  // If the guest then stops answering (a full disk), the app still offers the retry.
  unreachable = true
  expect(await ctx.call('bot.sessions.list', { vmId: created.vmId })).toMatchObject({ supported: false })
  const [stuck] = await ctx.call('environment.list')
  expect(stuck).toMatchObject({ status: 'unavailable', updateAvailable: 'desktop' })
  unreachable = false
  ctx.provider.prepareGuestRuntime = async (...args) => { const result = await prepare(...args); version = '0.1.0-desktop-r5'; return result }
  const retry = await ctx.call('environment.prepare', { vmId: created.vmId, idempotencyKey: 'update-2', confirmBackup: true, confirmRestart: true })
  const second = await until(() => ctx.call('environment.operation', { operationId: retry.id }), value => ['succeeded', 'failed'].includes(value.status))
  expect(second.status, JSON.stringify(second.error)).toBe('succeeded')
  expect(ctx.provider.backups).toEqual([created.vmId, created.vmId])
  const [done] = await ctx.call('environment.list')
  expect(done.status).toBe('ready')
  expect(done.updateAvailable).toBeUndefined()
  expect(done.reason ?? '').not.toContain('0,4 GiB')
})
it('does not back up or reinstall an already prepared environment', async () => {
  const ctx = await context()
  const op = await ctx.call('environment.create', { idempotencyKey: 'environment', name: 'Work' })
  const complete = await until(() => ctx.call('environment.operation', { operationId: op.id }), value => value.status === 'succeeded')
  const before = [...ctx.provider.calls]
  const prepared = await ctx.call('environment.prepare', { vmId: complete.vmId, idempotencyKey: 'prepare', confirmBackup: true, confirmRestart: true })
  expect(prepared.status).toBe('succeeded')
  expect(ctx.provider.backups).toEqual([]); expect(ctx.provider.prepared).toEqual([])
  expect(ctx.provider.calls).toEqual(before)
})
it('requires backup/restart consent for an old environment and preserves its VM identity', async () => {
  const ctx = await context()
  ctx.connector.managed = false
  const create = await ctx.call('vm.create', { idempotencyKey: 'old-vm', name: 'Existing', imageId: 'image', runtimeId: 'qemu', cpus: 2, memoryMiB: 2048, diskGiB: 12 })
  await until(() => ctx.call('operation.get', { operationId: create.id }), value => value.status === 'succeeded')
  await expect(ctx.call('environment.prepare', { vmId: create.vmId, idempotencyKey: 'prepare', confirmBackup: false, confirmRestart: true })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  const prepare = ctx.provider.prepareGuestRuntime.bind(ctx.provider)
  ctx.provider.prepareGuestRuntime = async (...args) => { const result = await prepare(...args); ctx.connector.managed = true; return result }
  const op = await ctx.call('environment.prepare', { vmId: create.vmId, idempotencyKey: 'prepare', confirmBackup: true, confirmRestart: true })
  const result = await until(() => ctx.call('environment.operation', { operationId: op.id }), value => ['succeeded', 'failed'].includes(value.status))
  expect(result.status, JSON.stringify(result.error)).toBe('succeeded')
  expect(ctx.provider.backups).toEqual([create.vmId]); expect(ctx.provider.prepared).toEqual([create.vmId])
  expect((await ctx.call('vm.list')).map((vm: any) => vm.id)).toEqual([create.vmId])
  expect(await ctx.call('bot.list')).toEqual([])
})
