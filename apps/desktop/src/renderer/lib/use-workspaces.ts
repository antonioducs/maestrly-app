/** Manage local workspace and conversation mutations through named preload operations.
 * Reconcile persisted state after mutations while preserving mounted conversations and drawer state. */
import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { i18n } from '@/lib/i18n'
import type { Conversation, WorkspaceGroup, WorkspaceWithConversations } from '../../preload'

type UseWorkspacesParams = {
  active: Conversation | null
  setActive: Dispatch<SetStateAction<Conversation | null>>
  forgetConvDrawerState: (id: string) => void
}

function reorderByIds<T extends { id: string }>(list: T[], ids: string[]): T[] {
  const rank = new Map(ids.map((id, i) => [id, i]))
  const known = list.filter((x) => rank.has(x.id)).sort((a, b) => rank.get(a.id)! - rank.get(b.id)!)
  const unknown = list.filter((x) => !rank.has(x.id))
  return [...known, ...unknown]
}

export function useWorkspaces({ active, setActive, forgetConvDrawerState }: UseWorkspacesParams) {
  const [workspaces, setWorkspaces] = useState<WorkspaceWithConversations[]>([])

  const [groups, setGroups] = useState<WorkspaceGroup[]>([])
  const [showArchived, setShowArchived] = useState(false)

  const workspacesRef = useRef<WorkspaceWithConversations[]>([])
  workspacesRef.current = workspaces
  const groupsRef = useRef<WorkspaceGroup[]>([])
  groupsRef.current = groups

  const refreshWorkspaces = useCallback(
    async (includeArchived = showArchived) => {
      const [list, gs] = await Promise.all([window.api.listWorkspaces(includeArchived), window.api.listGroups()])
      setWorkspaces(list)
      setGroups(gs)
      return list
    },
    [showArchived]
  )

  const reconcileWorkspace = useCallback(
    async (workspaceId: string) => {
      const list = await refreshWorkspaces()
      return list.find((workspace) => workspace.id === workspaceId) ?? null
    },
    [refreshWorkspaces]
  )

  const handleRemoveWorkspace = useCallback(
    async (workspaceId: string) => {
      if (!confirm(i18n.t('ui:app.confirmRemoveWorkspace'))) return
      try {
        await window.api.removeWorkspace(workspaceId)
      } catch (e: any) {
        alert(String(e?.message ?? e).replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, ''))
        return
      }
      if (active?.workspaceId === workspaceId) setActive(null)
      await refreshWorkspaces()
    },
    [active, refreshWorkspaces]
  )

  const handleRename = useCallback(
    async (conv: Conversation, name: string) => {
      await window.api.renameConversation(conv.id, name)
      if (active?.id === conv.id) setActive({ ...active, name })
      await refreshWorkspaces()
    },
    [active, refreshWorkspaces]
  )

  const handleArchive = useCallback(
    async (conv: Conversation, archived: boolean) => {
      await window.api.archiveConversation(conv.id, archived)
      if (archived) {
        if (active?.id === conv.id) setActive(null)
        forgetConvDrawerState(conv.id)
      }
      await refreshWorkspaces()
    },
    [active, refreshWorkspaces, forgetConvDrawerState]
  )

  const handlePinConversation = useCallback(
    async (conv: Conversation, pinned: boolean) => {
      try {
        const pinnedAt = await window.api.setConversationPinned(conv.id, pinned)
        setWorkspaces((wss) =>
          wss.map((w) => ({
            ...w,
            conversations: w.conversations.map((c) => (c.id === conv.id ? { ...c, pinnedAt } : c)),
          }))
        )
        setActive((current) => (current?.id === conv.id ? { ...current, pinnedAt } : current))
      } catch (e) {
        await refreshWorkspaces()
        throw e
      }
    },
    [refreshWorkspaces]
  )

  const handleDelete = useCallback(
    async (conv: Conversation) => {
      const msg =
        conv.mode === 'worktree'
          ? i18n.t('ui:app.confirmDeleteConvWorktree', { name: conv.name, cwd: conv.cwd, branch: conv.branch })
          : i18n.t('ui:app.confirmDeleteConvBranch', { name: conv.name, branch: conv.branch })
      if (!confirm(msg)) return

      if (active?.id === conv.id) setActive(null)
      forgetConvDrawerState(conv.id)
      setWorkspaces((wss) => wss.map((w) => ({ ...w, conversations: w.conversations.filter((c) => c.id !== conv.id) })))
      window.api.deleteConversation(conv.id).finally(() => refreshWorkspaces())
    },
    [active, refreshWorkspaces, forgetConvDrawerState]
  )

  const handleArchiveSiblings = useCallback(
    async (members: Conversation[], archived: boolean) => {
      for (const conv of members) {
        await window.api.archiveConversation(conv.id, archived)
        if (archived) {
          if (active?.id === conv.id) setActive(null)
          forgetConvDrawerState(conv.id)
        }
      }
      await refreshWorkspaces()
    },
    [active, refreshWorkspaces, forgetConvDrawerState]
  )

  const handleDeleteSiblings = useCallback(
    async (members: Conversation[]) => {
      if (!members.length) return
      const msg = i18n.t('ui:app.confirmDeleteSiblings', { count: members.length })
      if (!confirm(msg)) return
      const ids = new Set(members.map((c) => c.id))
      if (active && ids.has(active.id)) setActive(null)
      members.forEach((c) => forgetConvDrawerState(c.id))
      setWorkspaces((wss) => wss.map((w) => ({ ...w, conversations: w.conversations.filter((c) => !ids.has(c.id)) })))
      void (async () => {
        for (const conv of members) await window.api.deleteConversation(conv.id)
        await refreshWorkspaces()
      })()
    },
    [active, refreshWorkspaces, forgetConvDrawerState]
  )

  const handleReorderWorkspaces = useCallback(
    (ids: string[]) => {
      setWorkspaces((wss) => reorderByIds(wss, ids))
      window.api.reorderWorkspaces(ids).catch(() => refreshWorkspaces())
    },
    [refreshWorkspaces]
  )
  const handleReorderConversations = useCallback(
    (workspaceId: string, ids: string[]) => {
      setWorkspaces((wss) =>
        wss.map((w) => (w.id === workspaceId ? { ...w, conversations: reorderByIds(w.conversations, ids) } : w))
      )
      window.api.reorderConversations(workspaceId, ids).catch(() => refreshWorkspaces())
    },
    [refreshWorkspaces]
  )

  const handleCreateGroup = useCallback(async (name: string): Promise<WorkspaceGroup> => {
    const g = await window.api.createGroup(name)
    setGroups((gs) => [...gs, g])
    return g
  }, [])
  const handleRenameGroup = useCallback(
    (id: string, name: string) => {
      setGroups((gs) => gs.map((g) => (g.id === id ? { ...g, name } : g)))
      window.api.renameGroup(id, name).catch(() => refreshWorkspaces())
    },
    [refreshWorkspaces]
  )
  const handleDeleteGroup = useCallback(
    (id: string) => {
      setGroups((gs) => gs.filter((g) => g.id !== id))
      setWorkspaces((wss) => wss.map((w) => (w.groupId === id ? { ...w, groupId: null } : w)))
      window.api.deleteGroup(id).catch(() => refreshWorkspaces())
    },
    [refreshWorkspaces]
  )
  const handleReorderGroups = useCallback(
    (ids: string[]) => {
      setGroups((gs) => reorderByIds(gs, ids))
      window.api.reorderGroups(ids).catch(() => refreshWorkspaces())
    },
    [refreshWorkspaces]
  )
  const handleToggleGroupCollapsed = useCallback((id: string) => {
    const next = !(groupsRef.current.find((g) => g.id === id)?.collapsed ?? false)
    setGroups((gs) => gs.map((g) => (g.id === id ? { ...g, collapsed: next } : g)))
    window.api.setGroupCollapsed(id, next) // Optimistic fire-and-forget update.
  }, [])
  const handleMoveWorkspaceToGroup = useCallback(
    (wsId: string, groupId: string | null, flatIds: string[]) => {
      setWorkspaces((wss) => reorderByIds(wss, flatIds).map((w) => (w.id === wsId ? { ...w, groupId } : w)))
      window.api.moveWorkspaceToGroup(wsId, groupId, flatIds).catch(() => refreshWorkspaces())
    },
    [refreshWorkspaces]
  )
  const handleToggleWorkspaceCollapsed = useCallback((id: string) => {
    const next = !(workspacesRef.current.find((w) => w.id === id)?.collapsed ?? false)
    setWorkspaces((wss) => wss.map((w) => (w.id === id ? { ...w, collapsed: next } : w)))
    window.api.setWorkspaceCollapsed(id, next) // Optimistic update.
  }, [])

  return {
    workspaces,
    groups,
    showArchived,
    setShowArchived,
    refreshWorkspaces,
    reconcileWorkspace,
    handleRemoveWorkspace,
    handleRename,
    handleArchive,
    handlePinConversation,
    handleDelete,
    handleArchiveSiblings,
    handleDeleteSiblings,
    handleReorderWorkspaces,
    handleReorderConversations,
    handleCreateGroup,
    handleRenameGroup,
    handleDeleteGroup,
    handleReorderGroups,
    handleToggleGroupCollapsed,
    handleMoveWorkspaceToGroup,
    handleToggleWorkspaceCollapsed,
  }
}
