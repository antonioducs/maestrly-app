import { useTranslation } from 'react-i18next'
import { AlertCircle } from 'lucide-react'

export function RoutineRunFailureCard({
  error,
  onSwitchModel,
  onRunAgain,
  busy = false,
}: {
  error: string
  onSwitchModel?: () => void
  onRunAgain?: () => void
  busy?: boolean
}) {
  const { t } = useTranslation('routines')

  return (
    <div className="routine-perm-danger" role="alert" data-testid="routine-run-failure-card">
      <div className="routine-perm-top">
        <AlertCircle aria-hidden="true" className="size-4 shrink-0" />
        <span>{t('run.failedTitle')}</span>
      </div>
      <p>{error}</p>
      {(onSwitchModel || onRunAgain) && (
        <div className="routine-perm-actions">
          {onSwitchModel && (
            <button
              type="button"
              onClick={onSwitchModel}
              className="inline-flex h-7 items-center rounded-[7px] border border-border bg-white/[0.06] px-2.5 text-[12px] font-medium text-foreground hover:bg-white/[0.1]"
            >
              {t('run.changeModel')}
            </button>
          )}
          {onRunAgain && (
            <button
              type="button"
              onClick={onRunAgain}
              disabled={busy}
              className="inline-flex h-7 items-center rounded-[7px] px-2.5 text-[12px] font-medium text-muted-foreground hover:bg-white/[0.06] hover:text-foreground disabled:opacity-50"
            >
              {t('run.runAgain')}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
