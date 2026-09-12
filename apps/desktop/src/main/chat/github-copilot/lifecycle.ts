import { getGitHubCopilotSubscriptionManager, type GitHubCopilotSubscriptionManager } from './manager'
import { githubCopilotErrorMessage } from './errors'
import {
  clearAllGitHubCopilotSessionBindings,
  clearGitHubCopilotSessionCleanup,
  getGitHubCopilotSessionBinding,
  listGitHubCopilotSessionBindings,
  listGitHubCopilotSessionCleanup,
  markGitHubCopilotSessionCleanupFailed,
  queueGitHubCopilotSessionCleanup,
  retireGitHubCopilotSessionBinding,
} from './session-store'

function alreadyAbsent(error: unknown): boolean {
  return /not found|does not exist|unknown session/i.test(githubCopilotErrorMessage(error))
}

const DEFAULT_DELETE_TIMEOUT_MS = 5_000

export interface DeleteGitHubCopilotSessionOptions {
  /** Permanent user deletion must surface a failure instead of only leaving a retry tombstone. */
  strict?: boolean
  /** Injectable for deterministic tests; production uses a bounded five-second RPC window. */
  timeoutMs?: number
}

function withDeleteTimeout(promise: Promise<void>, sessionId: string, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => {
        reject(new Error(`Timed out deleting GitHub Copilot session ${sessionId}`))
      },
      Math.max(1, timeoutMs)
    )
    timer.unref?.()
    promise.then(
      () => {
        clearTimeout(timer)
        resolve()
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

export async function hardDeleteGitHubCopilotSession(
  manager: GitHubCopilotSubscriptionManager,
  sessionId: string,
  timeoutMs = DEFAULT_DELETE_TIMEOUT_MS
): Promise<void> {
  try {
    await withDeleteTimeout(manager.deleteSession(sessionId), sessionId, timeoutMs)
    clearGitHubCopilotSessionCleanup(sessionId)
  } catch (error) {
    if (alreadyAbsent(error)) {
      clearGitHubCopilotSessionCleanup(sessionId)
      return
    }
    const message = githubCopilotErrorMessage(error)
    markGitHubCopilotSessionCleanupFailed(sessionId, message)
    throw new Error(message)
  }
}

/** Best-effort hard-delete before the conversation FK removes the binding. */
export async function deleteGitHubCopilotSessionForConversation(
  conversationId: string,
  options: DeleteGitHubCopilotSessionOptions = {},
  managerFor: (accountId: string | null) => GitHubCopilotSubscriptionManager = getGitHubCopilotSubscriptionManager
): Promise<void> {
  const binding = getGitHubCopilotSessionBinding(conversationId)
  if (binding) {
    retireGitHubCopilotSessionBinding(conversationId, binding.sessionId)
    queueGitHubCopilotSessionCleanup(conversationId, binding.sessionId, binding.accountId)
  }
  // A strict retry happens after the binding was retired, therefore tombstones are part of the deletion
  // contract too. This also prevents a second delete attempt from falsely succeeding after a first failure.
  const cleanups = listGitHubCopilotSessionCleanup().filter((cleanup) => cleanup.conversationId === conversationId)
  const failures: unknown[] = []
  for (const cleanup of cleanups) {
    try {
      await hardDeleteGitHubCopilotSession(managerFor(cleanup.accountId), cleanup.sessionId, options.timeoutMs)
    } catch (error) {
      failures.push(error)
      console.warn(
        `[github-copilot] could not delete session ${cleanup.sessionId}: ${githubCopilotErrorMessage(error)}`
      )
    }
  }
  if (options.strict && failures.length > 0) {
    throw failures.length === 1
      ? failures[0]
      : new AggregateError(failures, 'Could not delete all GitHub Copilot sessions for this conversation')
  }
}

/** Retries tombstones left by offline/failed runtime deletions without touching valid bindings. */
export async function retryManagedGitHubCopilotSessionCleanup(
  managerFor: (accountId: string | null) => GitHubCopilotSubscriptionManager = getGitHubCopilotSubscriptionManager
): Promise<void> {
  await Promise.all(
    listGitHubCopilotSessionCleanup().map((cleanup) =>
      hardDeleteGitHubCopilotSession(managerFor(cleanup.accountId), cleanup.sessionId).catch(() => undefined)
    )
  )
}

/**
 * Account boundary: invalidate every binding before deleting provider-owned session data. `accountId` limits the
 * boundary to ONE account; omitted means all accounts (global wipe).
 */
export async function deleteAllManagedGitHubCopilotSessions(
  managerFor: (accountId: string | null) => GitHubCopilotSubscriptionManager = getGitHubCopilotSubscriptionManager,
  options: { accountId?: string | null } = {}
): Promise<void> {
  const scoped = options.accountId !== undefined
  const target = options.accountId ?? null
  const bindings = listGitHubCopilotSessionBindings().filter((binding) => !scoped || binding.accountId === target)
  for (const binding of bindings) {
    queueGitHubCopilotSessionCleanup(binding.conversationId, binding.sessionId, binding.accountId)
    retireGitHubCopilotSessionBinding(binding.conversationId, binding.sessionId)
  }
  if (!scoped) clearAllGitHubCopilotSessionBindings()
  // Include tombstones from previous offline/failed deletes too. An account transition must not strand
  // provider-owned sessions merely because their local binding was already invalidated on an earlier attempt.
  await Promise.all(
    listGitHubCopilotSessionCleanup()
      .filter((cleanup) => !scoped || cleanup.accountId === target)
      .map((cleanup) =>
        hardDeleteGitHubCopilotSession(managerFor(cleanup.accountId), cleanup.sessionId).catch(() => undefined)
      )
  )
}
