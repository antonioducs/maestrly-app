import type { MouseEvent } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Loader2,
  Plus,
  GitBranch,
  FolderOpen,
  Pencil,
  Archive,
  ArchiveRestore,
  Trash2,
  Trash,
  StickyNote,
  ExternalLink,
  SquareTerminal,
  Code2,
  BrainCircuit,
  MessageSquarePlus,
  Layers,
  Pin,
  PinOff,
} from 'lucide-react'
import type { Conversation, WorkspaceGroup, WorkspaceWithConversations } from '../../../preload'
import type { MenuKit } from '@/components/sidebar/menu-kit'
import { isApparentlyMigrationEligible } from '@/components/conversation-migration/flow'

export interface OpenTargets {
  vscode: boolean
}
export type OpenExternalTarget = 'terminal' | 'finder' | 'vscode'

export const activeSiblingSource = (members: Conversation[]): Conversation | null =>
  members.find((conv) => conv.archived !== 1) ?? null

export function useSidebarMenus({
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
}: {
  openTargets: OpenTargets
  onOpenExternal: (scope: 'conv' | 'workspace', id: string, target: OpenExternalTarget) => void
  groups: WorkspaceGroup[]
  startRename: (conv: Conversation, instanceKey: string) => void

  onPinConversation: (conv: Conversation, pinned: boolean) => Promise<void> | void
  onArchiveConversation: (conv: Conversation, archived: boolean) => void
  onDeleteConversation: (conv: Conversation) => void
  onMigrateConversation: (conv: Conversation) => void
  onArchiveSiblings: (members: Conversation[], archived: boolean) => void
  onDeleteSiblings: (members: Conversation[]) => void
  onNewConversation: (workspaceId: string) => void
  onOpenProjectNotes: (workspaceId: string) => void
  onOpenProjectMemory: (workspaceId: string) => void
  onEditDefaultBranch: (workspaceId: string) => void
  onRemoveWorkspace: (workspaceId: string) => void
  moveWsToGroupMenu: (ws: WorkspaceWithConversations, targetGroup: string | null) => void
  startRenameGroup: (group: WorkspaceGroup) => void
  onDeleteGroup: (id: string) => void

  newSiblingConversation: (sourceConvId: string) => Promise<void>
}) {
  const { t } = useTranslation('ui')

  const openSubmenu = (scope: 'conv' | 'workspace', id: string, m: MenuKit) => {
    const open = (target: OpenExternalTarget) => (e: MouseEvent) => {
      e.stopPropagation()
      onOpenExternal(scope, id, target)
    }
    return (
      <m.Sub>
        <m.SubTrigger>
          <ExternalLink /> {t('sidebar.openIn')}
        </m.SubTrigger>
        <m.SubContent>
          <m.Item onClick={open('terminal')}>
            <SquareTerminal /> Terminal
          </m.Item>
          <m.Item onClick={open('finder')}>
            <FolderOpen /> {window.api.platformInfo.openLabels.files}
          </m.Item>
          {openTargets.vscode && (
            <m.Item onClick={open('vscode')}>
              <Code2 /> VS Code
            </m.Item>
          )}
        </m.SubContent>
      </m.Sub>
    )
  }

  const siblingCliMenuItems = (sourceConvId: string, m: MenuKit, disabled = false) => (
    <>
      <m.Item disabled className="gap-2 whitespace-normal text-[10px] leading-snug text-muted-foreground">
        {t('sidebar.siblingShareWarning')}
      </m.Item>
      <m.Separator />
      <m.Item
        disabled={disabled}
        onClick={(e: MouseEvent) => {
          e.stopPropagation()
          void newSiblingConversation(sourceConvId)
        }}
        className="gap-2 text-xs"
      >
        <MessageSquarePlus /> {t('sidebar.newSiblingConversation')}
      </m.Item>
    </>
  )

  const canCreateSibling = (conv: Conversation, isArchived: boolean): boolean =>
    conv.mode === 'worktree' && !conv.isMulti && !isArchived

  const pinItem = (conv: Conversation, isArchived: boolean, m: MenuKit) => {
    if (isArchived) return null
    const pinned = conv.pinnedAt !== null
    return (
      <m.Item
        onClick={(e: MouseEvent) => {
          e.stopPropagation()
          Promise.resolve(onPinConversation(conv, !pinned)).catch((error) => {
            console.error('[conversation:pin]', error)
          })
        }}
      >
        {pinned ? <PinOff /> : <Pin />} {pinned ? t('sidebar.unpinConversation') : t('sidebar.pinConversation')}
      </m.Item>
    )
  }

  const convMenuItems = (conv: Conversation, isArchived: boolean, instanceKey: string, m: MenuKit) => (
    <>
      <m.Item
        onClick={(e: MouseEvent) => {
          e.stopPropagation()
          startRename(conv, instanceKey)
        }}
      >
        <Pencil /> {t('common.rename')}
      </m.Item>
      {pinItem(conv, isArchived, m)}
      {isApparentlyMigrationEligible(conv) && (
        <m.Item
          onClick={(e: MouseEvent) => {
            e.stopPropagation()
            onMigrateConversation(conv)
          }}
        >
          <GitBranch /> {t('conversationMigration.menuAction')}
        </m.Item>
      )}
      {canCreateSibling(conv, isArchived) && (
        <m.Sub>
          <m.SubTrigger className="gap-2">
            <MessageSquarePlus /> {t('sidebar.newSiblingConversation')}
          </m.SubTrigger>
          <m.SubContent>{siblingCliMenuItems(conv.id, m)}</m.SubContent>
        </m.Sub>
      )}
      <m.Item
        onClick={(e: MouseEvent) => {
          e.stopPropagation()
          onArchiveConversation(conv, !isArchived)
        }}
      >
        {isArchived ? (
          <>
            <ArchiveRestore /> {t('sidebar.unarchive')}
          </>
        ) : (
          <>
            <Archive /> {t('sidebar.archive')}
          </>
        )}
      </m.Item>
      {openSubmenu('conv', conv.id, m)}
      <m.Separator />
      <m.Item
        destructive
        onClick={(e: MouseEvent) => {
          e.stopPropagation()
          onDeleteConversation(conv)
        }}
      >
        <Trash /> {t('sidebar.deletePermanently')}
      </m.Item>
    </>
  )

  const sharedFolderMenuItems = (members: Conversation[], creating: boolean, m: MenuKit) => {
    const source = activeSiblingSource(members)
    const sourceId = source?.id ?? members[0]!.id
    const createDisabled = creating || !source
    return (
      <>
        <m.Sub>
          <m.SubTrigger className="gap-2 text-xs" disabled={createDisabled}>
            {creating ? <Loader2 className="size-3.5 animate-spin" /> : <MessageSquarePlus className="size-3.5" />}
            {t('sidebar.newSiblingConversation')}
          </m.SubTrigger>
          <m.SubContent>{siblingCliMenuItems(sourceId, m, createDisabled)}</m.SubContent>
        </m.Sub>
        <m.Separator />
        <m.Item onClick={() => onArchiveSiblings(members, true)} className="gap-2 text-xs">
          <Archive className="size-3.5" /> {t('sidebar.archiveAll', { count: members.length })}
        </m.Item>
        <m.Separator />
        <m.Item
          onClick={() => onDeleteSiblings(members)}
          className="gap-2 text-xs text-destructive focus:text-destructive"
        >
          <Trash2 className="size-3.5" /> {t('sidebar.deleteAll', { count: members.length })}
        </m.Item>
      </>
    )
  }

  const workspaceMenuItems = (ws: WorkspaceWithConversations, m: MenuKit) => (
    <>
      <m.Item onClick={() => onNewConversation(ws.id)}>
        <Plus /> {t('sidebar.newConversation')}
      </m.Item>
      <m.Item onClick={() => onOpenProjectNotes(ws.id)}>
        <StickyNote /> {t('sidebar.projectNotes')}
      </m.Item>
      <m.Item onClick={() => onOpenProjectMemory(ws.id)}>
        <BrainCircuit /> {t('sidebar.projectMemory')}
      </m.Item>
      <m.Item onClick={() => onEditDefaultBranch(ws.id)}>
        <GitBranch /> {t('sidebar.defaultBranch')}
      </m.Item>
      {openSubmenu('workspace', ws.id, m)}
      <m.Separator />

      <m.Sub>
        <m.SubTrigger>
          <Layers /> {t('sidebar.moveToGroup')}
        </m.SubTrigger>
        <m.SubContent>
          {groups.length === 0 && <m.Item disabled>{t('sidebar.noGroups')}</m.Item>}
          {groups.map((g) => (
            <m.Item key={g.id} disabled={ws.groupId === g.id} onClick={() => moveWsToGroupMenu(ws, g.id)}>
              <Layers /> {g.name}
            </m.Item>
          ))}
          {ws.groupId && (
            <>
              <m.Separator />
              <m.Item onClick={() => moveWsToGroupMenu(ws, null)}>{t('sidebar.removeFromGroup')}</m.Item>
            </>
          )}
        </m.SubContent>
      </m.Sub>
      <m.Separator />
      <m.Item destructive onClick={() => onRemoveWorkspace(ws.id)}>
        <Trash2 /> {t('sidebar.removeWorkspace')}
      </m.Item>
    </>
  )

  const groupMenuItems = (group: WorkspaceGroup, m: MenuKit) => (
    <>
      <m.Item onClick={() => startRenameGroup(group)}>
        <Pencil /> {t('sidebar.renameGroup')}
      </m.Item>
      <m.Separator />
      <m.Item destructive onClick={() => onDeleteGroup(group.id)}>
        <Trash2 /> {t('sidebar.deleteGroup')}
      </m.Item>
    </>
  )

  return {
    openSubmenu,
    siblingCliMenuItems,
    convMenuItems,
    sharedFolderMenuItems,
    workspaceMenuItems,
    groupMenuItems,
  }
}
