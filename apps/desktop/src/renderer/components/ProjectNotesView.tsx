import { useTranslation } from 'react-i18next'
import { FolderGit2, X, PanelLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { NotesPanel } from '@/components/notes/NotesPanel'
import { cn } from '@/lib/utils'

interface Props {
  workspaceId: string
  workspaceName: string

  onShowSidebar?: () => void
  onClose: () => void
}

export function ProjectNotesView({ workspaceId, workspaceName, onShowSidebar, onClose }: Props) {
  const { t } = useTranslation('ui')
  return (
    <div className="flex h-full flex-col">
      <header
        className={cn(
          'drag flex h-10 shrink-0 items-center gap-2 hairline-b pr-3',
          onShowSidebar ? 'pl-[var(--tt-offset)]' : 'pl-3'
        )}
      >
        {onShowSidebar && (
          <Button
            variant="ghost"
            size="icon"
            className="no-drag size-7 text-muted-foreground"
            onClick={onShowSidebar}
            title={t('common.showWorkspaces')}
          >
            <PanelLeft className="size-4" />
          </Button>
        )}
        <FolderGit2 className="size-4 text-muted-foreground" />
        <span className="truncate text-[13px] font-medium text-foreground/90">
          {t('projectNotes.title', { name: workspaceName })}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="no-drag ml-auto size-7"
          onClick={onClose}
          title={t('common.close')}
        >
          <X className="size-4" />
        </Button>
      </header>
      <div className="min-h-0 flex-1">
        <NotesPanel key={workspaceId} scope="project" scopeId={workspaceId} />
      </div>
    </div>
  )
}
