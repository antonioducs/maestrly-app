import type {
  FleetBackupRestorePreview,
  FleetBackupRun,
  FleetBackupSnapshotGroup,
  FleetBackupStatus,
} from '@maestrly/bot-fleet-protocol'
import { describe, expect, it } from 'vitest'
import {
  backupReducer,
  backupRowView,
  presetFromSchedule,
  restoreGroupView,
  restoreProblemKeys,
  s3MinimumPolicy,
  scheduleFromPreset,
} from '../../src/renderer/lib/fleet/backup'

const AT = '2026-11-07T03:00:00.000Z'
function run(overrides: Partial<FleetBackupRun> = {}): FleetBackupRun {
  return {
    id: '0b7a3c52-9d41-4c2e-8f60-1a2b3c4d5e6f',
    kind: 'backup',
    environmentId: 'work',
    environmentName: 'Work',
    trigger: 'schedule',
    state: 'running',
    phase: 'upload',
    progress: 0.42,
    snapshotId: null,
    bytesAdded: null,
    bytesTotal: null,
    error: null,
    startedAt: AT,
    finishedAt: null,
    ...overrides,
  }
}
type Row = FleetBackupStatus['environments'][number]
const row = (overrides: Partial<Row> = {}): Row => ({
  environmentId: 'work',
  included: true,
  eligibility: 'ok',
  nextRunAt: '2026-11-08T03:00:00.000Z',
  lastRun: null,
  lastSuccessAt: null,
  ...overrides,
})
function status(overrides: Partial<FleetBackupStatus> = {}): FleetBackupStatus {
  return {
    destination: { provider: 's3', label: 's3://my-bucket/maestrly-backups', account: '…1234', repositoryBytes: 5000 },
    enabled: true,
    schedule: { kind: 'weekly', days: [], time: '03:00', timezone: 'UTC' },
    retention: { daily: 7, weekly: 4, monthly: 6 },
    selection: { mode: 'all' },
    environments: [row(), row({ environmentId: 'home' })],
    active: [],
    ...overrides,
  }
}

describe('backup schedules', () => {
  it('makes a schedule from each preset', () => {
    expect(scheduleFromPreset({ kind: 'daily', time: '03:00' }, 'America/Sao_Paulo')).toEqual({
      kind: 'weekly',
      days: [],
      time: '03:00',
      timezone: 'America/Sao_Paulo',
    })
    expect(scheduleFromPreset({ kind: 'weekly', day: 7, time: '22:30' }, 'UTC')).toEqual({
      kind: 'weekly',
      days: [7],
      time: '22:30',
      timezone: 'UTC',
    })
    expect(scheduleFromPreset({ kind: 'hours', every: 6 }, 'UTC')).toEqual({ kind: 'interval', everyMinutes: 360 })
  })

  it('shows a schedule as the preset it came from, and daily at 03:00 without one', () => {
    for (const preset of [
      { kind: 'daily', time: '04:15' },
      { kind: 'weekly', day: 3, time: '01:00' },
      { kind: 'hours', every: 12 },
    ] as const)
      expect(presetFromSchedule(scheduleFromPreset(preset, 'UTC'))).toEqual(preset)
    expect(presetFromSchedule(null)).toEqual({ kind: 'daily', time: '03:00' })
    expect(presetFromSchedule({ kind: 'interval', everyMinutes: 300 })).toEqual({ kind: 'hours', every: 6 })
  })
})

describe('backup status', () => {
  it('replaces the status on backup.updated and ignores other events', () => {
    const next = status({ enabled: false })
    expect(backupReducer(status(), { type: 'backup.updated', at: AT, status: next })).toBe(next)
    const current = status()
    expect(backupReducer(current, { type: 'transcript.reset', at: AT, botId: 'alpha' })).toBe(current)
    expect(backupReducer(null, { type: 'backup_run.updated', at: AT, run: run() })).toBeNull()
  })

  it('follows a run until it ends', () => {
    const running = backupReducer(status(), { type: 'backup_run.updated', at: AT, run: run() })!
    expect(running.active).toEqual([run()])
    expect(running.environments[0].lastRun).toEqual(run())
    expect(running.environments[1].lastRun).toBeNull()
    const done = run({ state: 'succeeded', phase: 'finish', progress: 1, bytesAdded: 300, finishedAt: AT })
    const finished = backupReducer(running, { type: 'backup_run.updated', at: AT, run: done })!
    expect(finished.active).toEqual([])
    expect(finished.environments[0]).toMatchObject({ lastRun: done, lastSuccessAt: AT })
    const failed = run({ id: 'f', state: 'failed', error: { code: 'denied', message: 'x' }, finishedAt: AT })
    expect(backupReducer(finished, { type: 'backup_run.updated', at: AT, run: failed })!.environments[0]).toMatchObject(
      {
        lastRun: failed,
        lastSuccessAt: AT,
      }
    )
  })

  it("tells each environment's state", () => {
    expect(backupRowView(row(), run())).toMatchObject({
      tone: 'running',
      key: 'botServer.backups.status.running',
      values: { percent: 42 },
      running: { runId: run().id, progress: 0.42 },
    })
    expect(backupRowView(row(), run({ state: 'queued', progress: null }))).toMatchObject({
      tone: 'running',
      key: 'botServer.backups.status.queued',
    })
    const failed = row({ lastRun: run({ state: 'failed', error: { code: 'denied', message: 'refused' } }) })
    expect(backupRowView(failed, null)).toMatchObject({
      tone: 'error',
      key: 'botServer.backups.status.failed',
      error: { key: 'botServer.backups.errors.denied', values: { message: 'refused' } },
    })
    expect(backupRowView(row({ eligibility: 'shared-folder' }), null)).toMatchObject({
      tone: 'muted',
      key: 'botServer.backups.what.sharedFolder',
    })
    expect(backupRowView(row({ included: false }), null)).toMatchObject({
      tone: 'muted',
      key: 'botServer.backups.status.excluded',
    })
    const succeeded = row({ lastRun: run({ state: 'succeeded', bytesAdded: 300 }), lastSuccessAt: AT })
    expect(backupRowView(succeeded, null, { when: () => 'today', size: (bytes) => `${bytes} B` })).toEqual({
      tone: 'ok',
      key: 'botServer.backups.status.last',
      values: { when: 'today', size: '300 B' },
      next: { key: 'botServer.backups.status.next', values: { when: 'today' } },
      running: null,
    })
    expect(backupRowView(row({ nextRunAt: null }), null)).toMatchObject({
      key: 'botServer.backups.status.never',
      next: null,
    })
  })
})

describe('S3 permissions', () => {
  it('allows only listing the folder and reading, writing and deleting in it', () => {
    const policy = JSON.parse(s3MinimumPolicy('my-bucket', '/maestrly-backups/'))
    const statements = policy.Statement as Array<{ Action: string[]; Resource: string; Condition?: unknown }>
    expect(statements.flatMap((statement) => statement.Action).sort()).toEqual(
      ['s3:DeleteObject', 's3:GetBucketLocation', 's3:GetObject', 's3:ListBucket', 's3:PutObject'].sort()
    )
    expect(statements.map((statement) => statement.Resource)).toContain('arn:aws:s3:::my-bucket')
    expect(statements.map((statement) => statement.Resource)).toContain('arn:aws:s3:::my-bucket/maestrly-backups/*')
    expect(statements.find((statement) => statement.Action.includes('s3:ListBucket'))?.Condition).toEqual({
      StringLike: { 's3:prefix': ['maestrly-backups', 'maestrly-backups/*'] },
    })
  })
})

describe('restoring', () => {
  const group = (overrides: Partial<FleetBackupSnapshotGroup> = {}): FleetBackupSnapshotGroup => ({
    environmentId: 'work',
    name: 'Work',
    kind: 'bots',
    serverId: 'other-server',
    serverName: 'Home server',
    thisServer: false,
    taken: false,
    snapshots: [
      { id: 'b'.repeat(64), at: '2026-11-07T03:00:00.000Z', format: 1 },
      { id: 'a'.repeat(64), at: '2026-11-06T03:00:00.000Z', format: 1 },
    ],
    ...overrides,
  })

  it('lists an environment with its server and newest backup, and disables one taken here', () => {
    expect(restoreGroupView(group())).toEqual({
      disabled: false,
      reason: null,
      from: { key: 'botServer.backups.restoreDialog.fromServer', values: { server: 'Home server' } },
      latest: group().snapshots[0],
    })
    expect(restoreGroupView(group({ thisServer: true, taken: true }))).toMatchObject({
      disabled: true,
      reason: { key: 'botServer.backups.restoreDialog.taken' },
      from: null,
    })
  })

  it('names what keeps a backup from coming back', () => {
    const preview: FleetBackupRestorePreview = {
      snapshotId: 'b'.repeat(64),
      at: '2026-11-07T03:00:00.000Z',
      environment: { id: 'work', name: 'Work', kind: 'workspaces' },
      bots: [
        { id: 'ana', name: 'Ana', taken: true },
        { id: 'bea', name: 'Bea', taken: false },
        { id: 'cid', name: 'Cid', taken: true },
      ],
      projects: { path: '/srv/maestrly/work', state: 'absent' },
      problems: ['environment-taken', 'bot-taken', 'workspaces-root-different', 'workspaces-limit'],
    }
    expect(restoreProblemKeys(preview)).toEqual([
      { key: 'botServer.backups.restoreDialog.problems.environment-taken', values: {} },
      { key: 'botServer.backups.restoreDialog.problems.bot-taken', values: { names: 'Ana, Cid' } },
      {
        key: 'botServer.backups.restoreDialog.problems.workspaces-root-different',
        values: { path: '/srv/maestrly/work' },
      },
      { key: 'botServer.backups.restoreDialog.problems.workspaces-limit', values: {} },
    ])
    expect(restoreProblemKeys({ ...preview, problems: [] })).toEqual([])
  })
})
