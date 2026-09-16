import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { afterEach, expect, it } from 'vitest'
import type { SessionCapacity } from '@maestrly/host-protocol'
import { VmCatalog, type SessionRecord } from '../src/vm/catalog.js'
import { VmSupervisor, type SessionDriver, type UnitState } from '../src/vm/supervisor.js'
import { DesktopControl } from '../src/vm/desktop-control.js'
import { temporary } from './helpers.js'

const profile = { cpuQuotaPercent: 100, memoryMiB: 640, tasksMax: 128, diskMiB: 1024 }
const capacity: SessionCapacity = { profileId: 'test', evidenceSha256: 'a'.repeat(64), systemMemoryMiB: 384, systemDiskMiB: 1024, maxSessions: 2, perSession: profile }
type Units = { desktop: UnitState; services: UnitState; automation: UnitState }
const STOPPED: Units = { desktop: 'stopped', services: 'stopped', automation: 'stopped' }
/** Three-unit driver: display, graphical services and automation are observed separately. */
class UnitDriver implements SessionDriver {
  state = new Map<string, Units>()
  calls: string[] = []
  async resources() { return { memoryMiB: 2048, cpus: 2, freeDiskMiB: 4096 } }
  async provision(r: SessionRecord) { return { ...r, uid: 1001, gid: 1001 } }
  async start(r: SessionRecord, options: { automation?: boolean } = {}) {
    this.calls.push(`start:${options.automation === false ? 'graphics' : 'all'}`)
    const automation = options.automation === false ? (this.state.get(r.id)?.automation ?? 'stopped') : 'running'
    this.state.set(r.id, { desktop: 'running', services: 'running', automation })
  }
  async stop(r: SessionRecord) { this.calls.push('stop'); this.state.set(r.id, STOPPED) }
  async stopAutomation(r: SessionRecord) { this.calls.push('stopAutomation'); this.state.set(r.id, { ...(this.state.get(r.id) ?? STOPPED), automation: 'stopped' }) }
  async startAutomation(r: SessionRecord) { this.calls.push('startAutomation'); this.state.set(r.id, { ...(this.state.get(r.id) ?? STOPPED), automation: 'running' }) }
  async units(r: SessionRecord) { return this.state.get(r.id) ?? STOPPED }
  async inspect(): Promise<'running' | 'stopped' | 'unknown'> { return 'unknown' }
  async desktopGeneration() { return 'gen-1' }
}
const open: (() => void)[] = []
afterEach(() => { for (const close of open.splice(0)) close() })
async function fixture() {
  const catalog = new VmCatalog(await realpath(await temporary()))
  const driver = new UnitDriver()
  // Graphical services unavailable here: the supervisor paths under test must not depend on them.
  const admin = { request: async () => { throw Object.assign(new Error('down'), { code: 'DESKTOP_UNAVAILABLE' }) }, close() {} }
  const desktop = new DesktopControl(catalog, driver, { admin: () => admin, capabilities: async () => ['desktop.live.v1', 'desktop.handoff.v1'] })
  const supervisor = new VmSupervisor(catalog, driver, capacity, desktop)
  open.push(() => { desktop.close(); catalog.close() })
  const sessionId = randomUUID()
  await supervisor.handle({ type: 'vm.request', id: randomUUID(), method: 'session.create', params: { sessionId, botId: 'a', profile, idempotencyKey: randomUUID() } })
  const request = (method: string, params: Record<string, unknown>) => supervisor.handle({ type: 'vm.request', id: randomUUID(), method, params })
  return { catalog, driver, supervisor, sessionId, request, record: () => catalog.get(sessionId)! }
}
it('refuses to restart automation while a person holds the bot and reports the held session as running', async () => {
  const f = await fixture()
  f.catalog.saveDesktopHold(f.sessionId, { mode: 'paused', epoch: 1 })
  await f.driver.stopAutomation(f.record())
  expect(await f.request('session.inspect', { sessionId: f.sessionId })).toMatchObject({ state: 'running' })
  await expect(f.request('session.start', { sessionId: f.sessionId, generation: 1, idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: 'BOT_PAUSED_BY_USER' })
  expect(await f.request('vm.inspect', {})).toMatchObject({ capabilities: ['account.delegation.v1', 'desktop.live.v1', 'desktop.handoff.v1'] })
})
it('a lost turn lease stops only automation; the display and browser services keep running', async () => {
  const f = await fixture()
  await f.request('session.lease', { sessionId: f.sessionId, generation: 1, turnId: 'turn-a', leaseMs: 1000 })
  await f.supervisor.expireLeases(Date.now() + 1001)
  expect(f.driver.calls).toContain('stopAutomation')
  expect(f.driver.calls).not.toContain('stop')
  expect(await f.driver.units(f.record())).toEqual({ desktop: 'running', services: 'running', automation: 'stopped' })
  expect(f.record().leaseTurnId).toBeUndefined()
  expect(await f.request('session.inspect', { sessionId: f.sessionId })).toMatchObject({ state: 'stopped' })
  expect(await f.request('session.start', { sessionId: f.sessionId, generation: 1, idempotencyKey: randomUUID() })).toMatchObject({ state: 'running', generation: 2 })
})
it('an emergency stop still tears down every component and proves it', async () => {
  const f = await fixture()
  expect(await f.request('session.stop', { sessionId: f.sessionId, generation: 1, idempotencyKey: randomUUID() })).toMatchObject({ state: 'stopped' })
  expect(f.driver.calls).toContain('stop')
  expect(await f.driver.units(f.record())).toEqual(STOPPED)
})
it('recovery after a supervisor restart keeps the screen for a held session without starting automation', async () => {
  const f = await fixture()
  f.catalog.saveDesktopHold(f.sessionId, { mode: 'human', epoch: 4 })
  f.driver.calls.length = 0
  await f.supervisor.recover()
  expect(f.driver.calls).toEqual(['start:graphics', 'stopAutomation'])
  expect(f.catalog.desktopHold(f.sessionId)).toMatchObject({ mode: 'paused', epoch: 4 })
})
