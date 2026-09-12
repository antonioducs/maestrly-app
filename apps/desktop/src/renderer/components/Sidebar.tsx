/** Local workspaces, virtual groups, and pinned conversations.
 * Apply drag sorting only to the complete list so filtered searches cannot corrupt persisted order. */
import { useEffect, useMemo, useState, useRef, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Plus,
  ChevronRight,
  ChevronDown,
  Folder,
  FolderOpen,
  MoreHorizontal,
  StickyNote,
  Layers,
  Pin,
} from 'lucide-react'
import { DndContext } from '@dnd-kit/core'
import { SortableContext, type useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { Conversation, WorkspaceGroup, WorkspaceWithConversations } from '../../preload'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent } from '@/components/ui/dropdown-menu'
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
import { SidebarHeader } from '@/components/sidebar/SidebarHeader'
import { SidebarFooter } from '@/components/sidebar/SidebarFooter'

export type { OpenTargets, OpenExternalTarget }

interface Props {
  workspaces: WorkspaceWithConversations[]
  statuses: Record<string, AgentStatus>

  attention: Set<string>
  activeId: string | null

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
  onCollapseSidebar: () => void

  openTargets: OpenTargets

  onOpenExternal: (scope: 'conv' | 'workspace', id: string, target: OpenExternalTarget) => void
}

export function Sidebar({
  workspaces,
  statuses,
  attention,
  activeId,
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
  onCollapseSidebar,
  openTargets,
  onOpenExternal,
}: Props) {
  const { t } = useTranslation('ui')
  const [query, setQuery] = useState('')

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
    const workspace = workspaces.find((item) => item.id === focusedWorkspaceId)
    if (!workspace) return
    setQuery('')
    if (workspace.collapsed) onToggleWorkspaceCollapsed(focusedWorkspaceId)
    requestAnimationFrame(() => {
      document
        .querySelector(`[data-workspace-id="${focusedWorkspaceId}"]`)
        ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    })
    setHighlightedWorkspaceId(focusedWorkspaceId)
    const timer = window.setTimeout(() => setHighlightedWorkspaceId(null), 1_800)
    return () => window.clearTimeout(timer)
  }, [focusedWorkspaceId])

  const q = query.trim().toLowerCase()
  const filtered = useMemo(() => {
    if (!q) return workspaces
    return workspaces
      .map((ws) => ({
        ...ws,
        conversations: ws.conversations.filter(
          (c) => c.name.toLowerCase().includes(q) || c.branch.toLowerCase().includes(q)
        ),
      }))
      .filter((ws) => ws.conversations.length > 0 || ws.name.toLowerCase().includes(q))
  }, [workspaces, q])

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
    openTargets,
    onOpenExternal,
    groups,
    startRename,
    onPinConversation,
    onArchiveConversation,
    onDeleteConversation,
    onMigrateConversation,
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
                  className="truncate text-xs font-medium text-sidebar-foreground"
                  onMouseEnter={(e) => showQuickTooltip(e, ws.name)}
                  onMouseLeave={hideQuickTooltip}
                >
                  {ws.name}
                </span>
                {isCollapsed && ws.conversations.length > 0 && (
                  <span className="ml-1 shrink-0 text-[10px] text-muted-foreground">{ws.conversations.length}</span>
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
          <ul>
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
          <div {...(dragListeners ?? {})} className="group/grp flex touch-none items-center gap-1.5 px-2 py-1">
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
              <Layers className="size-3.5 shrink-0 text-primary/70" />
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
                  className="truncate text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground"
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

  return (
    <nav className="glass hairline-r flex w-64 shrink-0 flex-col bg-sidebar">
      <SidebarHeader
        query={query}
        onQueryChange={setQuery}
        onCollapseSidebar={onCollapseSidebar}
        onOpenAbout={onOpenAbout}
        onNewGroup={handleNewGroup}
        onAddWorkspace={onAddWorkspace}
      />

      <div className="flex-1 overflow-y-auto py-1">
        {filtered.length === 0 && (
          <p className="px-4 py-6 text-center text-xs text-muted-foreground">
            {q ? t('sidebar.nothingFound') : t('sidebar.noWorkspaces')}
          </p>
        )}

        {!q && pinned.length > 0 && (
          <div className="mb-1 border-b border-border/40 pb-1">
            <div className="flex items-center gap-1.5 px-2 py-1">
              <Pin className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate text-[10px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
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
          <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={onDragCancel}>
            <Droppable id="rootdrop">
              {(d) => (
                <div
                  ref={d.setNodeRef}
                  className={cn(
                    'rounded-md',
                    d.isOver && 'ring-1 ring-inset ring-primary/50',
                    draggingWs && loose.length === 0 && 'mx-1 min-h-[26px] border border-dashed border-border/60'
                  )}
                >
                  <SortableContext items={loose.map((w) => `ws-${w.id}`)} strategy={verticalListSortingStrategy}>
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

            <SortableContext items={groups.map((g) => `group-${g.id}`)} strategy={verticalListSortingStrategy}>
              {groups.map((g) => {
                const members = byGroup.get(g.id) ?? []
                return (
                  <Sortable key={g.id} id={`group-${g.id}`} disabled={dndOff}>
                    {(s) => (
                      <div
                        ref={s.setNodeRef}
                        style={{ transform: CSS.Transform.toString(s.transform), transition: s.transition }}
                        {...s.attributes}
                        className={cn('mb-0.5', s.isDragging && 'opacity-60')}
                      >
                        {renderGroupHeader(g, members, s.listeners)}
                        {!g.collapsed && (
                          <Droppable id={`groupdrop-${g.id}`}>
                            {(d) => (
                              <div
                                ref={d.setNodeRef}
                                className={cn('mx-1 rounded-md', d.isOver && 'ring-1 ring-inset ring-primary/40')}
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
      </div>

      <SidebarFooter
        workspaces={workspaces}
        showArchived={showArchived}
        onToggleArchived={onToggleArchived}
        onOpenAbout={onOpenAbout}
      />

      {quickTooltipNode}
    </nav>
  )
}
