import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { BarChart3, RefreshCw, Coins } from 'lucide-react'
import { cn } from '@/lib/utils'
import { estimatedCostOfUsage, totalTokensOf } from '../../shared/chat'
import type { ChatModelMeta } from '../../shared/chat'
import { USAGE_MAX_WINDOW_DAYS } from '../../shared/usage'
import type { UnifiedUsageStats, UsageModelRow } from '../../shared/usage'

const DAY = 86_400_000
type Period = 'today' | '7d' | '30d' | '90d' | 'custom'

const fmtTokens = (n: number): string =>
  n >= 1e9
    ? `${(n / 1e9).toFixed(1)}B`
    : n >= 1e6
      ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`
      : n >= 1e3
        ? `${(n / 1e3).toFixed(n >= 1e5 ? 0 : 1)}k`
        : String(Math.round(n))

const fmtNum = (n: number): string => n.toLocaleString()
const fmtCost = (c: number): string =>
  c >= 1 ? `$${c.toFixed(2)}` : c >= 0.01 ? `$${c.toFixed(3)}` : c > 0 ? `$${c.toFixed(4)}` : '$0'

const isoDay = (ms: number): string => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

interface Row extends UsageModelRow {
  total: number
  cost: number | null
}

export function UsagePanel() {
  const { t } = useTranslation('ui')
  const [stats, setStats] = useState<UnifiedUsageStats | null>(null)
  const [metaByModel, setMetaByModel] = useState<Record<string, ChatModelMeta | null>>({})
  const [providerNames, setProviderNames] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [refreshTick, setRefreshTick] = useState(0)
  const forceRef = useRef(false)

  const [period, setPeriod] = useState<Period>('30d')
  const [customFrom, setCustomFrom] = useState('') // YYYY-MM-DD
  const [customTo, setCustomTo] = useState('')

  const minCustomDay = isoDay(Date.now() - USAGE_MAX_WINDOW_DAYS * DAY)

  const range = useMemo((): { since?: number; until?: number } => {
    const now = Date.now()
    switch (period) {
      case 'today': {
        const d = new Date()
        d.setHours(0, 0, 0, 0)
        return { since: d.getTime() }
      }
      case '7d':
        return { since: now - 7 * DAY }
      case '30d':
        return { since: now - 30 * DAY }
      case '90d':
        return { since: now - USAGE_MAX_WINDOW_DAYS * DAY }
      case 'custom':
        return {
          since: customFrom ? new Date(`${customFrom}T00:00:00`).getTime() : undefined,
          until: customTo ? new Date(`${customTo}T23:59:59.999`).getTime() : undefined,
        }
      default:
        return {}
    }
  }, [period, customFrom, customTo])

  useEffect(() => {
    void window.api
      .chatConfig()
      .then((c) => setProviderNames(Object.fromEntries(c.providers.map((p) => [p.id, p.name]))))
  }, [])

  useEffect(() => {
    let alive = true
    setLoading(true)
    const force = forceRef.current
    forceRef.current = false
    void window.api.usageStats({ ...range, ...(force ? { force: true } : {}) }).then(async (s) => {
      const pairs = await Promise.all(
        s.rows.map((r) =>
          window.api.chatModelMeta(r.modelId, r.providerId).then((mm) => [`${r.providerId}\0${r.modelId}`, mm] as const)
        )
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

  const rows = useMemo((): Row[] => {
    if (!stats) return []
    return stats.rows.map((r) => {
      const meta = metaByModel[`${r.providerId}\0${r.modelId}`]
      const catalogUsage = {
        input: r.catalogInput ?? 0,
        output: r.catalogOutput ?? 0,
        cacheRead: r.catalogCacheRead ?? 0,
        cacheCreate: r.catalogCacheCreate ?? 0,
      }
      return {
        ...r,
        total: totalTokensOf(r),
        cost: estimatedCostOfUsage(r, meta, r.costUsd, catalogUsage),
      }
    })
  }, [stats, metaByModel])

  const totals = useMemo(() => {
    return {
      input: rows.reduce((a, r) => a + r.input, 0),
      output: rows.reduce((a, r) => a + r.output, 0),
      cacheRead: rows.reduce((a, r) => a + r.cacheRead, 0),
      cacheCreate: rows.reduce((a, r) => a + r.cacheCreate, 0),
      total: rows.reduce((a, r) => a + r.total, 0),
      cost: rows.reduce((a, r) => a + (r.cost ?? 0), 0),
      hasCost: rows.some((r) => r.cost != null),
      unpriced: rows.filter((r) => r.cost == null && r.total > 0).length,
    }
  }, [rows])

  const fmtDate = (ms: number) => new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
  const providerName = (id?: string) => (id ? providerNames[id] || id : '')

  const periods: { id: Period; label: string }[] = [
    { id: 'today', label: t('usage.periodToday') },
    { id: '7d', label: t('usage.period7d') },
    { id: '30d', label: t('usage.period30d') },
    { id: '90d', label: t('usage.period90d') },
    { id: 'custom', label: t('usage.periodCustom') },
  ]

  const totalCostLabel = totals.hasCost
    ? `~${fmtCost(totals.cost)}${totals.unpriced > 0 ? ` ${t('usage.unpricedSuffix', { count: totals.unpriced })}` : ''}`
    : t('common.dash')

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <BarChart3 className="size-4" /> {t('usage.heading')}
          </h2>
          <p className="mt-0.5 text-[12px] text-muted-foreground">{t('usage.desc')}</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="inline-flex overflow-hidden rounded-md border border-border">
            {periods.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => setPeriod(p.id)}
                className={cn(
                  'px-2 py-1 text-[11px] transition-colors',
                  period === p.id
                    ? 'bg-primary/20 font-medium text-foreground'
                    : 'text-muted-foreground hover:bg-white/5'
                )}
              >
                {p.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => {
              forceRef.current = true
              setRefreshTick((n) => n + 1)
            }}
            title={t('usage.refresh')}
            className="flex shrink-0 items-center gap-1.5 rounded-md border border-border px-2 py-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground"
          >
            <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
          </button>
        </div>
      </div>

      {period === 'custom' && (
        <div className="flex flex-wrap items-center gap-2 text-[12px] text-muted-foreground">
          <label className="flex items-center gap-1.5">
            {t('usage.from')}
            <input
              type="date"
              value={customFrom}
              min={minCustomDay}
              max={customTo || undefined}
              onChange={(e) => setCustomFrom(e.target.value)}
              className="rounded-md border border-border bg-black/20 px-2 py-1 text-foreground outline-none focus:border-primary/60"
            />
          </label>
          <label className="flex items-center gap-1.5">
            {t('usage.to')}
            <input
              type="date"
              value={customTo}
              min={customFrom || minCustomDay}
              onChange={(e) => setCustomTo(e.target.value)}
              className="rounded-md border border-border bg-black/20 px-2 py-1 text-foreground outline-none focus:border-primary/60"
            />
          </label>
        </div>
      )}

      {rows.length === 0 ? (
        <div className="rounded-lg border border-border bg-white/[0.02] px-4 py-8 text-center text-[13px] text-muted-foreground">
          {loading ? t('usage.loading') : t('usage.empty')}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Card label={t('usage.cardTotalTokens')} value={fmtTokens(totals.total)} title={fmtNum(totals.total)} />
            <Card label={t('usage.cardTotalCost')} value={totalCostLabel} accent />
            <Card label={t('usage.cardTurns')} value={fmtNum(stats?.chatTurns ?? 0)} />
            <Card
              label={t('usage.cardModels')}
              value={String(rows.length)}
              sub={stats?.firstAt ? `${fmtDate(stats.firstAt)} – ${fmtDate(stats.lastAt!)}` : undefined}
            />
          </div>

          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full border-collapse text-[12px]">
              <thead>
                <tr className="border-b border-border bg-white/[0.02] text-muted-foreground">
                  <Th className="text-left">{t('usage.colModel')}</Th>
                  <Th>{t('usage.colInput')}</Th>
                  <Th>{t('usage.colOutput')}</Th>
                  <Th>{t('usage.colCacheCreate')}</Th>
                  <Th>{t('usage.colCacheRead')}</Th>
                  <Th>{t('usage.colTotal')}</Th>
                  <Th>{t('usage.colShare')}</Th>
                  <Th>{t('usage.colCost')}</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const share = totals.total > 0 ? r.total / totals.total : 0
                  const sub = [providerName(r.providerId), `${r.turns} ${t('usage.turnsUnit')}`]
                    .filter(Boolean)
                    .join(' · ')
                  return (
                    <tr
                      key={`${r.source} ${r.providerId ?? ''} ${r.modelId}`}
                      className="border-b border-border/50 last:border-0 hover:bg-white/[0.015]"
                    >
                      <Td className="text-left">
                        <span className="font-mono text-[12px] text-foreground">{r.modelId}</span>
                        {sub && <span className="block text-[10px] text-muted-foreground">{sub}</span>}
                      </Td>
                      <Td title={fmtNum(r.input)}>{fmtTokens(r.input)}</Td>
                      <Td title={fmtNum(r.output)}>{fmtTokens(r.output)}</Td>
                      <Td title={fmtNum(r.cacheCreate)} className={r.cacheCreate ? '' : 'text-muted-foreground/40'}>
                        {fmtTokens(r.cacheCreate)}
                      </Td>
                      <Td title={fmtNum(r.cacheRead)} className={r.cacheRead ? '' : 'text-muted-foreground/40'}>
                        {fmtTokens(r.cacheRead)}
                      </Td>
                      <Td title={fmtNum(r.total)} className="font-medium text-foreground">
                        {fmtTokens(r.total)}
                      </Td>
                      <Td>
                        <div className="flex items-center justify-end gap-1.5">
                          <span className="tabular-nums">{(share * 100).toFixed(share >= 0.1 ? 0 : 1)}%</span>
                          <span className="h-1 w-8 overflow-hidden rounded-full bg-white/[0.06]">
                            <span
                              className="block h-full rounded-full bg-primary/70"
                              style={{ width: `${Math.max(2, share * 100)}%` }}
                            />
                          </span>
                        </div>
                      </Td>
                      <Td
                        className="font-medium text-foreground"
                        title={r.cost == null ? t('usage.noPricing') : undefined}
                      >
                        {r.cost == null ? t('common.dash') : `~${fmtCost(r.cost)}`}
                      </Td>
                    </tr>
                  )
                })}
              </tbody>
              <tfoot>
                <tr className="border-t border-border bg-white/[0.03] font-medium text-foreground">
                  <Td className="text-left">
                    <span className="flex items-center gap-1.5 text-foreground">
                      <Coins className="size-3.5 text-primary/80" /> {t('usage.totalRow')}
                    </span>
                    <span className="block text-[10px] font-normal text-muted-foreground">
                      {rows.length} {t('usage.cardModels').toLowerCase()}
                    </span>
                  </Td>
                  <Td>{fmtTokens(totals.input)}</Td>
                  <Td>{fmtTokens(totals.output)}</Td>
                  <Td>{fmtTokens(totals.cacheCreate)}</Td>
                  <Td>{fmtTokens(totals.cacheRead)}</Td>
                  <Td>{fmtTokens(totals.total)}</Td>
                  <Td>100%</Td>
                  <Td className="text-primary">{totalCostLabel}</Td>
                </tr>
              </tfoot>
            </table>
          </div>
          <p className="text-[11px] text-muted-foreground/80">{t('usage.note')}</p>
        </>
      )}
    </section>
  )
}

function Card({
  label,
  value,
  sub,
  title,
  accent,
}: {
  label: string
  value: string
  sub?: string
  title?: string
  accent?: boolean
}) {
  return (
    <div className="rounded-lg border border-border bg-white/[0.02] px-3 py-2.5" title={title}>
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className={cn('mt-0.5 text-lg font-semibold tabular-nums', accent ? 'text-primary' : 'text-foreground')}>
        {value}
      </div>
      {sub && <div className="mt-0.5 text-[10px] text-muted-foreground/70">{sub}</div>}
    </div>
  )
}

const Th = ({ children, className }: { children: React.ReactNode; className?: string }) => (
  <th className={cn('px-3 py-2 text-right text-[11px] font-medium uppercase tracking-wide', className)}>{children}</th>
)
const Td = ({ children, className, title }: { children: React.ReactNode; className?: string; title?: string }) => (
  <td title={title} className={cn('px-3 py-2 text-right tabular-nums text-muted-foreground', className)}>
    {children}
  </td>
)
