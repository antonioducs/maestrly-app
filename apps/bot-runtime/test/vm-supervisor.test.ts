import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { afterEach, expect, it } from 'vitest'
import type { SessionCapacity } from '@maestrly/host-protocol'
import { VmCatalog, type SessionRecord } from '../src/vm/catalog.js'
import { VmSupervisor, type SessionDriver } from '../src/vm/supervisor.js'
import { sessionDropIn, sessionEnvironment, sessionPaths, sessionSlice } from '../src/vm/session-profile.js'
import { temporary } from './helpers.js'

const profile = { cpuQuotaPercent: 100, memoryMiB: 640, tasksMax: 128, diskMiB: 1024 }
const capacity: SessionCapacity = { profileId: 'test', evidenceSha256: 'a'.repeat(64), systemMemoryMiB: 384, systemDiskMiB: 1024, maxSessions: 2, perSession: profile }
class Driver implements SessionDriver {
  states = new Map<string, 'running' | 'stopped'>()
  calls: string[] = []
  fail = false
  async resources() { return { memoryMiB: 2048, cpus: 2, freeDiskMiB: 4096 } }
  async provision(r: SessionRecord) { this.calls.push(`create:${r.id}`); if (this.fail) throw new Error('crash'); return { ...r, uid: this.calls.length + 1000, gid: this.calls.length + 1000 } }
  async start(r: SessionRecord) { this.calls.push(`start:${r.id}`); this.states.set(r.id, 'running') }
  async stop(r: SessionRecord) { this.calls.push(`stop:${r.id}`); this.states.set(r.id, 'stopped') }
  async inspect(r: SessionRecord) { return this.states.get(r.id) ?? 'stopped' as const }
}
const open: VmCatalog[] = []
afterEach(() => { for (const c of open.splice(0)) c.close() })
async function fixture() {
  const catalog = new VmCatalog(await realpath(await temporary())); open.push(catalog)
  const driver = new Driver()
  const service = new VmSupervisor(catalog, driver, capacity)
  const create = (botId: string) => ({ type: 'vm.request', id: randomUUID(), method: 'session.create', params: { sessionId: randomUUID(), botId, profile, idempotencyKey: randomUUID() } })
  return { catalog, driver, service, create }
}
it.skipIf(process.platform === 'win32')('runs two independent sessions and does not replay duplicate provisioning', async () => {
  const { service, driver, catalog, create } = await fixture()
  const a = create('a'), b = create('b')
  const [first, duplicate, second] = await Promise.all([service.handle(a), service.handle(a), service.handle(b)])
  expect(first).toEqual(duplicate)
  expect(first).not.toEqual(second)
  expect(driver.calls.filter(c => c.startsWith('create:'))).toHaveLength(2)
  expect(catalog.list().map(s => s.username)).toHaveLength(2)
  expect(new Set(catalog.list().map(s => s.username)).size).toBe(2)
  await service.handle({ type: 'vm.request', id: 'stop', method: 'session.stop', params: { sessionId: a.params.sessionId, generation: 1, idempotencyKey: 'stop-a' } })
  expect(driver.states.get(a.params.sessionId)).toBe('stopped')
  expect(driver.states.get(b.params.sessionId)).toBe('running')
  expect(await service.handle(a)).toEqual(first)
  expect(driver.calls.filter(c => c.startsWith('create:'))).toHaveLength(2)
})
it.skipIf(process.platform === 'win32')('reserves resource budgets atomically and retains archived disk/session identities', async () => {
  const { service, create } = await fixture()
  const results = await Promise.allSettled([service.handle(create('a')), service.handle(create('b')), service.handle(create('c'))])
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(2)
  expect(results.find(r => r.status === 'rejected')).toMatchObject({ reason: { code: 'SESSION_CAPACITY_EXCEEDED' } })
})
it.skipIf(process.platform === 'win32')('expires only the session whose Host lease was lost and never recycles its identity', async () => {
  const { service, driver, catalog, create } = await fixture()
  const a = create('a'), b = create('b')
  await service.handle(a); await service.handle(b)
  await service.handle({ type: 'vm.request', id: 'lease-a', method: 'session.lease', params: { sessionId: a.params.sessionId, generation: 1, turnId: 'turn-a', leaseMs: 1000 } })
  await service.handle({ type: 'vm.request', id: 'lease-b', method: 'session.lease', params: { sessionId: b.params.sessionId, generation: 1, turnId: 'turn-b', leaseMs: 30000 } })
  await service.expireLeases(Date.now() + 1001)
  expect(driver.states.get(a.params.sessionId)).toBe('stopped')
  expect(driver.states.get(b.params.sessionId)).toBe('running')
  const c = create('c'); await service.handle(c)
  expect(catalog.list()).toHaveLength(3)
  expect(catalog.get(a.params.sessionId)?.botId).toBe('a')
  expect(catalog.get(c.params.sessionId)?.username).not.toBe(catalog.get(a.params.sessionId)?.username)
  await expect(service.handle({ type: 'vm.request', id: 'restart-a', method: 'session.start', params: { sessionId: a.params.sessionId, generation: 1, idempotencyKey: 'restart-a' } })).rejects.toMatchObject({ code: 'SESSION_CAPACITY_EXCEEDED' })
})
it.skipIf(process.platform === 'win32')('rejects a conflicting in-flight key and records uncertain effects instead of retrying', async () => {
  const { service, driver, catalog, create } = await fixture()
  const a = create('a')
  const pending = service.handle(a)
  await expect(service.handle({ ...a, params: { ...a.params, botId: 'other' } })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
  await pending
  driver.fail = true
  const b = create('b')
  await expect(service.handle(b)).rejects.toThrow('crash')
  expect(catalog.get(b.params.sessionId)?.state).toBe('needs_attention')
  const reopened = new VmSupervisor(catalog, driver, capacity)
  await expect(reopened.handle(b)).rejects.toMatchObject({ code: 'SESSION_PREPARATION_UNCERTAIN' })
  expect(driver.calls.filter(c => c === `create:${b.params.sessionId}`)).toHaveLength(1)
})
it.skipIf(process.platform === 'win32')('generates user and namespace boundaries while keeping each desktop and runtime together', async () => {
  const { service, create, catalog } = await fixture()
  const a = create('a'), b = create('b')
  await service.handle(a); await service.handle(b)
  const ra = catalog.get(a.params.sessionId)!, rb = catalog.get(b.params.sessionId)!
  expect(sessionPaths(ra).home).not.toBe(sessionPaths(rb).home)
  expect(sessionEnvironment(ra).MAESTRLY_BOT_EGRESS_PATH).not.toBe(sessionEnvironment(rb).MAESTRLY_BOT_EGRESS_PATH)
  const unit = sessionDropIn(ra, false)
  for (const setting of ['PrivateNetwork=yes', 'PrivateIPC=yes', 'PrivateTmp=yes', 'NoNewPrivileges=yes', 'PrivateDevices=yes', `JoinsNamespaceOf=${sessionPaths(ra).desktopUnit}`]) expect(unit).toContain(setting)
  expect(unit).not.toContain(rb.id)
  expect(sessionSlice(ra)).toContain('MemoryMax=640M')
})
