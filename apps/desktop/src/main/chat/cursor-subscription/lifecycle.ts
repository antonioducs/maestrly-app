import { abortCursorAccountRuns } from './account-runs'
import {
  clearCursorAgentBindings,
  clearCursorAgentCleanup,
  clearAllCursorAgentCleanup,
  getCursorAgentBinding,
  listCursorAgentBindings,
  listCursorAgentCleanup,
  markCursorAgentCleanupFailed,
  retireCursorAgentBinding,
  queueCursorAgentCleanup,
  type CursorAgentBinding,
} from './session-store'
import { getCursorSubscriptionManager, listCursorSubscriptionManagers } from './manager'

/** Persist intent first, then retire the binding after the manager drains its leases. */
async function retireAndDeleteBinding(binding: CursorAgentBinding): Promise<void> {
  queueCursorAgentCleanup(binding.conversationId, binding.agentId, binding.cwd, binding.accountId)
  const manager = getCursorSubscriptionManager(binding.accountId)
  try {
    await manager.deleteAgent(binding.agentId)
    retireCursorAgentBinding(binding.conversationId, binding.agentId)
    clearCursorAgentCleanup(binding.agentId)
  } catch (error) {
    retireCursorAgentBinding(binding.conversationId, binding.agentId)
    markCursorAgentCleanupFailed(binding.agentId, error)
  }
}

export async function deleteCursorAgentForConversation(conversationId: string): Promise<void> {
  const binding = getCursorAgentBinding(conversationId)
  if (binding) await retireAndDeleteBinding(binding)
}

export async function deleteAllManagedCursorAgents(options: { accountId?: string | null } = {}): Promise<void> {
  const managers =
    options.accountId === undefined
      ? listCursorSubscriptionManagers()
      : [getCursorSubscriptionManager(options.accountId)]
  for (const manager of managers) abortCursorAccountRuns(manager)
  const bindings = listCursorAgentBindings().filter(
    (binding) => options.accountId === undefined || binding.accountId === (options.accountId ?? null)
  )
  for (const binding of bindings) await retireAndDeleteBinding(binding)
}

export async function resetCursorSubscriptionAccount(accountId: string | null = null): Promise<void> {
  const manager = getCursorSubscriptionManager(accountId)
  await manager.resetLocalData()
  clearCursorAgentBindings(accountId)
  clearAllCursorAgentCleanup(accountId)
}

export async function wipeAllCursorSubscriptionState(accountIds?: readonly (string | null)[]): Promise<void> {
  const ids = new Set<string | null>([
    null,
    ...(accountIds ?? []),
    ...listCursorSubscriptionManagers().map((manager) => manager.accountId),
    ...listCursorAgentBindings().map((binding) => binding.accountId),
    ...listCursorAgentCleanup().map((row) => row.accountId),
  ])
  const results = await Promise.allSettled(
    [...ids].map((accountId) => getCursorSubscriptionManager(accountId).resetLocalData())
  )
  const failures = results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []))
  if (failures.length) throw new AggregateError(failures, 'Cursor account cleanup was incomplete.')
  clearCursorAgentBindings()
  clearAllCursorAgentCleanup()
}

export async function drainCursorAgentCleanup(): Promise<void> {
  const pending = listCursorAgentCleanup()
  for (const row of pending) {
    const manager = getCursorSubscriptionManager(row.accountId)
    try {
      await manager.deleteAgent(row.agentId)
      retireCursorAgentBinding(row.conversationId, row.agentId)
      clearCursorAgentCleanup(row.agentId)
    } catch (error) {
      retireCursorAgentBinding(row.conversationId, row.agentId)
      markCursorAgentCleanupFailed(row.agentId, error)
    }
  }
}

export { clearCursorAgentBindings, clearAllCursorAgentCleanup }
