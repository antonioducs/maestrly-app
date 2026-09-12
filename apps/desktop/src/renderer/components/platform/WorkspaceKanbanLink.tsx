import { Columns3, ExternalLink, Unplug } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useWorkspaceKanban } from '@/lib/workspace-kanban'

export function WorkspaceKanbanLink({ workspaceId, compact = false }: { workspaceId: string; compact?: boolean }) {
  const link = useWorkspaceKanban(workspaceId)
  const { t } = useTranslation('chat')
  const [error, setError] = useState('')
  if (!link) return null
  const online = link.state === 'connected'
  return (
    <div data-testid="workspace-kanban-link" className={compact ? 'px-6 pb-1.5' : 'border-b border-white/5 px-4 py-2'}>
      <button
        type="button"
        className="flex max-w-full items-center gap-1.5 rounded text-[11px] text-muted-foreground hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
        title={`${link.organizationName ?? ''} · ${link.boardName ?? t('kanban.board')} — ${t(online ? 'kanban.linked' : 'kanban.disconnected')}`}
        aria-label={t('kanban.openProject', { project: link.projectName ?? t('kanban.project') })}
        disabled={!link.url}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={() => {
          setError('')
          void window.api.openExternalUrl(link.url).catch(() => setError(t('kanban.openFailed')))
        }}
      >
        {online ? <Columns3 size={13} className="shrink-0 text-primary" /> : <Unplug size={13} className="shrink-0" />}
        <span className="truncate">{link.projectName ?? t('kanban.project')}</span>
        {!compact ? (
          <span className="shrink-0 opacity-70">· {t(online ? 'kanban.open' : 'kanban.disconnected')}</span>
        ) : null}
        <ExternalLink size={11} className="shrink-0 opacity-60" />
      </button>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  )
}
