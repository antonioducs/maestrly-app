import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/** Single-choice row of buttons, used for reasoning effort and the preparation interval. */
export function SegmentedChoice({
  value,
  options,
  onChange,
  ariaLabel,
  disabled = false,
  className,
}: {
  value: string
  options: Array<{ id: string; label: string; title?: string }>
  onChange: (id: string) => void
  ariaLabel: string
  disabled?: boolean
  className?: string
}) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn(
        'inline-flex max-w-full flex-wrap gap-0.5 rounded-md border border-border bg-black/20 p-0.5',
        className
      )}
    >
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          role="radio"
          aria-checked={option.id === value}
          title={option.title}
          disabled={disabled}
          onClick={() => option.id !== value && onChange(option.id)}
          className={cn(
            'rounded px-2 py-1 text-[11.5px] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-45',
            option.id === value
              ? 'bg-white/[0.1] text-foreground'
              : 'text-muted-foreground hover:bg-white/[0.05] hover:text-foreground'
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

export function SettingSwitch({
  checked,
  onChange,
  label,
  title,
  disabled = false,
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
  title?: string
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={title}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'h-4 w-7 shrink-0 rounded-full p-0.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-45',
        checked ? 'bg-emerald-500/70' : 'bg-white/10'
      )}
    >
      <span className={cn('block h-3 w-3 rounded-full bg-white transition-transform', checked && 'translate-x-3')} />
    </button>
  )
}

/** Labelled field of the model picker: provider, model, reasoning. */
export function PickerField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-[10.5px] font-medium uppercase tracking-wide text-muted-foreground/80">{label}</span>
      {children}
    </div>
  )
}

/** "Saved" or an error, next to what was just saved. */
export function SaveNote({ note, className }: { note: { error: boolean; text: string } | null; className?: string }) {
  if (!note) return null
  return (
    <p
      role={note.error ? 'alert' : 'status'}
      className={cn('text-[11px]', note.error ? 'text-red-300' : 'text-emerald-300/90', className)}
    >
      {note.text}
    </p>
  )
}
