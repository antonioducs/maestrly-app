import type { ReactNode } from 'react'
import { Lock } from 'lucide-react'
import { cn } from '@maestrly/ui'
import { useChatUi } from '../provider'
import { contextOccupancy, formatCost, formatTokens, type ChatModelMeta, type ContextUsage } from '../usage/cost'

/**
 * The context/cost pill. Everything is computed from what the caller hands in: the occupancy of
 * the window (from the last usage), the window itself (from the runtime or the catalogue) and an
 * already-summed cost, so neither application has to agree on where those numbers come from.
 */
export function ChatContextMeter({
  usage,
  meta,
  limitOverride,
  cost,
  estimated = false,
  onClick,
  title,
  children,
}: {
  usage: ContextUsage | null
  meta: ChatModelMeta | null
  /** A manual cap below the real window; shown with a lock. */
  limitOverride?: number | null
  /** Accumulated cost in USD, when the caller could price the conversation. */
  cost?: number | null
  /** Whether the occupancy is an estimate rather than a runtime figure. */
  estimated?: boolean
  onClick?: () => void
  title?: string
  children?: ReactNode
}) {
  const { labels } = useChatUi()
  const used = usage ? contextOccupancy(usage) : 0
  if (used === 0) return null
  const win = meta?.contextWindow ?? null
  const pct = win ? used / win : null
  const limited = limitOverride != null && win != null && limitOverride < win
  const tip =
    title ??
    `${labels.context.title}: ${win ? labels.context.used(formatTokens(used), formatTokens(win)) : `${formatTokens(used)} · ${labels.context.unknownWindow}`}${
      cost != null && cost > 0 ? `\n${labels.context.cost(formatCost(cost))}` : ''
    }`
  return (
    <div className="relative">
      <button
        type="button"
        onClick={onClick}
        disabled={!onClick}
        title={tip}
        data-context-meter
        className={cn(
          'inline-flex items-center gap-1 rounded px-1 text-[11px]',
          onClick && 'cursor-pointer hover:bg-white/[0.06]',
          limited && 'text-indigo-400',
          !limited && (pct != null && pct >= 0.9 ? 'text-red-400' : pct != null && pct >= 0.75 ? 'text-amber-400' : 'text-muted-foreground')
        )}
      >
        {limited && <Lock className="h-2.5 w-2.5 shrink-0" />}
        <span>
          {estimated ? '~' : ''}
          {formatTokens(used)}
          {win ? `/${formatTokens(win)}` : ''}
          {pct != null ? ` ${Math.round(pct * 100)}%` : ' tok'}
          {cost != null && cost > 0 ? ` · ~${formatCost(cost)}` : ''}
        </span>
      </button>
      {children}
    </div>
  )
}
