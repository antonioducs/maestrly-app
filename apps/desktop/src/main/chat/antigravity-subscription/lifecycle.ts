import { rm } from 'node:fs/promises'
import { getAntigravitySubscriptionManager, listAntigravitySubscriptionManagers } from './manager'
import { antigravityDataRoot } from './paths'
import {
  clearAntigravitySessionBindings,
  getAntigravitySessionBinding,
  listAntigravitySessionBindings,
  retireAntigravitySessionBinding,
} from './session-store'

/** Removes the ACP session behind a conversation: live toolset, server-side session, files, and binding. */
export async function deleteAntigravitySessionForConversation(conversationId: string): Promise<void> {
  for (const manager of listAntigravitySubscriptionManagers()) manager.dropLiveSession(conversationId)
  const binding = getAntigravitySessionBinding(conversationId)
  if (!binding) return
  try {
    await getAntigravitySubscriptionManager(binding.accountId).deleteSession(binding.sessionId)
  } finally {
    retireAntigravitySessionBinding(conversationId, binding.sessionId)
  }
}

/** Local-data reset: signs every account out and deletes all Antigravity state owned by Maestrly. */
export async function wipeAllAntigravitySubscriptionState(accountIds?: readonly (string | null)[]): Promise<void> {
  const ids = new Set<string | null>([
    null,
    ...(accountIds ?? []),
    ...listAntigravitySubscriptionManagers().map((manager) => manager.accountId),
    ...listAntigravitySessionBindings().map((binding) => binding.accountId),
  ])
  const results = await Promise.allSettled(
    [...ids].map((accountId) => getAntigravitySubscriptionManager(accountId).logout())
  )
  await rm(antigravityDataRoot(), { recursive: true, force: true })
  clearAntigravitySessionBindings()
  const failures = results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []))
  if (failures.length) throw new AggregateError(failures, 'Google AI account cleanup was incomplete.')
}
