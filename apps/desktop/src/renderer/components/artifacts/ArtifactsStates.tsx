import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  AlertTriangle,
  ArrowRight,
  ArrowUpCircle,
  BarChart3,
  FileText,
  LayoutTemplate,
  Loader2,
  Plug,
  Power,
  RotateCw,
  Server,
  Wrench,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { UnavailableReason } from './artifacts-view'

/** Three version sheets fanned out: the same stack the cards use, with nothing published on top yet. */
function StackIllustration({ tags, muted, mark }: { tags?: boolean; muted?: boolean; mark?: ReactNode }) {
  return (
    <div className="artifact-illustration relative mt-[30px] h-[158px] w-[248px]" aria-hidden="true">
      <div className={cn('artifact-illustration-sheet is-back2', muted && 'is-muted')}>
        {tags && <span className="artifact-illustration-tag">v1</span>}
      </div>
      <div className={cn('artifact-illustration-sheet is-back1', muted && 'is-muted')}>
        {tags && <span className="artifact-illustration-tag">v2</span>}
      </div>
      <div className="artifact-illustration-sheet is-front">
        {tags && <span className="artifact-illustration-tag">v3</span>}
        <div className="artifact-page-chrome">
          <i />
          <i />
          <i />
        </div>
        <div className="artifact-page-lines">
          <i />
          <i />
          <i />
          <i />
        </div>
        {mark}
      </div>
    </div>
  )
}

function Mark({ tone, children }: { tone: 'plain' | 'warn' | 'bad'; children: ReactNode }) {
  return (
    <span
      className={cn(
        'absolute bottom-3.5 right-4 grid size-[30px] place-items-center rounded-full text-primary-foreground [&_svg]:size-[15px]',
        tone === 'plain' && 'bg-primary',
        tone === 'warn' && 'bg-artifact-warn',
        tone === 'bad' && 'bg-destructive'
      )}
    >
      {children}
    </span>
  )
}

export function LoadingGrid() {
  const { t } = useTranslation('ui')
  const widths = [
    [64, 88],
    [72, 76],
    [50, 92],
    [80, 70],
    [58, 84],
    [68, 90],
  ]
  return (
    <ul className="artifact-grid" aria-busy="true" aria-label={t('artifacts.loading')} data-testid="artifacts-loading">
      {widths.map(([title, meta], index) => (
        <li key={index} className="flex flex-col pt-4">
          <div className="artifact-shimmer aspect-[16/10] rounded-[10px] border border-border" />
          <div className="artifact-shimmer mt-2.5 h-2.5 rounded" style={{ width: `${title}%` }} />
          <div className="artifact-shimmer mt-2.5 h-2.5 rounded" style={{ width: `${meta}%` }} />
        </li>
      ))}
    </ul>
  )
}

export const SUGGESTIONS = [
  { key: 'prototype', icon: LayoutTemplate },
  { key: 'report', icon: FileText },
  { key: 'dashboard', icon: BarChart3 },
] as const

export type SuggestionKey = (typeof SUGGESTIONS)[number]['key']

export function EmptyState({
  pending,
  onSuggest,
}: {
  pending: SuggestionKey | null
  onSuggest: (key: SuggestionKey) => void
}) {
  const { t } = useTranslation('ui')
  return (
    <div className="artifact-state is-entering" data-testid="artifacts-empty">
      <StackIllustration tags />
      <h2 className="mb-2 mt-[26px] text-[19px] font-semibold tracking-tight text-foreground">
        {t('artifacts.empty.title')}
      </h2>
      <p className="text-[13.5px] text-muted-foreground">{t('artifacts.empty.text')}</p>
      <div className="mt-[26px] w-full text-left">
        <p className="mb-2 text-xs text-muted-foreground">{t('artifacts.empty.suggestLabel')}</p>
        <ul className="grid gap-1.5">
          {SUGGESTIONS.map(({ key, icon: Icon }) => {
            const busy = pending === key
            return (
              <li key={key}>
                <button
                  type="button"
                  data-testid="artifact-suggestion"
                  disabled={pending !== null && !busy}
                  aria-disabled={busy || undefined}
                  onClick={() => !busy && onSuggest(key)}
                  className={cn(
                    'group flex w-full items-center gap-2.5 rounded-[10px] border border-border-strong bg-black/[0.18] px-3 py-2.5 text-left transition-colors hover:border-primary/30 hover:bg-black/30 disabled:cursor-not-allowed disabled:opacity-45',
                    busy && 'cursor-progress border-primary/30'
                  )}
                >
                  <span className="grid size-7 shrink-0 place-items-center rounded-[7px] bg-primary/[0.08] text-foreground/75">
                    <Icon className="size-3.5" aria-hidden="true" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <b className="block text-[13px] font-medium text-foreground">
                      {t(`artifacts.empty.suggestions.${key}.title`)}
                    </b>
                    <span className="text-xs text-muted-foreground">
                      {busy ? t('artifacts.empty.opening') : t(`artifacts.empty.suggestions.${key}.detail`)}
                    </span>
                  </span>
                  <span className="text-muted-foreground group-hover:text-foreground">
                    {busy ? (
                      <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                    ) : (
                      <ArrowRight className="size-4" aria-hidden="true" />
                    )}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      </div>
      <p className="mt-3.5 flex w-full items-start gap-2.5 rounded-[10px] bg-white/[0.03] px-3 py-2.5 text-left text-[12.5px] text-muted-foreground">
        <Wrench className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
        <span>{t('artifacts.empty.hint')}</span>
      </p>
    </div>
  )
}

/** Why the list cannot show, from the bot server's state, with the way out of it. Nothing is ever deleted here. */
export function UnavailableState({
  reason,
  busy,
  onEnable,
  onRetry,
  onOpenSettings,
}: {
  reason: UnavailableReason
  busy: boolean
  onEnable: () => void
  onRetry: () => void
  onOpenSettings: () => void
}) {
  const { t } = useTranslation('ui')
  const view = {
    absent: { icon: <Server />, tone: 'plain' as const },
    unsupported: { icon: <ArrowUpCircle />, tone: 'warn' as const },
    unreachable: { icon: <Plug />, tone: 'bad' as const },
    off: { icon: <Power />, tone: 'plain' as const },
    problem: { icon: <AlertTriangle />, tone: 'bad' as const },
  }[reason]
  const spinner = busy ? <Loader2 className="size-3.5 animate-spin" /> : null
  const settings = (primary: boolean, label = t('artifacts.unavailable.settings')) => (
    <Button variant={primary ? 'default' : 'ghost'} onClick={onOpenSettings}>
      {label}
    </Button>
  )
  return (
    <div className="artifact-state is-entering" role="alert" data-testid="artifacts-unavailable" data-reason={reason}>
      <StackIllustration muted mark={<Mark tone={view.tone}>{view.icon}</Mark>} />
      <h2 className="mb-2 mt-[26px] text-[19px] font-semibold tracking-tight text-foreground">
        {t(`artifacts.unavailable.${reason}.title`)}
      </h2>
      <p className="text-[13.5px] text-muted-foreground">{t(`artifacts.unavailable.${reason}.text`)}</p>
      <div className="mt-[18px] flex flex-wrap justify-center gap-2">
        {reason === 'absent' && settings(true, t('artifacts.unavailable.setUp'))}
        {reason === 'unsupported' && settings(true, t('artifacts.unavailable.update'))}
        {reason === 'off' && (
          <>
            <Button onClick={onEnable} disabled={busy}>
              {spinner ?? <Power className="size-3.5" />} {t('artifacts.unavailable.enable')}
            </Button>
            {settings(false)}
          </>
        )}
        {(reason === 'unreachable' || reason === 'problem') && (
          <>
            <Button onClick={onRetry} disabled={busy}>
              {spinner ?? <RotateCw className="size-3.5" />} {t('artifacts.unavailable.retry')}
            </Button>
            {settings(false)}
          </>
        )}
      </div>
    </div>
  )
}

export function NoMatchState({ title, onClear }: { title: string; onClear: () => void }) {
  const { t } = useTranslation('ui')
  return (
    <div className="artifact-state" data-testid="artifacts-no-match">
      <h2 className="mb-2 text-[19px] font-semibold tracking-tight text-foreground">{title}</h2>
      <p className="text-[13.5px] text-muted-foreground">{t('artifacts.noMatch.text')}</p>
      <div className="mt-[18px]">
        <Button variant="outline" onClick={onClear}>
          {t('artifacts.noMatch.clear')}
        </Button>
      </div>
    </div>
  )
}
