import { getDb, transaction } from '../../store'

export type GitHubCopilotHarnessProfile = 'copilot-openai-v1' | 'copilot-anthropic-v1' | 'copilot-generic-v1'

export interface GitHubCopilotSessionBinding {
  conversationId: string
  sessionId: string
  modelId: string
  harnessProfile: GitHubCopilotHarnessProfile
  toolSignature: string
  lastMessageId: string
  accountFingerprint: string
  /** Subscription account slot owning the session; null means the default account. */
  accountId: string | null
  updatedAt: number
}

export interface GitHubCopilotSessionCleanup {
  sessionId: string
  conversationId: string
  lastError: string | null
  attempts: number
  /** Session owner account: hard-delete must use the correct runtime/token. */
  accountId: string | null
  createdAt: number
  updatedAt: number
}

interface BindingRow {
  conversation_id: string
  session_id: string
  model_id: string
  harness_profile: GitHubCopilotHarnessProfile
  tool_signature: string
  last_message_id: string
  account_fingerprint: string
  account_id: string
  updated_at: number
}

interface CleanupRow {
  session_id: string
  conversation_id: string
  last_error: string | null
  attempts: number
  account_id: string
  created_at: number
  updated_at: number
}

function bindingFromRow(row: BindingRow): GitHubCopilotSessionBinding {
  return {
    conversationId: row.conversation_id,
    sessionId: row.session_id,
    modelId: row.model_id,
    harnessProfile: row.harness_profile,
    toolSignature: row.tool_signature,
    lastMessageId: row.last_message_id,
    accountFingerprint: row.account_fingerprint,
    accountId: row.account_id || null,
    updatedAt: row.updated_at,
  }
}

export function getGitHubCopilotSessionBinding(conversationId: string): GitHubCopilotSessionBinding | null {
  const row = getDb()
    .prepare('SELECT * FROM chat_github_copilot_sessions WHERE conversation_id = ?')
    .get(conversationId) as BindingRow | undefined
  return row ? bindingFromRow(row) : null
}

export function listGitHubCopilotSessionBindings(): GitHubCopilotSessionBinding[] {
  const rows = getDb()
    .prepare('SELECT * FROM chat_github_copilot_sessions ORDER BY updated_at ASC, conversation_id ASC')
    .all() as unknown as BindingRow[]
  return rows.map(bindingFromRow)
}

export function putGitHubCopilotSessionBinding(
  input: Omit<GitHubCopilotSessionBinding, 'updatedAt' | 'accountId'> & { accountId?: string | null }
): void {
  const { accountId, ...row } = input
  getDb()
    .prepare(
      `INSERT INTO chat_github_copilot_sessions
         (conversation_id, session_id, model_id, harness_profile, tool_signature, last_message_id,
          account_fingerprint, account_id, updated_at)
       VALUES (@conversationId, @sessionId, @modelId, @harnessProfile, @toolSignature, @lastMessageId,
               @accountFingerprint, @accountId, @updatedAt)
       ON CONFLICT(conversation_id) DO UPDATE SET
         session_id = excluded.session_id,
         model_id = excluded.model_id,
         harness_profile = excluded.harness_profile,
         tool_signature = excluded.tool_signature,
         last_message_id = excluded.last_message_id,
         account_fingerprint = excluded.account_fingerprint,
         account_id = excluded.account_id,
         updated_at = excluded.updated_at`
    )
    .run({ ...row, accountId: accountId ?? '', updatedAt: Date.now() })
}

export function queueGitHubCopilotSessionCleanup(
  conversationId: string,
  sessionId: string,
  accountId: string | null = null
): void {
  const now = Date.now()
  getDb()
    .prepare(
      `INSERT INTO chat_github_copilot_session_cleanup
         (session_id, conversation_id, last_error, attempts, account_id, created_at, updated_at)
       VALUES (?, ?, NULL, 0, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         conversation_id = excluded.conversation_id,
         account_id = excluded.account_id,
         updated_at = excluded.updated_at`
    )
    .run(sessionId, conversationId, accountId ?? '', now, now)
}

export function retireGitHubCopilotSessionBinding(conversationId: string, expectedSessionId: string): boolean {
  let retired = false
  transaction(() => {
    const binding = getGitHubCopilotSessionBinding(conversationId)
    if (binding?.sessionId !== expectedSessionId) return
    queueGitHubCopilotSessionCleanup(conversationId, expectedSessionId, binding.accountId)
    retired =
      getDb()
        .prepare('DELETE FROM chat_github_copilot_sessions WHERE conversation_id = ? AND session_id = ?')
        .run(conversationId, expectedSessionId).changes > 0
  })
  return retired
}

export function clearAllGitHubCopilotSessionBindings(): number {
  return Number(getDb().prepare('DELETE FROM chat_github_copilot_sessions').run().changes)
}

export function listGitHubCopilotSessionCleanup(): GitHubCopilotSessionCleanup[] {
  const rows = getDb()
    .prepare('SELECT * FROM chat_github_copilot_session_cleanup ORDER BY created_at ASC, session_id ASC')
    .all() as unknown as CleanupRow[]
  return rows.map((row) => ({
    sessionId: row.session_id,
    conversationId: row.conversation_id,
    lastError: row.last_error,
    attempts: row.attempts,
    accountId: row.account_id || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }))
}

export function markGitHubCopilotSessionCleanupFailed(sessionId: string, error: string): void {
  getDb()
    .prepare(
      `UPDATE chat_github_copilot_session_cleanup
       SET last_error = ?, attempts = attempts + 1, updated_at = ?
       WHERE session_id = ?`
    )
    .run(error, Date.now(), sessionId)
}

export function clearGitHubCopilotSessionCleanup(sessionId: string): boolean {
  return (
    getDb().prepare('DELETE FROM chat_github_copilot_session_cleanup WHERE session_id = ?').run(sessionId).changes > 0
  )
}

export function clearAllGitHubCopilotSessionCleanup(): number {
  return Number(getDb().prepare('DELETE FROM chat_github_copilot_session_cleanup').run().changes)
}
