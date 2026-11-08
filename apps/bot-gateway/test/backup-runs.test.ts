import { randomUUID } from 'node:crypto'
import { FLEET_BACKUP_LIMITS, type FleetGatewayEvent } from '@maestrly/bot-fleet-protocol'
import { describe, expect, it } from 'vitest'
import { BackupHelper } from '../src/backups/helper.js'
import { Backups } from '../src/backups/service.js'
import { readBackupSlice } from '../src/backups/slice.js'
import type { ContainerSpec, HelperSpec } from '../src/docker.js'
import { backupRun, backupSettings } from './backup-fixtures.js'
import { harness } from './harness.js'

const SNAPSHOT = 'c'.repeat(64)
const copy = {
  snapshot: '.config/maestrly-app/.maestrly-backup-staging/maestrly-agents.db',
  database: '.config/maestrly-app/maestrly-agents.db',
  bytes: 4096,
}
const summary = (id = SNAPSHOT) =>
  [
    '{"message_type":"status","percent_done":0.5,"total_bytes":2000}',
    `{"message_type":"summary","snapshot_id":"${id}","data_added":300,"total_bytes_processed":2000}`,
  ].join('\n')
type Answer = { exitCode: number; stdout?: string; stderr?: string }
type Handler = (spec: HelperSpec) => Answer | Promise<Answer>

async function setup(options: { capable?: boolean; answers?: Record<string, Answer | Handler> } = {}) {
  const order: string[] = []
  const h = await harness(Date.now, {
    environments: true,
    instanceCapabilities: options.capable === false ? [] : ['environment-backup'],
    instanceRoutes: (req, res) => {
      if (req.url !== '/v1/environment/backup') return false
      order.push(req.method + ' copy')
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
  const answers: Record<string, Answer | Handler> = {
    backup: { exitCode: 0, stdout: summary() },
    stats: { exitCode: 0, stdout: '{"total_size":5000}' },
    ...options.answers,
  }
  h.docker.helperHandler = async (spec) => {
    if (spec.command[0] !== 'restic') return { exitCode: 0 }
    order.push('restic ' + spec.command[1])
    const answer = answers[spec.command[1]] ?? { exitCode: 0 }
    return typeof answer === 'function' ? answer(spec) : answer
  }
  const clock = { now: Date.parse('2026-11-07T02:59:00.000Z') }
  const events: FleetGatewayEvent[] = []
  const backups = new Backups({
    store: h.store,
    lifecycle: h.lifecycle,
    helper: new BackupHelper(h.docker, h.lifecycle.config),
    config: h.lifecycle.config,
    emit: (event) => events.push(event),
    gatewayVersion: '1.0.0',
    serverName: () => 'Home server',
    now: () => clock.now,
  })
  h.lifecycle.beforeEnvironmentPurge = (id) => backups.beforePurge(id)
  h.store.saveBackupSettings(backupSettings())
  const restic = (command: string) => h.docker.helperRuns.filter((spec) => spec.command[1] === command)
  const runNow = () => backups.runNow({ environmentId: 'test', idempotencyKey: randomUUID() })
  return { ...h, order, clock, events, backups, restic, runNow }
}
async function until(test: () => boolean) {
  for (let i = 0; i < 300; i++) {
    if (test()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Timed out')
}
const waitForAbort = (spec: HelperSpec) =>
  new Promise<Answer>((resolve) => spec.signal?.addEventListener('abort', () => resolve({ exitCode: 137 })))

describe('scheduled backups', () => {
  it('backs up a running environment when it is due, with a copy of its database', async () => {
    const f = await setup()
    await f.backups.tick()
    expect(f.backups.runs()).toEqual([])
    expect(f.store.backupEnvironments()).toEqual([{ environmentId: 'test', nextRunAt: '2026-11-07T03:00:00.000Z' }])
    f.clock.now = Date.parse('2026-11-07T03:00:00.000Z')
    await f.backups.tick()
    await f.backups.idle()
    const [run] = f.backups.runs()
    expect(run).toMatchObject({
      kind: 'backup',
      trigger: 'schedule',
      state: 'succeeded',
      snapshotId: SNAPSHOT,
      bytesAdded: 300,
      bytesTotal: 2000,
      error: null,
    })
    const [spec] = f.restic('backup')
    const environment = f.store.getEnvironment('test')!
    expect(spec.mounts).toContainEqual({
      type: 'volume',
      source: environment.volumeName,
      target: '/home/bot',
      readOnly: true,
    })
    expect(spec.files).toHaveLength(1)
    expect(spec.files[0]).toMatchObject({ path: 'tmp/maestrly-backup/gateway.json', mode: 0o600 })
    const slice = readBackupSlice(String(spec.files[0].content))
    expect(slice.ok && slice.slice.keyringPassword).toBe(f.store.environmentSecrets('test')!.keyringPassword)
    expect(slice.ok && slice.slice.files.database).toEqual({ snapshot: copy.snapshot, live: copy.database })
    const args = spec.command.slice(1)
    expect(args.slice(args.indexOf('--host'), args.indexOf('--host') + 2)).toEqual(['--host', f.store.serverId()])
    expect(args).toContain('env:test')
    expect(args.slice(args.indexOf('--')).slice(1)).toEqual(['/home/bot', '/tmp/maestrly-backup/gateway.json'])
    expect(args[args.indexOf('/home/bot/.config/maestrly-app/maestrly-agents.db') - 1]).toBe('--exclude')
    expect(f.order).toEqual([
      'POST copy',
      'restic backup',
      'DELETE copy',
      'restic forget',
      'restic prune',
      'restic check',
      'restic stats',
    ])
    expect(f.store.backupEnvironments()).toEqual([{ environmentId: 'test', nextRunAt: '2026-11-08T03:00:00.000Z' }])
    expect(f.store.backupSettings()).toMatchObject({ repositoryBytes: 5000, lastPruneAt: '2026-11-07T03:00:00.000Z' })
    expect(f.backups.status().environments[0]).toMatchObject({ lastSuccessAt: '2026-11-07T03:00:00.000Z' })
  })

  it('reads a stopped environment as it is', async () => {
    const f = await setup()
    await f.lifecycle.stopEnvironment('test')
    f.runNow()
    await f.backups.idle()
    expect(f.backups.runs()[0]).toMatchObject({ state: 'succeeded', trigger: 'manual' })
    expect(f.order).not.toContain('POST copy')
    const args = f.restic('backup')[0].command
    expect(args).toContain('/home/bot/.config/**/.maestrly-backup-staging')
    expect(args.some((value) => value.endsWith('maestrly-agents.db'))).toBe(false)
  })

  it('fails the backup of a running environment that cannot copy its database', async () => {
    const f = await setup({ capable: false })
    expect(() => f.runNow()).toThrow('Update this environment')
    f.store.setBackupNextRun('test', '2026-11-07T02:00:00.000Z')
    await f.backups.tick()
    await f.backups.idle()
    expect(f.backups.runs()[0]).toMatchObject({ state: 'failed', error: { code: 'update-environment' } })
    expect(f.restic('backup')).toHaveLength(0)
  })

  it('tells a backup that missed files from one that failed, without secrets', async () => {
    const partial = await setup({ answers: { backup: { exitCode: 3, stdout: summary(), stderr: 'error: open x' } } })
    partial.runNow()
    await partial.backups.idle()
    expect(partial.backups.runs()[0]).toMatchObject({ state: 'partial', snapshotId: SNAPSHOT })
    const denied = await setup({
      answers: { backup: { exitCode: 1, stderr: 'Fatal: secret-example-value refused: AccessDenied' } },
    })
    denied.runNow()
    await denied.backups.idle()
    const [run] = denied.backups.runs()
    expect(run).toMatchObject({ state: 'failed', error: { code: 'denied' } })
    expect(run.error?.message).toContain('[redacted]')
    expect(JSON.stringify(denied.events)).not.toContain('secret-example-value')
    expect(denied.restic('forget')).toHaveLength(0)
  })

  it('prunes and checks the repository once a week', async () => {
    const f = await setup()
    f.runNow()
    await f.backups.idle()
    expect(f.restic('prune')).toHaveLength(1)
    expect(f.restic('check')).toHaveLength(1)
    f.clock.now += 24 * 60 * 60_000
    f.runNow()
    await f.backups.idle()
    expect(f.restic('backup')).toHaveLength(2)
    expect(f.restic('forget')).toHaveLength(2)
    expect(f.restic('prune')).toHaveLength(1)
  })

  it('waits for an environment that is updating, for a while', async () => {
    const f = await setup()
    f.store.updateEnvironment('test', { updateRequestedAt: new Date().toISOString() })
    const run = f.runNow()
    await f.backups.idle()
    expect(f.backups.runs()[0]).toMatchObject({ id: run.id, state: 'queued' })
    f.clock.now += FLEET_BACKUP_LIMITS.deferMaxMs + 60_000
    await f.backups.tick()
    await f.backups.idle()
    expect(f.backups.runs()[0]).toMatchObject({ id: run.id, state: 'failed', error: { code: 'busy' } })
    expect(f.restic('backup')).toHaveLength(0)
  })

  it('cancels a running backup', async () => {
    const f = await setup({ answers: { backup: waitForAbort } })
    const run = f.runNow()
    await until(() => f.restic('backup').length === 1)
    expect(f.backups.cancel(run.id)).toMatchObject({ id: run.id, state: 'running' })
    await f.backups.idle()
    expect(f.backups.runs()[0]).toMatchObject({ id: run.id, state: 'cancelled', error: { code: 'cancelled' } })
    expect(f.order).toContain('DELETE copy')
    expect(() => f.backups.cancel(run.id)).toThrow('already ended')
  })

  it('backs up an environment once at a time', async () => {
    const f = await setup()
    const first = f.runNow()
    expect(f.runNow().id).toBe(first.id)
    await f.backups.idle()
    expect(f.restic('backup')).toHaveLength(1)
  })

  it('ends what a restart of the gateway interrupted', async () => {
    const f = await setup()
    f.store.saveBackupSettings(backupSettings({ enabled: false }))
    f.store.saveBackupRun(
      backupRun('old', { environmentId: 'test', state: 'running', phase: 'upload', finishedAt: null })
    )
    f.docker.containers.set('leftover', {
      id: 'leftover',
      imageId: 'image',
      name: 'leftover',
      state: 'running',
      startedAt: null,
      labels: { 'org.maestrly.fleet.helper': 'backup' },
      spec: { volume: 'none', network: 'none' } as ContainerSpec,
    })
    await f.backups.start()
    f.backups.stop()
    expect(f.store.backupRun('old')).toMatchObject({ state: 'failed', error: { code: 'interrupted' } })
    expect(f.docker.containers.has('leftover')).toBe(false)
  })

  it('lets a backup go before its environment is deleted', async () => {
    const f = await setup({ answers: { backup: waitForAbort } })
    const run = f.runNow()
    await until(() => f.restic('backup').length === 1)
    await f.lifecycle.archiveEnvironment('test')
    await f.lifecycle.purgeEnvironment('test')
    expect(f.store.getEnvironment('test')).toBeNull()
    expect(f.store.backupRun(run.id)).toMatchObject({ state: 'cancelled' })
  })

  it('tells devices each phase of a run', async () => {
    const f = await setup()
    const run = f.runNow()
    await f.backups.idle()
    const phases = f.events
      .flatMap((event) => (event.type === 'backup_run.updated' && event.run.id === run.id ? [event.run.phase] : []))
      .filter((phase, index, all) => phase !== all[index - 1])
    expect(phases).toEqual(['queued', 'snapshot', 'upload', 'retention', 'finish'])
    expect(f.events.at(-1)?.type).toBe('backup.updated')
  })
})
