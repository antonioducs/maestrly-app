import { LocalDataSection } from './LocalDataSection'
import { useState } from 'react'
import { RefreshCw, RotateCcw, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { TFn } from './shared'
import type { PerformanceDiagnostics } from '../../../preload'
import { useMemoryAutoReclaim } from '@/lib/use-memory-auto-reclaim'

export function PrivacySection({ t }: { t: TFn }) {
  const [performance, setPerformance] = useState<PerformanceDiagnostics | null>(null)
  const [loadingPerformance, setLoadingPerformance] = useState(false)
  const autoReclaim = useMemoryAutoReclaim()
  const [reclaiming, setReclaiming] = useState(false)
  const [performanceError, setPerformanceError] = useState('')
  const [reclaimResult, setReclaimResult] = useState('')

  const collectPerformance = async () => {
    setLoadingPerformance(true)
    setPerformanceError('')
    try {
      setPerformance(await window.api.getPerformanceDiagnostics())
    } catch {
      setPerformanceError(t('settings.performance.error'))
    } finally {
      setLoadingPerformance(false)
    }
  }

  const resetPerformance = async () => {
    await window.api.resetPerformanceCounters()
    setPerformance(null)
  }

  return (
    <section className="flex flex-col gap-3">
      <LocalDataSection t={t} />
      <div className="flex flex-col gap-2 rounded-lg border border-border bg-white/[0.02] px-3 py-2.5">
        <div>
          <div className="text-sm font-medium text-foreground">{t('settings.performance.title')}</div>
          <div className="text-[11px] leading-snug text-muted-foreground">{t('settings.performance.desc')}</div>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => {
              const next = autoReclaim === false
              window.api.setMemoryAutoReclaim(next)
            }}
            className="rounded-md border border-border px-2.5 py-1.5 text-xs text-foreground"
          >
            {t('settings.performance.autoReclaim')}: {autoReclaim !== false ? t('common.on') : t('common.off')}
          </button>
          <button
            type="button"
            disabled={reclaiming}
            onClick={() => {
              setReclaiming(true)
              void window.api
                .reclaimSafeMemoryNow()
                .then((result) => {
                  setReclaimResult(t('settings.performance.reclaimed', { count: result.evicted.length }))
                  void collectPerformance()
                })
                .finally(() => setReclaiming(false))
            }}
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs text-foreground disabled:opacity-50"
          >
            <Trash2 className="size-3.5" /> {t('settings.performance.reclaim')}
          </button>
          <button
            type="button"
            onClick={() => void collectPerformance()}
            disabled={loadingPerformance}
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs text-foreground transition-colors hover:bg-white/[0.04] disabled:opacity-50"
          >
            <RefreshCw className={cn('size-3.5', loadingPerformance && 'animate-spin')} />
            {loadingPerformance ? t('settings.performance.collecting') : t('settings.performance.collect')}
          </button>
          <button
            type="button"
            onClick={() => void resetPerformance()}
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-white/[0.04]"
          >
            <RotateCcw className="size-3.5" /> {t('settings.performance.reset')}
          </button>
        </div>
        {performance && (
          <div className="grid grid-cols-2 gap-2 text-[11px] text-muted-foreground">
            <span>
              {t('settings.performance.pressure')}: {performance.reclaimer.pressure}
            </span>
            <span>
              {t('settings.performance.total')}:{' '}
              {Math.round(
                (performance.totals.workingSetTotal +
                  (performance.totals.externalRssTotal ?? 0) +
                  performance.totals.cacheBytesTotal) /
                  1048576
              )}{' '}
              MiB
            </span>
            <span>
              {t('settings.performance.processes')}:{' '}
              {performance.processMetrics.length + performance.ownedProcesses.length}
            </span>
            <span>
              {t('settings.performance.caches')}: {Math.round(performance.totals.cacheBytesTotal / 1048576)} MiB
            </span>
          </div>
        )}
        {(performanceError || reclaimResult) && (
          <div className="text-[11px] text-muted-foreground">{performanceError || reclaimResult}</div>
        )}
        {performance && (
          <pre className="max-h-64 overflow-auto rounded border border-border bg-black/30 p-2 text-[10px] leading-relaxed text-muted-foreground">
            {JSON.stringify(performance, null, 2)}
          </pre>
        )}
      </div>
    </section>
  )
}
