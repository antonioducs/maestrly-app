import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Circle, CircleX, Loader2, Minus } from 'lucide-react'
import type { FleetInstallerJob } from '../../../../shared/fleet-installer'
import { Button } from '@/components/ui/button'
import { formatElapsed, stepLabelKey } from '@/lib/fleet/installer'

export function BotServerProgress({
  job,
  canRetry,
  onCancel,
  onRetry,
  onBack,
}: {
  job: FleetInstallerJob
  canRetry: boolean
  onCancel: () => void
  onRetry: () => void
  onBack: () => void
}) {
  const { t } = useTranslation('fleet')
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (job.state !== 'running') return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [job.state])
  const icon = {
    pending: <Circle className="size-4 text-muted-foreground" />,
    running: <Loader2 className="size-4 animate-spin text-primary" />,
    done: <Check className="size-4 text-emerald-500" />,
    failed: <CircleX className="size-4 text-destructive" />,
    skipped: <Minus className="size-4 text-muted-foreground" />,
  }
  return (
    <div className="space-y-4" aria-live="polite">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-base font-semibold">{t(`botServer.job.${job.kind}`)}</h3>
        <span className="text-xs tabular-nums text-muted-foreground">
          {formatElapsed(now - Date.parse(job.startedAt))}
        </span>
      </div>
      {job.hostKey && (
        <p className="rounded-md border border-border p-3 text-xs text-muted-foreground">
          {t('botServer.progress.hostKey')} <code className="break-all text-foreground">{job.hostKey}</code>
        </p>
      )}
      <ol className="space-y-2 rounded-lg border border-border bg-surface-elevated p-4">
        {job.steps.map((step) => (
          <li key={step.id} className="flex items-start gap-3 text-sm">
            <span aria-hidden="true" className="mt-0.5">
              {icon[step.state]}
            </span>
            <div className="min-w-0">
              <span className={step.state === 'pending' || step.state === 'skipped' ? 'text-muted-foreground' : ''}>
                {t(stepLabelKey(step.id, job.mode))}
              </span>
              {step.detail && <p className="break-words text-xs text-muted-foreground">{step.detail}</p>}
            </div>
          </li>
        ))}
      </ol>
      {job.warning && (
        <p role="status" className="rounded-md border border-amber-500/40 p-3 text-sm text-amber-500">
          {t(`botServer.warnings.${job.warning}`)}
        </p>
      )}
      {job.error && (
        <p role="alert" className="rounded-md border border-destructive/40 p-3 text-sm text-destructive">
          {t(`botServer.error.${job.error.code}`)}
          {job.error.detail ? ` ${job.error.detail}` : ''}
        </p>
      )}
      <div className="flex gap-2">
        {job.state === 'running' ? (
          <Button variant="outline" onClick={onCancel}>
            {t('botServer.progress.cancel')}
          </Button>
        ) : (
          <>
            {canRetry && <Button onClick={onRetry}>{t('botServer.progress.retry')}</Button>}
            <Button variant="outline" onClick={onBack}>
              {t('botServer.progress.back')}
            </Button>
          </>
        )}
      </div>
    </div>
  )
}
