import { getDb, transaction } from '../../store'
import { cursorSdkErrorMessage } from '../cursor-sdk/errors'

export const CURSOR_HARNESS_PROFILE = 'cursor-subscription-v1'

export interface CursorAgentBinding {
  conversationId: string
  agentId: string
  modelId: string

  modelParams: ReadonlyArray<{ id: string; value: string }>
  cwd: string
  harnessProfile: string
  instructionHash: string
  toolSignature: string
  lastMessageId: string
  accountFingerprint: string

  accountId: string | null
  usageJson: string
  updatedAt: number
}

export interface CursorAgentCleanup {
  agentId: string
  conversationId: string
  cwd: string
  lastError: string | null
  attempts: number
  accountId: string | null
  createdAt: number
  updatedAt: number
}

interface BindingRow {
  conversation_id: string
  agent_id: string
  model_id: string
  model_params_json: string
  cwd: string
  harness_profile: string
  instruction_hash: string
  tool_signature: string
  last_message_id: string
  account_fingerprint: string
  account_id: string
  usage_json: string
  updated_at: number
}

interface CleanupRow {
  agent_id: string
  conversation_id: string
  cwd: string
  last_error: string | null
  attempts: number
  account_id: string
  created_at: number
  updated_at: number
}

function parseParams(raw: string): Array<{ id: string; value: string }> {
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (entry) => entry && typeof entry === 'object' && typeof entry.id === 'string' && typeof entry.value === 'string'
    )
  } catch {
    return []
  }
}

function bindingFromRow(row: BindingRow): CursorAgentBinding {
  return {
    conversationId: row.conversation_id,
    agentId: row.agent_id,
    modelId: row.model_id,
    modelParams: parseParams(row.model_params_json),
    cwd: row.cwd,
    harnessProfile: row.harness_profile,
    instructionHash: row.instruction_hash,
    toolSignature: row.tool_signature,
    lastMessageId: row.last_message_id,
    accountFingerprint: row.account_fingerprint,
    accountId: row.account_id || null,
    usageJson: row.usage_json,
    updatedAt: row.updated_at,
  }
}

export function getCursorAgentBinding(conversationId: string): CursorAgentBinding | null {
  const row = getDb().prepare('SELECT * FROM chat_cursor_agents WHERE conversation_id = ?').get(conversationId) as
    | BindingRow
    | undefined
  return row ? bindingFromRow(row) : null
}

export function listCursorAgentBindings(): CursorAgentBinding[] {
  const rows = getDb()
    .prepare('SELECT * FROM chat_cursor_agents ORDER BY updated_at ASC, conversation_id ASC')
    .all() as unknown as BindingRow[]
  return rows.map(bindingFromRow)
}

export function putCursorAgentBinding(
  input: Omit<CursorAgentBinding, 'updatedAt' | 'accountId' | 'modelParams'> & {
    accountId?: string | null
    modelParams?: ReadonlyArray<{ id: string; value: string }>
  }
): void {
  const { accountId, modelParams, ...row } = input
  getDb()
    .prepare(
      `INSERT INTO chat_cursor_agents
         (conversation_id, agent_id, model_id, model_params_json, cwd, harness_profile, instruction_hash,
          tool_signature, last_message_id, account_fingerprint, account_id, usage_json, updated_at)
       VALUES (@conversationId, @agentId, @modelId, @modelParamsJson, @cwd, @harnessProfile, @instructionHash,
               @toolSignature, @lastMessageId, @accountFingerprint, @accountId, @usageJson, @updatedAt)
       ON CONFLICT(conversation_id) DO UPDATE SET
         agent_id = excluded.agent_id,
         model_id = excluded.model_id,
         model_params_json = excluded.model_params_json,
         cwd = excluded.cwd,
         harness_profile = excluded.harness_profile,
         instruction_hash = excluded.instruction_hash,
         tool_signature = excluded.tool_signature,
         last_message_id = excluded.last_message_id,
         account_fingerprint = excluded.account_fingerprint,
         account_id = excluded.account_id,
         usage_json = excluded.usage_json,
         updated_at = excluded.updated_at`
    )
    .run({
      ...row,
      usageJson: (row as { usageJson?: string }).usageJson ?? '{}',
      modelParamsJson: JSON.stringify(modelParams ?? []),
      accountId: accountId ?? '',
      updatedAt: Date.now(),
    })
}

export function queueCursorAgentCleanup(
  conversationId: string | null,
  agentId: string,
  cwd: string,
  accountId: string | null = null
): void {
  const now = Date.now()
  getDb()
    .prepare(
      `INSERT INTO chat_cursor_agent_cleanup
         (agent_id, conversation_id, cwd, last_error, attempts, account_id, created_at, updated_at)
       VALUES (?, ?, ?, NULL, 0, ?, ?, ?)
       ON CONFLICT(agent_id) DO UPDATE SET
         conversation_id = excluded.conversation_id,
         cwd = excluded.cwd,
         account_id = excluded.account_id,
         updated_at = excluded.updated_at`
    )

    .run(agentId, conversationId ?? '', cwd, accountId ?? '', now, now)
}

export function retireCursorAgentBinding(conversationId: string, expectedAgentId: string): boolean {
  let retired = false
  transaction(() => {
    const binding = getCursorAgentBinding(conversationId)
    if (binding?.agentId !== expectedAgentId) return
    retired =
      getDb()
        .prepare('DELETE FROM chat_cursor_agents WHERE conversation_id = ? AND agent_id = ?')
        .run(conversationId, expectedAgentId).changes > 0
  })
  return retired
}

export function clearCursorAgentBindings(accountId?: string | null): number {
  if (accountId === undefined) {
    return Number(getDb().prepare('DELETE FROM chat_cursor_agents').run().changes)
  }
  return Number(
    getDb()
      .prepare('DELETE FROM chat_cursor_agents WHERE account_id = ?')
      .run(accountId ?? '').changes
  )
}

export function listCursorAgentCleanup(): CursorAgentCleanup[] {
  const rows = getDb()
    .prepare('SELECT * FROM chat_cursor_agent_cleanup ORDER BY created_at ASC, agent_id ASC')
    .all() as unknown as CleanupRow[]
  return rows.map((row) => ({
    agentId: row.agent_id,
    conversationId: row.conversation_id,
    cwd: row.cwd,
    lastError: row.last_error,
    attempts: row.attempts,
    accountId: row.account_id || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }))
}

export function markCursorAgentCleanupFailed(agentId: string, error: unknown): void {
  getDb()
    .prepare(
      `UPDATE chat_cursor_agent_cleanup
       SET last_error = ?, attempts = attempts + 1, updated_at = ?
       WHERE agent_id = ?`
    )
    .run(cursorSdkErrorMessage(error), Date.now(), agentId)
}

export function clearCursorAgentCleanup(agentId: string): boolean {
  return getDb().prepare('DELETE FROM chat_cursor_agent_cleanup WHERE agent_id = ?').run(agentId).changes > 0
}

export function clearAllCursorAgentCleanup(accountId?: string | null): number {
  if (accountId === undefined) {
    return Number(getDb().prepare('DELETE FROM chat_cursor_agent_cleanup').run().changes)
  }
  return Number(
    getDb()
      .prepare('DELETE FROM chat_cursor_agent_cleanup WHERE account_id = ?')
      .run(accountId ?? '').changes
  )
}
