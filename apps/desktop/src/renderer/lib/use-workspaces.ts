/** Manage local workspace and conversation mutations through named preload operations.
 * Reconcile persisted state after mutations while preserving mounted conversations and drawer state. */
import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { useStandaloneChats } from './use-standalone-chats'
import { hostApi } from '@/lib/hosts/host-context'
import { i18n } from '@/lib/i18n'
import type { Conversation, WorkspaceGroup, WorkspaceWithConversations } from '../../preload'
import { type HostId, LOCAL_HOST_ID } from '../../shared/host-key'

type UseWorkspacesParams = {
  active: Conversation | null
  setActive: Dispatch<SetStateAction<Conversation | null>>
  forgetConvDrawerState: (id: string) => void
  hostId?: HostId
}

function reorderByIds<T extends { id: string }>(list: T[], ids: string[]): T[] {
  const rank = new Map(ids.map((id, i) => [id, i]))
  const known = list.filter((x) => rank.has(x.id)).sort((a, b) => rank.get(a.id)! - rank.get(b.id)!)
  const unknown = list.filter((x) => !rank.has(x.id))
  return [...known, ...unknown]
}

export function useWorkspaces({
  active,
  setActive,
  forgetConvDrawerState,
  hostId = LOCAL_HOST_ID,
}: UseWorkspacesParams) {
  const api = hostApi(hostId)
  const [workspaces, setWorkspaces] = useState<WorkspaceWithConversations[]>([])

  const standalone = useStandaloneChats(hostId)

  const [groups, setGroups] = useState<WorkspaceGroup[]>([])
  const [showArchived, setShowArchived] = useState(false)

  const workspacesRef = useRef<WorkspaceWithConversations[]>([])
  workspacesRef.current = workspaces
  const groupsRef = useRef<WorkspaceGroup[]>([])
  groupsRef.current = groups

  const refreshWorkspaces = useCallback(
    async (includeArchived = showArchived) => {
      const [list, gs] = await Promise.all([
        api.listWorkspaces(includeArchived),
        api.listGroups(),
        standalone.refresh(includeArchived),
      ])
      setWorkspaces(list)
      setGroups(gs)
      return list
    },
    [showArchived, standalone.refresh, api]
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
        await api.removeWorkspace(workspaceId)
      } catch (e: any) {
        alert(String(e?.message ?? e).replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, ''))
        return
      }
      if (active?.workspaceId === workspaceId) setActive(null)
      await refreshWorkspaces()
    },
    [active, refreshWorkspaces, api]
  )

  const handleRename = useCallback(
    async (conv: Conversation, name: string) => {
      await api.renameConversation(conv.id, name)
      if (active?.id === conv.id) setActive({ ...active, name })
      await refreshWorkspaces()
    },
    [active, refreshWorkspaces, api]
  )

  const handleArchive = useCallback(
    async (conv: Conversation, archived: boolean) => {
      await api.archiveConversation(conv.id, archived)
      if (archived) {
        if (active?.id === conv.id) setActive(null)
        forgetConvDrawerState(conv.id)
      }
      await refreshWorkspaces()
    },
    [active, refreshWorkspaces, forgetConvDrawerState, api]
  )

  const handlePinConversation = useCallback(
    async (conv: Conversation, pinned: boolean) => {
      try {
        const pinnedAt = await api.setConversationPinned(conv.id, pinned)
        setWorkspaces((wss) =>
          wss.map((w) => ({
            ...w,
            conversations: w.conversations.map((c) => (c.id === conv.id ? { ...c, pinnedAt } : c)),
          }))
        )
        standalone.setConversations((chats) =>
          chats.map((chat) => (chat.id === conv.id ? { ...chat, pinnedAt } : chat))
        )
        setActive((current) => (current?.id === conv.id ? { ...current, pinnedAt } : current))
      } catch (e) {
        await refreshWorkspaces()
        throw e
      }
    },
    [refreshWorkspaces, api]
  )

  const handleDelete = useCallback(
    async (conv: Conversation) => {
      const msg =
        conv.scope === 'standalone'
          ? i18n.t('ui:app.confirmDeleteChat', { name: conv.name })
          : conv.mode === 'worktree'
            ? i18n.t('ui:app.confirmDeleteConvWorktree', { name: conv.name, cwd: conv.cwd, branch: conv.branch })
            : i18n.t('ui:app.confirmDeleteConvBranch', { name: conv.name, branch: conv.branch })
      if (!confirm(msg)) return

      if (active?.id === conv.id) setActive(null)
      forgetConvDrawerState(conv.id)
      setWorkspaces((wss) => wss.map((w) => ({ ...w, conversations: w.conversations.filter((c) => c.id !== conv.id) })))
      standalone.setConversations((chats) => chats.filter((chat) => chat.id !== conv.id))
      try {
        await api.deleteConversation(conv.id)
      } catch (error) {
        alert(String(error))
      } finally {
        await refreshWorkspaces()
      }
    },
    [active, refreshWorkspaces, forgetConvDrawerState, api]
  )

  const handleArchiveSiblings = useCallback(
    async (members: Conversation[], archived: boolean) => {
      for (const conv of members) {
        await api.archiveConversation(conv.id, archived)
        if (archived) {
          if (active?.id === conv.id) setActive(null)
          forgetConvDrawerState(conv.id)
        }
      }
      await refreshWorkspaces()
    },
    [active, refreshWorkspaces, forgetConvDrawerState, api]
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
        for (const conv of members) await api.deleteConversation(conv.id)
        await refreshWorkspaces()
      })()
    },
    [active, refreshWorkspaces, forgetConvDrawerState, api]
  )

  const handleReorderWorkspaces = useCallback(
    (ids: string[]) => {
      setWorkspaces((wss) => reorderByIds(wss, ids))
      api.reorderWorkspaces(ids).catch(() => refreshWorkspaces())
    },
    [refreshWorkspaces, api]
  )
  const handleReorderConversations = useCallback(
    (workspaceId: string, ids: string[]) => {
      setWorkspaces((wss) =>
        wss.map((w) => (w.id === workspaceId ? { ...w, conversations: reorderByIds(w.conversations, ids) } : w))
      )
      api.reorderConversations(workspaceId, ids).catch(() => refreshWorkspaces())
    },
    [refreshWorkspaces, api]
  )

  const handleCreateGroup = useCallback(
    async (name: string): Promise<WorkspaceGroup> => {
      const g = await api.createGroup(name)
      setGroups((gs) => [...gs, g])
      return g
    },
    [api]
  )
  const handleRenameGroup = useCallback(
    (id: string, name: string) => {
      setGroups((gs) => gs.map((g) => (g.id === id ? { ...g, name } : g)))
      api.renameGroup(id, name).catch(() => refreshWorkspaces())
    },
    [refreshWorkspaces, api]
  )
  const handleDeleteGroup = useCallback(
    (id: string) => {
      setGroups((gs) => gs.filter((g) => g.id !== id))
      setWorkspaces((wss) => wss.map((w) => (w.groupId === id ? { ...w, groupId: null } : w)))
      api.deleteGroup(id).catch(() => refreshWorkspaces())
    },
    [refreshWorkspaces, api]
  )
  const handleReorderGroups = useCallback(
    (ids: string[]) => {
      setGroups((gs) => reorderByIds(gs, ids))
      api.reorderGroups(ids).catch(() => refreshWorkspaces())
    },
    [refreshWorkspaces, api]
  )
  const handleToggleGroupCollapsed = useCallback(
    (id: string) => {
      const next = !(groupsRef.current.find((g) => g.id === id)?.collapsed ?? false)
      setGroups((gs) => gs.map((g) => (g.id === id ? { ...g, collapsed: next } : g)))
      api.setGroupCollapsed(id, next) // Optimistic fire-and-forget update.
    },
    [api]
  )
  const handleMoveWorkspaceToGroup = useCallback(
    (wsId: string, groupId: string | null, flatIds: string[]) => {
      setWorkspaces((wss) => reorderByIds(wss, flatIds).map((w) => (w.id === wsId ? { ...w, groupId } : w)))
      api.moveWorkspaceToGroup(wsId, groupId, flatIds).catch(() => refreshWorkspaces())
    },
    [refreshWorkspaces, api]
  )
  const handleToggleWorkspaceCollapsed = useCallback(
    (id: string) => {
      const next = !(workspacesRef.current.find((w) => w.id === id)?.collapsed ?? false)
      setWorkspaces((wss) => wss.map((w) => (w.id === id ? { ...w, collapsed: next } : w)))
      api.setWorkspaceCollapsed(id, next) // Optimistic update.
    },
    [api]
  )

  return {
    workspaces,
    standaloneConversations: standalone.conversations,
    standaloneArchivedCount: standalone.archivedCount,
    handleReorderStandaloneConversations: async (ids: string[]) => {
      standalone.setConversations((chats) => reorderByIds(chats, ids))
      try {
        await api.reorderStandaloneConversations(ids)
      } catch {
        await refreshWorkspaces()
      }
    },
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
