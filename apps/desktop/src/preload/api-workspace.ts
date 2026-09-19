import type { CreateStandaloneConversationArgs } from '../shared/standalone-conversation'
import type { StandaloneConversation } from '../shared/conversation'
import { ipcRenderer } from 'electron'
import type { ConversationBranchInfo } from '../shared/conversation-branch'
import type { ConversationExperience } from '../shared/conversation-experience'
import type {
  LocalConversationConfirmInput,
  LocalConversationConfirmResult,
  LocalConversationPrepareInput,
  LocalConversationPrepareResult,
} from '../shared/local-conversation'

export interface Workspace {
  id: string
  path: string
  name: string
  defaultBranch: string
  addedAt: number
}

export interface WorkspaceGroup {
  id: string
  name: string
  position: number
  collapsed: boolean
}

export type {
  Conversation,
  ProjectConversation,
  StandaloneConversation,
  ConvRepo,
  ConvUiPrefs,
} from '../shared/conversation'
import type { Conversation, ProjectConversation } from '../shared/conversation'

export interface WorkspaceWithConversations extends Workspace {
  conversations: ProjectConversation[]
  archivedCount: number

  groupId: string | null

  collapsed: boolean
}

export interface BranchInfo {
  current: string
  local: string[]
  remote: string[]
  remoteRefs: Array<{ remote: string; name: string; ref: string }>
  defaultBranch: string
}

export interface CreateConvRepo {
  workspaceId: string
  branch: string
  isNewBranch: boolean
  base?: string
}

export interface CreateConversationArgs {
  workspaceId: string
  branch: string
  isNewBranch: boolean
  base?: string
  mode: 'worktree'
  experience?: ConversationExperience
  name?: string

  repos?: CreateConvRepo[]
}

export interface CreateSiblingConversationArgs {
  sourceConversationId: string
  /** Omitted means inherit the source conversation's current experience. */
  experience?: ConversationExperience
}

export const workspaceApi = {
  createStandaloneConversation: (args: CreateStandaloneConversationArgs = {}): Promise<StandaloneConversation> =>
    ipcRenderer.invoke('conversation:create-standalone', args),
  listStandaloneConversations: (includeArchived = false): Promise<StandaloneConversation[]> =>
    ipcRenderer.invoke('conversation:list-standalone', includeArchived),
  reorderStandaloneConversations: (ids: string[]): Promise<void> =>
    ipcRenderer.invoke('conversation:reorder-standalone', ids),
  // --- Workspaces and conversations ---
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke('workspace:pick'),
  addWorkspace: (dir: string): Promise<Workspace> => ipcRenderer.invoke('workspace:add', dir),
  listWorkspaces: (includeArchived = false): Promise<WorkspaceWithConversations[]> =>
    ipcRenderer.invoke('workspace:list', includeArchived),
  removeWorkspace: (id: string): Promise<void> => ipcRenderer.invoke('workspace:remove', id),
  getBranches: (workspaceId: string): Promise<BranchInfo> => ipcRenderer.invoke('workspace:branches', workspaceId),

  fetchBranches: (workspaceId: string): Promise<BranchInfo> => ipcRenderer.invoke('workspace:fetch', workspaceId),

  setWorkspaceDefaultBranch: (workspaceId: string, branch: string): Promise<void> =>
    ipcRenderer.invoke('workspace:set-default-branch', workspaceId, branch),
  createConversation: (args: CreateConversationArgs): Promise<ProjectConversation> =>
    ipcRenderer.invoke('conversation:create', args),
  prepareLocalConversation: (input: LocalConversationPrepareInput): Promise<LocalConversationPrepareResult> =>
    ipcRenderer.invoke('conversation:local-prepare', input),
  confirmLocalConversation: (input: LocalConversationConfirmInput): Promise<LocalConversationConfirmResult> =>
    ipcRenderer.invoke('conversation:local-confirm', input),

  createSiblingConversation: (args: CreateSiblingConversationArgs): Promise<ProjectConversation> =>
    ipcRenderer.invoke('conversation:createSibling', args),

  listConversations: (workspaceId: string): Promise<ProjectConversation[]> =>
    ipcRenderer.invoke('conversation:list', workspaceId),

  onConversationOpen: (callback: (payload: { conversation: Conversation; focus: boolean }) => void): (() => void) => {
    const listener = (_event: unknown, payload: { conversation: Conversation; focus: boolean }) => callback(payload)
    ipcRenderer.on('conversation:open', listener)
    return () => ipcRenderer.removeListener('conversation:open', listener)
  },

  getConversationBranchInfo: (id: string): Promise<ConversationBranchInfo | null> =>
    ipcRenderer.invoke('conversation:branch-info', id),
  renameConversation: (id: string, name: string): Promise<void> => ipcRenderer.invoke('conversation:rename', id, name),
  archiveConversation: (id: string, archived: boolean): Promise<void> =>
    ipcRenderer.invoke('conversation:archive', id, archived),

  setConversationPinned: (id: string, pinned: boolean): Promise<number | null> =>
    ipcRenderer.invoke('conversation:pin', id, pinned),
  deleteConversation: (id: string): Promise<void> => ipcRenderer.invoke('conversation:delete', id),

  setConvMainTabOrder: (convId: string, order: string[]) => ipcRenderer.send('conv:set-main-tab-order', convId, order),
  setConvOpenTabs: (convId: string, tabs: string[], active: string | null) =>
    ipcRenderer.send('conv:set-open-tabs', convId, tabs, active),

  reorderWorkspaces: (ids: string[]): Promise<void> => ipcRenderer.invoke('workspace:reorder', ids),
  reorderConversations: (workspaceId: string, ids: string[]): Promise<void> =>
    ipcRenderer.invoke('conversation:reorder', workspaceId, ids),

  listGroups: (): Promise<WorkspaceGroup[]> => ipcRenderer.invoke('group:list'),
  createGroup: (name: string): Promise<WorkspaceGroup> => ipcRenderer.invoke('group:create', name),
  renameGroup: (id: string, name: string): Promise<void> => ipcRenderer.invoke('group:rename', id, name),
  deleteGroup: (id: string): Promise<void> => ipcRenderer.invoke('group:delete', id),
  reorderGroups: (ids: string[]): Promise<void> => ipcRenderer.invoke('group:reorder', ids),

  moveWorkspaceToGroup: (wsId: string, groupId: string | null, flatIds: string[]): Promise<void> =>
    ipcRenderer.invoke('group:assign', wsId, groupId, flatIds),
  setGroupCollapsed: (id: string, collapsed: boolean): void => ipcRenderer.send('group:set-collapsed', id, collapsed),
  setWorkspaceCollapsed: (id: string, collapsed: boolean): void =>
    ipcRenderer.send('workspace:set-collapsed', id, collapsed),
}
