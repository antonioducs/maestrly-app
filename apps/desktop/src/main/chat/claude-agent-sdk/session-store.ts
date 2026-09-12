import { getDb, transaction } from '../../store'

export const CLAUDE_HARNESS_PROFILE = 'maestrly-claude-v1'

export interface ClaudeSessionUsageSnapshot {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  costUsd: number
  turns: number
  durationMs: number
  durationApiMs: number
}

export interface ClaudeContextSnapshot {
  totalTokens: number
  maxTokens: number
  percentage: number
  model: string
}

export interface ClaudeSessionBinding {
  conversationId: string
  sessionId: string
  modelId: string
  effort: string
  fastMode: boolean
  cwd: string
  harnessProfile: string
  promptHash: string
  toolSignature: string
  lastMessageId: string
  lastAssistantUuid: string | null
  accountFingerprint: string
  accountEpoch: number
  /** Subscription account slot owning the session; null means the default account. */
  accountId: string | null
  usage: ClaudeSessionUsageSnapshot
  context: ClaudeContextSnapshot | null
  updatedAt: number
}

export interface ClaudeMessageMapping {
  conversationId: string
  maestrlyMessageId: string
  sessionId: string
  sdkUserUuid: string | null
  sdkAssistantUuid: string | null
  createdAt: number
}

export interface ClaudeSessionCleanup {
  sessionId: string
  conversationId: string
  cwd: string
  lastError: string | null
  attempts: number
  /** Session owner account: hard-delete must use the correct CLAUDE_CONFIG_DIR. */
  accountId: string | null
  createdAt: number
  updatedAt: number
}

const EMPTY_USAGE: ClaudeSessionUsageSnapshot = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0,
  turns: 0,
  durationMs: 0,
  durationApiMs: 0,
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback
  try {
    return { ...fallback, ...(JSON.parse(raw) as Partial<T>) }
  } catch {
    return fallback
  }
}

interface BindingRow {
  conversation_id: string
  session_id: string
  model_id: string
  effort: string
  fast_mode: number
  cwd: string
  harness_profile: string
  prompt_hash: string
  tool_signature: string
  last_message_id: string
  last_assistant_uuid: string | null
  account_fingerprint: string
  account_epoch: number
  account_id: string
  usage_json: string
  context_json: string | null
  updated_at: number
}

function bindingFromRow(row: BindingRow): ClaudeSessionBinding {
  return {
    conversationId: row.conversation_id,
    sessionId: row.session_id,
    modelId: row.model_id,
    effort: row.effort,
    fastMode: row.fast_mode === 1,
    cwd: row.cwd,
    harnessProfile: row.harness_profile,
    promptHash: row.prompt_hash,
    toolSignature: row.tool_signature,
    lastMessageId: row.last_message_id,
    lastAssistantUuid: row.last_assistant_uuid,
    accountFingerprint: row.account_fingerprint,
    accountEpoch: row.account_epoch,
    accountId: row.account_id || null,
    usage: parseJson(row.usage_json, EMPTY_USAGE),
    context: parseJson<ClaudeContextSnapshot | null>(row.context_json, null),
    updatedAt: row.updated_at,
  }
}

export function getClaudeSessionBinding(conversationId: string): ClaudeSessionBinding | null {
  const row = getDb()
    .prepare('SELECT * FROM chat_claude_sessions WHERE conversation_id = ?')
    .get(conversationId) as BindingRow | undefined
  return row ? bindingFromRow(row) : null
}

export function listClaudeSessionBindings(): ClaudeSessionBinding[] {
  return (
    getDb()
      .prepare('SELECT * FROM chat_claude_sessions ORDER BY updated_at ASC, conversation_id ASC')
      .all() as unknown as BindingRow[]
  ).map(bindingFromRow)
}

export function putClaudeSessionBinding(
  input: Omit<ClaudeSessionBinding, 'updatedAt' | 'accountId'> & { accountId?: string | null }
): void {
  transaction(() => {
    const current = getClaudeSessionBinding(input.conversationId)
    if (current && current.sessionId !== input.sessionId) {
      queueClaudeSessionCleanup(current.conversationId, current.sessionId, current.cwd, current.accountId)
      getDb()
        .prepare('DELETE FROM chat_claude_sessions WHERE conversation_id = ? AND session_id = ?')
        .run(current.conversationId, current.sessionId)
    }
    const { usage, context, fastMode, accountId, ...row } = input
    getDb()
      .prepare(
        `INSERT INTO chat_claude_sessions
           (conversation_id, session_id, model_id, effort, fast_mode, cwd, harness_profile, prompt_hash,
            tool_signature, last_message_id, last_assistant_uuid, account_fingerprint, account_epoch,
            account_id, usage_json, context_json, updated_at)
         VALUES
           (@conversationId, @sessionId, @modelId, @effort, @fastMode, @cwd, @harnessProfile, @promptHash,
            @toolSignature, @lastMessageId, @lastAssistantUuid, @accountFingerprint, @accountEpoch,
            @accountId, @usageJson, @contextJson, @updatedAt)
         ON CONFLICT(conversation_id) DO UPDATE SET
           session_id = excluded.session_id,
           model_id = excluded.model_id,
           effort = excluded.effort,
           fast_mode = excluded.fast_mode,
           cwd = excluded.cwd,
           harness_profile = excluded.harness_profile,
           prompt_hash = excluded.prompt_hash,
           tool_signature = excluded.tool_signature,
           last_message_id = excluded.last_message_id,
           last_assistant_uuid = excluded.last_assistant_uuid,
           account_fingerprint = excluded.account_fingerprint,
           account_epoch = excluded.account_epoch,
           account_id = excluded.account_id,
           usage_json = excluded.usage_json,
           context_json = excluded.context_json,
           updated_at = excluded.updated_at`
      )
      .run({
        ...row,
        fastMode: fastMode ? 1 : 0,
        accountId: accountId ?? '',
        usageJson: JSON.stringify(usage),
        contextJson: context ? JSON.stringify(context) : null,
        updatedAt: Date.now(),
      })
  })
}

export function putClaudeMessageMapping(input: Omit<ClaudeMessageMapping, 'createdAt'>): void {
  getDb()
    .prepare(
      `INSERT INTO chat_claude_message_map
         (conversation_id, maestrly_message_id, session_id, sdk_user_uuid, sdk_assistant_uuid, created_at)
       VALUES (@conversationId, @maestrlyMessageId, @sessionId, @sdkUserUuid, @sdkAssistantUuid, @createdAt)
       ON CONFLICT(conversation_id, maestrly_message_id) DO UPDATE SET
         session_id = excluded.session_id,
         sdk_user_uuid = COALESCE(excluded.sdk_user_uuid, chat_claude_message_map.sdk_user_uuid),
         sdk_assistant_uuid = COALESCE(excluded.sdk_assistant_uuid, chat_claude_message_map.sdk_assistant_uuid)`
    )
    .run({ ...input, createdAt: Date.now() })
}

export function getClaudeMessageMapping(
  conversationId: string,
  maestrlyMessageId: string
): ClaudeMessageMapping | null {
  const row = getDb()
    .prepare(
      `SELECT conversation_id, maestrly_message_id, session_id, sdk_user_uuid, sdk_assistant_uuid, created_at
       FROM chat_claude_message_map WHERE conversation_id = ? AND maestrly_message_id = ?`
    )
    .get(conversationId, maestrlyMessageId) as
    | {
        conversation_id: string
        maestrly_message_id: string
        session_id: string
        sdk_user_uuid: string | null
        sdk_assistant_uuid: string | null
        created_at: number
      }
    | undefined
  return row
    ? {
        conversationId: row.conversation_id,
        maestrlyMessageId: row.maestrly_message_id,
        sessionId: row.session_id,
        sdkUserUuid: row.sdk_user_uuid,
        sdkAssistantUuid: row.sdk_assistant_uuid,
        createdAt: row.created_at,
      }
    : null
}

export function reassignClaudeMessageMappings(
  conversationId: string,
  fromSessionId: string,
  toSessionId: string
): number {
  if (!fromSessionId || !toSessionId || fromSessionId === toSessionId) return 0
  return Number(
    getDb()
      .prepare(
        `UPDATE chat_claude_message_map
         SET session_id = ?
         WHERE conversation_id = ? AND session_id = ?`
      )
      .run(toSessionId, conversationId, fromSessionId).changes
  )
}

export function clearClaudeSessionBinding(conversationId: string, expectedSessionId?: string): boolean {
  const result = expectedSessionId
    ? getDb()
        .prepare('DELETE FROM chat_claude_sessions WHERE conversation_id = ? AND session_id = ?')
        .run(conversationId, expectedSessionId)
    : getDb().prepare('DELETE FROM chat_claude_sessions WHERE conversation_id = ?').run(conversationId)
  return result.changes > 0
}

export function clearAllClaudeSessionBindings(): number {
  return Number(getDb().prepare('DELETE FROM chat_claude_sessions').run().changes)
}

export function queueClaudeSessionCleanup(
  conversationId: string,
  sessionId: string,
  cwd: string,
  accountId: string | null = null
): void {
  const now = Date.now()
  getDb()
    .prepare(
      `INSERT INTO chat_claude_session_cleanup
         (session_id, conversation_id, cwd, last_error, attempts, account_id, created_at, updated_at)
       VALUES (?, ?, ?, NULL, 0, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         conversation_id = excluded.conversation_id,
         cwd = excluded.cwd,
         account_id = excluded.account_id,
         updated_at = excluded.updated_at`
    )
    .run(sessionId, conversationId, cwd, accountId ?? '', now, now)
}

export function retireClaudeSessionBinding(conversationId: string, expectedSessionId: string): boolean {
  let retired = false
  transaction(() => {
    const binding = getClaudeSessionBinding(conversationId)
    if (binding?.sessionId !== expectedSessionId) return
    queueClaudeSessionCleanup(conversationId, expectedSessionId, binding.cwd, binding.accountId)
    retired = clearClaudeSessionBinding(conversationId, expectedSessionId)
  })
  return retired
}

export function listClaudeSessionCleanup(): ClaudeSessionCleanup[] {
  const rows = getDb()
    .prepare('SELECT * FROM chat_claude_session_cleanup ORDER BY created_at ASC, session_id ASC')
    .all() as unknown as Array<{
    session_id: string
    conversation_id: string
    cwd: string
    last_error: string | null
    attempts: number
    account_id: string
    created_at: number
    updated_at: number
  }>
  return rows.map((row) => ({
    sessionId: row.session_id,
    conversationId: row.conversation_id,
    cwd: row.cwd,
    lastError: row.last_error,
    attempts: row.attempts,
    accountId: row.account_id || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }))
}

export function markClaudeSessionCleanupFailed(sessionId: string, error: string): void {
  getDb()
    .prepare(
      `UPDATE chat_claude_session_cleanup
       SET last_error = ?, attempts = attempts + 1, updated_at = ?
       WHERE session_id = ?`
    )
    .run(error, Date.now(), sessionId)
}

export function clearClaudeSessionCleanup(sessionId: string): boolean {
  return getDb().prepare('DELETE FROM chat_claude_session_cleanup WHERE session_id = ?').run(sessionId).changes > 0
}

export function clearAllClaudeSessionCleanup(): number {
  return Number(getDb().prepare('DELETE FROM chat_claude_session_cleanup').run().changes)
}
