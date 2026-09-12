import { ipcRenderer } from 'electron'
import type { ConversationBranchInfo } from '../shared/conversation-branch'
import type { FloatTab } from '../shared/tool-tabs'
import type { ChatGptWebCapabilities } from '../shared/chat'
import type { ConversationExperience } from '../shared/conversation-experience'
import type { MaestroConfigV1 } from '../shared/maestro'
import type { FloatingBounds } from './api-drawer'
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

export interface ConvRepo {
  workspaceId: string
  repoTop: string
  branch: string
  base: string
  worktreePath: string
  linkName: string
}

export interface ConvUiPrefs {
  mainTabOrder?: string[]
  browserTabs?: { url: string; title?: string }[]
  browserActive?: number
  chatGptWebCapabilities?: ChatGptWebCapabilities
  chatGptWebPairedCapabilityFingerprint?: string

  floating?: Partial<Record<FloatTab, FloatingBounds>>
  maestro?: { config?: MaestroConfigV1; projectScoped?: boolean }
}

export interface Conversation {
  id: string
  workspaceId: string
  name: string
  branch: string
  mode: 'worktree' | 'local'
  experience: ConversationExperience
  cwd: string
  status: 'idle' | 'working' | 'ready' | 'waiting' | 'error'
  createdAt: number
  archived: number

  pinnedAt: number | null
  lastActivityAt: number

  isMulti: number

  repos?: ConvRepo[]

  uiPrefs?: ConvUiPrefs
}

export interface WorkspaceWithConversations extends Workspace {
  conversations: Conversation[]
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
  createConversation: (args: CreateConversationArgs): Promise<Conversation> =>
    ipcRenderer.invoke('conversation:create', args),
  prepareLocalConversation: (input: LocalConversationPrepareInput): Promise<LocalConversationPrepareResult> =>
    ipcRenderer.invoke('conversation:local-prepare', input),
  confirmLocalConversation: (input: LocalConversationConfirmInput): Promise<LocalConversationConfirmResult> =>
    ipcRenderer.invoke('conversation:local-confirm', input),

  createSiblingConversation: (args: CreateSiblingConversationArgs): Promise<Conversation> =>
    ipcRenderer.invoke('conversation:createSibling', args),

  listConversations: (workspaceId: string): Promise<Conversation[]> =>
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
