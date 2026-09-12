import type { Conversation, MigrationChangedEvent, MigrationPreview } from '../../../preload'

export type MigrationDialogBusy = 'preparing' | 'executing' | 'canceling' | null

export interface ConversationMigrationDialogState {
  open: boolean
  conversation: Conversation | null
  destinationBranch: string
  preview: MigrationPreview | null
  selectedIgnoredPaths: string[]
  confirmedSensitivePaths: string[]
  busy: MigrationDialogBusy
  progress: MigrationChangedEvent | null
  error: string | null
}

export type ConversationMigrationDialogAction =
  | { type: 'open'; conversation: Conversation }
  | { type: 'branch'; value: string }
  | { type: 'prepare-start' }
  | { type: 'prepare-success'; preview: MigrationPreview }
  | { type: 'execute-start' }
  | { type: 'cancel-start' }
  | { type: 'progress'; event: MigrationChangedEvent }
  | { type: 'toggle-ignored'; path: string; selected: boolean; sensitive: boolean }
  | { type: 'confirm-sensitive'; path: string; confirmed: boolean }
  | { type: 'edit-branch' }
  | { type: 'failure'; error: string }
  | { type: 'close' }

export const initialConversationMigrationDialog: ConversationMigrationDialogState = {
  open: false,
  conversation: null,
  destinationBranch: '',
  preview: null,
  selectedIgnoredPaths: [],
  confirmedSensitivePaths: [],
  busy: null,
  progress: null,
  error: null,
}

function togglePath(paths: string[], path: string, selected: boolean): string[] {
  if (selected) return paths.includes(path) ? paths : [...paths, path]
  return paths.filter((item) => item !== path)
}

export function conversationMigrationDialogReducer(
  state: ConversationMigrationDialogState,
  action: ConversationMigrationDialogAction
): ConversationMigrationDialogState {
  switch (action.type) {
    case 'open':
      return {
        ...initialConversationMigrationDialog,
        open: true,
        conversation: action.conversation,
      }
    case 'branch':
      return state.preview || state.busy ? state : { ...state, destinationBranch: action.value, error: null }
    case 'prepare-start':
      return { ...state, busy: 'preparing', error: null }
    case 'prepare-success':
      return {
        ...state,
        preview: action.preview,
        destinationBranch: action.preview.destinationBranch,
        selectedIgnoredPaths: [],
        confirmedSensitivePaths: [],
        busy: null,
        progress: null,
        error: null,
      }
    case 'execute-start':
      return { ...state, busy: 'executing', error: null }
    case 'cancel-start':
      return { ...state, busy: 'canceling', error: null }
    case 'progress':
      if (state.preview?.operationId !== action.event.operationId) return state
      return { ...state, progress: action.event, error: action.event.error ?? state.error }
    case 'toggle-ignored': {
      const selectedIgnoredPaths = togglePath(state.selectedIgnoredPaths, action.path, action.selected)
      const confirmedSensitivePaths =
        !action.selected && action.sensitive
          ? state.confirmedSensitivePaths.filter((item) => item !== action.path)
          : state.confirmedSensitivePaths
      return { ...state, selectedIgnoredPaths, confirmedSensitivePaths, error: null }
    }
    case 'confirm-sensitive':
      return {
        ...state,
        confirmedSensitivePaths: togglePath(state.confirmedSensitivePaths, action.path, action.confirmed),
        error: null,
      }
    case 'edit-branch':
      return {
        ...state,
        preview: null,
        selectedIgnoredPaths: [],
        confirmedSensitivePaths: [],
        busy: null,
        progress: null,
        error: null,
      }
    case 'failure':
      return { ...state, busy: null, error: action.error }
    case 'close':
      return initialConversationMigrationDialog
  }
}

export function isApparentlyMigrationEligible(conversation: Conversation): boolean {
  return conversation.mode === 'local' && conversation.isMulti === 0 && conversation.archived === 0
}

export function missingSensitiveConfirmations(
  preview: MigrationPreview,
  selectedIgnoredPaths: string[],
  confirmedSensitivePaths: string[]
): string[] {
  const selected = new Set(selectedIgnoredPaths)
  const confirmed = new Set(confirmedSensitivePaths)
  return preview.ignored
    .filter((entry) => entry.sensitive && selected.has(entry.path) && !confirmed.has(entry.path))
    .map((entry) => entry.path)
}

export function canExecuteConversationMigration(state: ConversationMigrationDialogState, now = Date.now()): boolean {
  return !!(
    state.preview &&
    !state.busy &&
    state.preview.blockers.length === 0 &&
    state.preview.expiresAt > now &&
    missingSensitiveConfirmations(state.preview, state.selectedIgnoredPaths, state.confirmedSensitivePaths).length === 0
  )
}

export function findConversation(
  workspaces: Array<{ conversations: Conversation[] }>,
  conversationId: string
): Conversation | null {
  for (const workspace of workspaces) {
    const conversation = workspace.conversations.find((item) => item.id === conversationId)
    if (conversation) return conversation
  }
  return null
}
