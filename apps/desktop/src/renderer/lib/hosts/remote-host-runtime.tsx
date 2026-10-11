import { type Dispatch, type SetStateAction, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Conversation, PlanReceived, WorkspaceGroup, WorkspaceWithConversations } from '../../../preload'
import type { StandaloneConversation } from '../../../shared/conversation'
import { type HostId, hostKey } from '../../../shared/host-key'
import type { Tab as DrawerTab } from '@/components/Drawer'
import type { AgentStatus } from '@/components/sidebar/StatusIcon'
import { useAgentStatuses } from '@/lib/use-agent-statuses'
import { usePlans } from '@/lib/use-plans'
import { useWorkspaces } from '@/lib/use-workspaces'
import { hostApi } from './host-context'
import {
  hostActiveSetter,
  hostConversation,
  hostOfKey,
  hostRecordSetter,
  rawId,
  rawIds,
  shellConversation,
  shellGroup,
  shellIds,
  shellRecord,
  shellWorkspace,
} from './shell-keys'

/** What the window does to a host's conversations and workspaces; every argument and result is in shell form. */
export interface HostShellActions {
  refresh: () => Promise<void>
  toggleArchived: () => void
  acknowledgeConversation: (key: string) => void
  newChat: () => Promise<Conversation>
  newSiblingConversation: (sourceKey: string) => Promise<Conversation>
  renameConversation: (conversation: Conversation, name: string) => void
  archiveConversation: (conversation: Conversation, archived: boolean) => void
  pinConversation: (conversation: Conversation, pinned: boolean) => Promise<void> | void
  deleteConversation: (conversation: Conversation) => void
  archiveSiblings: (members: Conversation[], archived: boolean) => void
  deleteSiblings: (members: Conversation[]) => void
  reorderStandaloneConversations: (keys: string[]) => void
  reorderConversations: (workspaceKey: string, keys: string[]) => void
  removeWorkspace: (workspaceKey: string) => void
  toggleWorkspaceCollapsed: (workspaceKey: string) => void
  /** The workspace after the host listed it again, as when it was just added; null when it is not there. */
  reconcileWorkspace: (workspaceKey: string) => Promise<WorkspaceWithConversations | null>
}

/** What the window shows of a remote host, keyed for the window. */
export interface RemoteHostShell {
  hostId: HostId
  /** False until the host answered its first listing. */
  loaded: boolean
  workspaces: WorkspaceWithConversations[]
  groups: WorkspaceGroup[]
  standaloneConversations: StandaloneConversation[]
  standaloneArchivedCount: number
  showArchived: boolean
  statuses: Record<string, AgentStatus>
  attention: Set<string>
  plans: Record<string, PlanReceived>
  pendingPlanIds: Set<string>
  actions: HostShellActions
}

interface Props {
  hostId: HostId
  active: Conversation | null
  setActive: Dispatch<SetStateAction<Conversation | null>>
  setMountedConvs: Dispatch<SetStateAction<Conversation[]>>
  mainOverride: string | null
  forgetConvDrawerState: (key: string) => void
  openDrawerTab: (key: string, tab: DrawerTab) => void
  setDrawerOpenByConv: Dispatch<SetStateAction<Record<string, boolean>>>
  /** Shows a conversation the host asked the window to focus. */
  onFocus: (conversation: Conversation) => void
  onChange: (shell: RemoteHostShell) => void
}

/**
 * Runs for a remote host what the window runs for this computer: the same hooks list its workspaces and chats, follow
 * its statuses and plans, and change them, over that host's API. Their state is handed to the window keyed by host,
 * and what the window passes back in (its active conversation, a row of the sidebar) is turned into the host's own
 * ids first. It renders nothing, and is mounted once per connection of the host: a host that answers again is listed
 * again from scratch.
 */
export function RemoteHostRuntime({
  hostId,
  active,
  setActive,
  setMountedConvs,
  mainOverride,
  forgetConvDrawerState,
  openDrawerTab,
  setDrawerOpenByConv,
  onFocus,
  onChange,
}: Props) {
  const api = hostApi(hostId)
  const hostActive = useMemo(
    () => (active && hostOfKey(active.id) === hostId ? hostConversation(active) : null),
    [active, hostId]
  )
  const setHostActive = useMemo(() => hostActiveSetter(hostId, setActive), [hostId, setActive])
  const forget = useCallback(
    (id: string) => forgetConvDrawerState(hostKey(hostId, id)),
    [forgetConvDrawerState, hostId]
  )
  const ws = useWorkspaces({ active: hostActive, setActive: setHostActive, forgetConvDrawerState: forget, hostId })
  // The hook's handlers are new functions as its state changes; the actions below reach the latest ones.
  const latest = useRef(ws)
  latest.current = ws
  const [loaded, setLoaded] = useState(false)
  const refresh = useCallback(async () => {
    const list = await ws.refreshWorkspaces()
    setLoaded(true)
    return list
  }, [ws.refreshWorkspaces])
  const agents = useAgentStatuses({
    refreshWorkspaces: refresh,
    activeId: hostActive?.id ?? null,
    mainOverride,
    hostId,
  })
  const openHostDrawerTab = useCallback(
    (id: string, tab: DrawerTab) => openDrawerTab(hostKey(hostId, id), tab),
    [openDrawerTab, hostId]
  )
  const setHostDrawerOpen = useMemo(
    () => hostRecordSetter<boolean>(hostId, setDrawerOpenByConv) as Dispatch<SetStateAction<Record<string, boolean>>>,
    [hostId, setDrawerOpenByConv]
  )
  const plans = usePlans({ openDrawerTab: openHostDrawerTab, setDrawerOpenByConv: setHostDrawerOpen, hostId })

  // A turn that ends anywhere lists the host again, as the local profile does on its own status events.
  useEffect(
    () =>
      api.onConversationOpen(({ conversation, focus }) => {
        void refresh()
        if (!conversation?.id) return
        const shell = shellConversation(hostId, conversation)
        setActive((current) => (current?.id === shell.id ? shell : current))
        setMountedConvs((current) => current.map((item) => (item.id === shell.id ? shell : item)))
        if (focus) onFocus(shell)
      }),
    [api, hostId, refresh, setActive, setMountedConvs, onFocus]
  )
  // A chat on the host created or cloned a project there: it appears in the host's section without a manual refresh.
  useEffect(() => api.onWorkspacesChanged(() => void refresh().catch(() => undefined)), [api, refresh])
  // Another computer may have created, renamed or removed a conversation of the host meanwhile: coming back to this
  // window lists the host again.
  useEffect(() => {
    const onFocus = (): void => void refresh().catch(() => undefined)
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refresh])
  // The agent focused one of the conversation's terminals: its drawer opens on the Terminal tab.
  useEffect(
    () =>
      api.onDrawerTerminalFocus(({ convId }) => {
        const key = hostKey(hostId, convId)
        setDrawerOpenByConv((previous) => (previous[key] ? previous : { ...previous, [key]: true }))
        openDrawerTab(key, 'terminal')
      }),
    [api, hostId, openDrawerTab, setDrawerOpenByConv]
  )

  const actions = useMemo<HostShellActions>(
    () => ({
      refresh: async () => void (await refresh()),
      toggleArchived: () => latest.current.setShowArchived((value) => !value),
      acknowledgeConversation: (key) => agents.acknowledgeConversation(rawId(key)),
      newChat: async () => {
        const conversation = await api.createStandaloneConversation()
        await refresh()
        return shellConversation(hostId, conversation)
      },
      newSiblingConversation: async (sourceKey) => {
        const conversation = await api.createSiblingConversation({ sourceConversationId: rawId(sourceKey) })
        await refresh()
        return shellConversation(hostId, conversation)
      },
      renameConversation: (conversation, name) =>
        void latest.current.handleRename(hostConversation(conversation), name),
      archiveConversation: (conversation, archived) =>
        void latest.current.handleArchive(hostConversation(conversation), archived),
      pinConversation: (conversation, pinned) =>
        latest.current.handlePinConversation(hostConversation(conversation), pinned),
      deleteConversation: (conversation) => void latest.current.handleDelete(hostConversation(conversation)),
      archiveSiblings: (members, archived) =>
        void latest.current.handleArchiveSiblings(members.map(hostConversation), archived),
      deleteSiblings: (members) => void latest.current.handleDeleteSiblings(members.map(hostConversation)),
      reorderStandaloneConversations: (keys) => void latest.current.handleReorderStandaloneConversations(rawIds(keys)),
      reorderConversations: (workspaceKey, keys) =>
        latest.current.handleReorderConversations(rawId(workspaceKey), rawIds(keys)),
      removeWorkspace: (workspaceKey) => void latest.current.handleRemoveWorkspace(rawId(workspaceKey)),
      toggleWorkspaceCollapsed: (workspaceKey) => latest.current.handleToggleWorkspaceCollapsed(rawId(workspaceKey)),
      reconcileWorkspace: async (workspaceKey) => {
        const workspace = (await refresh()).find((item) => item.id === rawId(workspaceKey))
        return workspace ? shellWorkspace(hostId, workspace) : null
      },
    }),
    [api, hostId, refresh, agents.acknowledgeConversation]
  )

  // The hook builds a new set on every render; the window is told only when its content changed.
  const attentionIds = [...agents.attention].sort().join('\n')
  const attention = useMemo(() => shellIds(hostId, agents.attention), [hostId, attentionIds])
  const shell = useMemo<RemoteHostShell>(
    () => ({
      hostId,
      loaded,
      workspaces: ws.workspaces.map((workspace) => shellWorkspace(hostId, workspace)),
      groups: ws.groups.map((group) => shellGroup(hostId, group)),
      standaloneConversations: ws.standaloneConversations.map((chat) => shellConversation(hostId, chat)),
      standaloneArchivedCount: ws.standaloneArchivedCount,
      showArchived: ws.showArchived,
      statuses: shellRecord(hostId, agents.statuses),
      attention,
      plans: shellRecord(hostId, plans.plans),
      pendingPlanIds: shellIds(hostId, plans.pendingPlanIds),
      actions,
    }),
    [
      hostId,
      loaded,
      ws.workspaces,
      ws.groups,
      ws.standaloneConversations,
      ws.standaloneArchivedCount,
      ws.showArchived,
      agents.statuses,
      attention,
      plans.plans,
      plans.pendingPlanIds,
      actions,
    ]
  )
  useEffect(() => onChange(shell), [shell, onChange])
  return null
}
