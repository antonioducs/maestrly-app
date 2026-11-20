import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronRight, MoreHorizontal, Pin, Square, Trash2 } from 'lucide-react'
import type { HostView } from '../../../shared/hosts'
import type { LocalRoutine, LocalRoutineRun } from '../../../shared/routines'
import { hostOfKey } from '@/lib/hosts/shell-keys'
import { formatWhen } from '@/lib/routines/relative-time'
import type { RoutineTranslator } from '@/lib/routines/schedule-text'
import { runTimestamp } from '@/lib/routines/timeline'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { RoutineHostBadge, RoutineOutcomePill } from './RoutineOutcomeBadge'

export function RoutineRunHeader({
  routine,
  run,
  hosts = [],
  titleFallback,
  onOpenAgenda,
  onOpenRoutine,
  onStop,
  onTogglePin,
  onDeleteConversation,
  rightExtra,
}: {
  routine: LocalRoutine | null
  run: LocalRoutineRun | null
  hosts?: readonly HostView[]
  titleFallback?: string
  onOpenAgenda: () => void
  onOpenRoutine: (routineId: string) => void
  onStop: () => void
  onTogglePin: () => void
  onDeleteConversation: () => Promise<void> | void
  rightExtra?: ReactNode
}) {
  const { t } = useTranslation('routines')
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const tr: RoutineTranslator = (key, opts) => String(t(key as never, opts as never))

  const routineId = routine?.id ?? run?.routineId ?? null
  const runHostId = run ? hostOfKey(run.id) : routineId ? hostOfKey(routineId) : null
  const runHost = runHostId ? hosts.find((h) => h.id === runHostId) : undefined
  const routineTitle = routine?.title ?? titleFallback ?? ''
  const whenText = run ? formatWhen(runTimestamp(run), Date.now(), tr) : ''

  const handleConfirmDelete = async () => {
    setDeleting(true)
    try {
      await onDeleteConversation()
      setConfirmDeleteOpen(false)
    } finally {
      setDeleting(false)
    }
  }

  return (
    <header className="drag flex h-10 shrink-0 items-center justify-between gap-2 hairline-b pl-[var(--view-header-inset)] pr-2">
      <div className="no-drag flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
        <button
          type="button"
          onClick={onOpenAgenda}
          className="-ml-1 inline-flex shrink-0 items-center rounded-[6px] px-1.5 py-0.5 text-[13px] text-muted-foreground hover:bg-white/[0.05] hover:text-foreground"
        >
          {t('detail.crumb')}
        </button>
        {routineTitle && (
          <>
            <ChevronRight aria-hidden="true" className="size-[11px] shrink-0 text-[rgba(154,149,140,0.58)]" />
            <button
              type="button"
              onClick={() => routineId && onOpenRoutine(routineId)}
              disabled={!routineId}
              className="inline-flex max-w-[26vw] shrink items-center truncate rounded-[6px] px-1.5 py-0.5 text-[13px] text-muted-foreground hover:bg-white/[0.05] hover:text-foreground disabled:pointer-events-none"
            >
              {routineTitle}
            </button>
          </>
        )}
        {whenText && (
          <>
            <ChevronRight aria-hidden="true" className="size-[11px] shrink-0 text-[rgba(154,149,140,0.58)]" />
            <span className="min-w-0 truncate text-[13px] font-medium text-foreground">{whenText}</span>
          </>
        )}
        {run && <RoutineOutcomePill status={run.status} waitingKind={run.waiting?.kind} short />}
        {runHostId && <RoutineHostBadge host={runHost} hostId={runHostId} compact />}
      </div>

      <div className="no-drag flex shrink-0 items-center gap-1.5">
        {run?.pinned && (
          <span className="routine-chip">
            <Pin aria-hidden="true" className="size-3" />
            <span>{t('run.keptChip')}</span>
          </span>
        )}
        {run?.status === 'running' && (
          <button
            type="button"
            onClick={onStop}
            className="inline-flex h-7 items-center gap-1.5 rounded-[7px] border border-border bg-white/[0.04] px-2.5 text-[12px] font-medium text-foreground hover:bg-white/[0.08]"
          >
            <Square aria-hidden="true" className="size-3" />
            <span>{t('run.stop')}</span>
          </button>
        )}
        {run && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={t('run.moreActions')}
                className="inline-flex size-7 items-center justify-center rounded-[7px] text-muted-foreground hover:bg-white/[0.06] hover:text-foreground"
              >
                <MoreHorizontal aria-hidden="true" className="size-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              <DropdownMenuItem onSelect={onTogglePin} className="items-start gap-2.5 py-2">
                <Pin aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
                <div className="flex min-w-0 flex-col">
                  <span className="text-[12.5px] font-medium text-foreground">
                    {run.pinned ? t('run.unpin') : t('run.pin')}
                  </span>
                  <span className="text-[11px] text-muted-foreground">
                    {run.pinned
                      ? routine?.retentionDays != null
                        ? t('run.unpinSub', { count: routine.retentionDays })
                        : t('run.unpinSubForever')
                      : t('run.pinSub')}
                  </span>
                </div>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() => setConfirmDeleteOpen(true)}
                className="items-start gap-2.5 py-2 text-[var(--status-error)] focus:text-[var(--status-error)]"
              >
                <Trash2 aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
                <div className="flex min-w-0 flex-col">
                  <span className="text-[12.5px] font-medium">{t('run.deleteConversation')}</span>
                  <span className="text-[11px] text-muted-foreground">{t('run.deleteConversationSub')}</span>
                </div>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {rightExtra}
      </div>

      {confirmDeleteOpen && (
        <ConfirmDialog
          title={t('run.confirmDeleteTitle')}
          message={t('run.confirmDeleteBody')}
          confirmLabel={t('run.confirmDeleteOk')}
          cancelLabel={t('detail.cancel')}
          destructive
          busy={deleting}
          onCancel={() => setConfirmDeleteOpen(false)}
          onConfirm={() => void handleConfirmDelete()}
        />
      )}
    </header>
  )
}
