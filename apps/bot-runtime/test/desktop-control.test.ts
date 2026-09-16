import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { type Duplex, duplexPair } from 'node:stream'
import { afterEach, expect, it } from 'vitest'
import { MediaMux, type MediaStream } from '@maestrly/guest-transport'
import { VmCatalog, type SessionRecord } from '../src/vm/catalog.js'
import { DesktopControl, type AdminChannel, type DesktopDriver } from '../src/vm/desktop-control.js'
import { temporary } from './helpers.js'

const profile = { cpuQuotaPercent: 100, memoryMiB: 768, tasksMax: 256, diskMiB: 1024 }
class FakeDriver implements DesktopDriver {
  automation: 'running' | 'stopped' = 'running'
  generation = 'gen-1'
  failStop = false
  calls: string[] = []
  async stopAutomation() {
    this.calls.push('stopAutomation')
    if (this.failStop) throw Object.assign(new Error('processes remain'), { code: 'HANDOFF_UNCERTAIN' })
    this.automation = 'stopped'
  }
  async startAutomation() {
    this.calls.push('startAutomation')
    this.automation = 'running'
  }
  async units() {
    return { desktop: 'running' as const, services: 'running' as const, automation: this.automation }
  }
  async desktopGeneration() {
    return this.generation
  }
}
class FakeAdmin implements AdminChannel {
  requests: { op: string; params: Record<string, unknown> }[] = []
  gate = { epoch: 0, allowed: true }
  human = { epoch: 0, enabled: false }
  async request(op: string, params: Record<string, unknown>) {
    this.requests.push({ op, params })
    switch (op) {
      case 'inspect':
        return { desktopGeneration: 'gen-1', width: 1280, height: 800, gate: { ...this.gate, inflight: 0 }, human: { ...this.human, pressed: 0 }, viewers: 0, transmitter: 'stopped', capabilities: ['desktop.live.v1', 'desktop.handoff.v1'] }
      case 'gate':
        this.gate = { epoch: Number(params.epoch), allowed: Boolean(params.allowed) }
        return this.gate
      case 'quiesce':
        this.gate.allowed = false
        return { drained: true }
      case 'human.enable':
        this.human = { epoch: Number(params.epoch), enabled: true }
        return this.human
      case 'human.disable':
        this.human.enabled = false
        return this.human
      case 'human.input':
        return { applied: (params.events as unknown[]).length }
      case 'capture':
        return { path: `.maestrly/screens/${params.observationId}.png`, name: 'x.png', size: 10, digest: 'a'.repeat(64), desktopGeneration: 'gen-1', width: 1280, height: 800 }
      case 'viewer.open':
        return { width: 1280, height: 800, desktopGeneration: 'gen-1' }
      default:
        return { ok: true }
    }
  }
  ops() {
    return this.requests.map((request) => request.op)
  }
  close() {}
}
const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})
async function fixture() {
  const catalog = new VmCatalog(await realpath(await temporary()))
  const record: SessionRecord = { id: randomUUID(), botId: 'bot-a', profile, state: 'running', generation: 1, desiredState: 'running', legacy: false, username: `mb${'b'.repeat(24)}`, uid: 1001, gid: 1001, provisioned: true, createdAt: new Date().toISOString() }
  catalog.save(record)
  const driver = new FakeDriver()
  const admin = new FakeAdmin()
  const clock = { now: 0 }
  const rfb: Duplex[] = []
  const control = new DesktopControl(catalog, driver, {
    admin: () => admin,
    now: () => clock.now,
    connectRfb: async () => {
      const [ours, theirs] = duplexPair()
      rfb.push(ours)
      theirs.write('RFB 003.008\n')
      return ours
    },
  })
  cleanups.push(() => {
    control.close()
    catalog.close()
  })
  const call = (method: string, params: Record<string, unknown>) =>
    control.handle({ type: 'vm.request', id: randomUUID(), method, params: { sessionId: record.id, ...params } } as never)
  const scope = (epoch: number) => ({ generation: 1, epoch })
  const network = { mode: 'offline', domains: [], revision: 3 }
  return { catalog, record, driver, admin, clock, control, call, scope, network, rfb }
}
it('takes control only after automation stops and drains; input needs exact epoch, generation and a fresh sequence', async () => {
  const f = await fixture()
  await f.call('desktop.hold', { ...f.scope(1), idempotencyKey: 'h1', network: f.network })
  expect(f.control.hold(f.record.id).mode).toBe('acquiring')
  expect(f.admin.requests.slice(0, 2)).toEqual([{ op: 'gate', params: { epoch: 1, allowed: false } }, { op: 'network.policy', params: { network: f.network } }])
  await expect(f.call('desktop.hold', { ...f.scope(1), idempotencyKey: 'h2', network: f.network })).rejects.toMatchObject({ code: 'STALE_DESKTOP' })
  const info = await f.call('desktop.acquire', { ...f.scope(1), idempotencyKey: 'a1' })
  expect(info).toMatchObject({ mode: 'human', epoch: 1, automation: 'stopped' })
  expect(f.driver.calls).toEqual(['stopAutomation'])
  expect(f.admin.ops()).toEqual(expect.arrayContaining(['quiesce', 'human.enable']))
  const input = (sequence: number, extra: Record<string, unknown> = {}) =>
    f.call('desktop.input', { ...f.scope(1), desktopGeneration: 'gen-1', sequence, events: [{ kind: 'pointer', x: 1, y: 1 }], ...extra })
  await expect(input(0)).resolves.toEqual({ sequence: 0, applied: 1 })
  await expect(input(0)).rejects.toMatchObject({ code: 'INPUT_SEQUENCE_INVALID' })
  await expect(input(1, { desktopGeneration: 'gen-0' })).rejects.toMatchObject({ code: 'STALE_DESKTOP' })
  await expect(input(2, { epoch: 2 })).rejects.toMatchObject({ code: 'CONTROL_EXPIRED' })
  f.clock.now += 11_000
  await f.call('desktop.lease', { ...f.scope(1), leaseMs: 12_000 })
  f.clock.now += 13_000
  await f.control.expire()
  expect(f.control.hold(f.record.id)).toMatchObject({ mode: 'paused', epoch: 1 })
  expect(f.admin.human.enabled).toBe(false)
  await expect(input(3)).rejects.toMatchObject({ code: 'CONTROL_EXPIRED' })
  // A pause never restarts automation by itself.
  expect(f.driver.automation).toBe('stopped')
})
it('an unconfirmed stop keeps the bot blocked and the interrupted step is never replayed', async () => {
  const f = await fixture()
  f.driver.failStop = true
  await f.call('desktop.hold', { ...f.scope(1), idempotencyKey: 'h1', network: f.network })
  await expect(f.call('desktop.acquire', { ...f.scope(1), idempotencyKey: 'a1' })).rejects.toMatchObject({ code: 'HANDOFF_UNCERTAIN' })
  expect(f.control.hold(f.record.id).mode).toBe('acquiring')
  f.driver.failStop = false
  await expect(f.call('desktop.acquire', { ...f.scope(1), idempotencyKey: 'a1' })).rejects.toMatchObject({ code: 'HANDOFF_UNCERTAIN' })
  expect(f.admin.ops()).not.toContain('human.enable')
  await expect(f.call('desktop.acquire', { ...f.scope(1), idempotencyKey: 'a1', generation: 2 })).rejects.toMatchObject({ code: 'SESSION_GENERATION_CHANGED' })
})
it('return revokes input first, captures the new state and restarts automation only on resume', async () => {
  const f = await fixture()
  await f.call('desktop.hold', { ...f.scope(1), idempotencyKey: 'h1', network: f.network })
  await f.call('desktop.acquire', { ...f.scope(1), idempotencyKey: 'a1' })
  const released = await f.call('desktop.release', { ...f.scope(2), idempotencyKey: 'r1' })
  expect(released).toMatchObject({ mode: 'resuming', epoch: 2 })
  expect(f.admin.human.enabled).toBe(false)
  await expect(f.call('desktop.input', { ...f.scope(1), desktopGeneration: 'gen-1', sequence: 9, events: [{ kind: 'releaseAll' }] })).rejects.toMatchObject({ code: 'CONTROL_EXPIRED' })
  expect(f.driver.automation).toBe('stopped')
  const observationId = randomUUID()
  await expect(f.call('desktop.capture', { ...f.scope(1), observationId })).rejects.toMatchObject({ code: 'STALE_DESKTOP' })
  expect(await f.call('desktop.capture', { ...f.scope(2), observationId })).toMatchObject({ path: `.maestrly/screens/${observationId}.png`, desktopGeneration: 'gen-1' })
  await expect(f.call('desktop.resume', { ...f.scope(1), idempotencyKey: 'x' })).rejects.toMatchObject({ code: 'STALE_DESKTOP' })
  const resumed = await f.call('desktop.resume', { ...f.scope(2), idempotencyKey: 'u1' })
  expect(resumed).toMatchObject({ mode: 'bot', epoch: 2, automation: 'running' })
  expect(f.admin.gate).toEqual({ epoch: 2, allowed: true })
  const before = f.admin.requests.length
  expect(await f.call('desktop.release', { ...f.scope(2), idempotencyKey: 'r1' })).toEqual(released)
  expect(f.admin.requests.length).toBe(before)
  await expect(f.call('desktop.release', { ...f.scope(3), idempotencyKey: 'r1' })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
})
it('viewer grants are single-use, bounded, bound to the session generation and expire unused', async () => {
  const f = await fixture()
  const [g1, g2, g3] = [randomUUID(), randomUUID(), randomUUID()]
  await f.call('desktop.viewer.open', { generation: 1, grantId: g1 })
  await f.call('desktop.viewer.open', { generation: 1, grantId: g2 })
  await expect(f.call('desktop.viewer.open', { generation: 1, grantId: g3 })).rejects.toMatchObject({ code: 'VIEWER_LIMIT' })
  const [a, z] = duplexPair()
  const host = new MediaMux(a, 'host')
  const guest = new MediaMux(z, 'guest')
  cleanups.push(() => {
    host.destroy()
    guest.destroy()
  })
  guest.on('open', (stream: MediaStream, payload: unknown) => void f.control.attach(stream, payload))
  const stream = await host.open({ sessionId: f.record.id, generation: 1, grantId: g1 })
  const [first] = await new Promise<Buffer[]>((resolve) => stream.once('data', (bytes) => resolve([bytes])))
  expect(first.toString()).toBe('RFB 003.008\n')
  await expect(host.open({ sessionId: f.record.id, generation: 1, grantId: g1 })).rejects.toMatchObject({ code: 'GRANT_INVALID' })
  await expect(host.open({ sessionId: f.record.id, generation: 2, grantId: g2 })).rejects.toMatchObject({ code: 'GRANT_INVALID' })
  await expect(host.open({ sessionId: randomUUID(), generation: 1, grantId: g2 })).rejects.toMatchObject({ code: 'GRANT_INVALID' })
  f.clock.now += 31_000
  await f.control.expire()
  await expect(host.open({ sessionId: f.record.id, generation: 1, grantId: g2 })).rejects.toMatchObject({ code: 'GRANT_INVALID' })
  expect(f.admin.requests.filter((r) => r.op === 'viewer.close').map((r) => r.params.grantId)).toContain(g2)
  const closed = new Promise<void>((resolve) => stream.once('close', () => resolve()))
  await f.call('desktop.viewer.close', { grantId: g1 })
  await closed
  // The supervisor's own connection to the screen server is closed with the viewer.
  await new Promise((resolve) => setImmediate(resolve))
  expect(f.rfb[0].destroyed).toBe(true)
})
it('a supervisor restart turns active control into a pause and never back into automation', async () => {
  const f = await fixture()
  await f.call('desktop.hold', { ...f.scope(1), idempotencyKey: 'h1', network: f.network })
  await f.call('desktop.acquire', { ...f.scope(1), idempotencyKey: 'a1' })
  const restarted = new DesktopControl(f.catalog, f.driver, { admin: () => f.admin })
  cleanups.push(() => restarted.close())
  restarted.recover()
  expect(restarted.hold(f.record.id)).toMatchObject({ mode: 'paused', epoch: 1 })
  await expect(restarted.handle({ type: 'vm.request', id: 'x', method: 'desktop.lease', params: { sessionId: f.record.id, generation: 1, epoch: 1, leaseMs: 12_000 } } as never)).rejects.toMatchObject({ code: 'CONTROL_EXPIRED' })
  expect(() => f.catalog.saveDesktopHold(f.record.id, { mode: 'bot', epoch: 0 })).toThrow('must not decrease')
})
