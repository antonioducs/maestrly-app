import { useMemo, useState, type Dispatch, type SetStateAction } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Loader2,
  ClipboardList,
  Plus,
  GitBranch,
  GitMerge,
  ChevronRight,
  ChevronDown,
  Folder,
  FolderOpen,
  MoreHorizontal,
  Sparkles,
  Clock,
  CornerDownRight,
  ArrowUpRight,
} from 'lucide-react'
import type { Conversation } from '../../../preload'
import { isRemoteKey } from '@/lib/hosts/shell-keys'
import { BotConversationBadge } from '../bot/BotConversationBadge'
import { cn } from '@/lib/utils'
import { useLocale } from '@/lib/i18n'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent } from '@/components/ui/dropdown-menu'
import { ContextMenu, ContextMenuTrigger, ContextMenuContent } from '@/components/ui/context-menu'
import { StatusIcon, type AgentStatus } from '@/components/sidebar/StatusIcon'
import type { DragHandle } from '@/components/sidebar/WorkspaceConvList'
import { dropdownKit, contextKit } from '@/components/sidebar/menu-kit'
import { activeSiblingSource, type useSidebarMenus } from '@/components/sidebar/use-sidebar-menus'
import type { DispatchConversationGroupInfo, SharedConversationGroupInfo } from '@/components/sidebar/conv-top-nodes'
import { compactAge } from '@/components/sidebar/relative-time'
import type { MouseEvent } from 'react'

export function useConvRows({
  statuses,
  attention,
  activeId,
  pendingPlanIds,
  onSelect,
  findConversation,
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
  routineOriginCounts,
}: {
  statuses: Record<string, AgentStatus>
  attention: Set<string>
  activeId: string | null
  pendingPlanIds: Set<string>
  onSelect: (conv: Conversation) => void
  findConversation?: (id: string) => Conversation | undefined
  renaming: { convId: string; instanceKey: string } | null
  setRenaming: Dispatch<SetStateAction<{ convId: string; instanceKey: string } | null>>
  renameValue: string
  setRenameValue: Dispatch<SetStateAction<string>>
  startRename: (conv: Conversation, instanceKey: string) => void
  commitRename: (conv: Conversation, instanceKey: string) => void
  creatingSiblings: Set<string>
  newSiblingConversation: (sourceConvId: string) => Promise<void>
  showQuickTooltip: (e: MouseEvent<HTMLElement>, text: string) => void
  hideQuickTooltip: () => void
  menus: ReturnType<typeof useSidebarMenus>
  routineOriginCounts?: ReadonlyMap<string, number>
}) {
  const { t } = useTranslation('ui')
  const { t: tRoutines } = useTranslation('routines')
  const [locale] = useLocale()
  const { convMenuItems, sharedFolderMenuItems, dispatchFolderMenuItems } = menus

  const dateFormat = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }),
    [locale]
  )
  const ageLabel = (ts: number): string => {
    const age = compactAge(ts)
    if (!age) return ''
    return age.unit === 'Now' ? t('sidebar.ageNow') : t(`sidebar.age${age.unit}`, { count: age.count })
  }
  /** When it was last active, in full, and whether it runs in a worktree or the project folder. */
  const timeTitle = (conv: Conversation): string | undefined => {
    const mode =
      conv.scope === 'standalone' || conv.isMulti
        ? ''
        : conv.mode === 'worktree'
          ? t('sidebar.worktreeTitle')
          : t('sidebar.localModeTitle')
    const parts = [conv.lastActivityAt ? dateFormat.format(conv.lastActivityAt) : '', mode].filter(Boolean)
    return parts.length ? parts.join(' · ') : undefined
  }

  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({})

  const convItem = (
    conv: Conversation,
    opts: {
      pl: string
      num?: number
      dnd?: DragHandle
      isOver?: boolean
      instanceKey: string
      contextLabel?: string
      contextTooltip?: string
    }
  ) => {
    const status = statuses[conv.id] ?? conv.status
    const isArchived = conv.archived === 1
    const isRenaming = renaming?.instanceKey === opts.instanceKey
    const contextLabel = opts.contextLabel
    const contextTooltip = opts.contextTooltip ?? contextLabel
    const row = (
      <li
        {...opts.dnd}
        onClick={() => !isRenaming && onSelect(conv)}
        onDoubleClick={() => startRename(conv, opts.instanceKey)}
        className={cn(
          'conv-item group relative mx-1.5 flex cursor-pointer gap-2 rounded-md py-1.5 pr-1 text-[13px] text-sidebar-foreground hover:bg-white/[0.04]',
          contextLabel ? 'items-start' : 'items-center',
          opts.pl,
          conv.id === activeId && 'conv-selected text-foreground',
          isArchived && 'opacity-45',
          opts.isOver && 'ring-1 ring-inset ring-primary/60'
        )}
      >
        {opts.num != null && (
          <span
            className={cn(
              'w-3 shrink-0 text-right font-mono text-[10px] tabular-nums text-muted-foreground/50',
              contextLabel && 'mt-0.5'
            )}
          >
            {opts.num}
          </span>
        )}

        <span className={cn('inline-flex shrink-0', contextLabel && 'mt-0.5')}>
          {pendingPlanIds.has(conv.id) ? (
            <span title={t('sidebar.planWaiting')} className="inline-flex shrink-0 text-primary">
              <ClipboardList className="size-3.5" />
            </span>
          ) : (
            <StatusIcon status={status} />
          )}
        </span>
        {conv.botOrigin && <BotConversationBadge conversation={conv} compact />}
        {!conv.botOrigin &&
          conv.dispatchOrigin &&
          (() => {
            const sourceName =
              findConversation?.(conv.dispatchOrigin.sourceConversationId)?.name ?? conv.dispatchOrigin.sourceName
            return (
              <span
                data-testid="conversation-dispatch-badge"
                aria-label={t('sidebar.createdByConversation', { name: sourceName })}
                title={t('sidebar.createdByConversation', { name: sourceName })}
                className={cn(
                  'inline-flex shrink-0 items-center rounded border border-violet-400/25 bg-violet-400/[0.08] px-1 py-0.5 text-violet-300',
                  contextLabel && 'mt-0.5'
                )}
              >
                <CornerDownRight className="size-3.5" aria-hidden="true" />
              </span>
            )
          })()}
        <div className="min-w-0 flex-1">
          {isRenaming ? (
            <input
              autoFocus
              data-no-drag
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onBlur={() => commitRename(conv, opts.instanceKey)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitRename(conv, opts.instanceKey)
                if (e.key === 'Escape') setRenaming(null)
              }}
              onClick={(e) => e.stopPropagation()}
              onContextMenu={(e) => e.stopPropagation()}
              className="block w-full min-w-0 rounded border border-input bg-transparent px-1 text-[13px] outline-none focus:ring-1 focus:ring-ring"
            />
          ) : (
            <span
              className="block truncate"
              onMouseEnter={(e) => showQuickTooltip(e, conv.name)}
              onMouseLeave={hideQuickTooltip}
            >
              {conv.name}
            </span>
          )}
          {contextLabel && (
            <span
              className="mt-0.5 flex min-w-0 items-center gap-1 text-[10px] leading-3 text-muted-foreground/80"
              onMouseEnter={(e) => showQuickTooltip(e, contextTooltip ?? contextLabel)}
              onMouseLeave={hideQuickTooltip}
            >
              <Folder className="size-3 shrink-0 opacity-70" />
              <span className="truncate">{contextLabel}</span>
            </span>
          )}
        </div>

        {!isRenaming && attention.has(conv.id) && (
          <span
            title={t('sidebar.attentionTitle')}
            className={cn(
              'size-2 shrink-0 rounded-full bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.9)]',
              contextLabel && 'mt-1.5'
            )}
          />
        )}

        {/* The time gives way to the menu on hover; its tooltip has the date and how the conversation runs. */}
        {!isRenaming && (
          <span
            className={cn(
              'flex shrink-0 items-center gap-1 text-[11px] tabular-nums text-muted-foreground/80 group-hover:hidden',
              contextLabel && 'mt-0.5'
            )}
            title={timeTitle(conv)}
          >
            {conv.experience === 'maestro' && (
              <span className="flex items-center text-amber-300/80" title={t('sidebar.maestroConversation')}>
                <Sparkles className="size-3" />
              </span>
            )}
            {conv.scope === 'project' && conv.isMulti ? (
              <span
                className="flex items-center gap-0.5 text-primary/80"
                title={conv.repos?.map((r) => `${r.linkName} → ${r.branch}`).join('\n')}
              >
                <GitMerge className="size-3" />
                {conv.repos?.length ?? ''}
              </span>
            ) : null}
            {!isRemoteKey(conv.id) && (routineOriginCounts?.get(conv.id) ?? 0) > 0 && (() => {
              const count = routineOriginCounts!.get(conv.id) ?? 0
              return (
                <span
                  className="flex items-center text-[var(--routine)]"
                  title={tRoutines(count === 1 ? 'list.chatMarkSingle' : 'list.chatMarkPlural', { count })}
                >
                  <Clock aria-hidden="true" className="size-3" />
                </span>
              )
            })()}
            {ageLabel(conv.lastActivityAt)}
          </span>
        )}

        {!isRenaming && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                data-no-drag
                className={cn('hidden size-6 group-hover:flex data-[state=open]:flex', contextLabel && '-mt-0.5')}
                onClick={(e) => e.stopPropagation()}
                title={t('sidebar.more')}
              >
                <MoreHorizontal className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {convMenuItems(conv, isArchived, opts.instanceKey, dropdownKit)}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </li>
    )
    return (
      <ContextMenu key={opts.instanceKey}>
        <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
        <ContextMenuContent>{convMenuItems(conv, isArchived, opts.instanceKey, contextKit)}</ContextMenuContent>
      </ContextMenu>
    )
  }

  const sharedFolder = (
    info: SharedConversationGroupInfo,
    members: Conversation[],
    opts: { dnd?: DragHandle; isOver?: boolean } = {}
  ) => {
    const open = !collapsedGroups[info.key]
    const folderAttention = members.some((mm) => attention.has(mm.id))
    const source = activeSiblingSource(members)
    const sourceId = source?.id ?? members[0]!.id
    const creating = source ? creatingSiblings.has(source.id) : false
    const createDisabled = creating || !source
    return (
      <li key={`group:${info.key}`} {...opts.dnd}>
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <div
              onClick={() => setCollapsedGroups((groups) => ({ ...groups, [info.key]: !groups[info.key] }))}
              className={cn(
                'group/folder mx-1.5 flex cursor-pointer items-center gap-1.5 rounded-md py-1.5 pl-3 pr-1 text-[13px] text-sidebar-foreground hover:bg-white/[0.04]',
                opts.isOver && 'ring-1 ring-inset ring-primary/60'
              )}
            >
              {open ? (
                <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
              ) : (
                <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
              )}
              {open ? (
                <FolderOpen className="size-3.5 shrink-0 text-primary/70" />
              ) : (
                <Folder className="size-3.5 shrink-0 text-primary/70" />
              )}
              <span
                className="flex min-w-0 flex-1 items-center gap-1 truncate"
                onMouseEnter={(e) => showQuickTooltip(e, info.branch)}
                onMouseLeave={hideQuickTooltip}
              >
                <GitBranch className="size-3 shrink-0 text-muted-foreground/70" />
                <span className="truncate">{info.branch}</span>
              </span>
              {folderAttention && (
                <span
                  title={t('sidebar.attentionTitle')}
                  className="size-2 shrink-0 rounded-full bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.9)]"
                />
              )}
              <button
                data-no-drag
                onClick={(e) => {
                  e.stopPropagation()
                  void newSiblingConversation(sourceId)
                }}
                disabled={createDisabled}
                title={t('sidebar.newSiblingConversation')}
                className="shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover/folder:opacity-100 disabled:opacity-100"
              >
                {creating ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
              </button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    data-no-drag
                    onClick={(e) => e.stopPropagation()}
                    title={t('sidebar.siblingFolderActions')}
                    className="shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover/folder:opacity-100 data-[state=open]:opacity-100"
                  >
                    <MoreHorizontal className="size-3.5" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
                  {sharedFolderMenuItems(members, creating, dropdownKit)}
                </DropdownMenuContent>
              </DropdownMenu>
              <span className="shrink-0 rounded bg-white/[0.05] px-1 text-[10px] text-muted-foreground">
                {members.length}
              </span>
            </div>
          </ContextMenuTrigger>
          <ContextMenuContent>{sharedFolderMenuItems(members, creating, contextKit)}</ContextMenuContent>
        </ContextMenu>
        {open && (
          <ul>{members.map((c, i) => convItem(c, { pl: 'pl-11', num: i + 1, instanceKey: `tree:${c.id}` }))}</ul>
        )}
      </li>
    )
  }

  const dispatchFolder = (
    info: DispatchConversationGroupInfo,
    members: Conversation[],
    opts: { dnd?: DragHandle; isOver?: boolean } = {}
  ) => {
    const collapseKey = `dispatch:${info.rootId}`
    const open = !collapsedGroups[collapseKey]
    const folderAttention = members.some((mm) => attention.has(mm.id))
    const rootInFolder = members.some((mm) => mm.id === info.rootId)
    const rootConv = findConversation?.(info.rootId)
    const rootName = rootConv?.name ?? info.rootName
    const originConv = rootInFolder ? undefined : rootConv
    const originTarget = originConv ? { conv: originConv, onOpen: onSelect } : undefined
    return (
      <li key={collapseKey} data-testid="sidebar-dispatch-folder" data-dispatch-root={info.rootId} {...opts.dnd}>
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <div
              onClick={() => setCollapsedGroups((groups) => ({ ...groups, [collapseKey]: !groups[collapseKey] }))}
              className={cn(
                'group/folder mx-1.5 flex cursor-pointer items-center gap-1.5 rounded-md py-1.5 pl-3 pr-1 text-[13px] text-sidebar-foreground hover:bg-white/[0.04]',
                opts.isOver && 'ring-1 ring-inset ring-primary/60'
              )}
            >
              {open ? (
                <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
              ) : (
                <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
              )}
              {open ? (
                <FolderOpen className="size-3.5 shrink-0 text-violet-400/80" />
              ) : (
                <Folder className="size-3.5 shrink-0 text-violet-400/80" />
              )}
              <span
                className="min-w-0 flex-1 truncate"
                onMouseEnter={(e) => showQuickTooltip(e, t('sidebar.dispatchFolder', { name: rootName }))}
                onMouseLeave={hideQuickTooltip}
              >
                {rootName}
              </span>
              {folderAttention && (
                <span
                  title={t('sidebar.attentionTitle')}
                  className="size-2 shrink-0 rounded-full bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.9)]"
                />
              )}
              {originConv && (
                <button
                  type="button"
                  data-no-drag
                  data-testid="dispatch-folder-open-origin"
                  onClick={(e) => {
                    e.stopPropagation()
                    onSelect(originConv)
                  }}
                  title={t('sidebar.openOrigin', { name: originConv.name })}
                  aria-label={t('sidebar.openOrigin', { name: originConv.name })}
                  className="shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover/folder:opacity-100 focus-visible:opacity-100"
                >
                  <ArrowUpRight className="size-3.5" aria-hidden="true" />
                </button>
              )}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    data-no-drag
                    onClick={(e) => e.stopPropagation()}
                    title={t('sidebar.siblingFolderActions')}
                    className="shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover/folder:opacity-100 data-[state=open]:opacity-100"
                  >
                    <MoreHorizontal className="size-3.5" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
                  {dispatchFolderMenuItems(members, dropdownKit, originTarget)}
                </DropdownMenuContent>
              </DropdownMenu>
              <span className="shrink-0 rounded bg-white/[0.05] px-1 text-[10px] text-muted-foreground">
                {members.length}
              </span>
            </div>
          </ContextMenuTrigger>
          <ContextMenuContent>{dispatchFolderMenuItems(members, contextKit, originTarget)}</ContextMenuContent>
        </ContextMenu>
        {open && <ul>{members.map((c) => convItem(c, { pl: 'pl-9', instanceKey: `tree:${c.id}` }))}</ul>}
      </li>
    )
  }

  return { convItem, sharedFolder, dispatchFolder }
}
