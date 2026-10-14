import type { ComputerOpenResult } from '../../../shared/conversation-computer'
import { isRemoteUiTarget } from '../../remote-ui-targets'
import { getConversation } from '../../store'
import { isServerMode } from './config'
import type { ConversationComputers } from './computers'

/**
 * The computers of this workspaces host's conversations, once server mode started them; null on a desktop, and on a
 * host without what they need (Linux, its X display and the bot image's display programs).
 */
let current: ConversationComputers | null = null

export function serverComputers(): ConversationComputers | null {
  return current
}

export function setServerComputers(computers: ConversationComputers | null): void {
  current = computers
}

/** Opens a conversation's computer for its Computer tab, which only another computer's window shows. */
export async function openComputerForViewer(sender: unknown, convId: unknown): Promise<ComputerOpenResult> {
  if (!isServerMode() || !isRemoteUiTarget(sender)) throw new Error('Computers are for remote viewers only.')
  if (typeof convId !== 'string' || !convId || convId.length > 200 || !getConversation(convId))
    throw new Error('Unknown conversation.')
  if (!current) return { ok: false, reason: 'unavailable' }
  return current.open(convId, 'owner')
}
