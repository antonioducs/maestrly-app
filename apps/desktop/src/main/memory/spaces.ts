import { PERSONAL_MEMORY_SPACE_ID } from '../../shared/memory'
import { isBotMode } from '../fleet/instance/config'
export { PERSONAL_MEMORY_SPACE_ID } from '../../shared/memory'
import { getConversation } from '../store'
import { getDb } from '../store/db'
import { isWorkspaceMemoryEnabled, isMemorySpaceEnabled } from './access'
import type { MemoryScopeRoot } from './index'

/**
 * The memory space of a bot container from before environments, when a container ran one bot. Starting a newer
 * Maestrly on such a container moves its entries to the bot's own space (`botMemorySpaceId`).
 */
export const LEGACY_BOT_MEMORY_SPACE_ID = 'bot-self'
/** A host-defined bot space id; kept for callers that only need some bot space. */
export const BOT_MEMORY_SPACE_ID = LEGACY_BOT_MEMORY_SPACE_ID

/** The durable memory space of one bot: bots that share an environment never share memories. */
export function botMemorySpaceId(botId: string): string {
  return `${LEGACY_BOT_MEMORY_SPACE_ID}:${botId}`
}
export type MemorySpaceKind = 'workspace' | 'bot' | 'personal'
export interface MemorySpace {
  id: string
  kind: MemorySpaceKind
  roots: MemoryScopeRoot[]
}

const registered = new Map<string, { id: string; kind: 'bot' }>()

/** A host (the bot runtime) gives a conversation without a workspace its own memory space. */
export function registerConversationMemorySpace(conversationId: string, space: { id: string; kind: 'bot' }): void {
  registered.set(conversationId, space)
}

export function clearConversationMemorySpace(conversationId: string): void {
  registered.delete(conversationId)
}

/** Eligibility ignores the user setting so tools can explain disabled personal memory. */
export function isPersonalMemoryConversation(conversationId: string): boolean {
  if (registered.has(conversationId) || isBotMode()) return false
  const conversation = getConversation(conversationId)
  if (conversation?.scope !== 'standalone') return false
  // Archived fleet conversations lose their runtime registration but retain their host-owned profile.
  // This also preserves isolation when a fleet profile is opened outside the bot process.
  return !getDb()
    .prepare(
      `SELECT 1 FROM app_settings
       WHERE (key = 'fleet.instance.profile' OR key GLOB 'fleet.instance.bots.*.profile')
       AND json_extract(CASE WHEN json_valid(value) THEN value ELSE '{}' END, '$.primaryConversationId') = ?
       LIMIT 1`
    )
    .get(conversationId)
}

export function memorySpaceForConversation(conversationId: string): MemorySpace | null {
  const bound = registered.get(conversationId)
  if (bound) return { ...bound, roots: [] }
  if (isPersonalMemoryConversation(conversationId))
    return isMemorySpaceEnabled(PERSONAL_MEMORY_SPACE_ID)
      ? { id: PERSONAL_MEMORY_SPACE_ID, kind: 'personal', roots: [] }
      : null
  const conversation = getConversation(conversationId)
  if (conversation?.scope !== 'project' || !conversation.workspaceId) return null
  if (!isWorkspaceMemoryEnabled(conversation.workspaceId)) return null
  return {
    id: conversation.workspaceId,
    kind: 'workspace',
    roots: conversation.isMulti
      ? (conversation.repos ?? []).map((repo) => ({ root: repo.worktreePath, linkName: repo.linkName }))
      : [{ root: conversation.cwd }],
  }
}
