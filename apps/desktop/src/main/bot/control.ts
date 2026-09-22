import { getConversation } from '../store'
import { broadcast } from '../window-ipc'
import { setBotManagementState } from './store'

type PauseListener = (conversationId: string) => void
const pauseListeners = new Set<PauseListener>()

/** Persist the owner's pause before any queued bot command can be admitted. */
export function pauseBotForHuman(conversationId: string): void {
  const conversation = getConversation(conversationId)
  if (!conversation?.botOrigin || conversation.botManagementState !== 'active') return
  setBotManagementState(conversationId, 'paused')
  for (const listener of pauseListeners) listener(conversationId)
  broadcast('conversation:open', { conversation: getConversation(conversationId), focus: false })
}

export function observeBotPauses(listener: PauseListener): () => void {
  pauseListeners.add(listener)
  return () => pauseListeners.delete(listener)
}

/** A bot holds this chat: it was created by one, and the person has not paused or revoked it. */
function botHoldsConversation(conversationId: string): boolean {
  const conversation = getConversation(conversationId)
  return !!conversation?.botOrigin && conversation.botManagementState === 'active'
}

/**
 * Whether a message the person writes here is refused.
 *
 * Holding the chat no longer decides it on its own: a chat the person released stays with its bot and
 * still accepts what they write. Pausing remains what hands the chat back to them entirely.
 */
export function botBlocksManualSend(conversationId: string): boolean {
  return botHoldsConversation(conversationId) && !getConversation(conversationId)?.botManualChatEnabled
}

/** A released chat is shared: the person writes in it without taking it from the bot. */
export function botSharesConversation(conversationId: string): boolean {
  return botHoldsConversation(conversationId) && !!getConversation(conversationId)?.botManualChatEnabled
}

export interface BotTurnAdmission {
  connectionId: string
  botName: string
  /** Stable identifier used for the persisted user message, not supplied by renderer IPC. */
  commandId: string
  providerId: string
  modelId: string
  /** Recheck the command lease after preflight, immediately before admission. */
  assertCurrent(): void
}

export function assertBotTurnAdmission(conversationId: string, admission: BotTurnAdmission): void {
  const conversation = getConversation(conversationId)
  if (
    !conversation?.botOrigin ||
    conversation.botOrigin.connectionId !== admission.connectionId ||
    conversation.botManagementState !== 'active'
  )
    throw new Error('Bot control is paused, revoked, or belongs to another connection.')
  admission.assertCurrent()
}
