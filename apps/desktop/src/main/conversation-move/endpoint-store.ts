import type { SQLInputValue } from 'node:sqlite'
import { getDb } from '../store/db'

export type SourceEndpointState = 'frozen' | 'exported' | 'releasing' | 'released' | 'thawed'
export type TargetEndpointState = 'workspace-ready' | 'importing' | 'imported' | 'committed' | 'discarded'
export type MoveEndpointRole = 'source' | 'target'

/** States in which the endpoint holds the conversation: nothing else may delete, archive or migrate it. */
export const ACTIVE_ENDPOINT_STATES: ReadonlySet<string> = new Set(['frozen', 'exported', 'importing', 'imported'])
const TERMINAL_ENDPOINT_STATES: ReadonlySet<string> = new Set(['released', 'thawed', 'committed', 'discarded'])

export interface MoveEndpointRecord {
  operationId: string
  role: MoveEndpointRole
  conversationId: string
  state: SourceEndpointState | TargetEndpointState
  cwd: string | null
  data: Record<string, unknown>
  createdAt: number
  updatedAt: number
}

const sqlList = (values: ReadonlySet<string>): string => [...values].map((value) => `'${value}'`).join(',')

function rowToRecord(row: any): MoveEndpointRecord {
  let data: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(row.data_json)
    if (parsed && typeof parsed === 'object') data = parsed
  } catch {
    /* A corrupt payload reads as empty; the state alone still guards the conversation. */
  }
  return {
    operationId: row.operation_id,
    role: row.role,
    conversationId: row.conversation_id,
    state: row.state,
    cwd: row.cwd ?? null,
    data,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function getMoveEndpoint(operationId: string, role: MoveEndpointRole): MoveEndpointRecord | undefined {
  const row = getDb()
    .prepare('SELECT * FROM conversation_move_endpoints WHERE operation_id = ? AND role = ?')
    .get(operationId, role)
  return row ? rowToRecord(row) : undefined
}

export function insertMoveEndpoint(record: Omit<MoveEndpointRecord, 'createdAt' | 'updatedAt'>): void {
  const now = Date.now()
  getDb()
    .prepare(
      `INSERT INTO conversation_move_endpoints
       (operation_id, role, conversation_id, state, cwd, data_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      record.operationId,
      record.role,
      record.conversationId,
      record.state,
      record.cwd,
      JSON.stringify(record.data),
      now,
      now
    )
}

/** Updates an endpoint journal; `data` is merged into what it already holds. */
export function updateMoveEndpoint(
  operationId: string,
  role: MoveEndpointRole,
  patch: { state?: MoveEndpointRecord['state']; cwd?: string | null; data?: Record<string, unknown> }
): void {
  const current = getMoveEndpoint(operationId, role)
  if (!current) throw new Error('Move endpoint journal not found.')
  const assignments = ['updated_at = @updatedAt']
  const params: Record<string, SQLInputValue> = { operationId, role, updatedAt: Date.now() }
  if (patch.state) {
    assignments.push('state = @state')
    params.state = patch.state
  }
  if (patch.cwd !== undefined) {
    assignments.push('cwd = @cwd')
    params.cwd = patch.cwd
  }
  if (patch.data) {
    assignments.push('data_json = @data')
    params.data = JSON.stringify({ ...current.data, ...patch.data })
  }
  getDb()
    .prepare(
      `UPDATE conversation_move_endpoints SET ${assignments.join(', ')} WHERE operation_id = @operationId AND role = @role`
    )
    .run(params)
}

export function listActiveMoveEndpoints(): MoveEndpointRecord[] {
  return (
    getDb()
      .prepare(
        `SELECT * FROM conversation_move_endpoints WHERE state IN (${sqlList(ACTIVE_ENDPOINT_STATES)}) ORDER BY created_at`
      )
      .all() as any[]
  ).map(rowToRecord)
}

export function activeMoveEndpointForConversation(conversationId: string): MoveEndpointRecord | undefined {
  const row = getDb()
    .prepare(
      `SELECT * FROM conversation_move_endpoints
       WHERE conversation_id = ? AND state IN (${sqlList(ACTIVE_ENDPOINT_STATES)}) ORDER BY created_at LIMIT 1`
    )
    .get(conversationId)
  return row ? rowToRecord(row) : undefined
}

/** Finished endpoint journals last touched before `timestamp`: their staging may be swept. */
export function listTerminalMoveEndpointsBefore(timestamp: number): MoveEndpointRecord[] {
  return (
    getDb()
      .prepare(
        `SELECT * FROM conversation_move_endpoints
         WHERE state IN (${sqlList(TERMINAL_ENDPOINT_STATES)}) AND updated_at < ? ORDER BY updated_at`
      )
      .all(timestamp) as any[]
  ).map(rowToRecord)
}
