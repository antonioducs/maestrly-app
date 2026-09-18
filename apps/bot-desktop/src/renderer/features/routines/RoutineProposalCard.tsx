import { CalendarClock } from 'lucide-react'
import type { RoutinePreview, RoutineProposal } from '@maestrly/host-protocol'
import { Button, Surface } from '../../ui'
import { useT } from '../../i18n'

/**
 * A suggestion the bot left, shown as what it is: a card the person decides about.
 *
 * It carries everything the decision needs — what will be done, for whom, how often, in which
 * zone, when the first one runs, what happens if the moment is missed, and the ceiling it will
 * run under. There is one primary action; nothing here spins while waiting for a person, because
 * a spinner that only means "we are waiting for you" is a lie about who is blocked.
 */
export function RoutineProposalCard({
  proposal,
  preview,
  targetName,
  busy,
  onActivate,
  onEdit,
  onDismiss,
}: {
  proposal: RoutineProposal
  /** Present once the Host computed the real instants for this suggestion. */
  preview?: RoutinePreview
  targetName: string
  busy: boolean
  onActivate: () => void
  onEdit: () => void
  onDismiss: () => void
}) {
  const t = useT()
  return (
    <Surface className="routine-card" role="group" aria-label={t('routineProposal')}>
      <header>
        <CalendarClock size={16} aria-hidden="true" />
        <strong>{proposal.name}</strong>
      </header>
      <p className="routine-request">{proposal.request}</p>
      <dl className="routine-facts">
        <div>
          <dt>{t('routineTarget')}</dt>
          <dd>{targetName}</dd>
        </div>
        {preview && (
          <>
            <div>
              <dt>{t('routineNext')}</dt>
              <dd>
                {preview.occurrences[0]?.scheduledForLocal ?? t('routineNoNext')}
                <small> ({preview.spec.schedule.timeZone})</small>
              </dd>
            </div>
            <div>
              <dt>{t('routineMisfire')}</dt>
              <dd>{preview.spec.misfirePolicy === 'latest' ? t('routineMisfireLatest') : t('routineMisfireSkip')}</dd>
            </div>
            <div>
              <dt>{t('routinePermissions')}</dt>
              <dd>{preview.permissionSummary.join(' · ')}</dd>
            </div>
            <div>
              <dt>{t('routineCeiling')}</dt>
              <dd>{t('routineCeilingValue').replace('{minutes}', String(Math.round(preview.effectiveCeiling.activeMs / 60_000))).replace('{actions}', String(preview.effectiveCeiling.maxTools))}</dd>
            </div>
          </>
        )}
      </dl>
      {proposal.clarification && <p className="routine-clarification">{proposal.clarification}</p>}
      {preview?.warnings.map((warning) => (
        <p className="routine-warning" key={warning.code}>
          {warning.message}
        </p>
      ))}
      <p className="routine-inert">{t('routineInert')}</p>
      <div className="routine-actions">
        <Button className="primary" type="button" disabled={busy || !preview?.feasible} onClick={onActivate}>
          {t('routineActivate')}
        </Button>
        <Button type="button" disabled={busy} onClick={onEdit}>
          {t('routineEdit')}
        </Button>
        <Button type="button" disabled={busy} onClick={onDismiss}>
          {t('routineDismiss')}
        </Button>
      </div>
    </Surface>
  )
}
