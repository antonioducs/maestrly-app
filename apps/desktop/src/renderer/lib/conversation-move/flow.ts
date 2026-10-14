import type { Conversation } from '../../../preload'
import type { MoveChangedEvent, MovePreview, MoveRecovery, MoveResult } from '../../../shared/conversation-move'
import { type HostId, hostKey, isRemoteHostId, parseHostKey } from '../../../shared/host-key'
import type { HostView } from '../../../shared/hosts'

/** What the sidebar can tell before asking: the source host checks the rest. */
export const isApparentlyMoveEligible = (conversation: Conversation): boolean =>
  conversation.scope === 'project' &&
  conversation.isMulti === 0 &&
  conversation.archived === 0 &&
  !conversation.botOrigin

export interface MoveTarget {
  hostId: HostId
  /** null: this computer, named by the view. */
  label: string | null
}

/** The online hosts a conversation can move to: every one but its own. */
export function moveTargetsFor(conversationKey: string, hosts: HostView[]): MoveTarget[] {
  const own = parseHostKey(conversationKey).hostId
  return hosts
    .filter((host) => host.id !== own && host.state === 'online')
    .map((host) => ({ hostId: host.id, label: host.remote ? host.label : null }))
}

/** The window's key for a conversation that now lives on `hostId`. */
export const moveTargetConversationKey = (hostId: HostId, id: string): string =>
  isRemoteHostId(hostId) ? hostKey(hostId, id) : id

export type MoveFlowState =
  | { kind: 'idle' }
  | {
      kind: 'preparing'
      sourceHostId: HostId
      conversationId: string
      targetHostId: HostId
      conversationName: string
      /** The branch name the person typed, when they chose one. */
      targetBranch?: string
    }
  | { kind: 'preview'; preview: MovePreview; selected: string[]; confirmed: string[]; branchDraft: string }
  | { kind: 'executing'; preview: MovePreview; event: MoveChangedEvent | null }
  | { kind: 'done'; preview: MovePreview; result: MoveResult }
  | { kind: 'error'; message: string; preview: MovePreview | null; recovery: MoveRecovery | null }

export type MoveFlowAction =
  | {
      type: 'prepare'
      sourceHostId: HostId
      conversationId: string
      targetHostId: HostId
      conversationName: string
      targetBranch?: string
    }
  | { type: 'prepared'; preview: MovePreview }
  | { type: 'toggle-ignored'; path: string }
  | { type: 'confirm-sensitive'; path: string }
  | { type: 'edit-branch'; value: string }
  | { type: 'execute' }
  | { type: 'progress'; event: MoveChangedEvent }
  | { type: 'finished'; result: MoveResult }
  | { type: 'failed'; message: string }
  | { type: 'close' }

export const initialMoveFlow: MoveFlowState = { kind: 'idle' }

/** The preview the dialog shows, whatever it is doing with it. */
export function previewOf(state: MoveFlowState): MovePreview | null {
  return state.kind === 'preview' || state.kind === 'executing' || state.kind === 'done' || state.kind === 'error'
    ? state.preview
    : null
}

export function moveFlowReducer(state: MoveFlowState, action: MoveFlowAction): MoveFlowState {
  switch (action.type) {
    case 'prepare':
      return {
        kind: 'preparing',
        sourceHostId: action.sourceHostId,
        conversationId: action.conversationId,
        targetHostId: action.targetHostId,
        conversationName: action.conversationName,
        ...(action.targetBranch ? { targetBranch: action.targetBranch } : {}),
      }
    case 'prepared':
      if (state.kind !== 'preparing') return state
      return {
        kind: 'preview',
        preview: action.preview,
        selected: [],
        confirmed: [],
        // A refused name stays in the field, to be corrected.
        branchDraft: action.preview.target?.branch ?? state.targetBranch ?? action.preview.source.branch ?? '',
      }
    case 'toggle-ignored': {
      if (state.kind !== 'preview') return state
      const selected = state.selected.includes(action.path)
        ? state.selected.filter((path) => path !== action.path)
        : [...state.selected, action.path]
      return { ...state, selected, confirmed: state.confirmed.filter((path) => selected.includes(path)) }
    }
    case 'confirm-sensitive': {
      if (state.kind !== 'preview' || !state.selected.includes(action.path)) return state
      const confirmed = state.confirmed.includes(action.path)
        ? state.confirmed.filter((path) => path !== action.path)
        : [...state.confirmed, action.path]
      return { ...state, confirmed }
    }
    case 'edit-branch':
      return state.kind === 'preview' ? { ...state, branchDraft: action.value } : state
    case 'execute': {
      const preview = previewOf(state)
      if (!preview || state.kind === 'executing' || state.kind === 'done') return state
      return { kind: 'executing', preview, event: null }
    }
    case 'progress':
      if (state.kind !== 'executing' || action.event.operationId !== state.preview.operationId) return state
      return { ...state, event: action.event }
    case 'finished': {
      const preview = previewOf(state)
      if (!preview || action.result.operationId !== preview.operationId) return state
      if (action.result.status === 'recovery-required')
        return {
          kind: 'error',
          message: action.result.recovery?.message ?? '',
          preview,
          recovery: action.result.recovery ?? null,
        }
      return { kind: 'done', preview, result: action.result }
    }
    case 'failed':
      return { kind: 'error', message: action.message, preview: previewOf(state), recovery: null }
    case 'close':
      return initialMoveFlow
  }
}

export function missingMoveConfirmations(preview: MovePreview, selected: string[], confirmed: string[]): string[] {
  const sensitive = new Set(preview.ignored.filter((entry) => entry.sensitive).map((entry) => entry.path))
  return selected.filter((path) => sensitive.has(path) && !confirmed.includes(path))
}

/** Whether the previewed move can start: unblocked, still fresh, sensitive files confirmed, its branch unchanged. */
export function canExecuteMove(state: MoveFlowState, now: number): boolean {
  if (state.kind !== 'preview') return false
  const { preview } = state
  return (
    !!preview.operationId &&
    !!preview.target &&
    preview.blockers.length === 0 &&
    preview.expiresAt > now &&
    state.branchDraft.trim() === preview.target.branch &&
    missingMoveConfirmations(preview, state.selected, state.confirmed).length === 0
  )
}

/** Blockers the person can lift by choosing another branch name. */
export const BRANCH_BLOCKER_CODES: ReadonlySet<string> = new Set(['target-branch-invalid', 'target-branch-unavailable'])

/** Whether the dialog offers the branch field: a planned move, or one refused for its branch name. */
export const offersBranchChoice = (preview: MovePreview): boolean =>
  !!preview.target || preview.blockers.some((blocker) => BRANCH_BLOCKER_CODES.has(blocker.code))

/** The move the dialog drives, whose events and recovery the window leaves to it. */
export const dialogOperationId = (state: MoveFlowState): string | null => previewOf(state)?.operationId ?? null
