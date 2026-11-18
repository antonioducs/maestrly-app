import { useTranslation } from 'react-i18next'
import { ChevronRight, Trash2 } from 'lucide-react'
import { isRoutineRunSkipped, type LocalRoutine, type LocalRoutineRun } from '../../../shared/routines'
import { formatWhen } from '@/lib/routines/relative-time'
import type { RoutineTranslator } from '@/lib/routines/schedule-text'
import { runTimestamp } from '@/lib/routines/timeline'
import { outcomeIcon, RoutineOutcomePill } from './RoutineOutcomeBadge'

export function RoutineRunGoneView({
  routine,
  run,
  onOpenAgenda,
  onOpenRoutine,
}: {
  routine: LocalRoutine | null
  run: LocalRoutineRun | null
  onOpenAgenda: () => void
  onOpenRoutine: (routineId: string) => void
}) {
  const { t } = useTranslation('routines')
  const tr: RoutineTranslator = (key, opts) => String(t(key as never, opts as never))

  const routineId = routine?.id ?? run?.routineId ?? null
  const isDeleted = !run || run.conversationDeleted || !isRoutineRunSkipped(run)
  const title = isDeleted ? t('run.goneDeletedTitle') : t(`outcome.${run.status}.label`)
  const body = isDeleted ? t('run.goneDeletedBody') : (run.summary ?? '')
  const whenText = run ? formatWhen(runTimestamp(run), Date.now(), tr) : ''

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-chat-canvas" data-testid="routine-run-gone-view">
      <header className="drag flex h-10 shrink-0 items-center gap-1.5 hairline-b pl-[var(--view-header-inset)] pr-3">
        <button
          type="button"
          onClick={onOpenAgenda}
          className="no-drag -ml-1 inline-flex shrink-0 items-center rounded-[6px] px-1.5 py-0.5 text-[13px] text-muted-foreground hover:bg-white/[0.05] hover:text-foreground"
        >
          {t('detail.crumb')}
        </button>
        {routine?.title && (
          <>
            <ChevronRight aria-hidden="true" className="size-[11px] shrink-0 text-[rgba(154,149,140,0.58)]" />
            <button
              type="button"
              onClick={() => routineId && onOpenRoutine(routineId)}
              disabled={!routineId}
              className="no-drag inline-flex max-w-[28vw] shrink items-center truncate rounded-[6px] px-1.5 py-0.5 text-[13px] text-muted-foreground hover:bg-white/[0.05] hover:text-foreground disabled:pointer-events-none"
            >
              {routine.title}
            </button>
          </>
        )}
        {whenText && (
          <>
            <ChevronRight aria-hidden="true" className="size-[11px] shrink-0 text-[rgba(154,149,140,0.58)]" />
            <span className="truncate text-[13px] font-medium text-foreground">{whenText}</span>
          </>
        )}
        {run && <RoutineOutcomePill status={run.status} short />}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="routine-skipped-note mx-auto max-w-[460px]">
          {isDeleted ? (
            <Trash2 aria-hidden="true" className="size-7 text-[rgba(154,149,140,0.58)]" />
          ) : (
            outcomeIcon(run.status, 'size-7 text-[rgba(154,149,140,0.58)]')
          )}
          <strong className="text-[14px] font-semibold text-foreground">{title}</strong>
          {body && <p className="m-0 max-w-[420px] leading-[1.55] text-muted-foreground">{body}</p>}
          {routineId && (
            <button
              type="button"
              onClick={() => onOpenRoutine(routineId)}
              className="mt-1 inline-flex h-7 items-center rounded-[7px] border border-border bg-white/[0.04] px-3 text-[12px] font-medium text-foreground hover:bg-white/[0.08]"
            >
              {t('run.goneOpenRoutine')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
