import type { SQLInputValue } from 'node:sqlite'
import {
  type ExportedPackage,
  type ImportedConversation,
  MOVE_TERMINAL_STATUSES,
  type MovePhase,
  type MovePreview,
  type MoveStatus,
} from '../../shared/conversation-move'
import type { HostId } from '../../shared/host-key'
import { getDb } from '../store/db'

/** What the coordinator learned while running a move, kept to resume it after a failure or a restart. */
export interface MoveRunState {
  package?: ExportedPackage
  targetPackagePath?: string
  localRelayPath?: string
  targetWorkspaceId?: string
  imported?: ImportedConversation
  transferIds?: string[]
}

export interface MoveSelection {
  selectedIgnoredPaths: string[]
  confirmedSensitivePaths: string[]
}

export interface ConversationMoveRecord {
  id: string
  conversationId: string
  conversationName: string
  sourceHostId: HostId
  targetHostId: HostId
  phase: MovePhase
  status: MoveStatus
  preview: MovePreview
  selection: MoveSelection
  state: MoveRunState
  error?: string
  errorCode?: string
  createdAt: number
  updatedAt: number
}

const TERMINAL_SQL = [...MOVE_TERMINAL_STATUSES].map((status) => `'${status}'`).join(',')

function json<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || !value) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function rowToRecord(row: any): ConversationMoveRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    conversationName: row.conversation_name,
    sourceHostId: row.source_host_id,
    targetHostId: row.target_host_id,
    phase: row.phase,
    status: row.status,
    preview: json(row.preview_json, {} as MovePreview),
    selection: { selectedIgnoredPaths: [], confirmedSensitivePaths: [], ...json(row.selection_json, {}) },
    state: json(row.state_json, {}),
    ...(row.error ? { error: row.error } : {}),
    ...(row.error_code ? { errorCode: row.error_code } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function insertMove(record: ConversationMoveRecord): void {
  getDb()
    .prepare(
      `INSERT INTO conversation_moves
       (id, conversation_id, conversation_name, source_host_id, target_host_id, phase, status, preview_json,
        selection_json, state_json, error, error_code, created_at, updated_at)
       VALUES (@id, @conversationId, @conversationName, @sourceHostId, @targetHostId, @phase, @status, @preview,
        @selection, @state, @error, @errorCode, @createdAt, @updatedAt)`
    )
    .run({
      id: record.id,
      conversationId: record.conversationId,
      conversationName: record.conversationName,
      sourceHostId: record.sourceHostId,
      targetHostId: record.targetHostId,
      phase: record.phase,
      status: record.status,
      preview: JSON.stringify(record.preview),
      selection: JSON.stringify(record.selection),
      state: JSON.stringify(record.state),
      error: record.error ?? null,
      errorCode: record.errorCode ?? null,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    })
}

export function getMove(id: string): ConversationMoveRecord | undefined {
  const row = getDb().prepare('SELECT * FROM conversation_moves WHERE id = ?').get(id)
  return row ? rowToRecord(row) : undefined
}

/** Compare-and-set on phase; returns false when another step already moved it. */
export function advanceMove(
  id: string,
  from: MovePhase,
  patch: { phase: MovePhase; status: MoveStatus; selection?: MoveSelection; error?: null }
): boolean {
  const assignments = ['phase = @phase', 'status = @status', 'updated_at = @updatedAt']
  const params: Record<string, SQLInputValue> = {
    id,
    from,
    phase: patch.phase,
    status: patch.status,
    updatedAt: Date.now(),
  }
  if (patch.selection) {
    assignments.push('selection_json = @selection')
    params.selection = JSON.stringify(patch.selection)
  }
  if (patch.error === null) assignments.push('error = NULL', 'error_code = NULL')
  return (
    Number(
      getDb()
        .prepare(`UPDATE conversation_moves SET ${assignments.join(', ')} WHERE id = @id AND phase = @from`)
        .run(params).changes
    ) === 1
  )
}

/** Merges what a step learned into the run state. */
export function patchMoveState(id: string, patch: Partial<MoveRunState>): void {
  const current = getMove(id)
  if (!current) throw new Error('Move not found.')
  getDb()
    .prepare('UPDATE conversation_moves SET state_json = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify({ ...current.state, ...patch }), Date.now(), id)
}

export function markMoveRecoveryRequired(id: string, message: string, code?: string): void {
  getDb()
    .prepare(
      "UPDATE conversation_moves SET status = 'recovery-required', error = ?, error_code = ?, updated_at = ? WHERE id = ?"
    )
    .run(message, code ?? null, Date.now(), id)
}

export function listIncompleteMoves(): ConversationMoveRecord[] {
  return (
    getDb()
      .prepare(`SELECT * FROM conversation_moves WHERE status NOT IN (${TERMINAL_SQL}) ORDER BY created_at`)
      .all() as any[]
  ).map(rowToRecord)
}

export function findIncompleteMoveForConversation(conversationId: string): ConversationMoveRecord | undefined {
  const row = getDb()
    .prepare(
      `SELECT * FROM conversation_moves WHERE conversation_id = ? AND status NOT IN (${TERMINAL_SQL})
       ORDER BY created_at LIMIT 1`
    )
    .get(conversationId)
  return row ? rowToRecord(row) : undefined
}

export const isMoveTerminal = (record: ConversationMoveRecord): boolean => MOVE_TERMINAL_STATUSES.has(record.status)
