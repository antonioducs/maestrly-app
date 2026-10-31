import type {
  TurnChangeTotals,
  TurnFileChange,
  TurnSnapshotStatus,
  TurnSnapshotUnavailableReason,
} from '../../shared/turn-snapshots'
import { getDb } from '../store'
import type { SkippedFile } from './capture'
import type { PathState } from './changes'

/** Persistence of snapshotted turns in `chat_turn_snapshots`. */

export interface SnapshotRoot {
  storeKey: string
  dirKey: string
  /** Real path of the folder when the turn started. */
  path: string
  label?: string
  startTree: string | null
  endTree: string | null
  startSkipped: SkippedFile[]
  endSkipped: SkippedFile[]
}

export interface StoredSummary {
  files: TurnFileChange[]
  totals: TurnChangeTotals
  truncated: boolean
}

export interface RevertFileState {
  root: number
  path: string
  state: 'undone' | 'redone'
  /** The file before the last undo, kept by that operation's ref: what a redo writes back. */
  pre: PathState
  /** What the last undo wrote. */
  post: PathState
  /** Tree holding `pre`, for previews and reads. */
  preTree: string
  op: number
  at: number
}

export interface StoredRevert {
  ops: number
  files: Record<string, RevertFileState>
}

export interface TurnSnapshotRecord {
  id: string
  conversationId: string
  userMessageId: string
  assistantMessageId: string | null
  status: TurnSnapshotStatus
  unavailableReason: TurnSnapshotUnavailableReason | null
  roots: SnapshotRoot[]
  summary: StoredSummary | null
  overlap: string[]
  revert: StoredRevert | null
  startedAt: number
  endedAt: number | null
}

export const revertKey = (root: number, file: string): string => `${root}\0${file}`

interface Row {
  id: string
  conversation_id: string
  user_message_id: string
  assistant_message_id: string | null
  status: string
  unavailable_reason: string | null
  roots_json: string
  summary_json: string | null
  overlap_json: string | null
  revert_json: string | null
  started_at: number
  ended_at: number | null
}

function parse<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function fromRow(row: Row): TurnSnapshotRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    userMessageId: row.user_message_id,
    assistantMessageId: row.assistant_message_id,
    status: row.status as TurnSnapshotStatus,
    unavailableReason: (row.unavailable_reason as TurnSnapshotUnavailableReason | null) ?? null,
    roots: parse<SnapshotRoot[]>(row.roots_json, []),
    summary: parse<StoredSummary | null>(row.summary_json, null),
    overlap: parse<string[]>(row.overlap_json, []),
    revert: parse<StoredRevert | null>(row.revert_json, null),
    startedAt: row.started_at,
    endedAt: row.ended_at,
  }
}

export function insertSnapshotRecord(record: TurnSnapshotRecord): void {
  getDb()
    .prepare(
      `INSERT INTO chat_turn_snapshots (id, conversation_id, user_message_id, assistant_message_id, status,
        unavailable_reason, roots_json, summary_json, overlap_json, revert_json, started_at, ended_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      record.id,
      record.conversationId,
      record.userMessageId,
      record.assistantMessageId,
      record.status,
      record.unavailableReason,
      JSON.stringify(record.roots),
      record.summary ? JSON.stringify(record.summary) : null,
      JSON.stringify(record.overlap),
      record.revert ? JSON.stringify(record.revert) : null,
      record.startedAt,
      record.endedAt
    )
}

export type SnapshotRecordPatch = Partial<
  Pick<
    TurnSnapshotRecord,
    'assistantMessageId' | 'status' | 'unavailableReason' | 'roots' | 'summary' | 'overlap' | 'revert' | 'endedAt'
  >
>

/** Updates the row if it still exists (its message may have been deleted meanwhile). */
export function updateSnapshotRecord(id: string, patch: SnapshotRecordPatch): boolean {
  const sets: string[] = []
  const values: Array<string | number | null> = []
  const set = (column: string, value: string | number | null) => {
    sets.push(`${column} = ?`)
    values.push(value)
  }
  if ('assistantMessageId' in patch) set('assistant_message_id', patch.assistantMessageId ?? null)
  if ('status' in patch) set('status', patch.status!)
  if ('unavailableReason' in patch) set('unavailable_reason', patch.unavailableReason ?? null)
  if ('roots' in patch) set('roots_json', JSON.stringify(patch.roots ?? []))
  if ('summary' in patch) set('summary_json', patch.summary ? JSON.stringify(patch.summary) : null)
  if ('overlap' in patch) set('overlap_json', JSON.stringify(patch.overlap ?? []))
  if ('revert' in patch) set('revert_json', patch.revert ? JSON.stringify(patch.revert) : null)
  if ('endedAt' in patch) set('ended_at', patch.endedAt ?? null)
  if (!sets.length) return false
  const result = getDb()
    .prepare(`UPDATE chat_turn_snapshots SET ${sets.join(', ')} WHERE id = ?`)
    .run(...values, id)
  return Number(result.changes) > 0
}

export function getSnapshotRecord(id: string): TurnSnapshotRecord | null {
  const row = getDb().prepare('SELECT * FROM chat_turn_snapshots WHERE id = ?').get(id) as Row | undefined
  return row ? fromRow(row) : null
}

export function listSnapshotRecords(conversationId: string): TurnSnapshotRecord[] {
  const rows = getDb()
    .prepare('SELECT * FROM chat_turn_snapshots WHERE conversation_id = ? ORDER BY started_at, id')
    .all(conversationId) as unknown as Row[]
  return rows.map(fromRow)
}

/** Records of these conversations that started at or after `startedAt`. */
export function snapshotRecordsSince(conversationIds: readonly string[], startedAt: number): TurnSnapshotRecord[] {
  if (!conversationIds.length) return []
  const placeholders = conversationIds.map(() => '?').join(', ')
  const rows = getDb()
    .prepare(
      `SELECT * FROM chat_turn_snapshots WHERE conversation_id IN (${placeholders}) AND started_at >= ?
       ORDER BY started_at, id`
    )
    .all(...conversationIds, startedAt) as unknown as Row[]
  return rows.map(fromRow)
}

/** Record ids whose trees must stay, by store. Expired and unavailable records keep no trees. */
export function liveSnapshotRecordsByStore(): Map<string, Set<string>> {
  const rows = getDb()
    .prepare("SELECT id, roots_json FROM chat_turn_snapshots WHERE status IN ('capturing', 'ready')")
    .all() as Array<{ id: string; roots_json: string }>
  const byStore = new Map<string, Set<string>>()
  for (const row of rows) {
    for (const root of parse<SnapshotRoot[]>(row.roots_json, [])) {
      const ids = byStore.get(root.storeKey) ?? new Set<string>()
      ids.add(row.id)
      byStore.set(root.storeKey, ids)
    }
  }
  return byStore
}

/**
 * Marks records expired: their trees are released, while the summary of what the turn changed stays visible.
 * With `olderThan`, only records that started before it; with `limit`, the oldest first.
 */
export function expireSnapshotRecords(opts: { olderThan?: number; limit?: number } = {}): number {
  const db = getDb()
  const where = ["status IN ('capturing', 'ready', 'unavailable')"]
  const params: number[] = []
  if (opts.olderThan !== undefined) {
    where.push('started_at < ?')
    params.push(opts.olderThan)
  }
  const ids = db
    .prepare(
      `SELECT id FROM chat_turn_snapshots WHERE ${where.join(' AND ')} ORDER BY started_at, id${
        opts.limit !== undefined ? ' LIMIT ?' : ''
      }`
    )
    .all(...params, ...(opts.limit !== undefined ? [opts.limit] : [])) as Array<{ id: string }>
  const update = db.prepare("UPDATE chat_turn_snapshots SET status = 'expired' WHERE id = ?")
  for (const row of ids) update.run(row.id)
  return ids.length
}

export function countLiveSnapshotRecords(): number {
  const row = getDb()
    .prepare("SELECT COUNT(*) AS n FROM chat_turn_snapshots WHERE status IN ('capturing', 'ready')")
    .get() as { n: number }
  return Number(row.n)
}

/** Records left `capturing` by a previous run that ended mid-turn. */
export function failInterruptedSnapshotRecords(): number {
  const result = getDb()
    .prepare(
      "UPDATE chat_turn_snapshots SET status = 'unavailable', unavailable_reason = 'failed' WHERE status = 'capturing'"
    )
    .run()
  return Number(result.changes)
}
