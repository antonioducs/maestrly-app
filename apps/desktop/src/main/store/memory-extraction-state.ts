import { getDb } from './db'

export interface ExtractionState {
  conversationId: string
  spaceId: string
  lastSeq: number
  status: 'idle' | 'running' | 'failed'
  error: string | null
  attempts: number
  lastRunAt: number | null
  updatedAt: number
}
export interface ConsolidationState {
  spaceId: string
  autoCreatedSince: number
  lastRunAt: number | null
  updatedAt: number
}
export function getExtractionState(conversationId: string): ExtractionState | undefined {
  const row = getDb().prepare('SELECT * FROM memory_extraction_state WHERE conversation_id = ?').get(conversationId) as
    | Record<string, unknown>
    | undefined
  if (!row) return undefined
  return {
    conversationId,
    spaceId: String(row.space_id),
    lastSeq: Number(row.last_seq),
    status: row.status as ExtractionState['status'],
    error: row.error === null ? null : String(row.error),
    attempts: Number(row.attempts),
    lastRunAt: row.last_run_at === null ? null : Number(row.last_run_at),
    updatedAt: Number(row.updated_at),
  }
}
export function saveExtractionState(state: ExtractionState): void {
  getDb()
    .prepare(`INSERT INTO memory_extraction_state (conversation_id, space_id, last_seq, status, error, attempts, last_run_at, updated_at)
 VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(conversation_id) DO UPDATE SET space_id = excluded.space_id, last_seq = excluded.last_seq, status = excluded.status, error = excluded.error, attempts = excluded.attempts, last_run_at = excluded.last_run_at, updated_at = excluded.updated_at`)
    .run(
      state.conversationId,
      state.spaceId,
      state.lastSeq,
      state.status,
      state.error,
      state.attempts,
      state.lastRunAt,
      state.updatedAt
    )
}
export function getConsolidationState(spaceId: string): ConsolidationState | undefined {
  const row = getDb().prepare('SELECT * FROM memory_consolidation_state WHERE space_id = ?').get(spaceId) as
    | Record<string, unknown>
    | undefined
  if (!row) return undefined
  return {
    spaceId,
    autoCreatedSince: Number(row.auto_created_since),
    lastRunAt: row.last_run_at === null ? null : Number(row.last_run_at),
    updatedAt: Number(row.updated_at),
  }
}
export function saveConsolidationState(state: ConsolidationState): void {
  getDb()
    .prepare(`INSERT INTO memory_consolidation_state (space_id, auto_created_since, last_run_at, updated_at) VALUES (?, ?, ?, ?)
 ON CONFLICT(space_id) DO UPDATE SET auto_created_since = excluded.auto_created_since, last_run_at = excluded.last_run_at, updated_at = excluded.updated_at`)
    .run(state.spaceId, state.autoCreatedSince, state.lastRunAt, state.updatedAt)
}
export function incrementAutoCreated(spaceId: string, count: number): void {
  getDb()
    .prepare(`INSERT INTO memory_consolidation_state (space_id, auto_created_since, updated_at) VALUES (?, ?, ?)
 ON CONFLICT(space_id) DO UPDATE SET auto_created_since = auto_created_since + excluded.auto_created_since, updated_at = excluded.updated_at`)
    .run(spaceId, count, Date.now())
}
