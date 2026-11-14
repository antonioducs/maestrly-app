import { chatDiag } from '../diag-log'
import { claudeSubscriptionErrorMessage } from './errors'
import { getClaudeSubscriptionManager, type ClaudeSubscriptionManager } from './manager'
import {
  clearAllClaudeSessionBindings,
  clearClaudeSessionCleanup,
  getClaudeSessionBinding,
  listClaudeSessionBindings,
  listClaudeSessionCleanup,
  markClaudeSessionCleanupFailed,
  queueClaudeSessionCleanup,
  retireClaudeSessionBinding,
} from './session-store'

function alreadyAbsent(error: unknown): boolean {
  return /not found|does not exist|unknown session/i.test(claudeSubscriptionErrorMessage(error))
}

/** Which path asked for the delete, so a session that vanished can be traced in the diagnostics log. */
export type ClaudeSessionDeleteTrigger = 'conversation' | 'retry' | 'account-boundary'

export async function hardDeleteClaudeSession(
  manager: ClaudeSubscriptionManager,
  sessionId: string,
  cwd: string,
  trace?: { trigger: ClaudeSessionDeleteTrigger; conversationId: string }
): Promise<void> {
  const record = (outcome: 'deleted' | 'absent' | 'failed', error?: string): void => {
    if (!trace) return
    chatDiag({
      kind: 'claude-session-deleted',
      conv: trace.conversationId,
      session: sessionId,
      trigger: trace.trigger,
      outcome,
      ...(error ? { error: error.slice(0, 300) } : {}),
    })
  }
  try {
    await manager.deleteManagedSession(sessionId, cwd)
    clearClaudeSessionCleanup(sessionId)
    record('deleted')
  } catch (error) {
    if (alreadyAbsent(error)) {
      clearClaudeSessionCleanup(sessionId)
      record('absent')
      return
    }
    const message = claudeSubscriptionErrorMessage(error)
    markClaudeSessionCleanupFailed(sessionId, message)
    record('failed', message)
    throw new Error(message)
  }
}

export async function deleteClaudeSessionForConversation(
  conversationId: string,
  options: { strict?: boolean } = {},
  managerFor: (accountId: string | null) => ClaudeSubscriptionManager = getClaudeSubscriptionManager
): Promise<void> {
  const binding = getClaudeSessionBinding(conversationId)
  if (binding) {
    queueClaudeSessionCleanup(conversationId, binding.sessionId, binding.cwd, binding.accountId)
    retireClaudeSessionBinding(conversationId, binding.sessionId)
  }
  const cleanups = listClaudeSessionCleanup().filter((cleanup) => cleanup.conversationId === conversationId)
  const failures: unknown[] = []
  for (const cleanup of cleanups) {
    try {
      await hardDeleteClaudeSession(managerFor(cleanup.accountId), cleanup.sessionId, cleanup.cwd, {
        trigger: 'conversation',
        conversationId: cleanup.conversationId,
      })
    } catch (error) {
      failures.push(error)
      console.warn(
        `[claude-subscription] could not delete session ${cleanup.sessionId}: ${claudeSubscriptionErrorMessage(error)}`
      )
    }
  }
  if (options.strict && failures.length > 0) {
    throw failures.length === 1
      ? failures[0]
      : new AggregateError(failures, 'Could not delete all Claude sessions for this conversation')
  }
}

export async function retryManagedClaudeSessionCleanup(
  managerFor: (accountId: string | null) => ClaudeSubscriptionManager = getClaudeSubscriptionManager
): Promise<void> {
  await Promise.all(
    listClaudeSessionCleanup().map((cleanup) =>
      hardDeleteClaudeSession(managerFor(cleanup.accountId), cleanup.sessionId, cleanup.cwd, {
        trigger: 'retry',
        conversationId: cleanup.conversationId,
      }).catch(() => undefined)
    )
  )
}

let cleanupRetriedThisProcess = false

/**
 * Retries the queued deletes once per process, on the first authenticated status. A session in use is queued too —
 * a Maestro worker's from its first message until its parent turn releases it, an isolated session until its run
 * ends — so retrying on every status or config read deleted workers the parent was about to resume.
 */
export async function retryManagedClaudeSessionCleanupOnce(
  managerFor: (accountId: string | null) => ClaudeSubscriptionManager = getClaudeSubscriptionManager
): Promise<void> {
  if (cleanupRetriedThisProcess) return
  cleanupRetriedThisProcess = true
  await retryManagedClaudeSessionCleanup(managerFor)
}

/** `accountId` limits the boundary to ONE account (slot login/logout); omitted means all accounts (global wipe). */
export async function deleteAllManagedClaudeSessions(
  managerFor: (accountId: string | null) => ClaudeSubscriptionManager = getClaudeSubscriptionManager,
  options: { accountId?: string | null } = {}
): Promise<void> {
  const scoped = options.accountId !== undefined
  const target = options.accountId ?? null
  const bindings = listClaudeSessionBindings().filter((binding) => !scoped || binding.accountId === target)
  for (const binding of bindings) {
    queueClaudeSessionCleanup(binding.conversationId, binding.sessionId, binding.cwd, binding.accountId)
    retireClaudeSessionBinding(binding.conversationId, binding.sessionId)
  }
  if (!scoped) clearAllClaudeSessionBindings()
  await Promise.all(
    listClaudeSessionCleanup()
      .filter((cleanup) => !scoped || cleanup.accountId === target)
      .map((cleanup) =>
        hardDeleteClaudeSession(managerFor(cleanup.accountId), cleanup.sessionId, cleanup.cwd, {
          trigger: 'account-boundary',
          conversationId: cleanup.conversationId,
        }).catch(() => undefined)
      )
  )
}
