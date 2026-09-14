import { afterEach, expect, it, vi } from 'vitest'
import { rm } from 'node:fs/promises'
import { setup, FakeConnector, until } from './bot-helpers.js'
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
