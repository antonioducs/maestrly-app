import { describe, expect, it } from 'vitest'
import {
  FLEET_RUNNERS_FEATURE,
  FLEET_RUNNERS_QUERY,
  FLEET_RUNNER_JOBS_CAPABILITY,
  FLEET_RUNNER_JOB_FINAL_STATES,
  FLEET_RUNNER_LIMITS,
  FLEET_RUNNER_PROTOCOL_VERSION,
  fleetGatewayEventSchema,
  fleetReaderWantsRunners,
  fleetRunnerJobSpecSchema,
  fleetRunnerMeets,
  isFleetRunnerEvent,
  type FleetRunnerCapabilities,
} from '../src/index.js'

const at = '2026-10-29T10:00:00.000Z'
const spec = { folder: '/home/bot/video', command: 'npm run render', outputs: ['out/**'] }
const mac: FleetRunnerCapabilities = {
  protocol: 1,
  os: 'macos',
  arch: 'arm64',
  cpus: 12,
  memoryBytes: 36 * 1024 ** 3,
  executor: 'native',
  gpu: { vendor: 'apple', name: 'Apple M3 Pro', memoryBytes: null },
  slots: 1,
}

describe('runner contracts', () => {
  it('names the feature, the capability, the stream parameter and the job protocol', () => {
    expect(FLEET_RUNNERS_FEATURE).toBe('runners')
    expect(FLEET_RUNNER_JOBS_CAPABILITY).toBe('runner-jobs')
    expect(FLEET_RUNNERS_QUERY).toBe('runners')
    expect(FLEET_RUNNER_PROTOCOL_VERSION).toBe(1)
    expect(FLEET_RUNNER_JOB_FINAL_STATES).toEqual(['succeeded', 'failed', 'cancelled', 'expired', 'lost'])
    expect(fleetReaderWantsRunners(new URLSearchParams('runners=1'))).toBe(true)
    expect(fleetReaderWantsRunners(new URLSearchParams('desktopBridge=1'))).toBe(false)
    // A runner is told a job in time to accept it before the gateway gives up on it.
    expect(FLEET_RUNNER_LIMITS.acceptTimeoutMs).toBeLessThan(FLEET_RUNNER_LIMITS.lostGraceMs)
  })

  it('fills a job spec with its defaults and keeps every path inside the job folder', () => {
    expect(fleetRunnerJobSpecSchema.parse(spec)).toEqual({
      ...spec,
      caches: [],
      env: {},
      timeoutMinutes: 60,
      queueTimeoutMinutes: 60,
    })
    for (const outputs of [['/etc/passwd'], ['../up'], ['out/../../up'], ['a\\b']])
      expect(fleetRunnerJobSpecSchema.safeParse({ ...spec, outputs }).success, outputs[0]).toBe(false)
    expect(fleetRunnerJobSpecSchema.safeParse({ ...spec, outputs: [] }).success).toBe(false)
    expect(fleetRunnerJobSpecSchema.safeParse({ ...spec, folder: 'video' }).success).toBe(false)
    expect(fleetRunnerJobSpecSchema.safeParse({ ...spec, folder: '/home/bot/../root' }).success).toBe(false)
    expect(
      fleetRunnerJobSpecSchema.safeParse({ ...spec, caches: [{ name: 'Node Modules', path: 'node_modules' }] }).success
    ).toBe(false)
    expect(fleetRunnerJobSpecSchema.safeParse({ ...spec, env: { 'BAD-NAME': 'x' } }).success).toBe(false)
    expect(
      fleetRunnerJobSpecSchema.safeParse({ ...spec, command: 'x'.repeat(FLEET_RUNNER_LIMITS.commandBytesMax + 1) })
        .success
    ).toBe(false)
    expect(
      fleetRunnerJobSpecSchema.safeParse({ ...spec, timeoutMinutes: FLEET_RUNNER_LIMITS.timeoutMinutesMax + 1 }).success
    ).toBe(false)
  })

  it('matches requirements against what a runner reports', () => {
    expect(fleetRunnerMeets(mac, {})).toBe(true)
    expect(fleetRunnerMeets(mac, { os: 'linux' })).toBe(false)
    expect(fleetRunnerMeets(mac, { gpu: true })).toBe(true)
    expect(fleetRunnerMeets({ ...mac, gpu: null }, { gpu: true })).toBe(false)
    expect(fleetRunnerMeets(mac, { executor: 'container' })).toBe(false)
    // An image needs a container.
    expect(fleetRunnerMeets(mac, {}, 'python:3.12')).toBe(false)
    expect(fleetRunnerMeets({ ...mac, executor: 'container' }, {}, 'python:3.12')).toBe(true)
    // A runner of another job protocol takes nothing.
    expect(fleetRunnerMeets({ ...mac, protocol: 2 }, {})).toBe(false)
  })

  it('round-trips runner events, and a runner never receives what only the environment uses', () => {
    const event = {
      type: 'runner.job',
      at,
      jobId: 'job_0123456789abcdef',
      botId: 'alpha',
      runnerId: 'rnr_0123456789abcdefABCD',
      spec: { ...spec, caches: [], env: {}, timeoutMinutes: 60 },
      acceptBy: at,
    }
    expect(fleetGatewayEventSchema.parse(event)).toEqual(event)
    expect(
      fleetGatewayEventSchema.safeParse({ ...event, spec: { ...event.spec, queueTimeoutMinutes: 5 } }).success
    ).toBe(false)
    expect(fleetGatewayEventSchema.parse({ type: 'runner.cancel', at, jobId: 'job_0123456789abcdef' })).toBeTruthy()
    expect(fleetGatewayEventSchema.parse({ type: 'runner_link.updated', at, botId: 'alpha', links: [] })).toBeTruthy()
    expect(isFleetRunnerEvent({ type: 'runner.job' })).toBe(true)
    expect(isFleetRunnerEvent({ type: 'runner_job.updated' })).toBe(true)
    expect(isFleetRunnerEvent({ type: 'routine_run.updated' })).toBe(false)
  })
})
