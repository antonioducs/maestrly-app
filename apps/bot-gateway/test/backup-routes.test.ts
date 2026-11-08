import { randomUUID } from 'node:crypto'
import { FLEET_PROTOCOL_HEADER } from '@maestrly/bot-fleet-protocol'
import { describe, expect, it } from 'vitest'
import type { HelperSpec } from '../src/docker.js'
import { s3Destination } from './backup-fixtures.js'
import { harness } from './harness.js'

const json = (response: Response) => response.json() as Promise<Record<string, any>>
const SNAPSHOT = 'a'.repeat(64)
const copy = {
  snapshot: '.config/maestrly-app/.maestrly-backup-staging/maestrly-agents.db',
  database: '.config/maestrly-app/maestrly-agents.db',
  bytes: 4096,
}
const answers: Record<string, { exitCode: number; stdout?: string }> = {
  cat: { exitCode: 10 },
  init: { exitCode: 0 },
  backup: {
    exitCode: 0,
    stdout: `{"message_type":"summary","snapshot_id":"${SNAPSHOT}","data_added":300,"total_bytes_processed":2000}`,
  },
  stats: { exitCode: 0, stdout: '{"total_size":5000}' },
}

/** A gateway whose environment copies its database, and whose helpers answer as restic would. */
async function setup() {
  const h = await harness(Date.now, {
    environments: true,
    instanceCapabilities: ['environment-backup'],
    instanceRoutes: (req, res) => {
      if (req.url !== '/v1/environment/backup') return false
      if (req.method === 'POST') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(copy))
      } else {
        res.writeHead(204)
        res.end()
      }
      return true
    },
  })
  h.docker.helperHandler = async (spec: HelperSpec) =>
    spec.command[0] === 'restic' ? (answers[spec.command[1]] ?? { exitCode: 0 }) : { exitCode: 0 }
  return h
}
const schedule = { kind: 'weekly', days: [], time: '03:00', timezone: 'UTC' }

describe('backup routes', () => {
  it('announces the feature past the 20 legacy ones', async () => {
    const h = await harness()
    const meta = await json(await fetch(h.origin + '/v1/meta'))
    expect(meta.moreFeatures).toContain('backups')
    expect(meta.features).not.toContain('backups')
    expect(meta.features).toHaveLength(20)
  })

  it('answers only paired devices', async () => {
    const h = await harness()
    const response = await fetch(h.origin + '/v1/backup', { headers: { [FLEET_PROTOCOL_HEADER]: '1' } })
    expect(response.status).toBe(401)
  })

  it('sets up a destination, backs up an environment and lists the run', async () => {
    const h = await setup()
    expect(await json(await h.request('GET', '/v1/backup'))).toMatchObject({ destination: null, enabled: false })
    const probe = await h.request('POST', '/v1/backup/probe', { destination: s3Destination })
    expect(await json(probe)).toEqual({ state: 'empty' })
    const connected = await h.request('PUT', '/v1/backup/destination', {
      mode: 'create',
      destination: s3Destination,
      idempotencyKey: randomUUID(),
    })
    expect(connected.status).toBe(200)
    const created = await json(connected)
    expect(created).toMatchObject({ ok: true, status: { destination: { provider: 's3' } } })
    expect(created.recoveryKey).toMatch(/^([A-Z2-7]{4}-){7}[A-Z2-7]{4}$/)
    const updated = await h.request('PATCH', '/v1/backup', { enabled: true, selection: { mode: 'all' }, schedule })
    expect(await json(updated)).toMatchObject({
      enabled: true,
      schedule,
      environments: [{ environmentId: 'test', included: true, eligibility: 'ok' }],
    })
    const started = await h.request('POST', '/v1/backup/runs', { environmentId: 'test', idempotencyKey: randomUUID() })
    expect(started.status).toBe(201)
    const run = await json(started)
    expect(run).toMatchObject({ kind: 'backup', trigger: 'manual', environmentId: 'test' })
    expect(run).not.toHaveProperty('volumeName')
    await h.gateway.backups.idle()
    const runs = await json(await h.request('GET', '/v1/backup/runs?environmentId=test'))
    expect(runs.runs).toEqual([expect.objectContaining({ id: run.id, state: 'succeeded', snapshotId: SNAPSHOT })])
    expect((await h.request('GET', '/v1/backup/runs?environmentId=Bad%20Id')).status).toBe(400)
    const status = await json(await h.request('GET', '/v1/backup'))
    expect(status.environments[0]).toMatchObject({ lastRun: { id: run.id, state: 'succeeded' } })
    expect(status.destination).toMatchObject({ repositoryBytes: 5000 })
    const cancel = await h.request('POST', `/v1/backup/runs/${run.id}/cancel`)
    expect(cancel.status).toBe(409)
  })

  it('gives the recovery key only when asked for it', async () => {
    const h = await setup()
    await h.request('PUT', '/v1/backup/destination', {
      mode: 'create',
      destination: s3Destination,
      idempotencyKey: randomUUID(),
    })
    const key = await json(await h.request('POST', '/v1/backup/recovery-key'))
    expect(key.recoveryKey).toMatch(/^([A-Z2-7]{4}-){7}[A-Z2-7]{4}$/)
    const status = JSON.stringify(await json(await h.request('GET', '/v1/backup')))
    expect(status).not.toContain(key.recoveryKey)
    expect(status).not.toContain(key.recoveryKey.replaceAll('-', ''))
    expect(status).not.toContain(s3Destination.secretAccessKey)
    const disconnected = await json(await h.request('DELETE', '/v1/backup/destination'))
    expect(disconnected.destination).toBeNull()
    expect((await h.request('POST', '/v1/backup/recovery-key')).status).toBe(404)
  })

  it('refuses a schedule more often than the shortest interval', async () => {
    const h = await setup()
    await h.request('PUT', '/v1/backup/destination', {
      mode: 'create',
      destination: s3Destination,
      idempotencyKey: randomUUID(),
    })
    const response = await h.request('PATCH', '/v1/backup', { schedule: { kind: 'interval', everyMinutes: 30 } })
    expect(response.status).toBe(400)
  })
})
