import {
  FLEET_ATTENTION_LIMITS,
  type FleetChatAttentionKind,
  type FleetChatAttentionSnapshotItem,
} from '@maestrly/bot-fleet-protocol'
import { conversationKind, type InboxKind } from '@maestrly/bot-fleet-protocol/inbox'
import { isAlerting, type RoutineNotify } from '../../../shared/routines'

type Emitter = {
  on(event: 'asked', listener: (payload: { conversationId: string }) => void): unknown
  off(event: 'asked', listener: (payload: { conversationId: string }) => void): unknown
}

export interface ChatAttentionState {
  status: string
  marked: boolean
  hasPendingPlan: boolean
  /** False when archived, deleted, or a routine conversation (same filter as listConversationAttention). */
  eligible: boolean
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
  /** Called when a conversation's attention kind transitions from non-null to null. */
  publishCleared?(conversationId: string): void
  /** Pre-existing attention items at startup so clearing them later emits `chat.attention.cleared`. */
  initialAttention?(): Array<{ conversationId: string; kind: FleetChatAttentionKind }>
  /** Current state of a conversation for computing `conversationKind(status, hasPendingPlan, marked)`. */
  conversationState?(conversationId: string): ChatAttentionState | null
  /** Fires when a mark is cleared, a plan changes, or a conversation is archived or deleted. */
  watchChanges?(listener: (conversationId: string) => void): () => void
}

export function toFleetChatAttentionKind(kind: InboxKind | null): FleetChatAttentionKind | null {
  switch (kind) {
    case 'plan':
      return 'plan'
    case 'question':
      return 'question'
    case 'approval':
      return 'waiting'
    case 'error':
      return 'failed'
    case 'finished':
      return 'finished'
    default:
      return null
  }
}

export function chatAttentionKindOf(
  status: string,
  hasPendingPlan: boolean,
  marked: boolean
): FleetChatAttentionKind | null {
  return toFleetChatAttentionKind(conversationKind(status, hasPendingPlan, marked))
}

export function buildChatAttentionSnapshot(
  rows: ReadonlyArray<{ id: string; name: string; status: string; marked: boolean; at: number }>,
  hasPendingPlan: (id: string) => boolean
): FleetChatAttentionSnapshotItem[] {
  const items: FleetChatAttentionSnapshotItem[] = []
  for (const row of rows) {
    const kind = chatAttentionKindOf(row.status, hasPendingPlan(row.id), row.marked)
    if (!kind) continue
    items.push({
      conversationId: row.id,
      name: row.name.slice(0, 200),
      kind,
      at: new Date(row.at > 0 ? row.at : Date.now()).toISOString(),
    })
    if (items.length >= FLEET_ATTENTION_LIMITS.entriesMax) break
  }
  return items
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
  const activeKinds = new Map<string, FleetChatAttentionKind>()
  for (const item of deps.initialAttention?.() ?? []) activeKinds.set(item.conversationId, item.kind)

  const syncConversation = (conversationId: string) => {
    if (!deps.conversationState) return
    const state = deps.conversationState(conversationId)
    const nextKind = state?.eligible ? chatAttentionKindOf(state.status, state.hasPendingPlan, state.marked) : null
    const previousKind = activeKinds.get(conversationId) ?? null
    if (nextKind === null) {
      if (previousKind !== null) {
        activeKinds.delete(conversationId)
        deps.publishCleared?.(conversationId)
      }
      return
    }
    activeKinds.set(conversationId, nextKind)
  }

  const publish = (conversationId: string, kind: FleetChatAttentionKind) => {
    const conversation = deps.conversation(conversationId)
    // A bot's conversation needs the owner as any chat does: its approvals and plans are theirs to decide.
    if (!conversation) return
    deps.publish({ conversationId, name: conversation.name.slice(0, 200), kind })
  }
  const asked = ({ conversationId }: { conversationId: string }) => {
    publish(conversationId, 'waiting')
    syncConversation(conversationId)
  }
  const question = ({ conversationId }: { conversationId: string }) => {
    publish(conversationId, 'question')
    syncConversation(conversationId)
  }
  deps.permissions.on('asked', asked)
  deps.questions.on('asked', question)
  const stopStatuses = deps.watchStatuses((conversationId, status) => {
    const previous = statuses.get(conversationId)
    statuses.set(conversationId, status)
    // Questions and approvals said so when they were asked; only a turn's end is news here.
    if (status !== previous) {
      // A run may settle before or after its turn reports ready, so whose turn it is is decided when the turn starts:
      // the owner continuing a finished run's conversation hears of each answer as in any chat.
      if (status === 'working') {
        if (deps.routineRun?.(conversationId)?.active) runTurns.add(conversationId)
        else runTurns.delete(conversationId)
      } else if (status === 'ready') {
        const routine = runTurns.delete(conversationId) ? (deps.routineRun?.(conversationId) ?? null) : null
        if (!routine || isAlerting({ status: routine.outcome }, routine.notify)) {
          publish(conversationId, deps.hasPendingPlan(conversationId) ? 'plan' : 'finished')
        }
      } else if (status === 'error') {
        runTurns.delete(conversationId)
        publish(conversationId, 'failed')
      }
    }
    syncConversation(conversationId)
  })
  const stopChanges = deps.watchChanges?.((conversationId) => syncConversation(conversationId))
  return () => {
    deps.permissions.off('asked', asked)
    deps.questions.off('asked', question)
    stopStatuses()
    stopChanges?.()
  }
}
