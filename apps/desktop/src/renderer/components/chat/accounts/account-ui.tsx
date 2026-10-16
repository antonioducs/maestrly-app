import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronLeft, Globe } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ChatSubscriptionProviderKind, ChatSubscriptionUsage } from '../../../../shared/chat'
import { subscriptionUsageTone } from '../subscription-usage-presentation'
import type { AccountHealth } from './account-entries'
import { ProviderGlyph } from './ProviderGlyph'
import { apiProviderGlyph, type ProviderGlyphId, subscriptionGlyph } from './provider-glyphs'

export const inputCls =
  'rounded-md border border-border bg-black/20 px-2.5 py-1.5 text-[13px] text-foreground outline-none placeholder:text-muted-foreground focus:border-indigo-500/60'

export const secondaryButtonCls =
  'inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-[12px] text-foreground hover:bg-white/5 disabled:opacity-50'

export const primaryButtonCls =
  'inline-flex items-center gap-1.5 rounded-md bg-indigo-500 px-2.5 py-1.5 text-[12px] font-medium text-white hover:bg-indigo-400 disabled:opacity-50'

export const iconButtonCls =
  'rounded-md border border-border p-1.5 text-muted-foreground hover:bg-white/5 hover:text-foreground disabled:opacity-50'

export const linkButtonCls =
  'inline-flex items-center gap-1 text-[11px] text-indigo-300 hover:text-indigo-200 disabled:text-muted-foreground disabled:opacity-60'

/** An API key provider is recognized by its base URL; one the app does not know shows its initials. */
export type ProviderMarkKind = ChatSubscriptionProviderKind | 'chatgpt-web' | { apiName: string; baseURL?: string }

function glyphFor(kind: ProviderMarkKind): ProviderGlyphId | null {
  if (typeof kind === 'object') return kind.baseURL ? apiProviderGlyph(kind.baseURL) : null
  // ChatGPT Web is ChatGPT itself; the globe badge tells it apart from the ChatGPT subscription.
  if (kind === 'chatgpt-web') return 'openai'
  return subscriptionGlyph(kind)
}

function initials(name: string): string {
  const letters = name.replace(/[^\p{L}\p{N}]/gu, '')
  return (letters.slice(0, 2) || '?').replace(/^./, (c) => c.toUpperCase())
}

const DOT_CLASS: Record<AccountHealth | 'limit', string> = {
  ok: 'bg-emerald-400',
  pending: 'bg-amber-400',
  attention: 'bg-amber-400',
  error: 'bg-rose-400',
  limit: 'bg-rose-400',
  idle: 'bg-zinc-500',
}

export function ProviderMark({
  kind,
  dot,
  size = 'md',
}: {
  kind: ProviderMarkKind
  dot?: AccountHealth | 'limit'
  size?: 'sm' | 'md' | 'lg'
}) {
  const glyph = glyphFor(kind)
  return (
    <span
      aria-hidden="true"
      className={cn(
        'relative grid shrink-0 place-items-center bg-white/[0.07] font-semibold leading-none text-foreground ring-1 ring-inset ring-white/[0.08]',
        size === 'sm' && 'size-5 rounded-full text-[8px]',
        size === 'md' && 'size-7 rounded-lg text-[11px]',
        size === 'lg' && 'size-10 rounded-xl text-[15px]'
      )}
    >
      {glyph ? (
        <ProviderGlyph
          glyph={glyph}
          className={cn(size === 'sm' && 'size-3', size === 'md' && 'size-4', size === 'lg' && 'size-[22px]')}
        />
      ) : (
        initials(typeof kind === 'object' ? kind.apiName : kind)
      )}
      {kind === 'chatgpt-web' && size !== 'sm' && (
        <span
          className={cn(
            'absolute -right-1 -top-1 grid place-items-center rounded-full bg-popover text-muted-foreground ring-1 ring-border',
            size === 'lg' ? 'size-4' : 'size-3.5'
          )}
        >
          <Globe className={size === 'lg' ? 'size-3' : 'size-2.5'} />
        </span>
      )}
      {dot && (
        <span
          className={cn('absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full ring-2 ring-popover', DOT_CLASS[dot])}
        />
      )}
    </span>
  )
}

export function toneTextClass(percent: number): string {
  const tone = subscriptionUsageTone(percent)
  return tone === 'critical' ? 'text-rose-300' : tone === 'high' ? 'text-amber-300' : 'text-emerald-300'
}

function toneBarClass(percent: number): string {
  const tone = subscriptionUsageTone(percent)
  return tone === 'critical' ? 'bg-rose-400' : tone === 'high' ? 'bg-amber-400' : 'bg-emerald-400'
}

/** One thin bar per usage window plus the tightest percentage, for a row in the account list. */
export function UsageGauge({ usage }: { usage: ChatSubscriptionUsage | null | undefined }) {
  if (usage?.state !== 'ready' || usage.windows.length === 0) return null
  const peak = Math.max(...usage.windows.map((window) => window.usedPercent))
  return (
    <span className="grid w-14 justify-items-end gap-[3px]" aria-hidden="true">
      {usage.windows.slice(0, 3).map((window) => (
        <span key={window.id} className="block h-[3px] w-full overflow-hidden rounded-full bg-white/10">
          <span
            className={cn('block h-full rounded-full', toneBarClass(window.usedPercent))}
            style={{ width: `${Math.min(100, Math.max(2, window.usedPercent))}%` }}
          />
        </span>
      ))}
      <span className={cn('font-mono text-[10px] tabular-nums', toneTextClass(peak))}>{Math.round(peak)}%</span>
    </span>
  )
}

export function DetailSection({
  title,
  hint,
  action,
  children,
}: {
  title?: ReactNode
  hint?: ReactNode
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="mt-4 border-t border-border/70 pt-4">
      {(title || hint || action) && (
        <div className="mb-2.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          {title && <h4 className="text-[12px] font-medium text-foreground">{title}</h4>}
          {hint && <span className="text-[11px] text-muted-foreground">{hint}</span>}
          {action}
        </div>
      )}
      {children}
    </section>
  )
}

export function Switch({
  checked,
  onChange,
  disabled,
  label,
  labelledBy,
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
  label?: string
  labelledBy?: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-labelledby={labelledBy}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'h-4 w-7 shrink-0 rounded-full p-0.5 transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        checked ? 'bg-emerald-500/70' : 'bg-white/10'
      )}
    >
      <span className={cn('block h-3 w-3 rounded-full bg-white transition-transform', checked && 'translate-x-3')} />
    </button>
  )
}

/** Returns to the list when the panel is too narrow to show both columns. */
export function DetailBackButton({ onBack }: { onBack: () => void }) {
  const { t } = useTranslation('chat')
  return (
    <button
      type="button"
      onClick={onBack}
      className="mb-3 inline-flex items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground @2xl:hidden"
    >
      <ChevronLeft className="size-3.5" /> {t('settings.accountsBack')}
    </button>
  )
}

export function DetailHeader({
  mark,
  title,
  status,
  subtitle,
  actions,
}: {
  mark: ReactNode
  title: ReactNode
  status?: ReactNode
  subtitle?: ReactNode
  actions?: ReactNode
}) {
  return (
    <div className="flex flex-wrap items-start gap-3">
      {mark}
      <div className="min-w-[11rem] flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <h3 className="min-w-0 truncate text-[15px] font-semibold text-foreground">{title}</h3>
          {status}
        </div>
        {subtitle && <p className="mt-0.5 text-[12px] text-muted-foreground">{subtitle}</p>}
      </div>
      {actions && <div className="ml-auto flex shrink-0 items-center gap-1.5">{actions}</div>}
    </div>
  )
}
