import type {
  HostTransferDirection,
  HostTransferError,
  HostTransferKind,
  HostTransferStage,
  HostTransferState,
} from '../../shared/host-transfers'
import { getDb, transaction } from '../store'
import type { HostTransferRange } from './ranges'

/** A transfer as the queue records it; `doneBytes` sums its finished ranges. */
export interface HostTransferRecord {
  id: string
  hostId: string
  direction: HostTransferDirection
  purpose: 'save' | 'open'
  kind: HostTransferKind
  /** Where a folder's transfer stands; null for a file. */
  stage: HostTransferStage | null
  /** The host's archive of a folder being downloaded. */
  archiveId: string | null
  /** The archive a folder moves as: the host's for a download, the one packed on this computer for an upload. */
  archivePath: string | null
  name: string
  remotePath: string
  /** Where an upload goes on the host. */
  remoteDirectory: string | null
  localPath: string | null
  /** Where a download is published on this computer. */
  localDirectory: string | null
  partialPath: string | null
  size: number
  /** The version of the file the transfer reads: the host's for a download, this computer's for an upload. */
  identity: string
  uploadId: string | null
  overwrite: boolean
  state: HostTransferState
  error: HostTransferError | null
  errorMessage: string | null
  remoteSha256: string | null
  localSha256: string | null
  createdAt: number
  finishedAt: number | null
  doneBytes: number
}

export type NewHostTransfer = Omit<
  HostTransferRecord,
  | 'uploadId'
  | 'state'
  | 'error'
  | 'errorMessage'
  | 'remoteSha256'
  | 'localSha256'
  | 'finishedAt'
  | 'doneBytes'
  | 'kind'
  | 'stage'
  | 'archiveId'
  | 'archivePath'
> & { kind?: HostTransferKind; stage?: HostTransferStage | null }

export type HostTransferPatch = Partial<
  Pick<
    HostTransferRecord,
    | 'state'
    | 'error'
    | 'errorMessage'
    | 'uploadId'
    | 'remotePath'
    | 'localPath'
    | 'overwrite'
    | 'remoteSha256'
    | 'localSha256'
    | 'finishedAt'
    | 'stage'
    | 'archiveId'
    | 'archivePath'
  >
>

const COLUMNS: Record<keyof HostTransferPatch, string> = {
  state: 'state',
  error: 'error',
  errorMessage: 'error_message',
  uploadId: 'upload_id',
  remotePath: 'remote_path',
  localPath: 'local_path',
  overwrite: 'overwrite',
  remoteSha256: 'remote_sha256',
  localSha256: 'local_sha256',
  finishedAt: 'finished_at',
  stage: 'stage',
  archiveId: 'archive_id',
  archivePath: 'archive_path',
}
const LIST_LIMIT = 500

type Row = Record<string, unknown>
const text = (value: unknown): string | null => (value === null || value === undefined ? null : String(value))

function record(row: Row): HostTransferRecord {
  return {
    id: String(row.id),
    hostId: String(row.host_id),
    direction: row.direction as HostTransferDirection,
    purpose: row.purpose as 'save' | 'open',
    kind: row.kind === 'folder' ? 'folder' : 'file',
    stage: text(row.stage) as HostTransferStage | null,
    archiveId: text(row.archive_id),
    archivePath: text(row.archive_path),
    name: String(row.name),
    remotePath: String(row.remote_path),
    remoteDirectory: text(row.remote_directory),
    localPath: text(row.local_path),
    localDirectory: text(row.local_directory),
    partialPath: text(row.partial_path),
    size: Number(row.size),
    identity: String(row.identity),
    uploadId: text(row.upload_id),
    overwrite: Number(row.overwrite) === 1,
    state: row.state as HostTransferState,
    error: text(row.error) as HostTransferError | null,
    errorMessage: text(row.error_message),
    remoteSha256: text(row.remote_sha256),
    localSha256: text(row.local_sha256),
    createdAt: Number(row.created_at),
    finishedAt: row.finished_at === null || row.finished_at === undefined ? null : Number(row.finished_at),
    doneBytes: Number(row.done_bytes ?? 0),
  }
}

const SELECT = `
  SELECT t.*, COALESCE(SUM(CASE WHEN r.done = 1 THEN r.length ELSE 0 END), 0) AS done_bytes
  FROM host_transfers t LEFT JOIN host_transfer_ranges r ON r.transfer_id = t.id`

function insertRanges(id: string, ranges: HostTransferRange[]): void {
  const insert = getDb().prepare(
    'INSERT INTO host_transfer_ranges (transfer_id, idx, start, length) VALUES (?, ?, ?, ?)'
  )
  for (const range of ranges) insert.run(id, range.index, range.start, range.length)
}

export function insertHostTransfer(transfer: NewHostTransfer, ranges: HostTransferRange[]): void {
  transaction(() => {
    getDb()
      .prepare(
        `INSERT INTO host_transfers (id, host_id, direction, purpose, name, remote_path, remote_directory, local_path,
          local_directory, partial_path, size, identity, overwrite, state, created_at, kind, stage)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`
      )
      .run(
        transfer.id,
        transfer.hostId,
        transfer.direction,
        transfer.purpose,
        transfer.name,
        transfer.remotePath,
        transfer.remoteDirectory,
        transfer.localPath,
        transfer.localDirectory,
        transfer.partialPath,
        transfer.size,
        transfer.identity,
        transfer.overwrite ? 1 : 0,
        transfer.createdAt,
        transfer.kind ?? 'file',
        transfer.stage ?? null
      )
    insertRanges(transfer.id, ranges)
  })
}

export function getHostTransfer(id: string): HostTransferRecord | null {
  const row = getDb().prepare(`${SELECT} WHERE t.id = ? GROUP BY t.id`).get(id) as Row | undefined
  return row ? record(row) : null
}

/**
 * Transfers in the order they were queued. Filtered by state, every match (the scheduler reads the queue);
 * otherwise the newest ones, up to a bound.
 */
export function listHostTransfers(options: { states?: HostTransferState[] } = {}): HostTransferRecord[] {
  const states = options.states
  if (states) {
    if (!states.length) return []
    const rows = getDb()
      .prepare(
        `${SELECT} WHERE t.state IN (${states.map(() => '?').join(', ')}) GROUP BY t.id ORDER BY t.created_at, t.id`
      )
      .all(...states) as Row[]
    return rows.map(record)
  }
  const rows = getDb()
    .prepare(`${SELECT} GROUP BY t.id ORDER BY t.created_at DESC, t.id DESC LIMIT ${LIST_LIMIT}`)
    .all() as Row[]
  return rows.map(record).reverse()
}

export function updateHostTransfer(id: string, patch: HostTransferPatch): void {
  const entries = Object.entries(patch).filter(([key]) => key in COLUMNS) as Array<[keyof HostTransferPatch, unknown]>
  if (!entries.length) return
  const values = entries.map(([key, value]) => (key === 'overwrite' ? (value ? 1 : 0) : (value ?? null)))
  getDb()
    .prepare(`UPDATE host_transfers SET ${entries.map(([key]) => `${COLUMNS[key]} = ?`).join(', ')} WHERE id = ?`)
    .run(...(values as Array<string | number | null>), id)
}

export function pendingHostTransferRanges(id: string): HostTransferRange[] {
  const rows = getDb()
    .prepare('SELECT idx, start, length FROM host_transfer_ranges WHERE transfer_id = ? AND done = 0 ORDER BY idx')
    .all(id) as Row[]
  return rows.map((row) => ({ index: Number(row.idx), start: Number(row.start), length: Number(row.length) }))
}

export function finishHostTransferRange(id: string, index: number): void {
  getDb().prepare('UPDATE host_transfer_ranges SET done = 1 WHERE transfer_id = ? AND idx = ?').run(id, index)
}

/** Starts a transfer over for a new version of its file: new ranges, no host session and no checksums. */
export function restartHostTransfer(
  id: string,
  file: { size: number; identity: string },
  ranges: HostTransferRange[]
): void {
  transaction(() => {
    getDb().prepare('DELETE FROM host_transfer_ranges WHERE transfer_id = ?').run(id)
    getDb()
      .prepare(
        `UPDATE host_transfers SET size = ?, identity = ?, upload_id = NULL, remote_sha256 = NULL, local_sha256 = NULL
         WHERE id = ?`
      )
      .run(file.size, file.identity, id)
    insertRanges(id, ranges)
  })
}

export function deleteHostTransfer(id: string): void {
  getDb().prepare('DELETE FROM host_transfers WHERE id = ?').run(id)
}

/** What the app was moving when it quit is queued again; what the person paused stays paused. */
export function recoverInterruptedHostTransfers(): number {
  const result = getDb()
    .prepare("UPDATE host_transfers SET state = 'queued' WHERE state IN ('running', 'waiting', 'verifying')")
    .run()
  return Number(result.changes)
}
