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
  /** True when the conversation is an unarchived routine run. */
  routine?: boolean
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
  /** Fires when the owner sees a conversation (even without a DB mark) so routine-run notices clear. */
  watchSeen?(listener: (conversationId: string) => void): () => void
}

export interface ChatAttentionSync {
  /** Stops watching host events and clears listeners. */
  stop(): void
  /** Drops any in-memory notice/active tracking for `conversationId`, emitting `chat.attention.cleared` if cleared. */
  clearSeen(conversationId: string): boolean
  /** Current computed attention kind for `conversationId` based on host state and routine notices. */
  kindOf(conversationId: string): FleetChatAttentionKind | null
  /** Current in-memory routine notices eligible for inclusion in `chat.attention.snapshot`. */
  routineSnapshot(): FleetChatAttentionSnapshotItem[]
}

export function clearChatAttentionIds(
  conversationIds: ReadonlyArray<string>,
  deps: {
    clearMark(id: string): boolean
    emitAttention(id: string, attention: boolean): void
    attention: Pick<ChatAttentionSync, 'clearSeen' | 'kindOf'>
  }
): { cleared: string[] } {
  const cleared: string[] = []
  for (const id of conversationIds) {
    const clearedMark = deps.clearMark(id)
    if (clearedMark) deps.emitAttention(id, false)
    const clearedTracked = deps.attention.clearSeen(id)
    if ((clearedMark || clearedTracked) && deps.attention.kindOf(id) === null) cleared.push(id)
  }
  return { cleared }
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
  rows: ReadonlyArray<{ id: string; name: string; status: string; marked: boolean; at: number; routine?: boolean }>,
  hasPendingPlan: (id: string) => boolean,
  extra: ReadonlyArray<FleetChatAttentionSnapshotItem> = []
): FleetChatAttentionSnapshotItem[] {
  const items: FleetChatAttentionSnapshotItem[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    const kind = chatAttentionKindOf(row.status, hasPendingPlan(row.id), row.routine ? false : row.marked)
    if (!kind) continue
    seen.add(row.id)
    items.push({
      conversationId: row.id,
      name: row.name.slice(0, 200),
      kind,
      at: new Date(row.at > 0 ? row.at : Date.now()).toISOString(),
    })
    if (items.length >= FLEET_ATTENTION_LIMITS.entriesMax) return items
  }
  for (const item of extra) {
    if (seen.has(item.conversationId)) continue
    seen.add(item.conversationId)
    items.push({
      ...item,
      name: item.name.slice(0, 200),
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
export function createChatAttentionSync(deps: ChatAttentionDeps): ChatAttentionSync {
  const statuses = new Map<string, string>()
  /** Conversations whose current turn is a routine run's own, told when the turn starts. */
  const runTurns = new Set<string>()
  const activeKinds = new Map<string, FleetChatAttentionKind>()
  /** In-memory routine-run notices ('finished'/'failed') which have no DB attention mark. */
  const routineNotices = new Map<string, { kind: 'finished' | 'failed'; name: string; at: number }>()
  for (const item of deps.initialAttention?.() ?? []) activeKinds.set(item.conversationId, item.kind)

  const kindOf = (conversationId: string): FleetChatAttentionKind | null => {
    if (!deps.conversationState) return null
    const state = deps.conversationState(conversationId)
    if (state?.eligible) {
      routineNotices.delete(conversationId)
      return chatAttentionKindOf(state.status, state.hasPendingPlan, state.marked)
    }
    if (state?.routine) {
      return (
        chatAttentionKindOf(state.status, state.hasPendingPlan, false) ??
        routineNotices.get(conversationId)?.kind ??
        null
      )
    }
    routineNotices.delete(conversationId)
    return null
  }

  const syncConversation = (conversationId: string, publishedKind?: FleetChatAttentionKind) => {
    if (!deps.conversationState) return
    // N1 (out of scope): an active attention kind stays stale until the turn ends because only transitions to null clear.
    const nextKind = kindOf(conversationId) ?? publishedKind ?? null
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

  const clearSeen = (conversationId: string): boolean => {
    const hadRoutine = routineNotices.delete(conversationId)
    const hadActive = activeKinds.has(conversationId)
    if (!hadRoutine && !hadActive) return false
    syncConversation(conversationId)
    return !activeKinds.has(conversationId)
  }

  const routineSnapshot = (): FleetChatAttentionSnapshotItem[] => {
    const items: FleetChatAttentionSnapshotItem[] = []
    for (const [conversationId, entry] of routineNotices) {
      const state = deps.conversationState?.(conversationId)
      if (state !== undefined && (!state || state.eligible || !state.routine)) {
        routineNotices.delete(conversationId)
        continue
      }
      const conversation = deps.conversation(conversationId)
      if (!conversation) {
        routineNotices.delete(conversationId)
        continue
      }
      items.push({
        conversationId,
        name: conversation.name.slice(0, 200),
        kind: entry.kind,
        at: new Date(entry.at).toISOString(),
      })
    }
    return items
  }

  const publish = (conversationId: string, kind: FleetChatAttentionKind): FleetChatAttentionKind | undefined => {
    const conversation = deps.conversation(conversationId)
    // A bot's conversation needs the owner as any chat does: its approvals and plans are theirs to decide.
    if (!conversation) return undefined
    const name = conversation.name.slice(0, 200)
    deps.publish({ conversationId, name, kind })
    if (kind === 'finished' || kind === 'failed') {
      const state = deps.conversationState?.(conversationId)
      if (state && !state.eligible && state.routine) {
        routineNotices.set(conversationId, { kind, name, at: Date.now() })
      }
    }
    return kind
  }
  const asked = ({ conversationId }: { conversationId: string }) => {
    const published = publish(conversationId, 'waiting')
    syncConversation(conversationId, published)
  }
  const question = ({ conversationId }: { conversationId: string }) => {
    const published = publish(conversationId, 'question')
    syncConversation(conversationId, published)
  }
  deps.permissions.on('asked', asked)
  deps.questions.on('asked', question)
  const stopStatuses = deps.watchStatuses((conversationId, status) => {
    const previous = statuses.get(conversationId)
    statuses.set(conversationId, status)
    // Questions and approvals said so when they were asked; only a turn's end is news here.
    let publishedKind: FleetChatAttentionKind | undefined
    if (status !== previous) {
      // A run may settle before or after its turn reports ready, so whose turn it is is decided when the turn starts:
      // the owner continuing a finished run's conversation hears of each answer as in any chat.
      if (status === 'working') {
        if (deps.routineRun?.(conversationId)?.active) runTurns.add(conversationId)
        else runTurns.delete(conversationId)
        routineNotices.delete(conversationId)
      } else if (status === 'ready') {
        const routine = runTurns.delete(conversationId) ? (deps.routineRun?.(conversationId) ?? null) : null
        if (!routine || isAlerting({ status: routine.outcome }, routine.notify)) {
          publishedKind = publish(conversationId, deps.hasPendingPlan(conversationId) ? 'plan' : 'finished')
        }
      } else if (status === 'error') {
        runTurns.delete(conversationId)
        publishedKind = publish(conversationId, 'failed')
      }
    }
    syncConversation(conversationId, publishedKind)
  })
  const stopChanges = deps.watchChanges?.((conversationId) => syncConversation(conversationId))
  const stopSeen = deps.watchSeen?.((conversationId) => {
    clearSeen(conversationId)
  })
  return {
    stop: () => {
      deps.permissions.off('asked', asked)
      deps.questions.off('asked', question)
      stopStatuses()
      stopChanges?.()
      stopSeen?.()
    },
    clearSeen,
    kindOf,
    routineSnapshot,
  }
}

export function watchChatAttention(deps: ChatAttentionDeps): () => void {
  return createChatAttentionSync(deps).stop
}
