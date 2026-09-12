import { useTranslation } from 'react-i18next'
import type { ChatSubscriptionUsage } from '../../../shared/chat'
import { cn } from '@/lib/utils'
import {
  subscriptionUsageLabel,
  subscriptionUsageResetDisplay,
  subscriptionUsageTone,
} from './subscription-usage-presentation'

function resetCopy(
  reset: ReturnType<typeof subscriptionUsageResetDisplay>,
  t: ReturnType<typeof useTranslation<'chat'>>['t']
): string | null {
  if (reset.kind === 'none') return null
  if (reset.kind === 'now') return t('settings.subscriptionUsageResetting')
  if (reset.kind === 'relative') return t('settings.subscriptionUsageResetsIn', { time: reset.value })
  return t('settings.subscriptionUsageResetsAt', { time: reset.value })
}

export function SubscriptionUsagePanel({
  usage,
  loading,
  showHeading = true,
}: {
  usage: ChatSubscriptionUsage | null
  loading: boolean
  showHeading?: boolean
}) {
  const { t, i18n } = useTranslation('chat')

  if (usage?.state === 'unsupported') return null
  if (!usage && !loading) return null

  return (
    <div className={cn(showHeading ? 'mt-3 border-t border-white/10 pt-2.5' : 'mt-2')}>
      {showHeading && (
        <p className="text-[11px] font-medium text-foreground/90">{t('settings.subscriptionUsageHeading')}</p>
      )}
      {loading && !usage ? (
        <div className="mt-2 space-y-2" aria-label={t('settings.subscriptionUsageLoading')}>
          <div className="h-1.5 animate-pulse rounded-full bg-white/10" />
          <div className="h-1.5 animate-pulse rounded-full bg-white/10" />
        </div>
      ) : usage?.state === 'error' ? (
        <p className="mt-1 text-[11px] text-amber-300" title={usage.error}>
          {t('settings.subscriptionUsageLoadFailed')}
        </p>
      ) : usage?.state === 'ready' && usage.windows.length === 0 ? (
        <p className="mt-1 text-[11px] text-muted-foreground">{t('settings.subscriptionUsageEmpty')}</p>
      ) : usage?.state === 'ready' ? (
        <div className="mt-2 space-y-2.5">
          {usage.windows.map((window) => {
            const descriptor = subscriptionUsageLabel(window)
            const label = t(descriptor.key, descriptor.values)
            const percent = Math.round(window.usedPercent)
            const reset = resetCopy(
              subscriptionUsageResetDisplay(window.resetsAt, i18n.resolvedLanguage || i18n.language),
              t
            )
            const tone = subscriptionUsageTone(window.usedPercent)
            const barClass = tone === 'critical' ? 'bg-rose-400' : tone === 'high' ? 'bg-amber-400' : 'bg-emerald-400'
            const textClass =
              tone === 'critical' ? 'text-rose-300' : tone === 'high' ? 'text-amber-300' : 'text-emerald-300'
            return (
              <div key={window.id}>
                <div className="mb-1 flex items-baseline justify-between gap-3 text-[11px]">
                  <div className="min-w-0">
                    <span className="text-foreground/90">{label}</span>
                    {reset && <span className="ml-1.5 text-muted-foreground">· {reset}</span>}
                  </div>
                  <span className={`shrink-0 tabular-nums ${textClass}`}>
                    {t('settings.subscriptionUsagePercentUsed', { percent })}
                  </span>
                </div>
                <div
                  className="h-1.5 overflow-hidden rounded-full bg-black/30 ring-1 ring-inset ring-white/[0.06]"
                  role="progressbar"
                  aria-label={label}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={percent}
                >
                  <div
                    className={`h-full rounded-full transition-[width] duration-300 ${barClass}`}
                    style={{ width: `${Math.min(100, Math.max(0, window.usedPercent))}%` }}
                  />
                </div>
              </div>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}
