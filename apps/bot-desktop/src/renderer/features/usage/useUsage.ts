import { useCallback, useEffect, useMemo, useState } from 'react'
import { USAGE_MAX_WINDOW_DAYS, type UsageSummary } from '@maestrly/host-protocol'
import { estimatedCostOfUsage, isoDay, usagePeriodRange, type ChatModelMeta, type UsagePanelRow, type UsagePeriod } from '@maestrly/chat-ui'
import { metaForModel, useModelMeta } from '../chat/useContextMeter'

const DAY = 86_400_000

/** A model row of the Host summary, priced with the public catalogue; null cost when it has no price. */
export function usageRows(summary: UsageSummary | null, catalogue: Record<string, ChatModelMeta>, turnsUnit: string): UsagePanelRow[] {
  if (!summary) return []
  return summary.byModel.map((row) => ({
    key: `${row.provider} ${row.model}`,
    modelId: row.model,
    sub: `${row.provider} · ${row.turns} ${turnsUnit}`,
    turns: row.turns,
    input: row.input - row.cachedInput,
    output: row.output,
    cacheRead: row.cachedInput,
    cacheCreate: 0,
    cost: estimatedCostOfUsage({ input: row.input - row.cachedInput, output: row.output, cacheRead: row.cachedInput }, metaForModel(catalogue, row.model)),
  }))
}

/**
 * The usage of one bot or of the whole Host over a chosen period. The Host sums its ledger; the
 * catalogue prices it here. A period outside what the Host keeps is refused before the request.
 */
export function useUsage(botId: string | undefined, connected: boolean, supported: boolean, turnsUnit: string, initialPeriod: UsagePeriod = '30d') {
  const catalogue = useModelMeta()
  const [period, setPeriod] = useState<UsagePeriod>(initialPeriod)
  const [custom, setCustom] = useState({ from: '', to: '' })
  const [summary, setSummary] = useState<UsageSummary | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [tick, setTick] = useState(0)
  const range = useMemo(() => usagePeriodRange(period, custom, USAGE_MAX_WINDOW_DAYS), [period, custom])
  const reload = useCallback(() => setTick((n) => n + 1), [])
  useEffect(() => {
    if (!connected || !supported) return
    const since = range.since ?? Date.now() - USAGE_MAX_WINDOW_DAYS * DAY
    let alive = true
    setLoading(true)
    setError('')
    window.bot
      .usage({
        method: 'usage.summary',
        params: { ...(botId ? { botId } : {}), since: new Date(since).toISOString(), ...(range.until ? { until: new Date(range.until).toISOString() } : {}) },
      })
      .then((value) => alive && setSummary(value))
      .catch((failure) => alive && setError(String(failure)))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [botId, connected, supported, range, tick])
  const rows = useMemo(() => usageRows(summary, catalogue, turnsUnit), [summary, catalogue, turnsUnit])
  return {
    summary,
    rows,
    loading,
    error,
    period,
    setPeriod,
    custom,
    setCustom,
    minCustomDay: isoDay(Date.now() - USAGE_MAX_WINDOW_DAYS * DAY),
    reload,
  }
}
