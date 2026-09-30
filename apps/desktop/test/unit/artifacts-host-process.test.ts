import { EventEmitter } from 'node:events'
import { ArtifactHostError } from '@maestrly/artifact-host'
import { describe, expect, it } from 'vitest'
import { ArtifactHostProcess, type UtilityLike } from '../../src/main/artifacts/host-process'
import { type ArtifactHostStatus, type ArtifactSettings, DEFAULT_ARTIFACT_SETTINGS } from '../../src/shared/artifacts'

class FakeUtility extends EventEmitter implements UtilityLike {
  sent: unknown[] = []
  killed = false
  postMessage(message: unknown): void {
    this.sent.push(message)
  }
  kill(): boolean {
    this.killed = true
    return true
  }
  reply(message: unknown): void {
    this.emit('message', message)
  }
  exit(code = 1): void {
    this.emit('exit', code)
  }
}

function harness(settings: Partial<ArtifactSettings> = {}) {
  const children: FakeUtility[] = []
  const scheduled: { fn: () => void; ms: number }[] = []
  const statuses: ArtifactHostStatus[] = []
  const events: unknown[] = []
  let now = 1_000_000
  const host = new ArtifactHostProcess({
    fork: () => {
      const child = new FakeUtility()
      children.push(child)
      return child
    },
    dataDir: () => '/data/artifacts',
    settings: () => ({ ...DEFAULT_ARTIFACT_SETTINGS, ...settings }),
    onStatus: (status) => statuses.push(status),
    onEvent: (event) => events.push(event),
    schedule: (fn, ms) => scheduled.push({ fn, ms }),
    now: () => now,
  })
  const last = () => children[children.length - 1]!
  const runScheduled = () => {
    for (const task of scheduled.splice(0)) task.fn()
  }
  return { host, children, scheduled, statuses, events, last, runScheduled, advance: (ms: number) => (now += ms) }
}

const flush = () => new Promise((resolve) => setImmediate(resolve))

async function errorOf(promise: Promise<unknown>): Promise<ArtifactHostError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof ArtifactHostError) return error
    throw error
  }
  throw new Error('expected an error')
}

describe('ArtifactHostProcess', () => {
  it('starts one worker and resolves once it listens', async () => {
    const { host, children, last } = harness()
    const first = host.ensureStarted()
    const second = host.ensureStarted()
    expect(children).toHaveLength(1)
    expect(last().sent[0]).toEqual({
      type: 'init',
      config: { dataDir: '/data/artifacts', port: 4010, quotaBytes: 2 * 1024 ** 3, publicOrigins: [], ownerName: '' },
    })
    expect(host.status().state).toBe('starting')
    last().reply({ type: 'ready', port: 4010 })
    const admin = await first
    expect(await second).toBe(admin)
    expect(host.status()).toEqual({ state: 'running', port: 4010 })
    expect(await host.ensureStarted()).toBe(admin)
    expect(children).toHaveLength(1)
  })

  it('reports a busy port without restarting', async () => {
    const { host, last, scheduled } = harness()
    const start = host.ensureStarted()
    last().reply({ type: 'init-error', code: 'port_in_use' })
    const error = await errorOf(start)
    expect(error.code).toBe('host_unavailable')
    expect(error.details?.reason).toBe('port_in_use')
    expect(host.status()).toMatchObject({ state: 'error', problem: 'port_in_use' })
    expect(last().killed).toBe(true)
    expect(scheduled).toEqual([])
  })

  it('does not start when hosting is off', async () => {
    const { host, children } = harness({ hostEnabled: false })
    expect((await errorOf(host.ensureStarted())).details?.reason).toBe('disabled')
    expect(children).toHaveLength(0)
    expect(host.status()).toMatchObject({ state: 'stopped', problem: 'disabled' })
  })

  it('restarts after unexpected exits and gives up after five in two minutes', async () => {
    const { host, children, scheduled, last, runScheduled } = harness()
    const start = host.ensureStarted()
    last().reply({ type: 'ready', port: 4010 })
    await start
    for (let crash = 1; crash <= 4; crash += 1) {
      last().exit(1)
      expect(scheduled).toHaveLength(1)
      runScheduled()
      await flush()
      expect(children).toHaveLength(crash + 1)
      last().reply({ type: 'ready', port: 4010 })
      await flush()
      expect(host.status().state).toBe('running')
    }
    last().exit(1)
    expect(scheduled).toEqual([])
    expect(host.status()).toMatchObject({ state: 'error', problem: 'crashed' })
  })

  it('fails pending admin calls when the worker exits', async () => {
    const { host, last } = harness()
    const start = host.ensureStarted()
    last().reply({ type: 'ready', port: 4010 })
    const admin = await start
    const call = admin.status()
    last().exit(1)
    expect((await errorOf(call)).code).toBe('host_unavailable')
  })

  it('stops gracefully, and kills a worker that does not exit', async () => {
    const { host, last, scheduled } = harness()
    const start = host.ensureStarted()
    last().reply({ type: 'ready', port: 4010 })
    await start
    const graceful = last()
    const stopping = host.stop()
    expect(graceful.sent.at(-1)).toEqual({ type: 'shutdown' })
    graceful.exit(0)
    await stopping
    expect(graceful.killed).toBe(false)
    expect(host.status().state).toBe('stopped')

    const restart = host.ensureStarted()
    last().reply({ type: 'ready', port: 4010 })
    await restart
    const stuck = last()
    scheduled.splice(0)
    const stopped = host.stop()
    for (const task of scheduled.splice(0)) task.fn()
    await stopped
    expect(stuck.killed).toBe(true)
  })

  it('forwards host events', async () => {
    const { host, last, events } = harness()
    const start = host.ensureStarted()
    last().reply({ type: 'ready', port: 4010 })
    await start
    last().reply({ type: 'event', event: { type: 'changed', artifactId: 'A'.repeat(22) } })
    last().reply({ type: 'event', event: { type: 'other' } })
    last().reply({ type: 'event', event: { type: 'activity', artifactId: 'A'.repeat(22), kind: 'access_requested' } })
    last().reply({ type: 'event', event: { type: 'activity', artifactId: 'A'.repeat(22), kind: 'made_up' } })
    last().reply({ type: 'event', event: { type: 'activity', kind: 'device_added' } })
    expect(events).toEqual([
      { type: 'changed', artifactId: 'A'.repeat(22) },
      { type: 'activity', artifactId: 'A'.repeat(22), kind: 'access_requested' },
    ])
  })

  it('tells the worker the public address and the owner’s name', async () => {
    const { host, last } = harness({ publicAddress: 'https://mac.tail1234.ts.net', ownerName: 'Antonio' })
    const start = host.ensureStarted()
    expect(last().sent[0]).toEqual({
      type: 'init',
      config: {
        dataDir: '/data/artifacts',
        port: 4010,
        quotaBytes: 2 * 1024 ** 3,
        publicOrigins: ['https://mac.tail1234.ts.net'],
        ownerName: 'Antonio',
      },
    })
    last().reply({ type: 'ready', port: 4010 })
    await start
  })

  it('reports status transitions', async () => {
    const { host, last, statuses } = harness()
    const start = host.ensureStarted()
    last().reply({ type: 'ready', port: 4010 })
    await start
    expect(statuses.map((status) => status.state)).toEqual(['starting', 'running'])
  })
})
