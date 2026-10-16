import { useTranslation } from 'react-i18next'
import { FolderGit2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { NotesPanel } from '@/components/notes/NotesPanel'

interface Props {
  workspaceId: string
  workspaceName: string
  onClose: () => void
}

export function ProjectNotesView({ workspaceId, workspaceName, onClose }: Props) {
  const { t } = useTranslation('ui')
  return (
    <div className="flex h-full flex-col">
      <header className="drag flex h-10 shrink-0 items-center gap-2 hairline-b pl-[var(--view-header-inset)] pr-3">
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
