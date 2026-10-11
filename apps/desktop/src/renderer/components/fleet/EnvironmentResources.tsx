import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check } from 'lucide-react'
import type { FleetEnvironment } from '@maestrly/bot-fleet-protocol'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { memoryLimitChoices, memoryLimitFromValue, memoryLimitValue } from '@/lib/fleet/environments'
import { fleetErrorText } from '@/lib/fleet/errors'
import { gb } from '@/lib/fleet/format'
import { formatUptime } from '@/lib/fleet/forms'
import type { FleetController } from '@/lib/fleet/use-fleet'
import { cn } from '@/lib/utils'

/** From this share of its limit on, the environment's memory shows as high. */
const HIGH_MEMORY = 0.85

/**
 * What the environment's container uses, against the limit it runs with, and that limit: one container holds every bot
 * of the environment, so these are the whole environment's.
 */
export function EnvironmentResources({
  environment,
  fleet,
}: {
  environment: FleetEnvironment
  fleet: FleetController
}) {
  const { t } = useTranslation('fleet')
  const { memoryBytes, cpuPercent, startedAt } = environment.resources
  // The limit Docker reports for the running container; the owner's choice until it reports one.
  const limitBytes = environment.resources.memoryLimitBytes ?? environment.memoryLimitBytes
  const share = memoryBytes !== null && limitBytes ? Math.min(1, memoryBytes / limitBytes) : null
  const uptime = startedAt ? formatUptime(Date.now() - Date.parse(startedAt)) : null
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!saved) return
    const timer = window.setTimeout(() => setSaved(false), 2400)
    return () => window.clearTimeout(timer)
  }, [saved])
  async function saveLimit(value: string) {
    if (busy) return
    setBusy(true)
    setSaved(false)
    setError('')
    try {
      const updated = await window.api.fleetPatchEnvironment(environment.id, {
        memoryLimitBytes: memoryLimitFromValue(value),
      })
      fleet.dispatch({
        type: 'event',
        value: { type: 'environment.updated', at: new Date().toISOString(), environment: updated },
      })
      setSaved(true)
    } catch (cause) {
      setError(fleetErrorText(cause, t))
    } finally {
      setBusy(false)
    }
  }
  const used = memoryBytes === null ? '—' : gb(memoryBytes)
  return (
    <section aria-labelledby="fleet-environment-resources">
      <h2 id="fleet-environment-resources" className="mb-3 text-[15px] font-semibold">
        {t('environment.resources')}
      </h2>
      <div className="space-y-3.5 rounded-xl border border-border p-4">
        <div className="flex flex-wrap items-center gap-x-3.5 gap-y-2">
          <span className="min-w-14 text-[12.5px] text-foreground/75">{t('server.memory')}</span>
          <div
            role="meter"
            aria-label={t('environment.memoryUsedLabel')}
            aria-valuemin={0}
            aria-valuemax={1}
            aria-valuenow={share ?? 0}
            aria-valuetext={
              limitBytes
                ? t('environment.memoryOf', { used, limit: gb(limitBytes) })
                : t('environment.memoryUsed', { used })
            }
            className="h-1.5 min-w-32 flex-1 overflow-hidden rounded-full bg-white/[0.07]"
          >
            <span
              className={cn(
                'block h-full rounded-full transition-[width] duration-500 motion-reduce:transition-none',
                share !== null && share >= HIGH_MEMORY ? 'bg-amber-300' : 'bg-foreground/80'
              )}
              style={{ width: `${(share ?? 0) * 100}%` }}
            />
          </div>
          <span className="font-mono text-[12.5px] tabular-nums text-foreground/75">
            {limitBytes
              ? t('environment.memoryOf', { used, limit: gb(limitBytes) })
              : t('environment.memoryUsed', { used })}
          </span>
        </div>
        <p className="flex flex-wrap gap-x-5 gap-y-1.5 text-[12.5px] text-muted-foreground">
          <span>
            {t('server.cpu')}
            <b className="ml-1.5 font-mono font-medium tabular-nums text-foreground/75">
              {cpuPercent === null ? '—' : `${Math.round(cpuPercent)}%`}
            </b>
          </span>
          <span>
            {t('environment.runningFor')}
            <b className="ml-1.5 font-medium text-foreground/75">
              {uptime && environment.lifecycle === 'running'
                ? t(uptime.long ? 'server.uptimeDays' : 'server.uptimeValue', uptime)
                : '—'}
            </b>
          </span>
          <span>
            {t('environment.versionLabel')}
            <b className="ml-1.5 font-mono font-medium tabular-nums text-foreground/75">
              {environment.appVersion ?? '—'}
            </b>
          </span>
        </p>
        <div className="flex flex-wrap items-center gap-x-3.5 gap-y-2 border-t border-border pt-3.5">
          <label className="text-[12.5px] text-foreground/75" htmlFor="fleet-environment-memory-limit">
            {t('environment.memoryLimit')}
          </label>
          <Select
            value={memoryLimitValue(environment.memoryLimitBytes)}
            disabled={busy}
            onValueChange={(value) => void saveLimit(value)}
          >
            <SelectTrigger
              id="fleet-environment-memory-limit"
              aria-label={t('environment.memoryLimit')}
              className="w-48"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {memoryLimitChoices(environment.memoryLimitBytes).map((choice) => (
                <SelectItem key={choice.value} value={choice.value}>
                  {choice.gb === null
                    ? t('environment.memoryLimitDefault')
                    : t('environment.memoryLimitValue', { value: choice.gb })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {saved && (
            <span role="status" className="inline-flex items-center gap-1 text-xs text-status-ready">
              <Check aria-hidden="true" className="size-3" />
              {t('environment.saved')}
            </span>
          )}
          <span className="min-w-48 flex-1 text-xs text-muted-foreground">{t('environment.memoryLimitNote')}</span>
        </div>
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
      </div>
    </section>
  )
}
