import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Lock } from 'lucide-react'
import { cn } from '@/lib/utils'
import { contextOccupancy, estimatedCostOfUsage, usageMetaForModel } from '../../../shared/chat'
import type { ChatHistoryStats, ChatModelMeta } from '../../../shared/chat'

const fmt = (n: number): string =>
  n >= 1e6
    ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`
    : n >= 1000
      ? `${(n / 1000).toFixed(n >= 1e5 ? 0 : 1)}k`
      : String(n)

const fmtCost = (c: number): string =>
  c >= 1 ? `$${c.toFixed(2)}` : c >= 0.01 ? `$${c.toFixed(3)}` : `$${c.toFixed(4)}`

function parseLimit(raw: string): number | null {
  const s = raw.trim().toLowerCase().replace(/\s+/g, '')
  if (!s) return null
  const m = /^(\d+(?:[.,]\d+)?)\s*([km])?$/.exec(s)
  if (!m) return null
  const base = parseFloat(m[1].replace(',', '.'))
  if (!Number.isFinite(base) || base <= 0) return null
  const mult = m[2] === 'm' ? 1e6 : m[2] === 'k' ? 1e3 : 1
  return Math.round(base * mult)
}

interface LimitInfo {
  limit: number | null
  providerWindow: number | null
  catalogWindow: number | null
  effective: number | null
}

export function ChatContextMeter({
  stats: history,
  meta,
  metaByModel,
  providerId,
  modelId,
  onLimitChange,
}: {
  stats: ChatHistoryStats | null
  meta: ChatModelMeta | null

  metaByModel?: Record<string, ChatModelMeta | null>

  providerId?: string | null
  modelId?: string | null

  onLimitChange?: () => void
}) {
  const { t } = useTranslation('chat')
  const stats = useMemo(() => {
    const lu = history?.lastUsage

    const used = history?.contextProjection?.usedTokens ?? (lu ? contextOccupancy(lu) : 0)
    let totalIn = 0
    let totalOut = 0
    let totalCached = 0
    let cost = 0
    let costAvailable = true
    let hasRuntimeCost = false
    for (const pm of history?.perModel ?? []) {
      totalIn += pm.input + pm.subInput + pm.cachedInput + pm.subCachedInput + pm.cacheCreate + pm.subCacheCreate
      totalOut += pm.output + pm.subOutput
      totalCached += pm.cachedInput + pm.subCachedInput + pm.cacheCreate + pm.subCacheCreate

      const mm = usageMetaForModel(metaByModel, pm, { providerId, modelId, meta })
      const modelCost = estimatedCostOfUsage(
        {
          input: pm.input + pm.subInput,
          output: pm.output + pm.subOutput,
          cacheRead: pm.cachedInput + pm.subCachedInput,
          cacheCreate: pm.cacheCreate + pm.subCacheCreate,
        },
        mm,
        pm.runtimeEstimatedCostUsd,
        {
          input: pm.catalogInput ?? 0,
          output: pm.catalogOutput ?? 0,
          cacheRead: pm.catalogCacheRead ?? 0,
          cacheCreate: pm.catalogCacheCreate ?? 0,
        }
      )
      if (modelCost == null) costAvailable = false
      else cost += modelCost
      if (pm.runtimeEstimatedCostUsd != null) hasRuntimeCost = true
    }
    return { used, totalIn, totalOut, totalCached, cost, costAvailable, hasRuntimeCost }
  }, [history, meta, metaByModel, modelId, providerId])

  // Manual context-limit popover.
  const [open, setOpen] = useState(false)
  const [info, setInfo] = useState<LimitInfo | null>(null)
  const [draft, setDraft] = useState('')
  const limitRequestRef = useRef(0)
  const ref = useRef<HTMLDivElement>(null)
  const canLimit = !!(providerId && modelId && meta?.contextLimitEditable !== false)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  // Load the current limit and raw ceilings when opening.
  useEffect(() => {
    if (!open || !canLimit) return
    let alive = true
    const requestId = ++limitRequestRef.current
    window.api.chatContextLimitGet(providerId as string, modelId as string).then((r) => {
      if (!alive || requestId !== limitRequestRef.current) return
      setInfo(r)
      setDraft(r.limit != null ? String(r.limit) : '')
    })
    return () => {
      alive = false
    }
  }, [open, canLimit, providerId, modelId])

  const ceiling = info ? (info.providerWindow ?? info.catalogWindow) : null
  const parsedDraft = parseLimit(draft)
  const willClamp = parsedDraft != null && ceiling != null && parsedDraft > ceiling

  const save = async (value: number | null) => {
    if (!canLimit) return
    const provider = providerId as string
    const model = modelId as string
    const requestId = ++limitRequestRef.current
    try {
      const result = await window.api.chatContextLimitSet(provider, model, value)
      if (!result.ok || requestId !== limitRequestRef.current) return
      const nextInfo = await window.api.chatContextLimitGet(provider, model)
      if (requestId !== limitRequestRef.current) return
      setInfo(nextInfo)
      setDraft(nextInfo.limit != null ? String(nextInfo.limit) : '')
      setOpen(false)
      onLimitChange?.()
    } catch {
      // Keep the popover open when persisting or re-reading the authoritative value fails.
    }
  }

  if (stats.used === 0) return null

  const runtimeWindow = history?.contextProjection?.modelContextWindow
  const win = runtimeWindow ?? meta?.contextWindow
  const pct = win ? stats.used / win : null

  const hasPricing = stats.costAvailable && stats.cost > 0

  const noCacheReported = hasPricing && stats.totalCached === 0

  const activeLimit = info?.limit != null && ceiling != null && info.limit < ceiling ? info.limit : null
  const tip =
    t('meter.contextTip', { used: fmt(stats.used) }) +
    (history?.contextProjection?.quality === 'estimated' ? t('meter.contextEstimatedSuffix') : '') +
    (win ? t('meter.contextWindowSuffix', { win: fmt(win), pct: Math.round((pct ?? 0) * 100) }) : '') +
    (activeLimit != null ? t('meter.limitBadge', { limit: fmt(activeLimit), ceiling: fmt(ceiling as number) }) : '') +
    (hasPricing
      ? t('meter.costTip', { cost: fmtCost(stats.cost), in: fmt(stats.totalIn), out: fmt(stats.totalOut) }) +
        (stats.hasRuntimeCost ? t('meter.runtimeCostEstimateNote') : '') +
        (noCacheReported ? t('meter.costNoCacheNote') : '')
      : '')

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => canLimit && setOpen((o) => !o)}
        title={canLimit ? tip + '\n\n' + t('meter.limitButtonTitle') : tip}
        disabled={!canLimit}
        className={cn(
          'inline-flex items-center gap-1 rounded px-1 text-[11px]',
          canLimit && 'cursor-pointer hover:bg-white/[0.06]',
          activeLimit != null && 'text-indigo-400',
          activeLimit == null &&
            (pct != null && pct >= 0.9
              ? 'text-red-400'
              : pct != null && pct >= 0.75
                ? 'text-amber-400'
                : 'text-muted-foreground')
        )}
      >
        {activeLimit != null && <Lock className="h-2.5 w-2.5 shrink-0" />}
        <span>
          {history?.contextProjection?.quality === 'estimated' ? '~' : ''}
          {fmt(stats.used)}
          {win ? `/${fmt(win)}` : ''}
          {pct != null ? ` ${Math.round(pct * 100)}%` : ' tok'}
          {hasPricing ? ` · ~${fmtCost(stats.cost)}` : ''}
        </span>
      </button>

      {open && canLimit && (
        <div className="absolute bottom-full right-0 z-50 mb-1 w-72 rounded-lg border border-white/[0.1] bg-[#161618] p-3 shadow-2xl">
          <div className="text-[13px] font-medium text-foreground">{t('meter.limitTitle')}</div>
          <div className="mt-0.5 text-[11px] text-muted-foreground">{t('meter.limitDesc')}</div>
          <div className="mt-1 text-[11px] text-muted-foreground">
            {info?.providerWindow != null
              ? t('meter.limitCeilingProvider', { ceiling: fmt(info.providerWindow) })
              : info?.catalogWindow != null
                ? t('meter.limitCeiling', { ceiling: fmt(info.catalogWindow) })
                : t('meter.limitCeilingUnknown')}
          </div>
          <input
            type="text"
            inputMode="numeric"
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') save(parsedDraft)
              else if (e.key === 'Escape') setOpen(false)
            }}
            placeholder={t('meter.limitPlaceholder')}
            className="mt-2 w-full rounded-md border border-white/[0.1] bg-black/20 px-2 py-1 text-[13px] text-foreground outline-none focus:border-indigo-500/60"
          />
          <div className="mt-1 min-h-[14px] text-[10px] text-muted-foreground">
            {willClamp ? (
              <span className="text-amber-400">{t('meter.limitClampNote', { ceiling: fmt(ceiling as number) })}</span>
            ) : (
              t('meter.limitHint')
            )}
          </div>
          <div className="mt-2 flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => save(null)}
              className="rounded-md px-2 py-1 text-[12px] text-muted-foreground hover:bg-white/[0.05] hover:text-foreground"
            >
              {t('meter.limitClear')}
            </button>
            <button
              type="button"
              onClick={() => save(parsedDraft)}
              className="rounded-md bg-indigo-500 px-3 py-1 text-[12px] font-medium text-white hover:bg-indigo-400"
            >
              {t('meter.limitSave')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
