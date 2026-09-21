import { getDb, getConversation } from '../store'
import type { BotIdentity, BotManagementState } from '../../shared/bot'

export interface BotConversationBinding {
  instanceId: string
  ownerUserId: string
  desktopId: string
  connectionId: string
  requestId: string
  allocationId: string
  conversationId: string | null
  workspaceId: string
  branch: string
  cwd: string
  baseBranch: string
  name: string
  fingerprint: string
  phase: 'reserved' | 'allocating' | 'prepared' | 'ready' | 'deleted' | 'recovery'
  error: string | null
}

const columns = `instance_id AS instanceId,owner_user_id AS ownerUserId,desktop_id AS desktopId,
  connection_id AS connectionId,request_id AS requestId,allocation_id AS allocationId,
  conversation_id AS conversationId,workspace_id AS workspaceId,branch,cwd,base_branch AS baseBranch,
  name,fingerprint,phase,error`

export function assertBotIdentity(identity: BotIdentity, binding: BotConversationBinding): void {
  if (
    identity.instanceId !== binding.instanceId ||
    identity.connectionId !== binding.connectionId ||
    identity.ownerUserId !== binding.ownerUserId ||
    identity.desktopId !== binding.desktopId
  )
    throw new Error('The conversation belongs to another bot or desktop owner.')
}

export function findBotConversation(identity: BotIdentity, requestId: string): BotConversationBinding | null {
  const row = getDb()
    .prepare(`SELECT ${columns} FROM bot_conversation_allocations
    WHERE instance_id=? AND connection_id=? AND request_id=?`)
    .get(identity.instanceId, identity.connectionId, requestId) as unknown as BotConversationBinding | undefined
  if (row) assertBotIdentity(identity, row)
  return row ?? null
}

export function getBotConversationBinding(conversationId: string): BotConversationBinding | null {
  return (
    (getDb()
      .prepare(`SELECT ${columns} FROM bot_conversation_allocations WHERE conversation_id=?`)
      .get(conversationId) as unknown as BotConversationBinding | undefined) ?? null
  )
}

export function reserveBotConversation(value: BotConversationBinding): void {
  getDb()
    .prepare(`INSERT INTO bot_conversation_allocations
    (instance_id,owner_user_id,desktop_id,connection_id,request_id,allocation_id,workspace_id,branch,cwd,base_branch,name,fingerprint,phase)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'reserved')`)
    .run(
      value.instanceId,
      value.ownerUserId,
      value.desktopId,
      value.connectionId,
      value.requestId,
      value.allocationId,
      value.workspaceId,
      value.branch,
      value.cwd,
      value.baseBranch,
      value.name,
      value.fingerprint
    )
}

export function setBotAllocationPhase(
  allocationId: string,
  phase: BotConversationBinding['phase'],
  error: string | null = null
): void {
  getDb()
    .prepare('UPDATE bot_conversation_allocations SET phase=?,error=? WHERE allocation_id=?')
    .run(phase, error, allocationId)
}

export function bindBotConversation(allocationId: string, conversationId: string): void {
  getDb()
    .prepare("UPDATE bot_conversation_allocations SET conversation_id=?,phase='ready',error=null WHERE allocation_id=?")
    .run(conversationId, allocationId)
}

export function setBotManagementState(conversationId: string, state: BotManagementState): void {
  const conversation = getConversation(conversationId)
  if (!conversation?.botOrigin) throw new Error('This conversation is not bot-owned.')
  if (conversation.botManagementState === 'revoked' && state !== 'revoked')
    throw new Error('Revoked bot management cannot be resumed.')
  getDb().prepare('UPDATE conversations SET bot_management_state=? WHERE id=?').run(state, conversationId)
}

/**
 * Release, or close again, this bot chat for the person's own messages.
 *
 * It is not a pause: the bot keeps the chat and may send at any moment. The choice therefore survives
 * pausing, resuming and restarting, and only the person at this computer ever writes it.
 */
export function setBotManualChatEnabled(conversationId: string, enabled: boolean): void {
  const conversation = getConversation(conversationId)
  if (!conversation?.botOrigin) throw new Error('This conversation is not bot-owned.')
  getDb()
    .prepare('UPDATE conversations SET bot_manual_chat_enabled=? WHERE id=?')
    .run(enabled ? 1 : 0, conversationId)
}

export function isBotManagedConversation(conversationId: string): boolean {
  const conversation = getConversation(conversationId)
  return !!conversation?.botOrigin && conversation.botManagementState === 'active'
}

export function assertBotMutationAllowed(conversationId: string, operation: string): void {
  if (getConversation(conversationId)?.botOrigin)
    throw new Error(`${operation} cannot share or migrate a bot conversation's exclusive worktree.`)
}
