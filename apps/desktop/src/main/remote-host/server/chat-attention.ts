import type { FleetChatAttentionKind } from '@maestrly/bot-fleet-protocol'
import { isAlerting, type RoutineNotify } from '../../../shared/routines'

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
  conversation(id: string): { name: string } | undefined
  /** Whether the conversation's turn ended with a plan to decide. */
  hasPendingPlan(id: string): boolean
  /**
   * The routine run a conversation belongs to: what its routine notifies, what the run found, and whether the run is
   * still going (running or waiting for the owner). Null for any other conversation.
   */
  routineRun?(
    conversationId: string
  ): { notify: RoutineNotify; outcome: 'notable' | 'nothing_new' | 'done'; active: boolean } | null
  publish(event: { conversationId: string; name: string; kind: FleetChatAttentionKind }): void
}

/**
 * What a workspaces host's chats need from the owner, for the gateway to send to the owner's phones: a request for
 * approval, a question, a plan, and a turn that finished or failed. A computer connected to the host hears of these
 * through its own window; a phone may be in a pocket.
 */
export function watchChatAttention(deps: ChatAttentionDeps): () => void {
  const statuses = new Map<string, string>()
  /** Conversations whose current turn is a routine run's own, told when the turn starts. */
  const runTurns = new Set<string>()
  const publish = (conversationId: string, kind: FleetChatAttentionKind) => {
    const conversation = deps.conversation(conversationId)
    // A bot's conversation needs the owner as any chat does: its approvals and plans are theirs to decide.
    if (!conversation) return
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
    // A run may settle before or after its turn reports ready, so whose turn it is is decided when the turn starts: the
    // owner continuing a finished run's conversation hears of each answer as in any chat.
    if (status === 'working') {
      if (deps.routineRun?.(conversationId)?.active) runTurns.add(conversationId)
      else runTurns.delete(conversationId)
      return
    }
    if (status === 'ready') {
      const routine = runTurns.delete(conversationId) ? (deps.routineRun?.(conversationId) ?? null) : null
      if (routine && !isAlerting({ status: routine.outcome }, routine.notify)) return
      publish(conversationId, deps.hasPendingPlan(conversationId) ? 'plan' : 'finished')
    } else if (status === 'error') {
      runTurns.delete(conversationId)
      publish(conversationId, 'failed')
    }
  })
  return () => {
    deps.permissions.off('asked', asked)
    deps.questions.off('asked', question)
    stopStatuses()
  }
}
