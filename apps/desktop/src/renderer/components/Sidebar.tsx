import { StandaloneChatList } from './sidebar/StandaloneChatList'
import { filterStandaloneConversations } from '@/lib/standalone-conversations'
import type { StandaloneConversation } from '../../shared/conversation'
/** Local workspaces, virtual groups, and pinned conversations.
 * Apply drag sorting only to the complete list so filtered searches cannot corrupt persisted order. */
import {
  useEffect,
  useMemo,
  useState,
  useRef,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import { useTranslation } from 'react-i18next'
import { requestChatWindow } from '@/lib/chat-windows'
import {
  Plus,
  Archive,
  ChevronRight,
  ChevronDown,
  Folder,
  FolderOpen,
  MoreHorizontal,
  StickyNote,
  Layers,
  Pin,
  Play,
  RefreshCw,
  SquareArrowOutUpRight,
} from 'lucide-react'
import { DndContext } from '@dnd-kit/core'
import { SortableContext, type useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { Conversation, WorkspaceGroup, WorkspaceWithConversations } from '../../preload'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'
import { ContextMenu, ContextMenuTrigger, ContextMenuContent } from '@/components/ui/context-menu'
import type { AgentStatus } from '@/components/sidebar/StatusIcon'
import { buildConvTopNodes } from '@/components/sidebar/conv-top-nodes'
import { buildPinnedWorkspaceLabels, collectPinnedConversations } from '@/components/sidebar/pinned-conversations'
import { WorkspaceConvList } from '@/components/sidebar/WorkspaceConvList'
import { Sortable } from '@/components/sidebar/Sortable'
import { Droppable } from '@/components/sidebar/Droppable'
import { dropdownKit, contextKit } from '@/components/sidebar/menu-kit'
import { useQuickTooltip } from '@/components/sidebar/use-quick-tooltip'
import { useWorkspaceDnd } from '@/components/sidebar/use-workspace-dnd'
import { useSidebarMenus, type OpenTargets, type OpenExternalTarget } from '@/components/sidebar/use-sidebar-menus'
import { useConvRows } from '@/components/sidebar/conv-rows'
import { SidebarPanelHeader, type SidebarCreateAction } from '@/components/sidebar/SidebarHeader'
import { SidebarRail } from '@/components/sidebar/SidebarRail'
import { UpdateCard } from '@/components/sidebar/UpdateCard'
import { FleetSidebarPanel } from '@/components/fleet/FleetSidebarPanel'
import { FleetServerSwitcher } from '@/components/fleet/FleetServerSwitcher'
import { HostSectionNotice, HostSwitcher, HostTile, hostName } from '@/components/sidebar/HostSection'
import { hostActivity, resolveSidebarHost, type HostActivity } from '@/components/sidebar/sidebar-hosts'
import type { RemoteHostShell } from '@/lib/hosts/remote-host-runtime'
import { hostRetryable, hostSectionStatus } from '@/lib/hosts/host-status'
import { PeerInUseChip } from '@/components/peer/PeerInUseChip'
import { hostOfKey } from '@/lib/hosts/shell-keys'
import type { MoveTarget } from '@/lib/conversation-move/flow'
import type { HostView } from '../../shared/hosts'
import type { FleetServerId, FleetServerView } from '../../shared/fleet-servers'
import { type HostId, LOCAL_HOST_ID } from '../../shared/host-key'
import type { FleetController } from '@/lib/fleet/use-fleet'
import { fleetSearchCount } from '@/lib/fleet/environments'
import {
  conversationSidebarTab,
  crossTabMatches,
  readSidebarTab,
  workspaceFilterCount,
  type SidebarTab,
} from '@/components/sidebar/sidebar-tabs'

export type { OpenTargets, OpenExternalTarget }

/** A remote host in the sidebar: what it lists, in shell form, and what its heading does. */
export interface SidebarHostSection {
  host: HostView
  /** Null until the host listed its chats and workspaces once. */
  shell: RemoteHostShell | null
  creatingChat: boolean
  onNewChat: () => void
  onAddWorkspace: () => void
  onRetry: () => void
  onStart: () => void
  onManage: () => void
  /** A paired computer's: pair with it again, or forget it here once it removed this computer. */
  onPair?: () => void
  onForget?: () => void
}

function filterWorkspaces(workspaces: WorkspaceWithConversations[], q: string): WorkspaceWithConversations[] {
  if (!q) return workspaces
  return workspaces
    .map((ws) => ({
      ...ws,
      conversations: ws.conversations.filter(
        (c) => c.name.toLowerCase().includes(q) || (c.branch ?? '').toLowerCase().includes(q)
      ),
    }))
    .filter((ws) => ws.conversations.length > 0 || ws.name.toLowerCase().includes(q))
}

interface Props {
  standaloneConversations: StandaloneConversation[]
  standaloneArchivedCount: number
  onNewChat: () => Promise<void>
  creatingChat: boolean
  onReorderStandaloneConversations: (ids: string[]) => void
  workspaces: WorkspaceWithConversations[]
  statuses: Record<string, AgentStatus>

  attention: Set<string>
  activeId: string | null
  selectedConversation: Conversation | null
  requestedTab?: { tab: SidebarTab; requestId: number } | null
  fleet: FleetController
  selectedFleet: string | null
  /** The ids of the shown server's bots with something new for the owner. */
  markedBots?: ReadonlySet<string>
  onOpenFleetBot: (id: string) => void
  onOpenFleetEnvironment: (id: string) => void
  onOpenFleetServer: () => void
  onOpenFleetInbox: () => void
  onOpenFleetOwnerMemory: () => void
  botServerConnected?: boolean
  botPendingCount?: number
  /** With more than one paired server, which one the Bots tab shows, chosen at its top. */
  fleetServers?: {
    servers: FleetServerView[]
    selectedId: FleetServerId
    pending: Record<string, number>
    onSelect: (id: FleetServerId) => void
    onAdd: () => void
  }
  /** Bots can be updated, or an update of theirs runs or waits. */
  botUpdate?: 'available' | 'pending' | null
  onCreateBot?: () => void
  onOpenBotSettings: () => void

  focusedWorkspaceId: string | null
  pendingPlanIds: Set<string>

  showArchived: boolean
  onToggleArchived: () => void
  onSelect: (conv: Conversation) => void
  onAddWorkspace: () => void
  onRemoveWorkspace: (workspaceId: string) => void
  onNewConversation: (workspaceId: string) => void

  onNewSiblingConversation: (sourceConvId: string) => Promise<void> | void

  onArchiveSiblings: (members: Conversation[], archived: boolean) => void
  onDeleteSiblings: (members: Conversation[]) => void
  onOpenProjectNotes: (workspaceId: string) => void
  onOpenProjectMemory: (workspaceId: string) => void

  onEditDefaultBranch: (workspaceId: string) => void
  onOpenAbout: () => void
  onRenameConversation: (conv: Conversation, name: string) => void
  onArchiveConversation: (conv: Conversation, archived: boolean) => void

  onPinConversation: (conv: Conversation, pinned: boolean) => Promise<void> | void
  onDeleteConversation: (conv: Conversation) => void

  onMigrateConversation: (conv: Conversation) => void
  /** The hosts a conversation can move to now. */
  moveTargetsOf: (conv: Conversation) => MoveTarget[]
  onMoveConversation: (conv: Conversation, targetHostId: HostId) => void

  onReorderWorkspaces: (ids: string[]) => void

  onReorderConversations: (workspaceId: string, ids: string[]) => void
  // Virtual workspace groups in the sidebar.

  groups: WorkspaceGroup[]

  onCreateGroup: (name: string) => Promise<WorkspaceGroup>
  onRenameGroup: (id: string, name: string) => void

  onDeleteGroup: (id: string) => void
  onReorderGroups: (ids: string[]) => void
  onToggleGroupCollapsed: (id: string) => void

  onMoveWorkspaceToGroup: (wsId: string, groupId: string | null, flatIds: string[]) => void

  onToggleWorkspaceCollapsed: (id: string) => void
  /** Only the icon rail is shown: the list panel is collapsed. */
  collapsed?: boolean
  onCollapsedChange: (collapsed: boolean) => void

  openTargets: OpenTargets

  onOpenExternal: (scope: 'conv' | 'workspace', id: string, target: OpenExternalTarget) => void

  /**
   * Remote hosts. With any, the Chats and Workspaces tabs list one machine at a time, chosen in a host switcher. The
   * props above are this computer's; their handlers also take the conversations and workspaces of these hosts.
   */
  hostSections?: SidebarHostSection[]
  /** This computer's view, for its entry in the host switcher. */
  localHost?: HostView
  appVersion?: string | null
  /** Shows a machine's lists, as when Settings opens a paired computer; `requestId` changes on each request. */
  requestedHost?: { hostId: HostId; requestId: number } | null
  /** Opens the dialog that pairs this computer with another of the owner's. */
  onConnectComputer?: () => void
  /** Opens Settings → Computers. */
  onOpenComputers?: () => void
}

export function Sidebar({
  standaloneConversations,
  standaloneArchivedCount,
  onNewChat,
  creatingChat,
  onReorderStandaloneConversations,
  workspaces,
  statuses,
  attention,
  activeId,
  selectedConversation,
  requestedTab,
  fleet,
  selectedFleet,
  markedBots,
  onOpenFleetBot,
  onOpenFleetEnvironment,
  onOpenFleetServer,
  onOpenFleetInbox,
  onOpenFleetOwnerMemory,
  botServerConnected = false,
  botPendingCount = 0,
  fleetServers,
  botUpdate = null,
  onCreateBot,
  onOpenBotSettings,
  focusedWorkspaceId,
  pendingPlanIds,
  showArchived,
  onToggleArchived,
  onSelect,
  onAddWorkspace,
  onRemoveWorkspace,
  onNewConversation,
  onNewSiblingConversation,
  onArchiveSiblings,
  onDeleteSiblings,
  onOpenProjectNotes,
  onOpenProjectMemory,
  onEditDefaultBranch,
  onOpenAbout,
  onRenameConversation,
  onArchiveConversation,
  onPinConversation,
  onDeleteConversation,
  onMigrateConversation,
  moveTargetsOf,
  onMoveConversation,
  onReorderWorkspaces,
  onReorderConversations,
  groups,
  onCreateGroup,
  onRenameGroup,
  onDeleteGroup,
  onReorderGroups,
  onToggleGroupCollapsed,
  onMoveWorkspaceToGroup,
  onToggleWorkspaceCollapsed,
  collapsed = false,
  onCollapsedChange,
  openTargets,
  onOpenExternal,
  hostSections = [],
  localHost,
  appVersion = null,
  requestedHost = null,
  onConnectComputer,
  onOpenComputers,
}: Props) {
  const { t } = useTranslation('ui')
  const [query, setQuery] = useState('')
  const [tab, setTab] = useState<SidebarTab>(() => readSidebarTab(localStorage.getItem('sidebar.tab')))
  const selectTab = (next: SidebarTab) => {
    setTab(next)
    localStorage.setItem('sidebar.tab', next)
  }

  // The machine whose chats and workspaces are listed; one at a time once the window reaches more than this computer.
  const [storedHost, setStoredHost] = useState<string | null>(() => localStorage.getItem('sidebar.host'))
  const selectHost = (next: HostId) => {
    setStoredHost(next)
    localStorage.setItem('sidebar.host', next)
  }
  const multiHost = hostSections.length > 0
  const selectedHostId = resolveSidebarHost(storedHost, [
    LOCAL_HOST_ID,
    ...hostSections.map((section) => section.host.id),
  ])
  const selectedSection = hostSections.find((section) => section.host.id === selectedHostId) ?? null

  useEffect(() => {
    if (!selectedConversation) return
    selectTab(conversationSidebarTab(selectedConversation))
    selectHost(hostOfKey(selectedConversation.id))
  }, [selectedConversation?.id, selectedConversation?.scope])

  useEffect(() => {
    if (requestedTab) selectTab(requestedTab.tab)
  }, [requestedTab?.requestId])

  useEffect(() => {
    if (!requestedHost) return
    selectHost(requestedHost.hostId)
    if (tab === 'bots') selectTab('workspaces')
    if (collapsed) onCollapsedChange(false)
  }, [requestedHost?.requestId])

  const [renaming, setRenaming] = useState<{ convId: string; instanceKey: string } | null>(null)
  const [renameValue, setRenameValue] = useState('')

  const [renamingGroup, setRenamingGroup] = useState<string | null>(null)
  const [groupRenameValue, setGroupRenameValue] = useState('')
  const creatingSiblingsRef = useRef(new Set<string>())
  const [creatingSiblings, setCreatingSiblings] = useState<Set<string>>(new Set())
  const [highlightedWorkspaceId, setHighlightedWorkspaceId] = useState<string | null>(null)
  const { showQuickTooltip, hideQuickTooltip, quickTooltipNode } = useQuickTooltip()

  useEffect(() => {
    if (!focusedWorkspaceId) return
    const workspace = [...workspaces, ...hostSections.flatMap((section) => section.shell?.workspaces ?? [])].find(
      (item) => item.id === focusedWorkspaceId
    )
    if (!workspace) return
    selectTab('workspaces')
    selectHost(hostOfKey(workspace.id))
    setQuery('')
    if (workspace.collapsed) onToggleWorkspaceCollapsed(focusedWorkspaceId)
    // Showing a workspace in the sidebar opens its panel; the workspace is scrolled to once the panel is laid out.
    if (collapsed) onCollapsedChange(false)
    const scroll = () =>
      document
        .querySelector(`[data-workspace-id="${focusedWorkspaceId}"]`)
        ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    requestAnimationFrame(() => (collapsed ? requestAnimationFrame(scroll) : scroll()))
    setHighlightedWorkspaceId(focusedWorkspaceId)
    const timer = window.setTimeout(() => setHighlightedWorkspaceId(null), 1_800)
    return () => window.clearTimeout(timer)
  }, [focusedWorkspaceId])

  const q = query.trim().toLowerCase()
  const filtered = useMemo(() => filterWorkspaces(workspaces, q), [workspaces, q])
  const remoteChats = hostSections.flatMap((section) => section.shell?.standaloneConversations ?? [])
  const remoteWorkspaces = hostSections.flatMap((section) => section.shell?.workspaces ?? [])

  const filteredChats = useMemo(
    () => filterStandaloneConversations(standaloneConversations, q).filter((chat) => q || chat.pinnedAt === null),
    [standaloneConversations, q]
  )
  const filterCounts = {
    chats: q ? filterStandaloneConversations([...standaloneConversations, ...remoteChats], q).length : 0,
    workspaces: workspaceFilterCount([...workspaces, ...remoteWorkspaces], q),
    bots: q ? fleetSearchCount(fleet.state.connection, fleet.state.snapshot, q) : 0,
  }
  const crossMatches = q && filterCounts[tab] === 0 ? crossTabMatches(tab, filterCounts) : []

  // What each machine's conversations do, for the switcher, and which sections hold one waiting for the person.
  const workspaceConversations = (list: WorkspaceWithConversations[]) => list.flatMap((ws) => ws.conversations)
  const activityByHost: Record<HostId, HostActivity> = {
    [LOCAL_HOST_ID]: hostActivity(
      [...standaloneConversations, ...workspaceConversations(workspaces)],
      statuses,
      attention
    ),
  }
  for (const section of hostSections)
    activityByHost[section.host.id] = hostActivity(
      section.shell
        ? [...section.shell.standaloneConversations, ...workspaceConversations(section.shell.workspaces)]
        : [],
      statuses,
      attention
    )
  const waiting = (list: Conversation[]) => list.some((conv) => conv.archived !== 1 && attention.has(conv.id))
  const railAttention = {
    chats: waiting([...standaloneConversations, ...remoteChats]),
    workspaces: waiting(workspaceConversations([...workspaces, ...remoteWorkspaces])),
  }
  /** Matches of the filter among one machine's chats or workspaces; the sidebar lists one machine at a time. */
  const hostMatches = (hostId: HostId, kind: 'chats' | 'workspaces'): number => {
    if (!q) return 0
    const remote = hostId !== LOCAL_HOST_ID
    const shell = remote ? hostSections.find((section) => section.host.id === hostId)?.shell : null
    if (remote && !shell) return 0
    return kind === 'chats'
      ? filterStandaloneConversations(shell ? shell.standaloneConversations : standaloneConversations, q).length
      : workspaceFilterCount(shell ? shell.workspaces : workspaces, q)
  }
  const pinnedChats = standaloneConversations
    .filter((chat) => chat.pinnedAt !== null && chat.archived !== 1)
    .sort((a, b) => (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0))
  const pinned = useMemo(() => collectPinnedConversations(workspaces), [workspaces])
  const pinnedWorkspaceLabels = useMemo(() => buildPinnedWorkspaceLabels(workspaces), [workspaces])

  const { sensors, draggingWs, loose, byGroup, buildFlatIds, onDragStart, onDragCancel, onDragEnd } = useWorkspaceDnd({
    workspaces,
    groups,
    onReorderWorkspaces,
    onReorderGroups,
    onMoveWorkspaceToGroup,
  })
  const dndOff = renaming !== null || renamingGroup !== null

  const startRenameGroup = (group: WorkspaceGroup) => {
    setRenamingGroup(group.id)
    setGroupRenameValue(group.name)
  }
  const commitRenameGroup = (group: WorkspaceGroup) => {
    const v = groupRenameValue.trim()
    if (v && v !== group.name) onRenameGroup(group.id, v)
    setRenamingGroup(null)
  }
  const handleNewGroup = async () => {
    const g = await onCreateGroup(t('sidebar.newGroupName'))
    if (g) startRenameGroup(g)
  }

  const moveWsToGroupMenu = (ws: WorkspaceWithConversations, targetGroup: string | null) => {
    onMoveWorkspaceToGroup(ws.id, targetGroup, buildFlatIds(ws.id, targetGroup, null))
  }

  const stopPointer = (e: ReactPointerEvent) => e.stopPropagation()

  function startRename(conv: Conversation, instanceKey: string) {
    setRenaming({ convId: conv.id, instanceKey })
    setRenameValue(conv.name)
  }
  function commitRename(conv: Conversation, instanceKey: string) {
    if (renaming?.instanceKey !== instanceKey) return
    const v = renameValue.trim()
    if (v && v !== conv.name) onRenameConversation(conv, v)
    setRenaming(null)
  }

  async function newSiblingConversation(sourceConvId: string) {
    if (creatingSiblingsRef.current.has(sourceConvId)) return
    creatingSiblingsRef.current.add(sourceConvId)
    setCreatingSiblings(new Set(creatingSiblingsRef.current))
    try {
      await onNewSiblingConversation(sourceConvId)
    } finally {
      creatingSiblingsRef.current.delete(sourceConvId)
      setCreatingSiblings(new Set(creatingSiblingsRef.current))
    }
  }

  const menus = useSidebarMenus({
    onOpenChatWindow: (conversation) => {
      onSelect(conversation)
      requestChatWindow({ kind: 'conversation', id: conversation.id })
    },
    openTargets,
    onOpenExternal,
    groups,
    startRename,
    onPinConversation,
    onArchiveConversation,
    onDeleteConversation,
    onMigrateConversation,
    moveTargetsOf,
    onMoveConversation,
    onArchiveSiblings,
    onDeleteSiblings,
    onNewConversation,
    onOpenProjectNotes,
    onOpenProjectMemory,
    onEditDefaultBranch,
    onRemoveWorkspace,
    moveWsToGroupMenu,
    startRenameGroup,
    onDeleteGroup,
    newSiblingConversation,
  })
  const { workspaceMenuItems, groupMenuItems } = menus
  const { convItem, sharedFolder } = useConvRows({
    statuses,
    attention,
    activeId,
    pendingPlanIds,
    onSelect,
    renaming,
    setRenaming,
    renameValue,
    setRenameValue,
    startRename,
    commitRename,
    creatingSiblings,
    newSiblingConversation,
    showQuickTooltip,
    hideQuickTooltip,
    menus,
  })

  const renderConvFlat = (convs: Conversation[]) =>
    convs.map((c) => convItem(c, { pl: 'pl-6', instanceKey: `tree:${c.id}` }))

  // Attach the sortable node to the container and drag listeners only to its header.

  const renderWorkspace = (ws: WorkspaceWithConversations, s?: ReturnType<typeof useSortable>) => {
    const isCollapsed = ws.collapsed && !q
    const style: CSSProperties | undefined = s
      ? { transform: CSS.Transform.toString(s.transform), transition: s.transition }
      : undefined
    return (
      <div
        key={ws.id}
        ref={s?.setNodeRef}
        data-workspace-id={ws.id}
        style={style}
        className={cn(
          'mb-0.5 rounded-md transition-colors duration-500',
          s?.isDragging && 'opacity-50',
          highlightedWorkspaceId === ws.id && 'bg-primary/10 ring-1 ring-inset ring-primary/30'
        )}
      >
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <div
              {...(s?.attributes ?? {})}
              {...(s?.listeners ?? {})}
              data-workspace-header={ws.id}
              className={cn('group flex items-center px-2 py-1', s && 'touch-none')}
            >
              <button
                className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                onClick={() => onToggleWorkspaceCollapsed(ws.id)}
                title={ws.path}
              >
                {isCollapsed ? (
                  <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
                ) : (
                  <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
                )}
                {isCollapsed ? (
                  <Folder className="size-3.5 shrink-0 text-muted-foreground" />
                ) : (
                  <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" />
                )}
                <span
                  className="truncate text-[13px] font-medium text-foreground/90"
                  onMouseEnter={(e) => showQuickTooltip(e, ws.name)}
                  onMouseLeave={hideQuickTooltip}
                >
                  {ws.name}
                </span>
                {isCollapsed && ws.conversations.length > 0 && (
                  <span className="ml-1 shrink-0 text-[10.5px] tabular-nums text-muted-foreground/80">
                    {ws.conversations.length}
                  </span>
                )}
              </button>
              <div className="pointer-events-none max-w-0 shrink-0 overflow-hidden opacity-0 transition-[max-width,opacity] duration-150 group-focus-within:max-w-[9rem] group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:max-w-[9rem] group-hover:pointer-events-auto group-hover:opacity-100 has-[[data-state=open]]:max-w-[9rem] has-[[data-state=open]]:pointer-events-auto has-[[data-state=open]]:opacity-100">
                <div className="ml-1 flex w-max items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    onPointerDown={stopPointer}
                    className="size-6 shrink-0"
                    onClick={() => onOpenProjectNotes(ws.id)}
                    title={t('sidebar.projectNotes')}
                  >
                    <StickyNote className="size-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    onPointerDown={stopPointer}
                    className="size-6 shrink-0"
                    onClick={() => onNewConversation(ws.id)}
                    title={t('sidebar.newConversation')}
                  >
                    <Plus className="size-3.5" />
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        onPointerDown={stopPointer}
                        className="size-6 shrink-0"
                        title={t('sidebar.more')}
                      >
                        <MoreHorizontal className="size-3.5" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">{workspaceMenuItems(ws, dropdownKit)}</DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>
            </div>
          </ContextMenuTrigger>
          <ContextMenuContent>{workspaceMenuItems(ws, contextKit)}</ContextMenuContent>
        </ContextMenu>

        {!isCollapsed && (
          // The guide under the workspace's chevron ties its conversations to it.
          <ul className="relative before:pointer-events-none before:absolute before:bottom-1 before:left-[13.5px] before:top-0 before:w-px before:bg-border">
            {q ? (
              renderConvFlat(ws.conversations)
            ) : (
              <WorkspaceConvList
                workspaceId={ws.id}
                nodes={buildConvTopNodes(ws.conversations)}
                dndEnabled={renaming === null}
                onReorder={onReorderConversations}
                renderConv={(conv, dnd, isOver) =>
                  convItem(conv, { pl: 'pl-6', dnd, isOver, instanceKey: `tree:${conv.id}` })
                }
                renderGroup={(info, members, dnd, isOver) => sharedFolder(info, members, { dnd, isOver })}
              />
            )}
            {ws.conversations.length === 0 && (
              <li className="py-1 pl-7 pr-3 text-xs text-muted-foreground/60">{t('sidebar.noConversations')}</li>
            )}
          </ul>
        )}
      </div>
    )
  }

  const renderGroupHeader = (
    group: WorkspaceGroup,
    members: WorkspaceWithConversations[],
    dragListeners: ReturnType<typeof useSortable>['listeners']
  ) => {
    const open = !group.collapsed
    const isRenaming = renamingGroup === group.id
    return (
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            {...(dragListeners ?? {})}
            // Sticky inside its group: while its workspaces scroll by, the group they belong to stays in sight.
            className="group/grp sticky top-0 z-10 flex touch-none items-center gap-1.5 bg-sidebar px-2 py-1.5 backdrop-blur-xl"
          >
            <button
              className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
              onClick={() => onToggleGroupCollapsed(group.id)}
              title={open ? t('sidebar.collapseGroup') : t('sidebar.expandGroup')}
            >
              {open ? (
                <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
              ) : (
                <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
              )}
              {isRenaming ? (
                <input
                  autoFocus
                  value={groupRenameValue}
                  onChange={(e) => setGroupRenameValue(e.target.value)}
                  onBlur={() => commitRenameGroup(group)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitRenameGroup(group)
                    if (e.key === 'Escape') setRenamingGroup(null)
                  }}
                  onClick={(e) => e.stopPropagation()}
                  onPointerDown={stopPointer}
                  className="min-w-0 flex-1 rounded border border-input bg-transparent px-1 text-xs outline-none focus:ring-1 focus:ring-ring"
                />
              ) : (
                <span
                  className="truncate text-xs font-semibold text-sidebar-foreground/85"
                  onDoubleClick={(e) => {
                    e.stopPropagation()
                    startRenameGroup(group)
                  }}
                  onMouseEnter={(e) => showQuickTooltip(e, group.name)}
                  onMouseLeave={hideQuickTooltip}
                >
                  {group.name}
                </span>
              )}
              <span className="shrink-0 rounded bg-white/[0.05] px-1 text-[10px] text-muted-foreground">
                {members.length}
              </span>
            </button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  onPointerDown={stopPointer}
                  className="size-6 opacity-0 group-hover/grp:opacity-100 data-[state=open]:opacity-100"
                  title={t('sidebar.groupActions')}
                >
                  <MoreHorizontal className="size-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">{groupMenuItems(group, dropdownKit)}</DropdownMenuContent>
            </DropdownMenu>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>{groupMenuItems(group, contextKit)}</ContextMenuContent>
      </ContextMenu>
    )
  }

  /** What the `+` of the open section creates, on the machine the sidebar shows. */
  const createAction = ((): SidebarCreateAction => {
    if (tab === 'bots')
      return {
        label: t('sidebar.createBot'),
        onClick: () => onCreateBot?.(),
        disabled: !botServerConnected || !onCreateBot,
        disabledReason: t('sidebar.noServerConnected'),
      }
    if (selectedSection) {
      const host = hostName(selectedSection.host, t)
      const online = selectedSection.host.state === 'online'
      return tab === 'chats'
        ? {
            label: t('sidebar.hostNewChat', { host }),
            onClick: selectedSection.onNewChat,
            busy: selectedSection.creatingChat,
            disabled: !online,
          }
        : { label: t('sidebar.hostAddWorkspace', { host }), onClick: selectedSection.onAddWorkspace, disabled: !online }
    }
    return tab === 'chats'
      ? { label: t('sidebar.newChat'), onClick: () => void onNewChat(), busy: creatingChat }
      : { label: t('sidebar.addWorkspace'), onClick: onAddWorkspace }
  })()

  /** The `⋯` of the open section: how the chosen machine's lists are shown, and what can be done to that machine. */
  const viewMenu = ((): ReactNode => {
    if (tab === 'bots') return null
    const items: ReactNode[] = []
    if (tab === 'workspaces' && !selectedSection)
      items.push(
        <DropdownMenuItem key="group" onClick={() => void handleNewGroup()}>
          <Layers /> {t('sidebar.newGroup')}
        </DropdownMenuItem>
      )
    const lists = selectedSection ? selectedSection.shell : { standaloneArchivedCount, workspaces, showArchived }
    const toggleArchived = selectedSection ? selectedSection.shell?.actions.toggleArchived : onToggleArchived
    if (lists && toggleArchived) {
      const archived =
        lists.standaloneArchivedCount + lists.workspaces.reduce((n, ws) => n + (ws.archivedCount ?? 0), 0)
      if (archived > 0 || lists.showArchived)
        items.push(
          <DropdownMenuItem key="archived" onClick={toggleArchived}>
            <Archive />
            {lists.showArchived ? t('sidebar.hideArchived') : t('sidebar.showArchived', { count: archived })}
          </DropdownMenuItem>
        )
    }
    if (selectedSection) {
      const status = hostSectionStatus(selectedSection.host)
      if (items.length) items.push(<DropdownMenuSeparator key="host" />)
      if (hostRetryable(status))
        items.push(
          <DropdownMenuItem key="retry" onClick={selectedSection.onRetry}>
            <RefreshCw /> {t(status === 'disconnected' ? 'sidebar.peerReconnect' : 'sidebar.hostRetry')}
          </DropdownMenuItem>
        )
      if (status === 'stopped' || status === 'failed')
        items.push(
          <DropdownMenuItem key="start" onClick={selectedSection.onStart}>
            <Play /> {t('sidebar.hostStart')}
          </DropdownMenuItem>
        )
      items.push(
        <DropdownMenuItem key="manage" onClick={selectedSection.onManage}>
          <SquareArrowOutUpRight />{' '}
          {t(
            !selectedSection.host.peer
              ? 'sidebar.hostManage'
              : status === 'incompatible'
                ? 'sidebar.peerUpdates'
                : 'sidebar.peerManage'
          )}
        </DropdownMenuItem>
      )
    }
    return items.length ? items : null
  })()

  const switcherHosts = [...(localHost ? [localHost] : []), ...hostSections.map((section) => section.host)]

  /** With a filter typed, a way to each other machine with matches: the sidebar lists one machine at a time. */
  const otherHostResults = (kind: 'chats' | 'workspaces') =>
    q && multiHost
      ? switcherHosts
          .filter((host) => host.id !== selectedHostId)
          .map((host) => ({ host, count: hostMatches(host.id, kind) }))
          .filter(({ count }) => count > 0)
          .map(({ host, count }) => (
            <button
              key={host.id}
              type="button"
              data-host-results={host.id}
              onClick={() => selectHost(host.id)}
              className="mx-2 mt-2 flex w-[calc(100%-1rem)] items-center gap-2 rounded-md border border-dashed border-border px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <HostTile host={host} size="sm" />
              <span className="min-w-0 flex-1 truncate">
                {host.remote
                  ? t('sidebar.hostResults', { count, host: hostName(host, t) })
                  : t('sidebar.hostResultsHere', { count })}
              </span>
              <ChevronRight className="size-3.5 shrink-0" />
            </button>
          ))
      : null

  /** This computer's lists, marked as its section once the sidebar can show another machine's instead. */
  const localSection = (children: ReactNode) =>
    multiHost ? <section data-host-section={LOCAL_HOST_ID}>{children}</section> : children

  const pinnedHeading = (count: number) => (
    <div className="flex items-center gap-1.5 px-2 py-1">
      <Pin className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate text-[11px] font-medium text-muted-foreground">{t('sidebar.pinnedConversations')}</span>
      <span className="shrink-0 rounded bg-white/[0.05] px-1 text-[10px] text-muted-foreground">{count}</span>
    </div>
  )

  /**
   * A remote host's chats or workspaces, when the switcher shows that host. Its rows are the rows of this computer's
   * lists: their ids carry the host, and the handlers above act on the host they belong to. While the host is
   * unreachable its last lists stay, dimmed, under what is wrong.
   */
  const renderHostSection = (section: SidebarHostSection, kind: 'chats' | 'workspaces') => {
    const { host, shell } = section
    const online = host.state === 'online'
    const chats = kind === 'chats' && shell ? filterStandaloneConversations(shell.standaloneConversations, q) : []
    const trees = kind === 'workspaces' && shell ? filterWorkspaces(shell.workspaces, q) : []
    const nothingFound = Boolean(q) && shell?.loaded && chats.length === 0 && trees.length === 0
    const hostPinnedChats = q
      ? []
      : chats
          .filter((chat) => chat.pinnedAt !== null && chat.archived !== 1)
          .sort((a, b) => (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0))
    const hostPinned = kind === 'workspaces' && shell && !q ? collectPinnedConversations(shell.workspaces) : []
    const hostPinnedLabels = hostPinned.length && shell ? buildPinnedWorkspaceLabels(shell.workspaces) : null
    const empty = shell?.loaded && (kind === 'chats' ? shell.standaloneConversations : shell.workspaces).length === 0
    return (
      <section key={host.id} data-host-section={host.id}>
        {(!online || !shell?.loaded) && <HostSectionNotice host={host} appVersion={appVersion} actions={section} />}
        {nothingFound && (
          <p className="px-4 py-6 text-center text-xs text-muted-foreground">{t('sidebar.nothingFound')}</p>
        )}
        {shell && !nothingFound && (
          <div className={cn(!online && 'opacity-60')}>
            {hostPinnedChats.length > 0 && (
              <div className="mb-1 border-b border-border/40 pb-1">
                {pinnedHeading(hostPinnedChats.length)}
                <ul>
                  {hostPinnedChats.map((conv) => convItem(conv, { pl: 'pl-6', instanceKey: `pinned:${conv.id}` }))}
                </ul>
              </div>
            )}
            {hostPinned.length > 0 && (
              <div className="mb-1 border-b border-border/40 pb-1">
                {pinnedHeading(hostPinned.length)}
                <ul>
                  {hostPinned.map((entry) =>
                    convItem(entry.conversation, {
                      pl: 'pl-6',
                      instanceKey: `pinned:${entry.conversation.id}`,
                      contextLabel: hostPinnedLabels?.get(entry.workspace.id) ?? entry.workspace.name,
                      contextTooltip: entry.workspace.path,
                    })
                  )}
                </ul>
              </div>
            )}
            {kind === 'chats' ? (
              <StandaloneChatList
                conversations={chats.filter((chat) => q || chat.pinnedAt === null)}
                enabled={!q && renaming === null && online}
                onReorder={shell.actions.reorderStandaloneConversations}
                renderConv={(conv, dnd, isOver) =>
                  convItem(conv, { pl: 'pl-3', dnd, isOver, instanceKey: `chat:${conv.id}` })
                }
              />
            ) : (
              trees.map((ws) => renderWorkspace(ws))
            )}
            {empty && !q && (
              <p className="px-3 pb-1 text-xs text-muted-foreground">
                {t(
                  kind === 'chats'
                    ? 'sidebar.noChats'
                    : host.peer
                      ? 'sidebar.peerNoWorkspaces'
                      : 'sidebar.hostNoWorkspaces'
                )}
              </p>
            )}
          </div>
        )}
      </section>
    )
  }
  return (
    <nav
      data-sidebar-collapsed={collapsed || undefined}
      className={cn(
        'flex shrink-0',
        // Collapsed, only the rail is left, and the strip over it joins the title bar of the views beside it.
        collapsed ? 'w-[var(--rail-width)]' : 'glass hairline-r w-[296px] bg-sidebar'
      )}
    >
      <SidebarRail
        tab={tab}
        collapsed={collapsed}
        onToggleCollapsed={() => onCollapsedChange(!collapsed)}
        onTabChange={selectTab}
        onTabActivate={(next) => {
          selectTab(next)
          if (collapsed) onCollapsedChange(false)
        }}
        attention={railAttention}
        botPendingCount={botPendingCount}
        botUpdate={botUpdate}
        onOpenAbout={onOpenAbout}
        showQuickTooltip={showQuickTooltip}
        hideQuickTooltip={hideQuickTooltip}
      />

      {/* Hidden rather than unmounted, so the filter and what is being renamed survive a collapse. */}
      <div id="sidebar-panel" className={cn('min-w-0 flex-1 flex-col', collapsed ? 'hidden' : 'flex')}>
        <SidebarPanelHeader tab={tab} create={createAction} viewMenu={viewMenu} query={query} onQueryChange={setQuery}>
          {multiHost && tab !== 'bots' && (
            <HostSwitcher
              hosts={switcherHosts}
              selectedId={selectedHostId}
              activity={activityByHost}
              onSelect={selectHost}
              onConnectComputer={onConnectComputer}
              showQuickTooltip={showQuickTooltip}
              hideQuickTooltip={hideQuickTooltip}
            />
          )}
          {tab === 'bots' && fleetServers && fleetServers.servers.length > 1 && (
            <FleetServerSwitcher {...fleetServers} />
          )}
        </SidebarPanelHeader>

        <div className="flex min-h-0 flex-1 flex-col border-t border-border">
          <div
            id="sidebar-panel-chats"
            role="tabpanel"
            aria-labelledby="sidebar-tab-chats"
            hidden={tab !== 'chats'}
            className="min-h-0 flex-1 overflow-y-auto py-1"
          >
            {selectedSection
              ? renderHostSection(selectedSection, 'chats')
              : localSection(
                  <>
                    {!q && pinnedChats.length > 0 && (
                      <div className="mb-1 border-b border-border/40 pb-1">
                        <div className="flex items-center gap-1.5 px-2 py-1">
                          <Pin className="size-3.5 shrink-0 text-muted-foreground" />
                          <span className="text-[11px] font-medium text-muted-foreground">
                            {t('sidebar.pinnedConversations')}
                          </span>
                          <span className="rounded bg-white/[0.05] px-1 text-[10px] text-muted-foreground">
                            {pinnedChats.length}
                          </span>
                        </div>
                        <ul>
                          {pinnedChats.map((conv) => convItem(conv, { pl: 'pl-6', instanceKey: `pinned:${conv.id}` }))}
                        </ul>
                      </div>
                    )}
                    <StandaloneChatList
                      conversations={filteredChats}
                      enabled={!q && renaming === null}
                      onReorder={onReorderStandaloneConversations}
                      renderConv={(conv, dnd, isOver) =>
                        convItem(conv, { pl: 'pl-3', dnd, isOver, instanceKey: `chat:${conv.id}` })
                      }
                    />
                    {standaloneConversations.length === 0 && !q && (
                      <p className="px-3 pb-1 text-xs text-muted-foreground">{t('sidebar.noChats')}</p>
                    )}
                    {q && filteredChats.length === 0 && (
                      <p className="px-4 py-6 text-center text-xs text-muted-foreground">{t('sidebar.nothingFound')}</p>
                    )}
                  </>
                )}
            {otherHostResults('chats')}
            {tab === 'chats' &&
              crossMatches.map(({ tab: matchTab, count }) => (
                <button
                  key={matchTab}
                  type="button"
                  onClick={() => selectTab(matchTab)}
                  className="mx-2 mt-2 flex w-[calc(100%-1rem)] items-center justify-between rounded-md border border-dashed border-border px-2 py-2 text-left text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  {t('sidebar.crossTabResults', { count, tab: t(`sidebar.${matchTab}`) })}
                  <ChevronRight className="size-3.5" />
                </button>
              ))}
          </div>

          <div
            id="sidebar-panel-workspaces"
            role="tabpanel"
            aria-labelledby="sidebar-tab-workspaces"
            hidden={tab !== 'workspaces'}
            className="min-h-0 flex-1 overflow-y-auto py-1"
          >
            {selectedSection
              ? renderHostSection(selectedSection, 'workspaces')
              : localSection(
                  <>
                    {filtered.length === 0 && (
                      <p className="px-4 py-6 text-center text-xs text-muted-foreground">
                        {q ? t('sidebar.nothingFound') : t('sidebar.noWorkspaces')}
                      </p>
                    )}

                    {!q && pinned.length > 0 && (
                      <div className="mb-1 border-b border-border/40 pb-1">
                        <div className="flex items-center gap-1.5 px-2 py-1">
                          <Pin className="size-3.5 shrink-0 text-muted-foreground" />
                          <span className="truncate text-[11px] font-medium text-muted-foreground">
                            {t('sidebar.pinnedConversations')}
                          </span>
                          <span className="shrink-0 rounded bg-white/[0.05] px-1 text-[10px] text-muted-foreground">
                            {pinned.length}
                          </span>
                        </div>

                        <ul>
                          {pinned.map((item) =>
                            convItem(item.conversation, {
                              pl: 'pl-6',
                              instanceKey: `pinned:${item.conversation.id}`,
                              contextLabel: pinnedWorkspaceLabels.get(item.workspace.id) ?? item.workspace.name,
                              contextTooltip: item.workspace.path,
                            })
                          )}
                        </ul>
                      </div>
                    )}

                    {q ? (
                      filtered.map((ws) => renderWorkspace(ws))
                    ) : (
                      <DndContext
                        sensors={sensors}
                        onDragStart={onDragStart}
                        onDragEnd={onDragEnd}
                        onDragCancel={onDragCancel}
                      >
                        <Droppable id="rootdrop">
                          {(d) => (
                            <div
                              ref={d.setNodeRef}
                              className={cn(
                                'rounded-md',
                                d.isOver && 'ring-1 ring-inset ring-primary/50',
                                draggingWs &&
                                  loose.length === 0 &&
                                  'mx-1 min-h-[26px] border border-dashed border-border/60'
                              )}
                            >
                              <SortableContext
                                items={loose.map((w) => `ws-${w.id}`)}
                                strategy={verticalListSortingStrategy}
                              >
                                {loose.map((ws) => (
                                  <Sortable key={ws.id} id={`ws-${ws.id}`} disabled={dndOff}>
                                    {(s) => renderWorkspace(ws, s)}
                                  </Sortable>
                                ))}
                              </SortableContext>
                              {draggingWs && loose.length === 0 && (
                                <p className="px-3 py-1 text-center text-[10px] text-muted-foreground/50">
                                  {t('sidebar.dropOutsideGroups')}
                                </p>
                              )}
                            </div>
                          )}
                        </Droppable>

                        <SortableContext
                          items={groups.map((g) => `group-${g.id}`)}
                          strategy={verticalListSortingStrategy}
                        >
                          {groups.map((g) => {
                            const members = byGroup.get(g.id) ?? []
                            return (
                              <Sortable key={g.id} id={`group-${g.id}`} disabled={dndOff}>
                                {(s) => (
                                  <div
                                    ref={s.setNodeRef}
                                    style={{
                                      transform: CSS.Transform.toString(s.transform),
                                      transition: s.transition,
                                    }}
                                    {...s.attributes}
                                    className={cn('mb-0.5', s.isDragging && 'opacity-60')}
                                  >
                                    {renderGroupHeader(g, members, s.listeners)}
                                    {!g.collapsed && (
                                      <Droppable id={`groupdrop-${g.id}`}>
                                        {(d) => (
                                          <div
                                            ref={d.setNodeRef}
                                            className={cn(
                                              // Indented under the group, with a guide under its chevron.
                                              'relative mx-1 rounded-md pl-3 before:pointer-events-none before:absolute before:bottom-1 before:left-2.5 before:top-0 before:w-px before:bg-border',
                                              d.isOver && 'ring-1 ring-inset ring-primary/40'
                                            )}
                                          >
                                            <SortableContext
                                              items={members.map((w) => `ws-${w.id}`)}
                                              strategy={verticalListSortingStrategy}
                                            >
                                              {members.map((ws) => (
                                                <Sortable key={ws.id} id={`ws-${ws.id}`} disabled={dndOff}>
                                                  {(sw) => renderWorkspace(ws, sw)}
                                                </Sortable>
                                              ))}
                                            </SortableContext>
                                            {members.length === 0 && (
                                              <p className="py-1.5 pl-9 pr-3 text-xs text-muted-foreground/50">
                                                {draggingWs ? t('sidebar.dropWorkspaceHere') : t('sidebar.emptyGroup')}
                                              </p>
                                            )}
                                          </div>
                                        )}
                                      </Droppable>
                                    )}
                                  </div>
                                )}
                              </Sortable>
                            )
                          })}
                        </SortableContext>
                      </DndContext>
                    )}
                  </>
                )}
            {otherHostResults('workspaces')}
            {tab === 'workspaces' &&
              crossMatches.map(({ tab: matchTab, count }) => (
                <button
                  key={matchTab}
                  type="button"
                  onClick={() => selectTab(matchTab)}
                  className="mx-2 mt-2 flex w-[calc(100%-1rem)] items-center justify-between rounded-md border border-dashed border-border px-2 py-2 text-left text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  {t('sidebar.crossTabResults', { count, tab: t(`sidebar.${matchTab}`) })}
                  <ChevronRight className="size-3.5" />
                </button>
              ))}
          </div>

          <div
            id="sidebar-panel-bots"
            role="tabpanel"
            aria-labelledby="sidebar-tab-bots"
            hidden={tab !== 'bots'}
            className="min-h-0 flex-1 overflow-y-auto py-1"
          >
            <FleetSidebarPanel
              fleet={fleet}
              query={q}
              selected={selectedFleet}
              marked={markedBots}
              onOpenBotSettings={onOpenBotSettings}
              onOpenBot={onOpenFleetBot}
              onOpenEnvironment={onOpenFleetEnvironment}
              onOpenServer={onOpenFleetServer}
              onOpenInbox={onOpenFleetInbox}
              onOpenOwnerMemory={onOpenFleetOwnerMemory}
            />
            {tab === 'bots' &&
              crossMatches.map(({ tab: matchTab, count }) => (
                <button
                  key={matchTab}
                  type="button"
                  onClick={() => selectTab(matchTab)}
                  className="mx-2 mt-2 flex w-[calc(100%-1rem)] items-center justify-between rounded-md border border-dashed border-border px-2 py-2 text-left text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  {t('sidebar.crossTabResults', { count, tab: t(`sidebar.${matchTab}`) })}
                  <ChevronRight className="size-3.5" />
                </button>
              ))}
          </div>
        </div>

        {onOpenComputers && <PeerInUseChip onOpenSettings={onOpenComputers} />}
        <UpdateCard />
      </div>

      {quickTooltipNode}
    </nav>
  )
}
