import { createHash } from 'node:crypto'
import type {
  ChatMessage,
  ChatRole,
  MessagePart,
  SubagentResumeStatus,
  SubagentRuntimeHandle,
  SubagentSessionOrigin,
  SubagentSessionStatus,
  SubagentSessionSummary,
  SubagentSessionUsage,
  SubagentTranscriptChange,
  SubagentTranscriptPage,
} from '../../shared/chat'
import type { MaestroDelegationSnapshotV1 } from '../../shared/maestro'
import type { SubagentExecutionSnapshotV1 } from '../../shared/subagent-profiles'
import { getDb, transaction } from '../store'
import { parseParts } from './message'

interface SessionRow {
  id: string
  conversation_id: string
  parent_message_id: string
  tool_call_id: string
  origin: SubagentSessionOrigin
  agent_name: string
  task: string
  status: SubagentSessionStatus
  phase: string | null
  current_tool: string | null
  profile_json: string | null
  maestro_json: string | null
  usage_json: string | null
  runtime_estimated_cost_usd: number | null
  summary_json: string
  error: string | null
  revision: number
  started_at: number
  last_activity_at: number
  finished_at: number | null
  resumed_from: string | null
  resume_status: string | null
  resume_reason: string | null
  runtime_handle_json: string | null
}

interface TranscriptRow {
  session_id: string
  part_id: string
  message_id: string
  message_seq: number
  role: ChatRole
  position: number
  part_json: string
  revision: number
  created_at: number
  updated_at: number
}

interface StoredSummary {
  toolNames?: unknown
  files?: unknown
  commands?: unknown
  tests?: unknown
}

function json<T>(value: string | null): T | undefined {
  if (!value) return undefined
  try {
    return JSON.parse(value) as T
  } catch {
    return undefined
  }
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string').slice(0, 100)
}

function summaryFromRow(row: SessionRow): SubagentSessionSummary {
  const compact = json<StoredSummary>(row.summary_json) ?? {}
  const finishedAt = row.finished_at ?? undefined
  return {
    id: row.id,
    conversationId: row.conversation_id,
    parentMessageId: row.parent_message_id,
    toolCallId: row.tool_call_id,
    origin: row.origin,
    agentName: row.agent_name,
    task: row.task,
    status: row.status,
    ...(row.phase ? { phase: row.phase } : {}),
    ...(row.current_tool ? { currentTool: row.current_tool } : {}),
    ...(json<SubagentExecutionSnapshotV1>(row.profile_json)
      ? { profile: json<SubagentExecutionSnapshotV1>(row.profile_json)! }
      : {}),
    ...(json<MaestroDelegationSnapshotV1>(row.maestro_json)
      ? { maestro: json<MaestroDelegationSnapshotV1>(row.maestro_json)! }
      : {}),
    startedAt: row.started_at,
    lastActivityAt: row.last_activity_at,
    ...(finishedAt != null ? { finishedAt, durationMs: Math.max(0, finishedAt - row.started_at) } : {}),
    ...(json<SubagentSessionUsage>(row.usage_json) ? { usage: json<SubagentSessionUsage>(row.usage_json)! } : {}),
    ...(row.runtime_estimated_cost_usd != null ? { runtimeEstimatedCostUsd: row.runtime_estimated_cost_usd } : {}),
    revision: row.revision,
    toolNames: stringList(compact.toolNames),
    files: stringList(compact.files),
    commands: stringList(compact.commands),
    tests: stringList(compact.tests),
    ...(row.error ? { error: row.error } : {}),
    ...(row.resumed_from ? { resumedFrom: row.resumed_from } : {}),
    ...(row.resume_status === 'resumed' || row.resume_status === 'recreated'
      ? { resumeStatus: row.resume_status }
      : {}),
    ...(row.resume_reason ? { resumeReason: row.resume_reason } : {}),
  }
}

function sessionRow(id: string): SessionRow | undefined {
  return getDb().prepare('SELECT * FROM chat_subagent_sessions WHERE id = ?').get(id) as SessionRow | undefined
}

export function subagentSessionId(input: {
  conversationId: string
  parentMessageId: string
  toolCallId: string
}): string {
  const digest = createHash('sha256')
    .update(`${input.conversationId}\0${input.parentMessageId}\0${input.toolCallId}`)
    .digest('hex')
    .slice(0, 32)
  return `subagent-${digest}`
}

export function createSubagentSession(input: {
  conversationId: string
  parentMessageId: string
  toolCallId: string
  origin: SubagentSessionOrigin
  agentName: string
  task: string
  profile?: SubagentExecutionSnapshotV1
  maestro?: MaestroDelegationSnapshotV1
  startedAt?: number
  resumedFrom?: string
}): SubagentSessionSummary {
  const id = subagentSessionId(input)
  const startedAt = input.startedAt ?? Date.now()
  transaction(() => {
    getDb()
      .prepare(
        `INSERT INTO chat_subagent_sessions
          (id,conversation_id,parent_message_id,tool_call_id,origin,agent_name,task,status,phase,
           profile_json,maestro_json,summary_json,revision,started_at,last_activity_at,resumed_from)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO NOTHING`
      )
      .run(
        id,
        input.conversationId,
        input.parentMessageId,
        input.toolCallId,
        input.origin,
        input.agentName,
        input.task,
        'preparing',
        'preparing-runtime',
        input.profile ? JSON.stringify(input.profile) : null,
        input.maestro ? JSON.stringify(input.maestro) : null,
        '{}',
        1,
        startedAt,
        startedAt,
        input.resumedFrom ?? null
      )
    getDb()
      .prepare(
        `INSERT INTO chat_subagent_transcript
          (session_id,part_id,message_id,message_seq,role,position,part_json,revision,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(session_id,part_id) DO NOTHING`
      )
      .run(
        id,
        `${id}:task:text`,
        `${id}:task`,
        0,
        'user',
        0,
        JSON.stringify({ type: 'text', id: `${id}:task:text`, text: input.task } satisfies MessagePart),
        1,
        startedAt,
        startedAt
      )
  })
  return summaryFromRow(sessionRow(id)!)
}

export interface SubagentSessionPatch {
  status?: SubagentSessionStatus
  phase?: string | null
  currentTool?: string | null
  usage?: SubagentSessionUsage
  runtimeEstimatedCostUsd?: number | null
  error?: string | null
  finishedAt?: number | null
  toolNames?: string[]
  files?: string[]
  commands?: string[]
  tests?: string[]
  /** `null` clears the handle (remote resource already released). */
  runtimeHandle?: SubagentRuntimeHandle | null
  resume?: { status: SubagentResumeStatus; reason?: string }
}

function mergedList(current: string[], incoming: string[] | undefined): string[] {
  if (!incoming?.length) return current
  return [...new Set([...current, ...incoming].map((item) => item.trim()).filter(Boolean))].slice(-100)
}

export function updateSubagentSession(id: string, patch: SubagentSessionPatch): SubagentSessionSummary | null {
  const current = sessionRow(id)
  if (!current) return null
  const previous = summaryFromRow(current)
  const now = Date.now()
  const finishedAt = patch.finishedAt === null ? null : (patch.finishedAt ?? current.finished_at)
  const compact = {
    toolNames: mergedList(previous.toolNames, patch.toolNames),
    files: mergedList(previous.files, patch.files),
    commands: mergedList(previous.commands, patch.commands),
    tests: mergedList(previous.tests, patch.tests),
  }
  getDb()
    .prepare(
      `UPDATE chat_subagent_sessions SET
         status = ?, phase = ?, current_tool = ?, usage_json = ?, runtime_estimated_cost_usd = ?,
         summary_json = ?, error = ?, revision = revision + 1, last_activity_at = ?, finished_at = ?,
         runtime_handle_json = ?, resume_status = ?, resume_reason = ?
       WHERE id = ?`
    )
    .run(
      patch.status ?? current.status,
      patch.phase === undefined ? current.phase : patch.phase,
      patch.currentTool === undefined ? current.current_tool : patch.currentTool,
      patch.usage === undefined ? current.usage_json : JSON.stringify(patch.usage),
      patch.runtimeEstimatedCostUsd === undefined ? current.runtime_estimated_cost_usd : patch.runtimeEstimatedCostUsd,
      JSON.stringify(compact),
      patch.error === undefined ? current.error : patch.error,
      now,
      finishedAt,
      patch.runtimeHandle === undefined
        ? current.runtime_handle_json
        : patch.runtimeHandle === null
          ? null
          : JSON.stringify(patch.runtimeHandle),
      patch.resume === undefined ? current.resume_status : patch.resume.status,
      patch.resume === undefined ? current.resume_reason : (patch.resume.reason ?? null),
      id
    )
  return summaryFromRow(sessionRow(id)!)
}

/** Native provider handle; main-only (never part of the public summary). */
export function getSubagentRuntimeHandle(id: string): SubagentRuntimeHandle | null {
  const row = sessionRow(id)
  if (!row?.runtime_handle_json) return null
  const parsed = json<SubagentRuntimeHandle>(row.runtime_handle_json)
  return parsed && (parsed.kind === 'codex-thread' || parsed.kind === 'claude-session') ? parsed : null
}

export function upsertSubagentTranscriptPart(input: {
  sessionId: string
  partId: string
  messageId?: string
  messageSeq?: number
  role?: ChatRole
  position?: number
  part: MessagePart
}): SubagentSessionSummary | null {
  const current = sessionRow(input.sessionId)
  if (!current) return null
  const now = Date.now()
  const revision = current.revision + 1
  transaction(() => {
    getDb()
      .prepare(
        `INSERT INTO chat_subagent_transcript
          (session_id,part_id,message_id,message_seq,role,position,part_json,revision,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(session_id,part_id) DO UPDATE SET
           part_json=excluded.part_json, revision=excluded.revision, updated_at=excluded.updated_at`
      )
      .run(
        input.sessionId,
        input.partId,
        input.messageId ?? `${input.sessionId}:assistant`,
        input.messageSeq ?? 1,
        input.role ?? 'assistant',
        input.position ?? revision,
        JSON.stringify(input.part),
        revision,
        now,
        now
      )
    getDb()
      .prepare('UPDATE chat_subagent_sessions SET revision = ?, last_activity_at = ? WHERE id = ?')
      .run(revision, now, input.sessionId)
  })
  return summaryFromRow(sessionRow(input.sessionId)!)
}

export function getSubagentSession(id: string): SubagentSessionSummary | null {
  const row = sessionRow(id)
  return row ? summaryFromRow(row) : null
}

export function findSubagentSession(input: {
  conversationId: string
  parentMessageId: string
  toolCallId: string
}): SubagentSessionSummary | null {
  const row = getDb()
    .prepare(
      `SELECT * FROM chat_subagent_sessions
       WHERE conversation_id = ? AND parent_message_id = ? AND tool_call_id = ?`
    )
    .get(input.conversationId, input.parentMessageId, input.toolCallId) as SessionRow | undefined
  return row ? summaryFromRow(row) : null
}

export function listSubagentSessions(
  conversationId: string,
  options: { parentMessageId?: string; origin?: SubagentSessionOrigin; limit?: number } = {}
): SubagentSessionSummary[] {
  const where = ['conversation_id = ?']
  const values: Array<string | number> = [conversationId]
  if (options.parentMessageId) {
    where.push('parent_message_id = ?')
    values.push(options.parentMessageId)
  }
  if (options.origin) {
    where.push('origin = ?')
    values.push(options.origin)
  }
  const limit = Math.max(1, Math.min(200, Math.floor(options.limit ?? 100)))
  values.push(limit)
  const rows = getDb()
    .prepare(`SELECT * FROM chat_subagent_sessions WHERE ${where.join(' AND ')} ORDER BY started_at DESC LIMIT ?`)
    .all(...values) as unknown as SessionRow[]
  return rows.map(summaryFromRow)
}

function rowsToMessages(session: SubagentSessionSummary, rows: TranscriptRow[]): ChatMessage[] {
  const grouped = new Map<string, { seq: number; role: ChatRole; createdAt: number; parts: MessagePart[] }>()
  for (const row of rows) {
    const part = parseParts(`[${row.part_json}]`)[0]
    if (!part) continue
    const entry = grouped.get(row.message_id) ?? {
      seq: row.message_seq,
      role: row.role,
      createdAt: row.created_at,
      parts: [],
    }
    entry.parts.push(part)
    grouped.set(row.message_id, entry)
  }
  return [...grouped.entries()]
    .sort((left, right) => left[1].seq - right[1].seq)
    .map(([id, entry]) => ({
      id,
      conversationId: session.conversationId,
      role: entry.role,
      parts: entry.parts,
      createdAt: entry.createdAt,
      ...(entry.role === 'assistant'
        ? {
            model: session.profile?.effective
              ? {
                  providerId: session.profile.effective.providerId,
                  modelId: session.profile.effective.modelId,
                }
              : undefined,
            responseStartedAt: session.startedAt,
            ...(session.durationMs != null ? { responseDurationMs: session.durationMs } : {}),
            ...(session.error ? { error: session.error } : {}),
          }
        : {}),
    }))
}

export function getSubagentTranscriptPage(
  sessionId: string,
  options: { limit?: number } = {}
): SubagentTranscriptPage | null {
  const session = getSubagentSession(sessionId)
  if (!session) return null
  const limit = Math.max(1, Math.min(1_000, Math.floor(options.limit ?? 500)))
  const rows = getDb()
    .prepare(
      `SELECT * FROM chat_subagent_transcript
       WHERE session_id = ? ORDER BY message_seq, position LIMIT ?`
    )
    .all(sessionId, limit + 1) as unknown as TranscriptRow[]
  const visible = rows.slice(0, limit)
  return {
    session,
    messages: rowsToMessages(session, visible),
    cursor: session.revision,
    hasMore: rows.length > limit,
  }
}

export function getSubagentTranscriptChanges(
  sessionId: string,
  cursor: number,
  limit = 100
): SubagentTranscriptChange[] {
  const bounded = Math.max(1, Math.min(200, Math.floor(limit)))
  const rows = getDb()
    .prepare(
      `SELECT * FROM chat_subagent_transcript
       WHERE session_id = ? AND revision > ? ORDER BY revision LIMIT ?`
    )
    .all(sessionId, Math.max(0, Math.floor(cursor)), bounded) as unknown as TranscriptRow[]
  return rows.flatMap((row) => {
    const part = parseParts(`[${row.part_json}]`)[0]
    return part
      ? [
          {
            cursor: row.revision,
            messageId: row.message_id,
            role: row.role,
            part,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
          },
        ]
      : []
  })
}

export function markInterruptedSubagentSessions(now = Date.now()): number {
  try {
    const result = getDb()
      .prepare(
        `UPDATE chat_subagent_sessions
         SET status='interrupted', phase='process-interrupted', current_tool=NULL,
             error=COALESCE(error, 'The app stopped before this subagent session completed.'),
             finished_at=?, last_activity_at=?, revision=revision+1
         WHERE status IN ('preparing','running')`
      )
      .run(now, now)
    return Number(result?.changes ?? 0)
  } catch {
    // Service contract tests intentionally mock the store without a SQLite handle.
    return 0
  }
}
