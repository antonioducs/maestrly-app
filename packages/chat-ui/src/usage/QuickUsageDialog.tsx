import { useEffect, useRef, type ReactNode } from 'react'
import { Activity, Loader2, RefreshCw, X } from 'lucide-react'
import { cn } from '@maestrly/ui'
import { useChatUi } from '../provider'

/**
 * The body of the quick usage dialog: one section per target, each with a label and whatever
 * the application renders for it. The desktop wraps it in its own dialog primitive; the Bot uses
 * the native shell below. The `data-*` attributes are the ones the desktop tests already read.
 */
export interface QuickUsageTargetView {
  key: string
  label: string
  /** A second line shown when it is not already part of the label (an account e-mail, a bot name…). */
  accountLabel?: string
  /** Attributes the application wants on the section, for its own tests. */
  data?: Record<string, string>
}

export function QuickUsageTargets<T extends QuickUsageTargetView>({ targets, render, className }: { targets: T[]; render: (target: T) => ReactNode; className?: string }) {
  return (
    <div className={cn('min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain pr-1', className)} data-testid="quick-usage-list">
      {targets.map((target) => (
        <section key={target.key} className="rounded-lg border border-border bg-black/15 px-3 py-3" {...Object.fromEntries(Object.entries(target.data ?? {}).map(([k, v]) => [`data-${k}`, v]))}>
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-[13px] font-medium text-foreground">{target.label}</p>
              {target.accountLabel && !target.label.includes(target.accountLabel) && <p className="truncate text-[11px] text-muted-foreground">{target.accountLabel}</p>}
            </div>
          </div>
          {render(target)}
        </section>
      ))}
    </div>
  )
}

/** The refresh control of the dialog footer, spinning while a load is in flight. */
export function QuickUsageRefresh({ loading, onRefresh, label }: { loading: boolean; onRefresh: () => void; label: string }) {
  const { labels } = useChatUi()
  return (
    <button
      type="button"
      disabled={loading}
      onClick={onRefresh}
      aria-label={label}
      className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-3 text-[12px] text-foreground transition-colors hover:bg-white/5 disabled:opacity-50"
    >
      {loading ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
      {labels.usage.refresh}
    </button>
  )
}

/**
 * A native-dialog shell for an application without a dialog primitive of its own. Opens as a
 * modal, closes on Escape and on the close button, and reports both through `onOpenChange`.
 */
export function QuickUsageDialog({ open, onOpenChange, title, description, children, footer }: { open: boolean; onOpenChange: (open: boolean) => void; title: string; description?: string; children: ReactNode; footer?: ReactNode }) {
  const { labels } = useChatUi()
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const node = ref.current
    if (!node) return
    if (open && !node.open) node.showModal()
    if (!open && node.open) node.close()
  }, [open])
  if (!open) return null
  return (
    <dialog
      ref={ref}
      aria-labelledby="quick-usage-title"
      data-testid="quick-usage-dialog"
      className="m-auto flex max-h-[min(560px,calc(100vh-2rem))] w-[min(640px,calc(100vw-2rem))] flex-col gap-4 overflow-hidden rounded-xl border border-border bg-background p-5 text-foreground shadow-2xl backdrop:bg-black/50"
      onClose={() => onOpenChange(false)}
      onCancel={(event) => {
        event.preventDefault()
        onOpenChange(false)
      }}
    >
      <header className="flex shrink-0 items-start justify-between gap-3">
        <div>
          <h2 id="quick-usage-title" className="flex items-center gap-2 text-sm font-semibold">
            <Activity className="size-4 text-emerald-400" />
            {title}
          </h2>
          {description && <p className="mt-0.5 text-[12px] text-muted-foreground">{description}</p>}
        </div>
        <button type="button" aria-label={labels.usage.close} onClick={() => onOpenChange(false)} className="rounded-md p-1 text-muted-foreground hover:bg-white/5 hover:text-foreground">
          <X className="size-4" />
        </button>
      </header>
      {children}
      {footer && <div className="flex shrink-0 justify-end">{footer}</div>}
    </dialog>
  )
}
