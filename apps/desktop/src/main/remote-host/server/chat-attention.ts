import type { FleetChatAttentionKind } from '@maestrly/bot-fleet-protocol'

type Emitter = {
  on(event: 'asked', listener: (payload: { conversationId: string }) => void): unknown
  off(event: 'asked', listener: (payload: { conversationId: string }) => void): unknown
}

export interface ChatAttentionDeps {
  /** Requests for approval of the host's chats. */
  permissions: Emitter
  /** Questions the host's chats ask. */
  questions: Emitter
  /** Follows the status of the host's conversations; returns how to stop. */
  watchStatuses(listener: (conversationId: string, status: string) => void): () => void
  conversation(id: string): { name: string; botOrigin?: unknown } | undefined
  /** Whether the conversation's turn ended with a plan to decide. */
  hasPendingPlan(id: string): boolean
  publish(event: { conversationId: string; name: string; kind: FleetChatAttentionKind }): void
}

/**
 * What a workspaces host's chats need from the owner, for the gateway to send to the owner's phones: a request for
 * approval, a question, a plan, and a turn that finished or failed. A computer connected to the host hears of these
 * through its own window; a phone may be in a pocket.
 */
export function watchChatAttention(deps: ChatAttentionDeps): () => void {
  const statuses = new Map<string, string>()
  const publish = (conversationId: string, kind: FleetChatAttentionKind) => {
    const conversation = deps.conversation(conversationId)
    // Bots tell the gateway themselves; a server mode host has none, but a conversation of one is never a chat.
    if (!conversation || conversation.botOrigin) return
    deps.publish({ conversationId, name: conversation.name.slice(0, 200), kind })
  }
  const asked = ({ conversationId }: { conversationId: string }) => publish(conversationId, 'waiting')
  const question = ({ conversationId }: { conversationId: string }) => publish(conversationId, 'question')
  deps.permissions.on('asked', asked)
  deps.questions.on('asked', question)
  const stopStatuses = deps.watchStatuses((conversationId, status) => {
    const previous = statuses.get(conversationId)
    statuses.set(conversationId, status)
    // Questions and approvals said so when they were asked; only a turn's end is news here.
    if (status === previous) return
    if (status === 'ready') publish(conversationId, deps.hasPendingPlan(conversationId) ? 'plan' : 'finished')
    else if (status === 'error') publish(conversationId, 'failed')
  })
  return () => {
    deps.permissions.off('asked', asked)
    deps.questions.off('asked', question)
    stopStatuses()
  }
}
