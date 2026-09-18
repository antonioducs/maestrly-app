import { CalendarClock, Pause, Play, Plus } from 'lucide-react'
import type { Routine } from '@maestrly/host-protocol'
import { Button, Surface } from '../../ui'
import { useT } from '../../i18n'

/**
 * The list a person actually reads: the name, when it runs next, and how the last one went.
 * Everything else lives in the details, because a routine list that looks like a monitoring
 * console makes the product feel like infrastructure instead of help.
 */
export function RoutineList({
  routines,
  busy,
  onCreate,
  onOpen,
  onPause,
}: {
  routines: Routine[]
  busy: boolean
  onCreate: () => void
  onOpen: (routine: Routine) => void
  onPause: (routine: Routine, resume: boolean) => void
}) {
  const t = useT()
  return (
    <Surface className="routine-list" role="group" aria-label={t('routines')}>
      <header>
        <h3>{t('routines')}</h3>
        <Button type="button" onClick={onCreate} disabled={busy}>
          <Plus size={14} aria-hidden="true" />
          {t('routineNew')}
        </Button>
      </header>
      {!routines.length && <p className="routine-empty">{t('routineEmpty')}</p>}
      <ul>
        {routines.map((routine) => (
          <li key={routine.id}>
            <button type="button" className="routine-row" onClick={() => onOpen(routine)}>
              <CalendarClock size={15} aria-hidden="true" />
              <span className="routine-name">{routine.spec.name}</span>
              <span className="routine-next">
                {routine.status === 'paused'
                  ? t('routinePaused')
                  : routine.nextDueUtc
                    ? t('routineNextAt').replace('{when}', new Date(routine.nextDueUtc).toLocaleString(undefined, { timeZone: routine.spec.schedule.timeZone }))
                    : t('routineNoNext')}
              </span>
              {routine.lastOutcome && <span className="routine-last">{t(`routineOutcome_${routine.lastOutcome}` as never)}</span>}
            </button>
            {/* Pausing the routine is not the same as stopping the run that is happening now. */}
            <Button
              type="button"
              disabled={busy || routine.status === 'archived'}
              aria-label={routine.status === 'paused' ? t('routineResume') : t('routinePause')}
              onClick={() => onPause(routine, routine.status === 'paused')}
            >
              {routine.status === 'paused' ? <Play size={14} aria-hidden="true" /> : <Pause size={14} aria-hidden="true" />}
            </Button>
          </li>
        ))}
      </ul>
    </Surface>
  )
}
