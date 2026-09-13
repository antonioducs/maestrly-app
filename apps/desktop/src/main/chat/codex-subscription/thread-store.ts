import { getDb, transaction } from '../../store'
import {
  isHarnessProfileIdentity,
  readHarnessSnapshotJson,
  type HarnessSnapshotState,
  type HarnessSnapshotV1,
} from '../../../shared/harness'

/** Identity recorded before the versioned model-harness contract existed. */
const LEGACY_DEFAULT_HARNESS_PROFILE = 'openai-default-v1'

export interface CodexThreadBinding {
  conversationId: string
  threadId: string
  modelId: string
  toolSignature: string
  /** Hash of the canonical AGENTS.override.md/AGENTS.md/CLAUDE.md block used to create the thread. */
  instructionHash: string
  harnessProfile: string
  /** Versioned harness contract of the execution that created the thread. Absent on legacy rows. */
  harnessSnapshot: HarnessSnapshotState
  lastMessageId: string
  usage: CodexUsageTotals
  /** Subscription account slot owning the thread; null means the default account. */
  accountId: string | null
  updatedAt: number
}

export interface CodexUsageTotals {
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
}

export interface CodexThreadCleanup {
  threadId: string
  conversationId: string
  lastError: string | null
  attempts: number
  /** Thread owner account: hard-delete must use the correct CODEX_HOME. */
  accountId: string | null
  createdAt: number
  updatedAt: number
}

interface BindingRow {
  conversation_id: string
  thread_id: string
  model_id: string
  tool_signature: string
  instruction_hash: string
  harness_profile: string
  harness_snapshot_json: string | null
  last_message_id: string
  usage_json: string
  account_id: string
  updated_at: number
}

interface CleanupRow {
  thread_id: string
  conversation_id: string
  last_error: string | null
  attempts: number
  account_id: string
  created_at: number
  updated_at: number
}

const EMPTY_USAGE: CodexUsageTotals = {
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
}

function parseUsage(raw: string): CodexUsageTotals {
  try {
    const value = JSON.parse(raw) as Partial<CodexUsageTotals>
    return {
      inputTokens: Math.max(0, Number(value.inputTokens) || 0),
      cachedInputTokens: Math.max(0, Number(value.cachedInputTokens) || 0),
      outputTokens: Math.max(0, Number(value.outputTokens) || 0),
      reasoningOutputTokens: Math.max(0, Number(value.reasoningOutputTokens) || 0),
    }
  } catch {
    return { ...EMPTY_USAGE }
  }
}

function fromRow(row: BindingRow): CodexThreadBinding {
  return {
    conversationId: row.conversation_id,
    threadId: row.thread_id,
    modelId: row.model_id,
    toolSignature: row.tool_signature,
    instructionHash: row.instruction_hash,
    // Syntactic validation only: an unknown but well-formed identity is preserved, never rewritten
    // into the default profile, so a newer profile round-trips through an older reader untouched.
    harnessProfile: isHarnessProfileIdentity(row.harness_profile)
      ? row.harness_profile
      : LEGACY_DEFAULT_HARNESS_PROFILE,
    harnessSnapshot: readHarnessSnapshotJson(row.harness_snapshot_json),
    lastMessageId: row.last_message_id,
    usage: parseUsage(row.usage_json),
    accountId: row.account_id || null,
    updatedAt: row.updated_at,
  }
}

export function getCodexThreadBinding(conversationId: string): CodexThreadBinding | null {
  const row = getDb().prepare('SELECT * FROM chat_codex_threads WHERE conversation_id = ?').get(conversationId) as
    | BindingRow
    | undefined
  return row ? fromRow(row) : null
}

export function listCodexThreadBindings(): CodexThreadBinding[] {
  const rows = getDb()
    .prepare('SELECT * FROM chat_codex_threads ORDER BY updated_at ASC, conversation_id ASC')
    .all() as unknown as BindingRow[]
  return rows.map(fromRow)
}

export function putCodexThreadBinding(
  input: Omit<
    CodexThreadBinding,
    'updatedAt' | 'accountId' | 'instructionHash' | 'harnessProfile' | 'harnessSnapshot'
  > & {
    accountId?: string | null
    instructionHash?: string
    harnessProfile?: string
    harnessSnapshot?: HarnessSnapshotV1 | null
  }
): void {
  const { usage, accountId, instructionHash, harnessProfile, harnessSnapshot, ...row } = input
  getDb()
    .prepare(
      `INSERT INTO chat_codex_threads
         (conversation_id, thread_id, model_id, tool_signature, instruction_hash, harness_profile, harness_snapshot_json,
          last_message_id, usage_json, account_id, updated_at)
       VALUES (@conversationId, @threadId, @modelId, @toolSignature, @instructionHash, @harnessProfile, @harnessSnapshotJson,
               @lastMessageId, @usageJson, @accountId, @updatedAt)
       ON CONFLICT(conversation_id) DO UPDATE SET
         thread_id = excluded.thread_id,
         model_id = excluded.model_id,
         tool_signature = excluded.tool_signature,
         instruction_hash = excluded.instruction_hash,
         harness_profile = excluded.harness_profile,
         harness_snapshot_json = excluded.harness_snapshot_json,
         last_message_id = excluded.last_message_id,
         usage_json = excluded.usage_json,
         account_id = excluded.account_id,
         updated_at = excluded.updated_at`
    )
    .run({
      ...row,
      instructionHash: instructionHash ?? '',
      harnessProfile: harnessProfile ?? LEGACY_DEFAULT_HARNESS_PROFILE,
      harnessSnapshotJson: harnessSnapshot ? JSON.stringify(harnessSnapshot) : null,
      usageJson: JSON.stringify(usage),
      accountId: accountId ?? '',
      updatedAt: Date.now(),
    })
}

export function clearCodexThreadBinding(conversationId: string, expectedThreadId?: string): boolean {
  const result = expectedThreadId
    ? getDb()
        .prepare('DELETE FROM chat_codex_threads WHERE conversation_id = ? AND thread_id = ?')
        .run(conversationId, expectedThreadId)
    : getDb().prepare('DELETE FROM chat_codex_threads WHERE conversation_id = ?').run(conversationId)
  return result.changes > 0
}

export function clearAllCodexThreadBindings(): number {
  return Number(getDb().prepare('DELETE FROM chat_codex_threads').run().changes)
}

function cleanupFromRow(row: CleanupRow): CodexThreadCleanup {
  return {
    threadId: row.thread_id,
    conversationId: row.conversation_id,
    lastError: row.last_error,
    attempts: row.attempts,
    accountId: row.account_id || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** Make a thread enumerable for retry before any remote removal attempt. */
export function queueCodexThreadCleanup(
  conversationId: string,
  threadId: string,
  accountId: string | null = null
): void {
  const now = Date.now()
  getDb()
    .prepare(
      `INSERT INTO chat_codex_thread_cleanup
         (thread_id, conversation_id, last_error, attempts, account_id, created_at, updated_at)
       VALUES (?, ?, NULL, 0, ?, ?, ?)
       ON CONFLICT(thread_id) DO UPDATE SET
         conversation_id = excluded.conversation_id,
         account_id = excluded.account_id,
         updated_at = excluded.updated_at`
    )
    .run(threadId, conversationId, accountId ?? '', now, now)
}

/** Atomically enqueue and invalidate the binding; compare-and-delete preserves concurrent new bindings. */
export function retireCodexThreadBinding(conversationId: string, expectedThreadId: string): boolean {
  let retired = false
  transaction(() => {
    const binding = getCodexThreadBinding(conversationId)
    if (binding?.threadId !== expectedThreadId) return
    queueCodexThreadCleanup(conversationId, expectedThreadId, binding.accountId)
    retired = clearCodexThreadBinding(conversationId, expectedThreadId)
  })
  return retired
}

export function listCodexThreadCleanup(): CodexThreadCleanup[] {
  const rows = getDb()
    .prepare('SELECT * FROM chat_codex_thread_cleanup ORDER BY created_at ASC, thread_id ASC')
    .all() as unknown as CleanupRow[]
  return rows.map(cleanupFromRow)
}

export function markCodexThreadCleanupFailed(threadId: string, error: string): void {
  getDb()
    .prepare(
      `UPDATE chat_codex_thread_cleanup
       SET last_error = ?, attempts = attempts + 1, updated_at = ?
       WHERE thread_id = ?`
    )
    .run(error, Date.now(), threadId)
}

export function clearCodexThreadCleanup(threadId: string): boolean {
  return getDb().prepare('DELETE FROM chat_codex_thread_cleanup WHERE thread_id = ?').run(threadId).changes > 0
}

/** Explicit local wipe: also remove tombstones without FKs that would survive workspace cascades. */
export function clearAllCodexThreadCleanup(): number {
  return Number(getDb().prepare('DELETE FROM chat_codex_thread_cleanup').run().changes)
}
