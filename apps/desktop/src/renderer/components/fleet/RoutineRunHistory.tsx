import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { FleetRoutineRun } from '@maestrly/bot-fleet-protocol'
import { fleetErrorMessage } from '@/lib/fleet/errors'

export function RoutineRunHistory({
  botId,
  routineId,
  refreshKey,
}: {
  botId: string
  routineId: string
  refreshKey: number
}) {
  const { t, i18n } = useTranslation('fleet')
  const [runs, setRuns] = useState<FleetRoutineRun[] | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let alive = true
    void window.api
      .fleetListRoutineRuns(botId, routineId)
      .then((value) => {
        if (alive) {
          setRuns(value.runs)
          setError('')
        }
      })
      .catch((cause) => {
        if (alive) setError(fleetErrorMessage(cause))
      })
    return () => {
      alive = false
    }
  }, [botId, routineId, refreshKey])
  return (
    <div className="w-full space-y-2">
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      {runs?.length === 0 && <p className="text-xs text-muted-foreground">{t('routineRuns.empty')}</p>}
      <ul className="space-y-2">
        {runs?.map((run) => (
          <li key={run.id} className="space-y-1 rounded-lg border border-border bg-surface-elevated p-3 text-xs">
            <div className="flex flex-wrap items-center gap-2 text-muted-foreground">
              <span className="rounded border border-border px-1.5 py-0.5 text-foreground">
                {t(`routineRuns.status.${run.status}`)}
              </span>
              <time dateTime={run.deliveredAt}>{new Date(run.deliveredAt).toLocaleString(i18n.language)}</time>
              <span>{t(`routineRuns.trigger.${run.trigger}`)}</span>
            </div>
            {run.report?.summary && (
              <p>
                {t('routineRuns.did')}: {run.report.summary}
              </p>
            )}
            {run.report?.pending && (
              <p>
                {t('routineRuns.pending')}: {run.report.pending}
              </p>
            )}
            {run.report?.notes && (
              <p>
                {t('routineRuns.notes')}: {run.report.notes}
              </p>
            )}
            {run.finalText && (
              <details>
                <summary className="cursor-pointer text-muted-foreground">{t('routineRuns.answer')}</summary>
                <p className="mt-2 whitespace-pre-wrap break-words">{run.finalText}</p>
              </details>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
