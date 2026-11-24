import { dialog, type BrowserWindow } from 'electron'
import {
  addWorkspace,
  listWorkspacesWithConversations,
  getBranches,
  fetchBranches,
  removeWorkspace,
  deleteConversation,
} from './workspace-service'
import {
  listConversations,
  listConvIdsByWorkspaceRepo,
  setWorkspaceDefaultBranch,
  setWorkspaceOrder,
  setWorkspaceCollapsed,
  listWorkspaceGroups,
  createWorkspaceGroup,
  renameWorkspaceGroup,
  deleteWorkspaceGroup,
  setGroupOrder,
  setWorkspaceGroupAndOrder,
  setGroupCollapsed,
} from './store'
import { tMain } from './i18n'
import { clearPlan } from './plan-broker'
import { stopConversationProcesses } from './process-ownership/conversation-processes'
import * as floatingManager from './floating-manager'
import * as popupManager from './popup-manager'
import { disposeConversation } from './drawer-manager'
import { unwatchNotes, unwatchProject } from './notes/notes-service'
import { unwatchMemory } from './memory-service'
import type { IpcRegistrar } from './ipc-registrar'
import { assertConversationMigrationMutationAllowed } from './conversation-migration/store'

export interface WorkspaceIpcDeps {
  getMainWindow: () => BrowserWindow | null
  stopChat: (conversationId: string) => void | Promise<void>
  /** Tells this computer's window and the computers connected to it to list the workspaces again. */
  notifyWorkspacesChanged: () => void
}

export function registerWorkspaceIpc(reg: IpcRegistrar, deps: WorkspaceIpcDeps): void {
  reg.handle('workspace:pick', async () => {
    const win = deps.getMainWindow()
    if (!win) return null
    const res = await dialog.showOpenDialog(win, {
      properties: ['openDirectory', 'createDirectory'],
    })
    return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0]
  })

  reg.mhandle('workspace:add', (_e, dir: string) => addWorkspace(dir))
  reg.handle('workspace:list', (_e, includeArchived?: boolean) => listWorkspacesWithConversations(includeArchived))
  reg.mhandle('workspace:remove', async (_e, id: string) => {
    // Reject removing a workspace used as a secondary multi-repository participant: doing so would orphan
    // worktrees/branches and violate conversation_repos references. Delete those conversations first.
    const ownIds = new Set(listConversations(id, true).map((c) => c.id))
    const participating = listConvIdsByWorkspaceRepo(id).filter((cid) => !ownIds.has(cid))
    if (participating.length > 0) {
      throw new Error(tMain('main')('dialog.multiRepoInUse', { count: participating.length }))
    }
    // Stop in-memory PTYs, buffers, and views, then delete each conversation through deleteConversation so
    // worktrees, multi-repository aggregators, and store rows are cleaned together.
    const conversations = listConversations(id, true)
    for (const c of conversations) assertConversationMigrationMutationAllowed(c.id, 'Remover workspace')
    for (const c of conversations) {
      clearPlan(c.id)
      await deps.stopChat(c.id)
      await stopConversationProcesses(c.id)
      floatingManager.disposeConversation(c.id) // close floating windows before destroying views
      popupManager.disposeConversation(c.id) // clear popup state before destroying views (#328)
      disposeConversation(c.id)
      void unwatchNotes(c.id) // before deleting the row needed to resolve notes cwd
      await deleteConversation(c.id)
    }
    void unwatchProject(id) // stop project-note watching while its workspace row still exists
    unwatchMemory(id) // release project-memory watching
    removeWorkspace(id)
  })
  reg.handle('workspace:branches', (_e, workspaceId: string) => getBranches(workspaceId))
  reg.handle('workspace:fetch', (_e, workspaceId: string) => fetchBranches(workspaceId))
  // #557: Editable workspace default branch supplies new-conversation bases. Use invoke so UI
  // awaits and handles empty-value rejection after trimming.
  reg.mhandle('workspace:set-default-branch', (_e, wsId: string, branch: string) =>
    setWorkspaceDefaultBranch(wsId, branch)
  )
  // Manual sidebar reorder (#31) uses invoke for reconciliation. Store normalizes IDs, excludes
  // invalid or foreign entries, and merges hidden archived conversations. Optimistic UI refreshes
  // after rejection or divergence.
  // The order and the groups of a host's workspaces are the same for everyone who uses it: this computer's window and
  // the connected computers list them again once they change. Collapsing is not announced.
  const announced = <T>(value: T): T => {
    deps.notifyWorkspacesChanged()
    return value
  }
  reg.mhandle('workspace:reorder', (_e, ids: string[]) => announced(setWorkspaceOrder(ids)))
  // Workspace groups (#218) are virtual sidebar organization with no disk/Git changes. Ordering/moving uses
  // invoke for reconciliation; collapse uses optimistic send.
  reg.handle('group:list', () => listWorkspaceGroups())
  reg.mhandle('group:create', (_e, name: string) => announced(createWorkspaceGroup(name)))
  reg.mhandle('group:rename', (_e, id: string, name: string) => announced(renameWorkspaceGroup(id, name)))
  reg.mhandle('group:delete', (_e, id: string) => announced(deleteWorkspaceGroup(id)))
  reg.mhandle('group:reorder', (_e, ids: string[]) => announced(setGroupOrder(ids)))
  reg.mhandle('group:assign', (_e, wsId: string, groupId: string | null, flatIds: string[]) =>
    announced(setWorkspaceGroupAndOrder(wsId, groupId, flatIds))
  )
  reg.mon('group:set-collapsed', (_e, id: string, collapsed: boolean) => setGroupCollapsed(id, collapsed))
  reg.mon('workspace:set-collapsed', (_e, id: string, collapsed: boolean) => setWorkspaceCollapsed(id, collapsed))
}
