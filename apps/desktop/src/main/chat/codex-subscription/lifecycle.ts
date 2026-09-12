import { getCodexSubscriptionManager, type CodexSubscriptionManager } from './manager'
import {
  clearCodexThreadCleanup,
  getCodexThreadBinding,
  listCodexThreadCleanup,
  listCodexThreadBindings,
  markCodexThreadCleanupFailed,
  queueCodexThreadCleanup,
  retireCodexThreadBinding,
  type CodexThreadCleanup,
} from './thread-store'

const THREAD_DELETE_TIMEOUT_MS = 15_000

export interface CodexThreadCleanupResult {
  conversationId: string
  threadId: string | null
  remoteDeleted: boolean
  error?: string
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function threadAlreadyMissing(error: string): boolean {
  const message = error.trim()
  return (
    /^(?:thread|rollout)(?:\s+\S+)?\s+(?:not found|does not exist)(?::.*)?$/i.test(message) ||
    /^no (?:thread|rollout)(?:\s+found)?(?::.*)?$/i.test(message)
  )
}

function cleanupSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(THREAD_DELETE_TIMEOUT_MS)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

async function deleteQueuedThread(
  manager: CodexSubscriptionManager,
  cleanup: CodexThreadCleanup,
  signal?: AbortSignal
): Promise<CodexThreadCleanupResult> {
  try {
    // thread/delete operates on local CODEX_HOME and does not require an active ChatGPT session.
    await manager.deleteThread(cleanup.threadId, { signal: cleanupSignal(signal) })
    clearCodexThreadCleanup(cleanup.threadId)
    return {
      conversationId: cleanup.conversationId,
      threadId: cleanup.threadId,
      remoteDeleted: true,
    }
  } catch (cause) {
    const error = messageOf(cause)
    // Hard-delete is idempotent from the product's perspective: absence is already the desired final state.
    if (threadAlreadyMissing(error)) {
      clearCodexThreadCleanup(cleanup.threadId)
      return {
        conversationId: cleanup.conversationId,
        threadId: cleanup.threadId,
        remoteDeleted: true,
      }
    }
    markCodexThreadCleanupFailed(cleanup.threadId, error)
    console.warn(`[codex-subscription] could not delete thread ${cleanup.threadId}: ${error}`)
    return {
      conversationId: cleanup.conversationId,
      threadId: cleanup.threadId,
      remoteDeleted: false,
      error,
    }
  }
}

/**
 * Hard-delete an EPHEMERAL thread WITHOUT a binding (e.g. portable summarizer): seed/confirm its tombstone and
 * attempt deletion now. Success (or an already absent thread) clears the tombstone; failure KEEPS it for durable
 * retry (retryManagedCodexThreadCleanup). NEVER touches conversation bindings.
 */
export async function deleteEphemeralCodexThread(
  conversationId: string,
  threadId: string,
  options: { signal?: AbortSignal; accountId?: string | null } = {}
): Promise<CodexThreadCleanupResult> {
  const existing = listCodexThreadCleanup().find((item) => item.threadId === threadId)
  if (!existing) queueCodexThreadCleanup(conversationId, threadId, options.accountId ?? null)
  const cleanup = existing ?? listCodexThreadCleanup().find((item) => item.threadId === threadId)
  if (!cleanup) return { conversationId, threadId, remoteDeleted: false }
  return deleteQueuedThread(getCodexSubscriptionManager(cleanup.accountId), cleanup, options.signal)
}

/** Enqueue an ID already detached from its binding (e.g. active thread during teardown) and try hard-delete now. */
export async function deleteManagedCodexThread(
  conversationId: string,
  threadId: string,
  options: { signal?: AbortSignal; accountId?: string | null } = {}
): Promise<CodexThreadCleanupResult> {
  retireCodexThreadBinding(conversationId, threadId)
  // Retirement above (or an earlier attempt) may have seeded the tombstone with the OWNER account from the
  // binding. This is authoritative and must never be overwritten by the caller's default: deletion under
  // the wrong account returns "thread not found", falsely indicating success and orphaning the real thread.
  const existing = listCodexThreadCleanup().find((item) => item.threadId === threadId)
  if (!existing) queueCodexThreadCleanup(conversationId, threadId, options.accountId ?? null)
  const cleanup = existing ?? listCodexThreadCleanup().find((item) => item.threadId === threadId)
  if (!cleanup) return { conversationId, threadId, remoteDeleted: false }
  return deleteQueuedThread(getCodexSubscriptionManager(cleanup.accountId), cleanup, options.signal)
}

/**
 * Discard a Maestrly/Codex thread. Deliberate order: try official hard-delete before removing the local binding.
 * Remote failure never blocks clear/resend/delete; invalidate the binding regardless to avoid reviving another
 * account's context or a thread the user tried to stop retaining.
 */
export async function deleteCodexThreadForConversation(
  conversationId: string,
  options: { signal?: AbortSignal } = {}
): Promise<CodexThreadCleanupResult> {
  const binding = getCodexThreadBinding(conversationId)
  if (!binding) return { conversationId, threadId: null, remoteDeleted: false }
  // Local invalidation and tombstone creation are atomic. The user action proceeds offline, but the ID is never lost.
  if (!retireCodexThreadBinding(conversationId, binding.threadId)) {
    queueCodexThreadCleanup(conversationId, binding.threadId, binding.accountId)
  }
  return deleteManagedCodexThread(conversationId, binding.threadId, { ...options, accountId: binding.accountId })
}

/**
 * Account/wipe boundary: delete only official threads managed by Maestrly; excludes BYOK. `accountId` limits this
 * to ONE account (slot login/logout); omitted means all accounts (global wipe).
 */
export async function deleteAllManagedCodexThreads(
  options: { signal?: AbortSignal; accountId?: string | null } = {}
): Promise<CodexThreadCleanupResult[]> {
  const scoped = options.accountId !== undefined
  const bindings = listCodexThreadBindings().filter(
    (binding) => !scoped || binding.accountId === (options.accountId ?? null)
  )
  for (const binding of bindings) {
    if (!retireCodexThreadBinding(binding.conversationId, binding.threadId)) {
      queueCodexThreadCleanup(binding.conversationId, binding.threadId, binding.accountId)
    }
  }
  const queued = listCodexThreadCleanup().filter(
    (cleanup) => !scoped || cleanup.accountId === (options.accountId ?? null)
  )
  if (!queued.length) return []
  return Promise.all(
    queued.map((cleanup) => deleteQueuedThread(getCodexSubscriptionManager(cleanup.accountId), cleanup, options.signal))
  )
}

/** Drain only old tombstones, without invalidating the current account's valid bindings. */
export async function retryManagedCodexThreadCleanup(
  options: { signal?: AbortSignal } = {}
): Promise<CodexThreadCleanupResult[]> {
  const queued = listCodexThreadCleanup()
  if (!queued.length) return []
  return Promise.all(
    queued.map((cleanup) => deleteQueuedThread(getCodexSubscriptionManager(cleanup.accountId), cleanup, options.signal))
  )
}
