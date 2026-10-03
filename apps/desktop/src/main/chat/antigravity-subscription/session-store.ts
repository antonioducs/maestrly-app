import { getDb } from '../../store'

/** Everything that must still match for an Antigravity ACP session to continue a Maestrly conversation. */
export interface AntigravitySessionBinding {
  conversationId: string
  accountId: string | null
  accountFingerprint: string
  sessionId: string
  modelValue: string
  toolSignature: string
  instructionHash: string
  lastMessageId: string | null
  updatedAt: number
}

interface BindingRow {
  conversation_id: string
  account_id: string
  account_fingerprint: string
  session_id: string
  model_value: string
  tool_signature: string
  instruction_hash: string
  last_message_id: string | null
  updated_at: number
}

function bindingFromRow(row: BindingRow): AntigravitySessionBinding {
  return {
    conversationId: row.conversation_id,
    accountId: row.account_id || null,
    accountFingerprint: row.account_fingerprint,
    sessionId: row.session_id,
    modelValue: row.model_value,
    toolSignature: row.tool_signature,
    instructionHash: row.instruction_hash,
    lastMessageId: row.last_message_id,
    updatedAt: row.updated_at,
  }
}

export function getAntigravitySessionBinding(conversationId: string): AntigravitySessionBinding | undefined {
  const row = getDb()
    .prepare('SELECT * FROM chat_antigravity_sessions WHERE conversation_id = ?')
    .get(conversationId) as BindingRow | undefined
  return row ? bindingFromRow(row) : undefined
}

export function listAntigravitySessionBindings(): AntigravitySessionBinding[] {
  const rows = getDb()
    .prepare('SELECT * FROM chat_antigravity_sessions ORDER BY updated_at ASC, conversation_id ASC')
    .all() as unknown as BindingRow[]
  return rows.map(bindingFromRow)
}

export function putAntigravitySessionBinding(
  binding: Omit<AntigravitySessionBinding, 'updatedAt'> & { updatedAt?: number }
): void {
  getDb()
    .prepare(
      `INSERT INTO chat_antigravity_sessions
         (conversation_id, account_id, account_fingerprint, session_id, model_value, tool_signature,
          instruction_hash, last_message_id, updated_at)
       VALUES (@conversationId, @accountId, @accountFingerprint, @sessionId, @modelValue, @toolSignature,
               @instructionHash, @lastMessageId, @updatedAt)
       ON CONFLICT(conversation_id) DO UPDATE SET
         account_id = excluded.account_id,
         account_fingerprint = excluded.account_fingerprint,
         session_id = excluded.session_id,
         model_value = excluded.model_value,
         tool_signature = excluded.tool_signature,
         instruction_hash = excluded.instruction_hash,
         last_message_id = excluded.last_message_id,
         updated_at = excluded.updated_at`
    )
    .run({
      conversationId: binding.conversationId,
      accountId: binding.accountId ?? '',
      accountFingerprint: binding.accountFingerprint,
      sessionId: binding.sessionId,
      modelValue: binding.modelValue,
      toolSignature: binding.toolSignature,
      instructionHash: binding.instructionHash,
      lastMessageId: binding.lastMessageId,
      updatedAt: binding.updatedAt ?? Date.now(),
    })
}

/** Deletes the binding only if it still points at `expectedSessionId`. */
export function retireAntigravitySessionBinding(conversationId: string, expectedSessionId: string): boolean {
  const result = getDb()
    .prepare('DELETE FROM chat_antigravity_sessions WHERE conversation_id = ? AND session_id = ?')
    .run(conversationId, expectedSessionId)
  return Number(result.changes) > 0
}

/** `undefined` clears every account; `null` is the default account. */
export function clearAntigravitySessionBindings(accountId?: string | null): void {
  if (accountId === undefined) {
    getDb().prepare('DELETE FROM chat_antigravity_sessions').run()
    return
  }
  getDb()
    .prepare('DELETE FROM chat_antigravity_sessions WHERE account_id = ?')
    .run(accountId ?? '')
}
