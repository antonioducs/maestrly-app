import { useState, type Dispatch, type SetStateAction } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Loader2,
  ClipboardList,
  Plus,
  GitBranch,
  GitMerge,
  HardDrive,
  ChevronRight,
  ChevronDown,
  Folder,
  FolderOpen,
  MoreHorizontal,
  Sparkles,
} from 'lucide-react'
import type { Conversation } from '../../../preload'
import { cn } from '@/lib/utils'
import { useLocale } from '@/lib/i18n'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent } from '@/components/ui/dropdown-menu'
import { ContextMenu, ContextMenuTrigger, ContextMenuContent } from '@/components/ui/context-menu'
import { StatusIcon, type AgentStatus } from '@/components/sidebar/StatusIcon'
import type { DragHandle } from '@/components/sidebar/WorkspaceConvList'
import { dropdownKit, contextKit } from '@/components/sidebar/menu-kit'
import { activeSiblingSource, type useSidebarMenus } from '@/components/sidebar/use-sidebar-menus'
import type { SharedConversationGroupInfo } from '@/components/sidebar/conv-top-nodes'
import { relativeTime } from '@/components/sidebar/relative-time'
import type { MouseEvent } from 'react'

export function useConvRows({
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
}: {
  statuses: Record<string, AgentStatus>
  attention: Set<string>
  activeId: string | null
  pendingPlanIds: Set<string>
  onSelect: (conv: Conversation) => void
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
}) {
  const { t } = useTranslation('ui')
  const [locale] = useLocale()
  const { convMenuItems, sharedFolderMenuItems } = menus

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
          'conv-item group relative mx-1.5 flex cursor-pointer gap-2 rounded-md py-1.5 pr-1 text-sm text-sidebar-foreground hover:bg-white/[0.04]',
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
              className="block w-full min-w-0 rounded border border-input bg-transparent px-1 text-sm outline-none focus:ring-1 focus:ring-ring"
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

        {/* Time and workspace mode give way to the menu on hover. */}
        {!isRenaming && (
          <span
            className={cn(
              'flex shrink-0 items-center gap-1 text-[10px] text-muted-foreground group-hover:hidden',
              contextLabel && 'mt-0.5'
            )}
          >
            {conv.experience === 'maestro' && (
              <span className="flex items-center text-amber-300/80" title={t('sidebar.maestroConversation')}>
                <Sparkles className="size-3" />
              </span>
            )}
            {conv.isMulti ? (
              <span
                className="flex items-center gap-0.5 text-primary/80"
                title={conv.repos?.map((r) => `${r.linkName} → ${r.branch}`).join('\n')}
              >
                <GitMerge className="size-3" />
                {conv.repos?.length ?? ''}
              </span>
            ) : conv.mode === 'worktree' ? (
              <span className="flex items-center" title={t('sidebar.worktreeTitle')}>
                <GitBranch className="size-3 opacity-50" />
              </span>
            ) : (
              <span className="flex items-center" title={t('sidebar.localModeTitle')}>
                <HardDrive className="size-3 opacity-50" />
              </span>
            )}
            {relativeTime(locale, conv.lastActivityAt)}
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
                'group/folder mx-1.5 flex cursor-pointer items-center gap-1.5 rounded-md py-1.5 pl-3 pr-1 text-sm text-sidebar-foreground hover:bg-white/[0.04]',
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
          <ul>
            {members.map((c, i) =>
              convItem(c, { pl: 'pl-11', num: i + 1, instanceKey: `tree:${c.id}` })
            )}
          </ul>
        )}
      </li>
    )
  }

  return { convItem, sharedFolder }
}
