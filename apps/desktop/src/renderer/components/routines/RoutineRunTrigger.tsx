import { useTranslation } from 'react-i18next'
import { Clock, History } from 'lucide-react'
import type { ChatRoutineRunMeta } from '../../../shared/chat'
import { formatHHMM } from '@/lib/routines/relative-time'
import { scheduleSummary, type RoutineTranslator } from '@/lib/routines/schedule-text'

export function RoutineRunTrigger({ meta }: { meta: ChatRoutineRunMeta }) {
  const { t } = useTranslation('routines')
  const tr: RoutineTranslator = (key, opts) => String(t(key as never, opts as never))
  const isLate = meta.trigger === 'late'
  const lateNote = isLate
    ? t('run.ranLateWhenAwake', { time: formatHHMM(meta.startedAt) })
    : ''

  return (
    <div className="routine-trigger" data-testid="routine-run-trigger">
      <div className="routine-trigger-top">
        <Clock aria-hidden="true" className="size-3 shrink-0" />
        <span>{meta.trigger === 'manual' ? t('run.triggerManual') : t('run.triggerRoutine')}</span>
        <span className="routine-sched">· {scheduleSummary(meta.schedule, tr)}</span>
      </div>
      <div className="routine-trigger-title">{meta.title}</div>
      <details className="routine-instr">
        <summary>
          <span className="routine-more-toggle">{t('run.viewInstruction')}</span>
        </summary>
        <div className="routine-full mt-1.5 text-[12.5px] leading-[1.5]">{meta.instruction}</div>
      </details>
      {(meta.hasPreviousReport || isLate) && (
        <div className="routine-trigger-ctx">
          <History aria-hidden="true" className="size-3 shrink-0" />
          <span>
            {meta.hasPreviousReport ? t('run.receivedPreviousReport') : ''}
            {meta.hasPreviousReport ? lateNote : lateNote.replace(/^\s*·\s*/, '')}
          </span>
        </div>
      )}
    </div>
  )
}
