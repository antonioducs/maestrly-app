/**
 * Provenance of turns that may talk to other conversations.
 *
 * A turn is either:
 * - human: admitted from text the person typed here (recorded by conversation-dispatch-authorization), hop 0; or
 * - linked: started by another conversation, either a dispatch seed or a message, report or result it sent. It
 *   carries the sending conversation and how many agent-to-agent turns led to it since a person last typed.
 *
 * Like the human origin, this is decided by the chat service at admission from how the turn entered, never from
 * transcript roles, and it is bound to the admitted run: it expires when the turn ends or a newer one starts.
 */
import { CONVERSATION_LINK_MAX_HOPS } from '../../shared/conversation-link'
import { currentHumanTurnOrigin } from './conversation-dispatch-authorization'

export interface LinkedTurnOrigin {
  /** Identity of the admitted run. */
  token: object
  conversationId: string
  /** Persisted id of the message that started the turn. */
  messageId: string
  /** Conversation whose message or dispatch started this turn. */
  peerConversationId: string
  hop: number
  /** The sender asked for this turn's final answer; report_to_source to it is redundant. */
  reportBack: boolean
  signal: AbortSignal
}

export type ConversationTurnProvenance =
  | { kind: 'human'; token: object; conversationId: string; messageId: string; hop: 0; signal: AbortSignal }
  | ({ kind: 'linked' } & LinkedTurnOrigin)

const linked = new Map<string, LinkedTurnOrigin>()

export function recordLinkedTurnOrigin(origin: LinkedTurnOrigin): void {
  linked.set(origin.conversationId, origin)
}

export function clearLinkedTurnOrigin(conversationId: string, token: object): void {
  if (linked.get(conversationId)?.token === token) linked.delete(conversationId)
}

export function currentLinkedTurnOrigin(conversationId: string): LinkedTurnOrigin | null {
  const origin = linked.get(conversationId)
  return origin && !origin.signal.aborted ? origin : null
}

/** The live turn's provenance; a turn the person typed wins over an older linked record. */
export function currentConversationTurnProvenance(conversationId: string): ConversationTurnProvenance | null {
  const human = currentHumanTurnOrigin(conversationId)
  if (human)
    return {
      kind: 'human',
      token: human.token,
      conversationId,
      messageId: human.messageId,
      hop: 0,
      signal: human.signal,
    }
  const origin = currentLinkedTurnOrigin(conversationId)
  return origin ? { kind: 'linked', ...origin } : null
}

/** Recheck right before a side effect: the captured turn must still be the conversation's live turn. */
export function assertConversationTurnProvenanceCurrent(provenance: ConversationTurnProvenance): void {
  const current = currentConversationTurnProvenance(provenance.conversationId)
  if (provenance.signal.aborted || current?.token !== provenance.token)
    throw new Error('The turn that made this request is no longer active.')
}

/** Whether a turn at `hop` may cause `extraTurns` more agent-to-agent turns (a message, plus its result). */
export function hopAllowed(hop: number, extraTurns: 1 | 2): boolean {
  return hop + extraTurns <= CONVERSATION_LINK_MAX_HOPS
}
