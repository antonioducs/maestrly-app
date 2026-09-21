import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/** Small status badge shared by the bot cards, so one state never reads differently in two places. */
export type PillTone = 'ok' | 'warn' | 'off' | 'danger' | 'bot'

const TONES: Record<PillTone, string> = {
  ok: 'border-emerald-400/25 bg-emerald-400/[0.08] text-emerald-300',
  warn: 'border-amber-400/25 bg-amber-400/[0.08] text-amber-200',
  off: 'border-border bg-white/[0.04] text-muted-foreground',
  danger: 'border-destructive/25 bg-destructive/[0.08] text-destructive',
  bot: 'border-sky-400/25 bg-sky-400/[0.08] text-sky-300',
}

export function Pill({ tone, children, testId }: { tone: PillTone; children: ReactNode; testId?: string }) {
  return (
    <span
      data-testid={testId}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium',
        TONES[tone]
      )}
    >
      <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />
      {children}
    </span>
  )
}
