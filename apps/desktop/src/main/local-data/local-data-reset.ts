import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { listAllConversations, listWorkspaces, transaction, getDb } from '../store'
import { stopWorkspaceMemoryIndex } from '../memory/index'
import { deleteAllManagedCodexThreads } from '../chat/codex-subscription/lifecycle'
import { getCodexSubscriptionManager } from '../chat/codex-subscription/manager'
import { clearAllCodexThreadCleanup } from '../chat/codex-subscription/thread-store'
import { deleteAllManagedGitHubCopilotSessions } from '../chat/github-copilot/lifecycle'
import { getGitHubCopilotSubscriptionManager } from '../chat/github-copilot/manager'
import { clearAllGitHubCopilotSessionCleanup } from '../chat/github-copilot/session-store'
import { deleteAllManagedClaudeSessions } from '../chat/claude-agent-sdk/lifecycle'
import { getClaudeSubscriptionManager } from '../chat/claude-agent-sdk/manager'
import { clearAllClaudeSessionCleanup } from '../chat/claude-agent-sdk/session-store'
import { getGrokSubscriptionManager } from '../chat/grok-subscription/manager'
import { listSubscriptionAccounts, removeSubscriptionAccount } from '../chat/catalog'
import { clearEphemeralToolImages } from '../chat/tool-output'

export interface LocalDataResetDeps {
  stopConversation: (id: string) => void | Promise<void>
  stopWorkspace: (id: string) => void | Promise<void>
}

export function assertLocalDataResetAllowed(): void {
  const incomplete = getDb()
    .prepare(
      "SELECT id FROM conversation_migrations WHERE status NOT IN ('completed', 'cancelled', 'rolled-back') LIMIT 1"
    )
    .get()
  if (incomplete) throw new Error('Resolve the incomplete conversation migration before resetting local data.')
}

/** Reset app-owned data only. Never invoke workspace-service deletion: it also removes user worktrees. */
export async function resetLocalAppData(deps: LocalDataResetDeps): Promise<void> {
  assertLocalDataResetAllowed()
  const workspaces = listWorkspaces()
  const failures: Error[] = []
  const attempt = async (action: () => unknown | Promise<unknown>): Promise<void> => {
    try {
      await action()
    } catch (error) {
      failures.push(error instanceof Error ? error : new Error(String(error)))
    }
  }
  const assertComplete = (message: string): void => {
    if (failures.length) throw new AggregateError(failures, message)
  }

  // Complete every shutdown before deleting any files, credentials, or database rows.
  for (const conversation of listAllConversations()) {
    await attempt(() => deps.stopConversation(conversation.id))
  }
  for (const workspace of workspaces) {
    await attempt(() => deps.stopWorkspace(workspace.id))
    await attempt(() => stopWorkspaceMemoryIndex(workspace.id))
  }
  assertComplete('Local data reset stopped because live work could not be shut down.')

  assertLocalDataResetAllowed()
  await attempt(() => clearEphemeralToolImages())
  assertComplete('Local data reset stopped because retired provider state could not be removed.')
  await attempt(() => deleteAllManagedCodexThreads())
  await attempt(() => deleteAllManagedGitHubCopilotSessions())
  await attempt(() => deleteAllManagedClaudeSessions())

  // Only isolated provider homes owned by this app are reset; BYOK credentials retain their lifecycle.
  const accounts = listSubscriptionAccounts()
  const accountIds = (kind: string): Array<string | null> => [
    null,
    ...accounts.filter((account) => account.kind === kind).map((account) => account.id),
  ]
  for (const id of accountIds('codex-subscription')) {
    await attempt(() => getCodexSubscriptionManager(id).resetLocalData())
  }
  for (const id of accountIds('github-copilot-subscription')) {
    await attempt(() => getGitHubCopilotSubscriptionManager(id).resetLocalData())
  }
  for (const id of accountIds('claude-subscription')) {
    await attempt(() => getClaudeSubscriptionManager(id).wipe())
  }
  for (const id of accountIds('grok-subscription')) {
    await attempt(() => getGrokSubscriptionManager(id).resetLocalData())
  }
  for (const account of accounts) await attempt(() => removeSubscriptionAccount(account.id))

  // Remove cross-workspace conversation references before workspace owners, in one transaction.
  // On a database failure retain settings and sidecars so the surviving rows remain usable.
  let databaseCleared = false
  await attempt(() => {
    transaction(() => {
      assertLocalDataResetAllowed()
      const db = getDb()
      db.prepare('DELETE FROM conversations').run()
      db.prepare('DELETE FROM workspaces').run()
      clearAllCodexThreadCleanup()
      clearAllGitHubCopilotSessionCleanup()
      clearAllClaudeSessionCleanup()
      for (const table of ['chat_usage_ledger', 'workspace_groups', 'permission_saved', 'app_settings']) {
        db.prepare(`DELETE FROM ${table}`).run()
      }
    })
    databaseCleared = true
  })
  if (!databaseCleared) assertComplete('Local data cleanup was incomplete.')

  // Fixed app-owned roots include orphaned sidecars. Never follow workspace/repository paths from the DB.
  for (const directory of ['workspace-data', 'chat-generated-images', 'chat-attachment-images', 'chat-tool-output']) {
    await attempt(() => fsp.rm(path.join(app.getPath('userData'), directory), { recursive: true, force: true }))
  }
  assertComplete('Local data cleanup was incomplete.')
}
