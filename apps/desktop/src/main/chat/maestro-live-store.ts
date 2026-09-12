import { randomUUID } from 'node:crypto'
import {
  MAESTRO_LIVE_DEFAULT_CLAIM_BYTES,
  MAESTRO_LIVE_DEFAULT_CLAIM_MESSAGES,
  MAESTRO_LIVE_MAX_MESSAGE_BYTES,
  MAESTRO_LIVE_MAX_PENDING_BYTES,
  MAESTRO_LIVE_MAX_PENDING_MESSAGES,
  type MaestroLiveMessage,
  type MaestroLiveMessageStatus,
  type MaestroLivePostInput,
  type MaestroLivePostResult,
  type MaestroLiveRunSnapshot,
  type MaestroLiveRunStatus,
} from '../../shared/maestro-live'
import type { StructuredAgentMentionDraft } from '../../shared/chat-agent-mentions'
import { normalizeSubagentProfileKey } from '../../shared/subagent-profiles'
import { getDb, transaction } from '../store'

const RUN_STATUSES = new Set<MaestroLiveRunStatus>(['active', 'completed', 'error', 'aborted', 'interrupted'])
const MESSAGE_STATUSES = new Set<MaestroLiveMessageStatus>(['pending', 'embedded', 'rolled_over', 'cancelled'])
const TERMINAL_RUN_STATUSES = new Set<Exclude<MaestroLiveRunStatus, 'active'>>([
  'completed',
  'error',
  'aborted',
  'interrupted',
])
const MAX_ID_LENGTH = 512
const MAX_MENTIONS = 64

const RUN_SUMMARY_SQL = `
  SELECT r.*,
         COUNT(m.id) AS message_count,
         COALESCE(SUM(CASE WHEN m.status = 'pending' THEN 1 ELSE 0 END), 0) AS pending_count,
         COALESCE(SUM(CASE WHEN m.status = 'embedded' THEN 1 ELSE 0 END), 0) AS embedded_count,
         COALESCE(SUM(CASE WHEN m.status = 'rolled_over' THEN 1 ELSE 0 END), 0) AS rolled_over_count,
         COALESCE(SUM(CASE WHEN m.status = 'cancelled' THEN 1 ELSE 0 END), 0) AS cancelled_count,
         MAX(m.seq) AS last_message_seq
  FROM chat_maestro_runs r
  LEFT JOIN chat_maestro_run_messages m ON m.run_id = r.id
`

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function cleanId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const id = value.trim()
  return id && id.length <= MAX_ID_LENGTH ? id : null
}

function integer(value: unknown, minimum = 0): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum ? value : null
}

function timestamp(value: unknown, fallback = Date.now()): number {
  return integer(value) ?? fallback
}

function isRunStatus(value: unknown): value is MaestroLiveRunStatus {
  return typeof value === 'string' && RUN_STATUSES.has(value as MaestroLiveRunStatus)
}

function isMessageStatus(value: unknown): value is MaestroLiveMessageStatus {
  return typeof value === 'string' && MESSAGE_STATUSES.has(value as MaestroLiveMessageStatus)
}

/** Mentions are untrusted IPC/JSON data. Invalid ranges degrade to plain text instead of poisoning the queue. */
function sanitizeMentions(value: unknown, text: string): StructuredAgentMentionDraft[] {
  if (!Array.isArray(value)) return []
  const mentions: StructuredAgentMentionDraft[] = []
  const seenIds = new Set<string>()
  for (const item of value) {
    if (mentions.length >= MAX_MENTIONS) break
    const raw = record(item)
    if (!raw) continue
    const id = cleanId(raw.id)
    const start = integer(raw.start)
    const end = integer(raw.end, 1)
    if (!id || seenIds.has(id) || start === null || end === null || end <= start || end > text.length) continue
    if (typeof raw.name !== 'string' || raw.name.length > 160) continue
    const name = normalizeSubagentProfileKey(raw.name)
    const token = text.slice(start, end)
    if (!name || !token.startsWith('#') || normalizeSubagentProfileKey(token.slice(1)) !== name) continue
    seenIds.add(id)
    mentions.push({ id, name, start, end })
  }
  return mentions
}

function parseMentions(value: unknown, text: string): StructuredAgentMentionDraft[] {
  if (typeof value !== 'string') return []
  try {
    return sanitizeMentions(JSON.parse(value), text)
  } catch {
    return []
  }
}

function messageFromRow(value: unknown): MaestroLiveMessage | null {
  const row = record(value)
  if (!row) return null
  const id = cleanId(row.id)
  const runId = cleanId(row.run_id)
  const seq = integer(row.seq, 1)
  const createdAt = integer(row.created_at)
  const status = row.status
  if (!id || !runId || seq === null || createdAt === null || typeof row.text !== 'string' || !isMessageStatus(status)) {
    return null
  }
  const checkpointId = row.checkpoint_id === null ? null : cleanId(row.checkpoint_id)
  const embeddedAt = row.embedded_at === null ? null : integer(row.embedded_at)
  if (row.checkpoint_id !== null && checkpointId === null) return null
  if (row.embedded_at !== null && embeddedAt === null) return null
  return {
    id,
    runId,
    seq,
    text: row.text,
    agentMentions: parseMentions(row.agent_mentions_json, row.text),
    status,
    checkpointId,
    createdAt,
    embeddedAt,
  }
}

function runFromRow(value: unknown): MaestroLiveRunSnapshot | null {
  const row = record(value)
  if (!row) return null
  const id = cleanId(row.id)
  const conversationId = cleanId(row.conversation_id)
  const startedAt = integer(row.started_at)
  const status = row.status
  const assistantMessageId = row.assistant_message_id === null ? null : cleanId(row.assistant_message_id)
  const finishedAt = row.finished_at === null ? null : integer(row.finished_at)
  const messageCount = integer(row.message_count)
  const pendingCount = integer(row.pending_count)
  const embeddedCount = integer(row.embedded_count)
  const rolledOverCount = integer(row.rolled_over_count)
  const cancelledCount = integer(row.cancelled_count)
  const lastMessageSeq = row.last_message_seq === null ? null : integer(row.last_message_seq, 1)
  if (
    !id ||
    !conversationId ||
    startedAt === null ||
    !isRunStatus(status) ||
    (row.assistant_message_id !== null && assistantMessageId === null) ||
    (row.finished_at !== null && finishedAt === null) ||
    messageCount === null ||
    pendingCount === null ||
    embeddedCount === null ||
    rolledOverCount === null ||
    cancelledCount === null ||
    (row.last_message_seq !== null && lastMessageSeq === null)
  ) {
    return null
  }
  return {
    id,
    conversationId,
    assistantMessageId,
    status,
    startedAt,
    finishedAt,
    messageCount,
    pendingCount,
    embeddedCount,
    rolledOverCount,
    cancelledCount,
    lastMessageSeq,
  }
}

function rowsToMessages(rows: unknown[]): MaestroLiveMessage[] {
  return rows
    .map(messageFromRow)
    .filter((message): message is MaestroLiveMessage => message !== null)
    .sort((left, right) => left.seq - right.seq)
}

function getMessage(id: string): MaestroLiveMessage | null {
  const row = getDb().prepare('SELECT * FROM chat_maestro_run_messages WHERE id = ?').get(id)
  return messageFromRow(row)
}

export interface CreateMaestroLiveRunInput {
  conversationId: string
  /** Optional for idempotent host recovery/tests; normally generated once by this store. */
  id?: string
  assistantMessageId?: string | null
  startedAt?: number
}

export function createMaestroLiveRun(input: CreateMaestroLiveRunInput): MaestroLiveRunSnapshot
export function createMaestroLiveRun(
  conversationId: string,
  options?: Omit<CreateMaestroLiveRunInput, 'conversationId'>
): MaestroLiveRunSnapshot
export function createMaestroLiveRun(
  inputOrConversationId: CreateMaestroLiveRunInput | string,
  options: Omit<CreateMaestroLiveRunInput, 'conversationId'> = {}
): MaestroLiveRunSnapshot {
  const input =
    typeof inputOrConversationId === 'string'
      ? { ...options, conversationId: inputOrConversationId }
      : inputOrConversationId
  const conversationId = cleanId(input.conversationId)
  const requestedId = input.id === undefined ? null : cleanId(input.id)
  if (!conversationId || (input.id !== undefined && !requestedId)) throw new Error('invalid-maestro-live-run')
  const assistantMessageId = input.assistantMessageId == null ? null : cleanId(input.assistantMessageId)
  if (input.assistantMessageId != null && !assistantMessageId) throw new Error('invalid-assistant-message-id')

  if (requestedId) {
    const existing = getMaestroLiveRun(requestedId)
    if (existing) {
      if (existing.conversationId !== conversationId) throw new Error('maestro-live-run-id-conflict')
      if (assistantMessageId && !existing.assistantMessageId) {
        return bindMaestroLiveAssistantMessage(existing.id, assistantMessageId) ?? existing
      }
      if (assistantMessageId && existing.assistantMessageId !== assistantMessageId) {
        throw new Error('maestro-live-assistant-id-conflict')
      }
      return existing
    }
  }
  const active = getActiveMaestroLiveRun(conversationId)
  if (active) throw new Error('maestro-live-run-already-active')

  const id = requestedId ?? randomUUID()
  getDb()
    .prepare(
      `INSERT INTO chat_maestro_runs
       (id, conversation_id, assistant_message_id, status, started_at, finished_at)
       VALUES (?, ?, ?, 'active', ?, NULL)`
    )
    .run(id, conversationId, assistantMessageId, timestamp(input.startedAt))
  const created = getMaestroLiveRun(id)
  if (!created) throw new Error('maestro-live-run-write-failed')
  return created
}

/** Binds once; a conflicting second assistant id is a host lifecycle bug, never a silent overwrite. */
export function bindMaestroLiveAssistantMessage(
  runIdValue: string,
  assistantMessageIdValue: string
): MaestroLiveRunSnapshot | null {
  const runId = cleanId(runIdValue)
  const assistantMessageId = cleanId(assistantMessageIdValue)
  if (!runId || !assistantMessageId) return null
  const current = getMaestroLiveRun(runId)
  if (!current) return null
  if (current.assistantMessageId && current.assistantMessageId !== assistantMessageId) {
    throw new Error('maestro-live-assistant-id-conflict')
  }
  if (!current.assistantMessageId) {
    getDb()
      .prepare('UPDATE chat_maestro_runs SET assistant_message_id = ? WHERE id = ? AND assistant_message_id IS NULL')
      .run(assistantMessageId, runId)
  }
  return getMaestroLiveRun(runId)
}

export function getMaestroLiveRun(runIdValue: string): MaestroLiveRunSnapshot | null {
  const runId = cleanId(runIdValue)
  if (!runId) return null
  const row = getDb().prepare(`${RUN_SUMMARY_SQL} WHERE r.id = ? GROUP BY r.id`).get(runId)
  return runFromRow(row)
}

export function getActiveMaestroLiveRun(conversationIdValue: string): MaestroLiveRunSnapshot | null {
  const conversationId = cleanId(conversationIdValue)
  if (!conversationId) return null
  const row = getDb()
    .prepare(
      `${RUN_SUMMARY_SQL}
       WHERE r.conversation_id = ? AND r.status = 'active'
       GROUP BY r.id
       ORDER BY r.started_at DESC, r.id DESC
       LIMIT 1`
    )
    .get(conversationId)
  return runFromRow(row)
}

export function listMaestroLiveMessages(runIdValue: string): MaestroLiveMessage[] {
  const runId = cleanId(runIdValue)
  if (!runId) return []
  const rows = getDb()
    .prepare('SELECT * FROM chat_maestro_run_messages WHERE run_id = ? ORDER BY seq ASC')
    .all(runId) as unknown[]
  return rowsToMessages(rows)
}

export interface MaestroLiveStorePostInput extends MaestroLivePostInput {
  /** Host/test clock override; untrusted non-integers fall back to Date.now(). */
  createdAt?: number
}

/** Posts one pending message and allocates seq in the same transaction as both pending limits. */
export function postMaestroLiveMessage(input: MaestroLiveStorePostInput): MaestroLivePostResult {
  const runId = cleanId(input?.runId)
  if (!runId || typeof input?.text !== 'string' || !input.text.trim()) return { ok: false, error: 'invalid-input' }
  const messageBytes = Buffer.byteLength(input.text, 'utf8')
  if (messageBytes > MAESTRO_LIVE_MAX_MESSAGE_BYTES) return { ok: false, error: 'message-too-large' }
  const agentMentions = sanitizeMentions(input.agentMentions, input.text)
  const id = randomUUID()
  const createdAt = timestamp(input.createdAt)
  let result: MaestroLivePostResult = { ok: false, error: 'run-not-active' }

  transaction(() => {
    const run = getDb().prepare('SELECT status FROM chat_maestro_runs WHERE id = ?').get(runId) as
      | { status?: unknown }
      | undefined
    if (run?.status !== 'active') return
    const pending = getDb()
      .prepare(
        `SELECT COUNT(*) AS count, COALESCE(SUM(length(CAST(text AS BLOB))), 0) AS bytes
         FROM chat_maestro_run_messages WHERE run_id = ? AND status = 'pending'`
      )
      .get(runId) as { count: number; bytes: number }
    if (pending.count >= MAESTRO_LIVE_MAX_PENDING_MESSAGES) {
      result = { ok: false, error: 'pending-count-limit' }
      return
    }
    if (pending.bytes + messageBytes > MAESTRO_LIVE_MAX_PENDING_BYTES) {
      result = { ok: false, error: 'pending-bytes-limit' }
      return
    }
    const next = getDb()
      .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM chat_maestro_run_messages WHERE run_id = ?')
      .get(runId) as { seq: number }
    getDb()
      .prepare(
        `INSERT INTO chat_maestro_run_messages
         (id, run_id, seq, text, agent_mentions_json, status, checkpoint_id, created_at, embedded_at)
         VALUES (?, ?, ?, ?, ?, 'pending', NULL, ?, NULL)`
      )
      .run(id, runId, next.seq, input.text, JSON.stringify(agentMentions), createdAt)
    const message = getMessage(id)
    const snapshot = getMaestroLiveRun(runId)
    if (!message || !snapshot) throw new Error('maestro-live-message-write-failed')
    result = { ok: true, message, run: snapshot }
  })
  return result
}

export function postPendingMaestroLiveMessage(input: MaestroLiveStorePostInput): MaestroLivePostResult {
  return postMaestroLiveMessage(input)
}

export interface MaestroLiveClaimInput {
  runId: string
  checkpointId: string
  maxMessages?: number
  maxCount?: number
  maxBytes?: number
}

export function claimPendingMaestroLiveMessages(input: MaestroLiveClaimInput): MaestroLiveMessage[]
export function claimPendingMaestroLiveMessages(
  runId: string,
  checkpointId: string,
  limits?: Pick<MaestroLiveClaimInput, 'maxMessages' | 'maxCount' | 'maxBytes'>
): MaestroLiveMessage[]
export function claimPendingMaestroLiveMessages(
  inputOrRunId: MaestroLiveClaimInput | string,
  checkpointIdValue?: string,
  limits: Pick<MaestroLiveClaimInput, 'maxMessages' | 'maxCount' | 'maxBytes'> = {}
): MaestroLiveMessage[] {
  const input =
    typeof inputOrRunId === 'string'
      ? { ...limits, runId: inputOrRunId, checkpointId: checkpointIdValue ?? '' }
      : inputOrRunId
  const runId = cleanId(input.runId)
  const checkpointId = cleanId(input.checkpointId)
  const requestedCount = input.maxMessages ?? input.maxCount ?? MAESTRO_LIVE_DEFAULT_CLAIM_MESSAGES
  const requestedBytes = input.maxBytes ?? MAESTRO_LIVE_DEFAULT_CLAIM_BYTES
  if (
    !runId ||
    !checkpointId ||
    !Number.isFinite(requestedCount) ||
    !Number.isInteger(requestedCount) ||
    requestedCount <= 0 ||
    !Number.isFinite(requestedBytes) ||
    !Number.isInteger(requestedBytes) ||
    requestedBytes <= 0
  ) {
    return []
  }
  const maxCount = Math.min(requestedCount, MAESTRO_LIVE_MAX_PENDING_MESSAGES)
  const maxBytes = Math.min(requestedBytes, MAESTRO_LIVE_MAX_PENDING_BYTES)

  // One write statement is the claim boundary. checkpoint_id remains nullable for unclaimed pending rows and
  // makes different (or repeated) callers mutually exclusive without introducing an externally visible status.
  const rows = getDb()
    .prepare(
      `WITH candidates AS (
         SELECT message.id,
                ROW_NUMBER() OVER (ORDER BY message.seq ASC) AS ordinal,
                SUM(length(CAST(message.text AS BLOB))) OVER (
                  ORDER BY message.seq ASC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
                ) AS cumulative_bytes
         FROM chat_maestro_run_messages message
         JOIN chat_maestro_runs run ON run.id = message.run_id
         WHERE message.run_id = ?
           AND message.status = 'pending'
           AND message.checkpoint_id IS NULL
           AND run.status = 'active'
           AND NOT EXISTS (
             SELECT 1 FROM chat_maestro_run_messages existing
             WHERE existing.run_id = message.run_id AND existing.checkpoint_id = ?
           )
       ), claimable AS (
         SELECT id FROM candidates WHERE ordinal <= ? AND cumulative_bytes <= ?
       )
       UPDATE chat_maestro_run_messages
       SET checkpoint_id = ?
       WHERE run_id = ?
         AND status = 'pending'
         AND checkpoint_id IS NULL
         AND id IN (SELECT id FROM claimable)
       RETURNING *`
    )
    .all(runId, checkpointId, maxCount, maxBytes, checkpointId, runId) as unknown[]
  return rowsToMessages(rows)
}

export interface MaestroLiveMarkEmbeddedInput {
  runId: string
  checkpointId: string
  embeddedAt?: number
}

export function markMaestroLiveMessagesEmbedded(input: MaestroLiveMarkEmbeddedInput): MaestroLiveMessage[]
export function markMaestroLiveMessagesEmbedded(
  runId: string,
  checkpointId: string,
  embeddedAt?: number
): MaestroLiveMessage[]
export function markMaestroLiveMessagesEmbedded(
  inputOrRunId: MaestroLiveMarkEmbeddedInput | string,
  checkpointIdValue?: string,
  embeddedAtValue?: number
): MaestroLiveMessage[] {
  const input =
    typeof inputOrRunId === 'string'
      ? { runId: inputOrRunId, checkpointId: checkpointIdValue ?? '', embeddedAt: embeddedAtValue }
      : inputOrRunId
  const runId = cleanId(input.runId)
  const checkpointId = cleanId(input.checkpointId)
  if (!runId || !checkpointId) return []
  const rows = getDb()
    .prepare(
      `UPDATE chat_maestro_run_messages
       SET status = 'embedded', embedded_at = ?
       WHERE run_id = ? AND checkpoint_id = ? AND status = 'pending'
       RETURNING *`
    )
    .all(timestamp(input.embeddedAt), runId, checkpointId) as unknown[]
  return rowsToMessages(rows)
}

export function markMaestroLiveCheckpointEmbedded(
  runId: string,
  checkpointId: string,
  embeddedAt?: number
): MaestroLiveMessage[] {
  return markMaestroLiveMessagesEmbedded(runId, checkpointId, embeddedAt)
}

/** Releases a failed model-injection attempt so the same rows can be claimed by a later checkpoint. */
export function releaseMaestroLiveCheckpoint(runIdValue: string, checkpointIdValue: string): MaestroLiveMessage[] {
  const runId = cleanId(runIdValue)
  const checkpointId = cleanId(checkpointIdValue)
  if (!runId || !checkpointId) return []
  const rows = getDb()
    .prepare(
      `UPDATE chat_maestro_run_messages
       SET checkpoint_id = NULL
       WHERE run_id = ? AND checkpoint_id = ? AND status = 'pending'
       RETURNING *`
    )
    .all(runId, checkpointId) as unknown[]
  return rowsToMessages(rows)
}

function transitionPendingMessages(
  runIdValue: string,
  status: Extract<MaestroLiveMessageStatus, 'rolled_over' | 'cancelled'>
): MaestroLiveMessage[] {
  const runId = cleanId(runIdValue)
  if (!runId) return []
  const rows = getDb()
    .prepare(
      `UPDATE chat_maestro_run_messages
       SET status = ?, embedded_at = NULL
       WHERE run_id = ? AND status = 'pending'
       RETURNING *`
    )
    .all(status, runId) as unknown[]
  return rowsToMessages(rows)
}

export function rollOverPendingMaestroLiveMessages(runId: string): MaestroLiveMessage[] {
  return transitionPendingMessages(runId, 'rolled_over')
}

export function cancelPendingMaestroLiveMessages(runId: string): MaestroLiveMessage[] {
  return transitionPendingMessages(runId, 'cancelled')
}

export function cancelMaestroLiveMessage(runIdValue: string, messageIdValue: string): MaestroLiveMessage | null {
  const runId = cleanId(runIdValue)
  const messageId = cleanId(messageIdValue)
  if (!runId || !messageId) return null
  getDb()
    .prepare(
      `UPDATE chat_maestro_run_messages SET status = 'cancelled'
       WHERE run_id = ? AND id = ? AND status = 'pending'`
    )
    .run(runId, messageId)
  const row = getDb()
    .prepare('SELECT * FROM chat_maestro_run_messages WHERE run_id = ? AND id = ?')
    .get(runId, messageId)
  return messageFromRow(row)
}

export function finishMaestroLiveRun(
  runIdValue: string,
  status: Exclude<MaestroLiveRunStatus, 'active'>,
  finishedAtValue?: number
): MaestroLiveRunSnapshot | null {
  const runId = cleanId(runIdValue)
  if (!runId || !TERMINAL_RUN_STATUSES.has(status)) return null
  const finishedAt = timestamp(finishedAtValue)
  transaction(() => {
    const pendingStatus: Extract<MaestroLiveMessageStatus, 'rolled_over' | 'cancelled'> =
      status === 'aborted' ? 'cancelled' : 'rolled_over'
    getDb()
      .prepare(
        `UPDATE chat_maestro_run_messages
         SET status = ?, embedded_at = NULL
         WHERE run_id = ? AND status = 'pending'
           AND EXISTS (SELECT 1 FROM chat_maestro_runs WHERE id = ? AND status = 'active')`
      )
      .run(pendingStatus, runId, runId)
    getDb()
      .prepare(
        `UPDATE chat_maestro_runs
         SET status = ?, finished_at = ?
         WHERE id = ? AND status = 'active'`
      )
      .run(status, finishedAt, runId)
  })
  return getMaestroLiveRun(runId)
}

/** Crash recovery never replays a claimed message: every still-pending row is surfaced as rolled over. */
export function reconcileActiveMaestroLiveRuns(finishedAtValue?: number): MaestroLiveRunSnapshot[] {
  const finishedAt = timestamp(finishedAtValue)
  const activeIds = (
    getDb().prepare("SELECT id FROM chat_maestro_runs WHERE status = 'active' ORDER BY started_at, id").all() as Array<{
      id?: unknown
    }>
  )
    .map((row) => cleanId(row.id))
    .filter((id): id is string => id !== null)
  if (activeIds.length === 0) return []
  transaction(() => {
    getDb().exec(`
      UPDATE chat_maestro_run_messages
      SET status = 'rolled_over', embedded_at = NULL
      WHERE status = 'pending'
        AND run_id IN (SELECT id FROM chat_maestro_runs WHERE status = 'active');
    `)
    getDb()
      .prepare("UPDATE chat_maestro_runs SET status = 'interrupted', finished_at = ? WHERE status = 'active'")
      .run(finishedAt)
  })
  return activeIds.map(getMaestroLiveRun).filter((run): run is MaestroLiveRunSnapshot => run !== null)
}

export function reconcileMaestroLiveRunsOnBoot(finishedAt?: number): MaestroLiveRunSnapshot[] {
  return reconcileActiveMaestroLiveRuns(finishedAt)
}

/** Boot hook kept count-shaped so callers can log recovery without serializing every snapshot. */
export function reconcileInterruptedMaestroLiveRuns(finishedAt?: number): number {
  return reconcileActiveMaestroLiveRuns(finishedAt).length
}

/** Chat clear removes the sidecar transcript as well; usage accounting remains in its independent ledger. */
export function clearMaestroLiveRunsForConversation(conversationIdValue: string): number {
  const conversationId = cleanId(conversationIdValue)
  if (!conversationId) return 0
  return Number(getDb().prepare('DELETE FROM chat_maestro_runs WHERE conversation_id = ?').run(conversationId).changes)
}
