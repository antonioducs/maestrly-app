import type { Routine, RoutineOccurrence } from '@maestrly/host-protocol'
import { Button, Surface } from '../../ui'
import { useT } from '../../i18n'

const when = (occurrence: RoutineOccurrence) => occurrence.scheduledForLocal

/**
 * What actually happened, per firing: the moment it was due, how it ended and — when the Host
 * skipped it — why, in words rather than in a code. A person looking here is usually asking
 * "did it run last Monday?", and the answer has to be visible without opening anything.
 */
export function RoutineHistory({
  routine,
  occurrences,
  busy,
  onOpen,
  onStop,
  onRunNow,
}: {
  routine: Routine
  occurrences: RoutineOccurrence[]
  busy: boolean
  /** Opens the scoped conversation of one firing, where its questions can be answered. */
  onOpen: (occurrence: RoutineOccurrence) => void
  onStop: (occurrence: RoutineOccurrence) => void
  onRunNow: () => void
}) {
  const t = useT()
  const reason = (occurrence: RoutineOccurrence) => {
    if (!occurrence.causeCode) return undefined
    const key = `routineCause_${occurrence.causeCode}` as never
    const text = t(key)
    return text === key ? occurrence.attention : text
  }
  return (
    <Surface className="routine-history" role="group" aria-label={t('routineHistory')}>
      <header>
        <h4>{t('routineHistory')}</h4>
        <Button type="button" disabled={busy || routine.status !== 'active'} onClick={onRunNow}>
          {t('routineRunNow')}
        </Button>
      </header>
      {!occurrences.length && <p className="routine-empty">{t('routineNoHistory')}</p>}
      <ul>
        {occurrences.map((occurrence) => (
          <li key={occurrence.id}>
            <span className="routine-when">{when(occurrence)}</span>
            <span className={`routine-status routine-status-${occurrence.status}`}>{t(`routineOccurrence_${occurrence.status}` as never)}</span>
            {occurrence.origin === 'manual' && <span className="routine-manual">{t('routineManual')}</span>}
            {reason(occurrence) && <span className="routine-reason">{reason(occurrence)}</span>}
            {occurrence.summary && <p className="routine-summary">{occurrence.summary}</p>}
            <div className="routine-actions">
              {occurrence.execution && (
                <Button type="button" onClick={() => onOpen(occurrence)}>
                  {t('routineOpenRun')}
                </Button>
              )}
              {/* Stopping THIS run, which is a different decision from pausing the routine. */}
              {['pending', 'waiting_resource', 'running', 'waiting_user', 'needs_attention'].includes(occurrence.status) && (
                <Button type="button" disabled={busy} onClick={() => onStop(occurrence)}>
                  {t('routineStopRun')}
                </Button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </Surface>
  )
}
