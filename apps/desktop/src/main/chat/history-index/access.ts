import { isBotMode } from '../../fleet/instance/config'
import type { MaestroWorkerScope } from '../../maestro-worker-scope'
import { getConversation, getDb } from '../../store'

/**
 * Who may read the history of other conversations, and which. Only a person's own project conversation, in the
 * desktop app and not as a delegated worker, may look into the other project conversations of its workspace
 * (archived ones included, bots' excluded). Standalone chats, bot conversations and bot runtimes stay confined to
 * their own history.
 */
export const HISTORY_WORKSPACE = { maxConversations: 200 } as const

export interface HistoryScopeConversation {
  id: string
  name: string
  lastActivityAt: number
  archived: boolean
}

export type HistoryWorkspaceAccess =
  | { ok: true; workspaceId: string; conversations: HistoryScopeConversation[] }
  | { ok: false; reason: 'worker' | 'bot' | 'standalone' | 'missing' }

function callerWorkspace(
  callerId: string,
  workerScope?: MaestroWorkerScope
): { workspaceId: string } | { reason: 'worker' | 'bot' | 'standalone' | 'missing' } {
  if (workerScope) return { reason: 'worker' }
  if (isBotMode()) return { reason: 'bot' }
  const caller = getConversation(callerId)
  if (!caller) return { reason: 'missing' }
  if (caller.botOrigin) return { reason: 'bot' }
  if (caller.scope !== 'project' || !caller.workspaceId) return { reason: 'standalone' }
  return { workspaceId: caller.workspaceId }
}

/** The caller first, then the most recently active project conversations of its workspace. */
export function workspaceHistoryAccess(callerId: string, workerScope?: MaestroWorkerScope): HistoryWorkspaceAccess {
  const caller = callerWorkspace(callerId, workerScope)
  if ('reason' in caller) return { ok: false, reason: caller.reason }
  const rows = getDb()
    .prepare(
      `SELECT id, name, last_activity_at, archived FROM conversations
       WHERE scope = 'project' AND workspace_id = ? AND bot_origin IS NULL
       ORDER BY (id = ?) DESC, last_activity_at DESC, created_at DESC LIMIT ${HISTORY_WORKSPACE.maxConversations}`
    )
    .all(caller.workspaceId, callerId) as Array<{
    id: string
    name: string
    last_activity_at: number
    archived: number
  }>
  return {
    ok: true,
    workspaceId: caller.workspaceId,
    conversations: rows.map((row) => ({
      id: row.id,
      name: row.name,
      lastActivityAt: Number(row.last_activity_at),
      archived: row.archived === 1,
    })),
  }
}

/** Whether the caller may read `targetId`'s history: its own always, another only under workspace access. */
export function canReadConversationHistory(
  callerId: string,
  targetId: string,
  workerScope?: MaestroWorkerScope
): boolean {
  if (targetId === callerId) return true
  const caller = callerWorkspace(callerId, workerScope)
  if ('reason' in caller) return false
  const target = getConversation(targetId)
  return !!target && target.scope === 'project' && target.workspaceId === caller.workspaceId && !target.botOrigin
}
