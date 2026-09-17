import { useMemo, type ReactNode } from 'react'
import { BarChart3, Coins, RefreshCw } from 'lucide-react'
import { cn } from '@maestrly/ui'
import { useChatUi } from '../provider'

/**
 * The usage table both applications render. Everything is handed in: rows already priced by
 * the caller (each application owns its ledger and its catalogue), the selected period and the
 * copy. The component only lays them out, so what the desktop shows for its local ledger and
 * what the Bot shows for a Host's ledger is the same table.
 */
export type UsagePeriod = 'today' | '7d' | '30d' | '90d' | 'custom'
export const DAY_MS = 86_400_000

export interface UsagePanelRow {
  /** Stable identity of the row (source + provider + model in the desktop, model alone in the Bot). */
  key: string
  modelId: string
  /** Shown under the model name: provider, turns… already formatted by the caller. */
  sub?: string
  turns: number
  input: number
  output: number
  cacheRead: number
  cacheCreate: number
  /** Estimated cost in USD, or null when the catalogue cannot price the model. */
  cost: number | null
}

export const fmtTokens = (n: number): string =>
  n >= 1e9
    ? `${(n / 1e9).toFixed(1)}B`
    : n >= 1e6
      ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`
      : n >= 1e3
        ? `${(n / 1e3).toFixed(n >= 1e5 ? 0 : 1)}k`
        : String(Math.round(n))
export const fmtNum = (n: number): string => n.toLocaleString()
export const fmtCost = (c: number): string =>
  c >= 1 ? `$${c.toFixed(2)}` : c >= 0.01 ? `$${c.toFixed(3)}` : c > 0 ? `$${c.toFixed(4)}` : '$0'
export const isoDay = (ms: number): string => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** The window a period selects, in epoch milliseconds; `custom` reads the two day strings. */
export function usagePeriodRange(
  period: UsagePeriod,
  custom: { from: string; to: string },
  maxWindowDays: number,
  now = Date.now()
): { since?: number; until?: number } {
  switch (period) {
    case 'today': {
      const d = new Date(now)
      d.setHours(0, 0, 0, 0)
      return { since: d.getTime() }
    }
    case '7d':
      return { since: now - 7 * DAY_MS }
    case '30d':
      return { since: now - 30 * DAY_MS }
    case '90d':
      return { since: now - maxWindowDays * DAY_MS }
    case 'custom':
      return {
        since: custom.from ? new Date(`${custom.from}T00:00:00`).getTime() : undefined,
        until: custom.to ? new Date(`${custom.to}T23:59:59.999`).getTime() : undefined,
      }
    default:
      return {}
  }
}

export interface UsagePanelProps {
  rows: UsagePanelRow[]
  /** Turns in the window, from the ledger itself (a row count would miss turns without a model). */
  turns: number
  firstAt?: number | null
  lastAt?: number | null
  loading: boolean
  period: UsagePeriod
  onPeriodChange: (period: UsagePeriod) => void
  custom: { from: string; to: string }
  onCustomChange: (custom: { from: string; to: string }) => void
  /** Earliest day a custom range may start (the ledger window). */
  minCustomDay: string
  onRefresh: () => void
  /** Optional heading override; the default is the shared usage title and description. */
  heading?: ReactNode
}

export function UsagePanel({ rows, turns, firstAt, lastAt, loading, period, onPeriodChange, custom, onCustomChange, minCustomDay, onRefresh, heading }: UsagePanelProps) {
  const { labels, locale } = useChatUi()
  const u = labels.usage
  const totals = useMemo(() => {
    const total = (row: UsagePanelRow) => row.input + row.output + row.cacheRead + row.cacheCreate
    return {
      input: rows.reduce((a, r) => a + r.input, 0),
      output: rows.reduce((a, r) => a + r.output, 0),
      cacheRead: rows.reduce((a, r) => a + r.cacheRead, 0),
      cacheCreate: rows.reduce((a, r) => a + r.cacheCreate, 0),
      total: rows.reduce((a, r) => a + total(r), 0),
      cost: rows.reduce((a, r) => a + (r.cost ?? 0), 0),
      hasCost: rows.some((r) => r.cost != null),
      unpriced: rows.filter((r) => r.cost == null && total(r) > 0).length,
      of: total,
    }
  }, [rows])
  const fmtDate = (ms: number) => new Date(ms).toLocaleDateString(locale, { day: 'numeric', month: 'short' })
  const periods: { id: UsagePeriod; label: string }[] = [
    { id: 'today', label: u.periodToday },
    { id: '7d', label: u.period7d },
    { id: '30d', label: u.period30d },
    { id: '90d', label: u.period90d },
    { id: 'custom', label: u.periodCustom },
  ]
  const totalCostLabel = totals.hasCost ? `~${fmtCost(totals.cost)}${totals.unpriced > 0 ? ` ${u.unpriced(totals.unpriced)}` : ''}` : u.dash

  return (
    <section className="flex flex-col gap-4" data-usage-panel>
      <div className="flex flex-wrap items-start justify-between gap-2">
        {heading ?? (
          <div>
            <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <BarChart3 className="size-4" /> {u.title}
            </h2>
            <p className="mt-0.5 text-[12px] text-muted-foreground">{u.description}</p>
          </div>
        )}
        <div className="flex items-center gap-2">
          <div className="inline-flex overflow-hidden rounded-md border border-border" role="group" aria-label={u.period}>
            {periods.map((p) => (
              <button
                key={p.id}
                type="button"
                aria-pressed={period === p.id}
                onClick={() => onPeriodChange(p.id)}
                className={cn('px-2 py-1 text-[11px] transition-colors', period === p.id ? 'bg-primary/20 font-medium text-foreground' : 'text-muted-foreground hover:bg-white/5')}
              >
                {p.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={onRefresh}
            title={u.refresh}
            aria-label={u.refresh}
            className="flex shrink-0 items-center gap-1.5 rounded-md border border-border px-2 py-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground"
          >
            <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
          </button>
        </div>
      </div>

      {period === 'custom' && (
        <div className="flex flex-wrap items-center gap-2 text-[12px] text-muted-foreground">
          <label className="flex items-center gap-1.5">
            {u.from}
            <input
              type="date"
              value={custom.from}
              min={minCustomDay}
              max={custom.to || undefined}
              onChange={(e) => onCustomChange({ ...custom, from: e.target.value })}
              className="rounded-md border border-border bg-black/20 px-2 py-1 text-foreground outline-none focus:border-primary/60"
            />
          </label>
          <label className="flex items-center gap-1.5">
            {u.to}
            <input
              type="date"
              value={custom.to}
              min={custom.from || minCustomDay}
              onChange={(e) => onCustomChange({ ...custom, to: e.target.value })}
              className="rounded-md border border-border bg-black/20 px-2 py-1 text-foreground outline-none focus:border-primary/60"
            />
          </label>
        </div>
      )}

      {rows.length === 0 ? (
        <div className="rounded-lg border border-border bg-white/[0.02] px-4 py-8 text-center text-[13px] text-muted-foreground" role="status">
          {loading ? u.loading : u.empty}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Card label={u.cardTotalTokens} value={fmtTokens(totals.total)} title={fmtNum(totals.total)} />
            <Card label={u.cardTotalCost} value={totalCostLabel} accent />
            <Card label={u.cardTurns} value={fmtNum(turns)} />
            <Card label={u.cardModels} value={String(rows.length)} sub={firstAt && lastAt ? `${fmtDate(firstAt)} – ${fmtDate(lastAt)}` : undefined} />
          </div>

          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full border-collapse text-[12px]">
              <thead>
                <tr className="border-b border-border bg-white/[0.02] text-muted-foreground">
                  <Th className="text-left">{u.colModel}</Th>
                  <Th>{u.colInput}</Th>
                  <Th>{u.colOutput}</Th>
                  <Th>{u.colCacheCreate}</Th>
                  <Th>{u.colCacheRead}</Th>
                  <Th>{u.colTotal}</Th>
                  <Th>{u.colShare}</Th>
                  <Th>{u.colCost}</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const total = totals.of(r)
                  const share = totals.total > 0 ? total / totals.total : 0
                  return (
                    <tr key={r.key} className="border-b border-border/50 last:border-0 hover:bg-white/[0.015]" data-usage-row={r.modelId}>
                      <Td className="text-left">
                        <span className="font-mono text-[12px] text-foreground">{r.modelId}</span>
                        {r.sub && <span className="block text-[10px] text-muted-foreground">{r.sub}</span>}
                      </Td>
                      <Td title={fmtNum(r.input)}>{fmtTokens(r.input)}</Td>
                      <Td title={fmtNum(r.output)}>{fmtTokens(r.output)}</Td>
                      <Td title={fmtNum(r.cacheCreate)} className={r.cacheCreate ? '' : 'text-muted-foreground/40'}>
                        {fmtTokens(r.cacheCreate)}
                      </Td>
                      <Td title={fmtNum(r.cacheRead)} className={r.cacheRead ? '' : 'text-muted-foreground/40'}>
                        {fmtTokens(r.cacheRead)}
                      </Td>
                      <Td title={fmtNum(total)} className="font-medium text-foreground">
                        {fmtTokens(total)}
                      </Td>
                      <Td>
                        <div className="flex items-center justify-end gap-1.5">
                          <span className="tabular-nums">{(share * 100).toFixed(share >= 0.1 ? 0 : 1)}%</span>
                          <span className="h-1 w-8 overflow-hidden rounded-full bg-white/[0.06]">
                            <span className="block h-full rounded-full bg-primary/70" style={{ width: `${Math.max(2, share * 100)}%` }} />
                          </span>
                        </div>
                      </Td>
                      <Td className="font-medium text-foreground" title={r.cost == null ? u.noPricing : undefined}>
                        {r.cost == null ? u.dash : `~${fmtCost(r.cost)}`}
                      </Td>
                    </tr>
                  )
                })}
              </tbody>
              <tfoot>
                <tr className="border-t border-border bg-white/[0.03] font-medium text-foreground">
                  <Td className="text-left">
                    <span className="flex items-center gap-1.5 text-foreground">
                      <Coins className="size-3.5 text-primary/80" /> {u.totalRow}
                    </span>
                    <span className="block text-[10px] font-normal text-muted-foreground">
                      {rows.length} {u.cardModels.toLowerCase()}
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
          <p className="text-[11px] text-muted-foreground/80">{u.note}</p>
        </>
      )}
    </section>
  )
}

function Card({ label, value, sub, title, accent }: { label: string; value: string; sub?: string; title?: string; accent?: boolean }) {
  return (
    <div className="rounded-lg border border-border bg-white/[0.02] px-3 py-2.5" title={title}>
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className={cn('mt-0.5 text-lg font-semibold tabular-nums', accent ? 'text-primary' : 'text-foreground')}>{value}</div>
      {sub && <div className="mt-0.5 text-[10px] text-muted-foreground/70">{sub}</div>}
    </div>
  )
}

const Th = ({ children, className }: { children: ReactNode; className?: string }) => (
  <th className={cn('px-3 py-2 text-right text-[11px] font-medium uppercase tracking-wide', className)}>{children}</th>
)
const Td = ({ children, className, title }: { children: ReactNode; className?: string; title?: string }) => (
  <td title={title} className={cn('px-3 py-2 text-right tabular-nums text-muted-foreground', className)}>
    {children}
  </td>
)
