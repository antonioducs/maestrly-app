import { describe, expect, it } from 'vitest'
import {
  FLEET_GATEWAY_ROUTES,
  FLEET_INSTANCE_ROUTES,
  FLEET_INTERNAL_ROUTES,
  FLEET_RUNNER_TRANSFER_ROUTE_KEYS,
  fleetInternalRunnerJobRequestSchema,
  fleetRunnerStateRequestSchema,
  fleetRunnerSubmitResultSchema,
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

  it('declares the runner routes of the gateway, of its internal API and of the environment', () => {
    const paths = (table: Record<string, { method: string; path: string }>, keys: string[]) =>
      Object.fromEntries(keys.map((key) => [key, `${table[key].method} ${table[key].path}`]))
    expect(
      paths(FLEET_GATEWAY_ROUTES, [
        'botRunnerLinkPut',
        'botRunnerLinkDelete',
        'botRunnerLinks',
        'botRunnerLinkRemove',
        'botRunnerJobs',
        'botRunnerJobCancel',
        'runnerState',
        'runnerJobAccept',
        'runnerJobProgress',
        'runnerJobFinish',
        ...FLEET_RUNNER_TRANSFER_ROUTE_KEYS,
      ])
    ).toEqual({
      botRunnerLinkPut: 'PUT /v1/bots/:id/runner-link',
      botRunnerLinkDelete: 'DELETE /v1/bots/:id/runner-link',
      botRunnerLinks: 'GET /v1/bots/:id/runner-links',
      botRunnerLinkRemove: 'DELETE /v1/bots/:id/runner-links/:runnerId',
      botRunnerJobs: 'GET /v1/bots/:id/runner-jobs',
      botRunnerJobCancel: 'POST /v1/bots/:id/runner-jobs/:jobId/cancel',
      runnerState: 'PUT /v1/runner/state',
      runnerJobAccept: 'POST /v1/runner-jobs/:jobId/accept',
      runnerJobProgress: 'POST /v1/runner-jobs/:jobId/progress',
      runnerJobFinish: 'POST /v1/runner-jobs/:jobId/finish',
      runnerJobManifest: 'GET /v1/runner-jobs/:jobId/manifest',
      runnerJobBlobs: 'POST /v1/runner-jobs/:jobId/blobs',
      runnerJobLog: 'POST /v1/runner-jobs/:jobId/log',
      runnerJobOutputs: 'GET /v1/runner-jobs/:jobId/outputs',
      runnerJobOutputChunk: 'PUT /v1/runner-jobs/:jobId/outputs/:offset',
      runnerJobOutputCommit: 'POST /v1/runner-jobs/:jobId/outputs/commit',
    })
    // The gateway streams these through as they are: it never parses their bodies.
    for (const key of FLEET_RUNNER_TRANSFER_ROUTE_KEYS) expect(FLEET_GATEWAY_ROUTES[key].body, key).toBeNull()
    expect(
      paths(FLEET_INTERNAL_ROUTES, [
        'runners',
        'runnerJobCreate',
        'runnerJobsList',
        'runnerJobGet',
        'runnerJobCancelOwn',
      ])
    ).toEqual({
      runners: 'GET /internal/v1/runners',
      runnerJobCreate: 'POST /internal/v1/runner-jobs',
      runnerJobsList: 'GET /internal/v1/runner-jobs',
      runnerJobGet: 'GET /internal/v1/runner-jobs/:jobId',
      runnerJobCancelOwn: 'POST /internal/v1/runner-jobs/:jobId/cancel',
    })
    expect(
      paths(FLEET_INSTANCE_ROUTES, [
        'botRunnerJobState',
        'botRunnerJobManifest',
        'botRunnerJobBlobs',
        'botRunnerJobLog',
        'botRunnerJobOutputs',
        'botRunnerJobOutputChunk',
        'botRunnerJobOutputCommit',
      ])
    ).toEqual({
      botRunnerJobState: 'POST /v1/bots/:botId/runner-jobs/:jobId/state',
      botRunnerJobManifest: 'GET /v1/bots/:botId/runner-jobs/:jobId/manifest',
      botRunnerJobBlobs: 'POST /v1/bots/:botId/runner-jobs/:jobId/blobs',
      botRunnerJobLog: 'POST /v1/bots/:botId/runner-jobs/:jobId/log',
      botRunnerJobOutputs: 'GET /v1/bots/:botId/runner-jobs/:jobId/outputs',
      botRunnerJobOutputChunk: 'PUT /v1/bots/:botId/runner-jobs/:jobId/outputs/:offset',
      botRunnerJobOutputCommit: 'POST /v1/bots/:botId/runner-jobs/:jobId/outputs/commit',
    })
  })

  it('requires capabilities from a runner that accepts jobs, and an id of its own for each job', () => {
    expect(fleetRunnerStateRequestSchema.safeParse({ accepting: true, capabilities: null, jobs: [] }).success).toBe(
      false
    )
    expect(fleetRunnerStateRequestSchema.safeParse({ accepting: false, capabilities: null, jobs: [] }).success).toBe(
      true
    )
    expect(fleetRunnerStateRequestSchema.safeParse({ accepting: true, capabilities: mac, jobs: [] }).success).toBe(true)
    expect(fleetInternalRunnerJobRequestSchema.safeParse({ jobId: 'abc', spec }).success).toBe(false)
    expect(fleetInternalRunnerJobRequestSchema.parse({ jobId: 'job_0123456789abcdef', spec }).requires).toEqual({})
    expect(
      fleetRunnerSubmitResultSchema.parse({ ok: false, error: { code: 'runner_busy', message: 'Wait.' } })
    ).toBeTruthy()
  })
})

describe('runner transfers', () => {
  it('keeps every manifest entry inside the job folder', async () => {
    const { fleetRunnerManifestSchema, FLEET_RUNNER_DEFAULT_EXCLUDES } = await import('../src/index.js')
    const file = { kind: 'file', path: 'src/a.txt', mode: 0o644, size: 3, sha256: 'a'.repeat(64) }
    const manifest = (entries: unknown[]) =>
      fleetRunnerManifestSchema.safeParse({ jobId: 'job_0123456789abcdef', entries, bytes: 3, skipped: 0 })
    expect(manifest([{ kind: 'directory', path: 'src', mode: 0o755 }, file]).success).toBe(true)
    expect(manifest([{ kind: 'symlink', path: 'link', target: 'src/a.txt' }]).success).toBe(true)
    for (const path of ['/etc/passwd', '../up', 'a/../../up', 'a//b', './a', 'a\\b'])
      expect(manifest([{ ...file, path }]).success, path).toBe(false)
    expect(manifest([{ ...file, sha256: 'xyz' }]).success).toBe(false)
    expect(FLEET_RUNNER_DEFAULT_EXCLUDES).toEqual(['.git/', 'node_modules/', '.venv/', '__pycache__/'])
  })
})
