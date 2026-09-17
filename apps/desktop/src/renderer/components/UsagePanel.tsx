import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { UsagePanel as SharedUsagePanel, isoDay, usagePeriodRange, type UsagePanelRow, type UsagePeriod } from '@maestrly/chat-ui'
import { estimatedCostOfUsage } from '../../shared/chat'
import type { ChatModelMeta } from '../../shared/chat'
import { USAGE_MAX_WINDOW_DAYS } from '../../shared/usage'
import type { UnifiedUsageStats } from '../../shared/usage'

const DAY = 86_400_000

/**
 * The desktop's usage view: this device's ledger, priced with the model catalogue, laid out by
 * the shared panel. Only the data plumbing lives here; the table is the one the Bot renders too.
 */
export function UsagePanel() {
  const { t } = useTranslation('ui')
  const [stats, setStats] = useState<UnifiedUsageStats | null>(null)
  const [metaByModel, setMetaByModel] = useState<Record<string, ChatModelMeta | null>>({})
  const [providerNames, setProviderNames] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [refreshTick, setRefreshTick] = useState(0)
  const forceRef = useRef(false)

  const [period, setPeriod] = useState<UsagePeriod>('30d')
  const [custom, setCustom] = useState({ from: '', to: '' })
  const minCustomDay = isoDay(Date.now() - USAGE_MAX_WINDOW_DAYS * DAY)
  const range = useMemo(() => usagePeriodRange(period, custom, USAGE_MAX_WINDOW_DAYS), [period, custom])

  useEffect(() => {
    void window.api.chatConfig().then((c) => setProviderNames(Object.fromEntries(c.providers.map((p) => [p.id, p.name]))))
  }, [])

  useEffect(() => {
    let alive = true
    setLoading(true)
    const force = forceRef.current
    forceRef.current = false
    void window.api.usageStats({ ...range, ...(force ? { force: true } : {}) }).then(async (s) => {
      const pairs = await Promise.all(
        s.rows.map((r) => window.api.chatModelMeta(r.modelId, r.providerId).then((mm) => [`${r.providerId}\0${r.modelId}`, mm] as const))
      )
      if (!alive) return
      setStats(s)
      setMetaByModel(Object.fromEntries(pairs))
      setLoading(false)
    })
    return () => {
      alive = false
    }
  }, [range, refreshTick])

  const providerName = (id?: string) => (id ? providerNames[id] || id : '')
  const rows = useMemo((): UsagePanelRow[] => {
    if (!stats) return []
    return stats.rows.map((r) => {
      const meta = metaByModel[`${r.providerId}\0${r.modelId}`]
      const catalogUsage = { input: r.catalogInput ?? 0, output: r.catalogOutput ?? 0, cacheRead: r.catalogCacheRead ?? 0, cacheCreate: r.catalogCacheCreate ?? 0 }
      return {
        key: `${r.source} ${r.providerId ?? ''} ${r.modelId}`,
        modelId: r.modelId,
        sub: [providerName(r.providerId), `${r.turns} ${t('usage.turnsUnit')}`].filter(Boolean).join(' · '),
        turns: r.turns,
        input: r.input,
        output: r.output,
        cacheRead: r.cacheRead,
        cacheCreate: r.cacheCreate,
        cost: estimatedCostOfUsage(r, meta, r.costUsd, catalogUsage),
      }
    })
  }, [stats, metaByModel, providerNames, t])

  return (
    <SharedUsagePanel
      rows={rows}
      turns={stats?.chatTurns ?? 0}
      firstAt={stats?.firstAt}
      lastAt={stats?.lastAt}
      loading={loading}
      period={period}
      onPeriodChange={setPeriod}
      custom={custom}
      onCustomChange={setCustom}
      minCustomDay={minCustomDay}
      onRefresh={() => {
        forceRef.current = true
        setRefreshTick((n) => n + 1)
      }}
    />
  )
}
