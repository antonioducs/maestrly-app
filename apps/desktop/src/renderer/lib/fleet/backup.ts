import {
  type FleetBackupError,
  type FleetBackupRestorePreview,
  type FleetBackupRun,
  type FleetBackupSnapshotGroup,
  type FleetBackupSchedule,
  type FleetBackupStatus,
  type FleetGatewayEvent,
  isFleetBackupEvent,
} from '@maestrly/bot-fleet-protocol'

/** When backups run, as the owner picks it: one of three simple forms. */
export type BackupSchedulePreset =
  | { kind: 'daily'; time: string }
  /** `day`: ISO weekday, 1 (Monday) to 7. */
  | { kind: 'weekly'; day: number; time: string }
  /** `every`: one of BACKUP_HOUR_CHOICES. */
  | { kind: 'hours'; every: number }
export const BACKUP_HOUR_CHOICES = [1, 2, 3, 4, 6, 8, 12, 24] as const
const DEFAULT_PRESET: BackupSchedulePreset = { kind: 'daily', time: '03:00' }

export function scheduleFromPreset(preset: BackupSchedulePreset, timezone: string): FleetBackupSchedule {
  if (preset.kind === 'hours') return { kind: 'interval', everyMinutes: preset.every * 60 }
  return { kind: 'weekly', days: preset.kind === 'daily' ? [] : [preset.day], time: preset.time, timezone }
}
/** The preset a schedule shows as; a schedule none of them makes shows as the nearest one. Null: daily at 03:00. */
export function presetFromSchedule(schedule: FleetBackupSchedule | null): BackupSchedulePreset {
  if (!schedule) return DEFAULT_PRESET
  if (schedule.kind === 'interval') {
    const hours = schedule.everyMinutes / 60
    const every = BACKUP_HOUR_CHOICES.find((choice) => choice >= hours) ?? 24
    return { kind: 'hours', every }
  }
  if (schedule.days.length === 1) return { kind: 'weekly', day: schedule.days[0], time: schedule.time }
  return { kind: 'daily', time: schedule.time }
}

const FINISHED: ReadonlySet<FleetBackupRun['state']> = new Set(['succeeded', 'partial', 'failed', 'cancelled'])
export const backupRunFinished = (run: FleetBackupRun): boolean => FINISHED.has(run.state)

/** The status after a backup event; other events leave it as it is. */
export function backupReducer(status: FleetBackupStatus | null, event: FleetGatewayEvent): FleetBackupStatus | null {
  if (!isFleetBackupEvent(event)) return status
  if (event.type === 'backup.updated') return event.status
  if (event.type !== 'backup_run.updated' || !status) return status
  const { run } = event
  const finished = backupRunFinished(run)
  const others = status.active.filter((item) => item.id !== run.id)
  return {
    ...status,
    active: finished ? others : [...others, run],
    environments: status.environments.map((row) =>
      row.environmentId !== run.environmentId
        ? row
        : {
            ...row,
            lastRun: run,
            lastSuccessAt:
              run.kind === 'backup' && (run.state === 'succeeded' || run.state === 'partial')
                ? (run.finishedAt ?? row.lastSuccessAt)
                : row.lastSuccessAt,
          }
    ),
  }
}

/** A translation key with its values. */
export type BackupText = { key: string; values: Record<string, string | number> }
/** How the text of a backup error reads. */
export function backupErrorText(error: Pick<FleetBackupError, 'code' | 'message'>): BackupText {
  return { key: `botServer.backups.errors.${error.code}`, values: { message: error.message } }
}

export type BackupRowView = BackupText & {
  tone: 'ok' | 'running' | 'warning' | 'error' | 'muted'
  /** The reason of a failed backup, translated into the `reason` value of the row's text. */
  error?: BackupText
  /** When the next backup runs; null when none is scheduled. */
  next: BackupText | null
  running: { runId: string; progress: number | null } | null
}
type Formats = { when: (iso: string) => string; size: (bytes: number) => string }
const RAW: Formats = { when: (iso) => iso, size: (bytes) => String(bytes) }

/** What an environment's row says about its backups. */
export function backupRowView(
  row: FleetBackupStatus['environments'][number],
  active: FleetBackupRun | null,
  formats: Formats = RAW
): BackupRowView {
  const next = row.nextRunAt
    ? { key: 'botServer.backups.status.next', values: { when: formats.when(row.nextRunAt) } }
    : null
  const base = { next, running: null }
  if (active && active.kind === 'backup') {
    const percent = active.progress === null ? 0 : Math.round(active.progress * 100)
    return {
      ...base,
      tone: 'running',
      key: active.state === 'queued' ? 'botServer.backups.status.queued' : 'botServer.backups.status.running',
      values: { percent },
      running: { runId: active.id, progress: active.progress },
    }
  }
  if (row.eligibility === 'shared-folder')
    return { ...base, tone: 'muted', key: 'botServer.backups.what.sharedFolder', values: {} }
  if (row.eligibility === 'archived')
    return { ...base, tone: 'muted', key: 'botServer.backups.what.archived', values: {} }
  if (!row.included) return { ...base, tone: 'muted', key: 'botServer.backups.status.excluded', values: {} }
  const last = row.lastRun?.kind === 'backup' ? row.lastRun : null
  if (last && (last.state === 'failed' || last.state === 'cancelled') && last.error)
    return {
      ...base,
      tone: 'error',
      key: 'botServer.backups.status.failed',
      values: {},
      error: backupErrorText(last.error),
    }
  if (row.eligibility === 'update-environment')
    return { ...base, tone: 'warning', key: 'botServer.backups.errors.update-environment', values: { message: '' } }
  if (row.lastSuccessAt) {
    const size = last?.bytesAdded ?? null
    return {
      ...base,
      tone: last?.state === 'partial' ? 'warning' : 'ok',
      key: size === null ? 'botServer.backups.status.lastAt' : 'botServer.backups.status.last',
      values: { when: formats.when(row.lastSuccessAt), ...(size === null ? {} : { size: formats.size(size) }) },
    }
  }
  if (row.eligibility === 'not-ready')
    return { ...base, tone: 'muted', key: 'botServer.backups.what.notReady', values: {} }
  return { ...base, tone: 'muted', key: 'botServer.backups.status.never', values: {} }
}

/** The narrowest IAM policy restic needs on one bucket's folder: list the folder, then read, write and delete in it. */
export function s3MinimumPolicy(bucket: string, prefix: string): string {
  const folder = prefix.replace(/^\/+|\/+$/g, '')
  return JSON.stringify(
    {
      Version: '2012-10-17',
      Statement: [
        // Asked without a prefix, so it cannot share the listing's condition.
        { Effect: 'Allow', Action: ['s3:GetBucketLocation'], Resource: `arn:aws:s3:::${bucket}` },
        {
          Effect: 'Allow',
          Action: ['s3:ListBucket'],
          Resource: `arn:aws:s3:::${bucket}`,
          Condition: { StringLike: { 's3:prefix': [folder, `${folder}/*`] } },
        },
        {
          Effect: 'Allow',
          Action: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
          Resource: `arn:aws:s3:::${bucket}/${folder}/*`,
        },
      ],
    },
    null,
    2
  )
}

/** How an environment backed up at the destination shows in the list to restore from. */
export type RestoreGroupView = {
  disabled: boolean
  /** Why it cannot be restored here, when it cannot. */
  reason: BackupText | null
  /** The server it was backed up from, when not this one. */
  from: BackupText | null
  latest: FleetBackupSnapshotGroup['snapshots'][number] | null
}
export function restoreGroupView(group: FleetBackupSnapshotGroup): RestoreGroupView {
  return {
    disabled: group.taken || group.snapshots.length === 0,
    reason: group.taken ? { key: 'botServer.backups.restoreDialog.taken', values: {} } : null,
    from: group.thisServer
      ? null
      : { key: 'botServer.backups.restoreDialog.fromServer', values: { server: group.serverName || group.serverId } },
    latest: group.snapshots[0] ?? null,
  }
}
/** What keeps a backup from coming back here, as texts. */
export function restoreProblemKeys(preview: FleetBackupRestorePreview): BackupText[] {
  return preview.problems.map((problem): BackupText => {
    const key = `botServer.backups.restoreDialog.problems.${problem}`
    if (problem === 'bot-taken')
      return {
        key,
        values: {
          names: preview.bots
            .filter((bot) => bot.taken)
            .map((bot) => bot.name)
            .join(', '),
        },
      }
    if (problem === 'workspaces-root-different') return { key, values: { path: preview.projects?.path ?? '' } }
    return { key, values: {} }
  })
}
