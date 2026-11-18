import { useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import {
  AlertCircle,
  Check,
  CheckCircle2,
  Clock,
  Copy,
  Folder,
  Loader2,
  Moon,
  Power,
  Shield,
  SkipForward,
  Sparkles,
  Square,
  Trash2,
  User,
  X,
} from 'lucide-react'
import { cn } from '@/lib/utils'

export type ToastTone = 'ok' | 'run' | 'notable' | 'quiet' | 'warn' | 'error' | 'skip'
export type ToastIconName =
  | 'check'
  | 'circleCheck'
  | 'clock'
  | 'copy'
  | 'trash'
  | 'power'
  | 'shield'
  | 'folder'
  | 'sparkle'
  | 'alert'
  | 'user'
  | 'stop'
  | 'moon'
  | 'skip'
  | 'loader'

export interface ToastAction {
  label: string
  onClick: () => void
}

export interface ToastInput {
  id?: string
  tone?: ToastTone
  icon?: ToastIconName
  title: string
  description?: string
  action?: ToastAction
  durationMs?: number
}

export interface ToastItem extends Omit<ToastInput, 'id' | 'tone'> {
  id: string
  tone: ToastTone
}

const MAX_TOASTS = 3
const DEFAULT_DURATION_MS = 7000

let seq = 0
let items: ToastItem[] = []
const timers = new Map<string, ReturnType<typeof setTimeout>>()
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

export function getToasts(): ToastItem[] {
  return items
}

export function dismissToast(id: string): void {
  const timer = timers.get(id)
  if (timer) {
    clearTimeout(timer)
    timers.delete(id)
  }
  if (!items.some((item) => item.id === id)) return
  items = items.filter((item) => item.id !== id)
  emit()
}

export function dismissToasts(predicate: (item: ToastItem) => boolean): void {
  const toRemove = items.filter(predicate)
  if (toRemove.length === 0) return
  for (const item of toRemove) {
    const timer = timers.get(item.id)
    if (timer) {
      clearTimeout(timer)
      timers.delete(item.id)
    }
  }
  const removeIds = new Set(toRemove.map((t) => t.id))
  items = items.filter((item) => !removeIds.has(item.id))
  emit()
}

export function clearToasts(): void {
  for (const timer of timers.values()) clearTimeout(timer)
  timers.clear()
  if (items.length === 0) return
  items = []
  emit()
}

export function toast(input: ToastInput): string {
  const id = input.id ?? `toast-${++seq}`
  const existingTimer = timers.get(id)
  if (existingTimer) {
    clearTimeout(existingTimer)
    timers.delete(id)
  }

  const next: ToastItem = {
    id,
    tone: input.tone ?? 'ok',
    icon: input.icon,
    title: input.title,
    description: input.description,
    action: input.action,
    durationMs: input.durationMs,
  }

  const withoutDup = items.filter((item) => item.id !== id)
  const dropped = withoutDup.slice(0, Math.max(0, withoutDup.length - (MAX_TOASTS - 1)))
  for (const drop of dropped) {
    const timer = timers.get(drop.id)
    if (timer) {
      clearTimeout(timer)
      timers.delete(drop.id)
    }
  }
  items = [...withoutDup.slice(-(MAX_TOASTS - 1)), next]

  const duration = input.durationMs ?? DEFAULT_DURATION_MS
  if (duration > 0) {
    timers.set(
      id,
      setTimeout(() => {
        timers.delete(id)
        dismissToast(id)
      }, duration)
    )
  }
  emit()
  return id
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

const TONE_ICON_BG: Record<ToastTone, string> = {
  ok: 'bg-emerald-500/15 text-emerald-400',
  run: 'bg-[var(--routine-soft)] text-[var(--routine)]',
  notable: 'bg-[var(--routine-soft)] text-[var(--routine)]',
  quiet: 'bg-muted text-muted-foreground',
  warn: 'bg-amber-500/15 text-amber-400',
  error: 'bg-destructive/15 text-destructive',
  skip: 'bg-muted text-muted-foreground',
}

function ToastIcon({ name }: { name?: ToastIconName }) {
  const cls = 'size-3.5 shrink-0'
  switch (name) {
    case 'circleCheck':
      return <CheckCircle2 className={cls} />
    case 'clock':
      return <Clock className={cls} />
    case 'copy':
      return <Copy className={cls} />
    case 'trash':
      return <Trash2 className={cls} />
    case 'power':
      return <Power className={cls} />
    case 'shield':
      return <Shield className={cls} />
    case 'folder':
      return <Folder className={cls} />
    case 'sparkle':
      return <Sparkles className={cls} />
    case 'alert':
      return <AlertCircle className={cls} />
    case 'user':
      return <User className={cls} />
    case 'stop':
      return <Square className={cls} />
    case 'moon':
      return <Moon className={cls} />
    case 'skip':
      return <SkipForward className={cls} />
    case 'loader':
      return <Loader2 className={cn(cls, 'animate-spin')} />
    case 'check':
    default:
      return <Check className={cls} />
  }
}

export function Toaster() {
  const { t } = useTranslation('routines')
  const list = useSyncExternalStore(subscribe, getToasts, getToasts)

  return (
    <div
      className="pointer-events-none fixed right-4 bottom-4 z-[45] flex w-[min(360px,calc(100vw-32px))] flex-col gap-2"
      aria-live="polite"
    >
      {list.map((item) => (
        <div
          key={item.id}
          className="pointer-events-auto flex items-start gap-2.5 rounded-xl border border-border bg-popover px-3 py-2.5 text-[12.5px] shadow-2xl animate-in fade-in slide-in-from-right-4 duration-200"
        >
          <span
            className={cn(
              'mt-0.5 flex size-[26px] shrink-0 items-center justify-center rounded-md',
              TONE_ICON_BG[item.tone]
            )}
          >
            <ToastIcon name={item.icon} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="font-semibold text-foreground">{item.title}</div>
            {item.description && <div className="mt-0.5 text-muted-foreground">{item.description}</div>}
            {item.action && (
              <div className="mt-1.5 flex gap-1">
                <button
                  type="button"
                  onClick={() => {
                    item.action?.onClick()
                    dismissToast(item.id)
                  }}
                  className="inline-flex h-6 items-center rounded-md border border-border bg-background/60 px-2 text-xs font-medium text-foreground transition-colors hover:bg-accent"
                >
                  {item.action.label}
                </button>
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={() => dismissToast(item.id)}
            aria-label={t('toasts.close')}
            className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
        </div>
      ))}
    </div>
  )
}
