import { ChevronDown, Brain, Check } from 'lucide-react'
import { cn } from '@maestrly/ui'
import { useChatUi } from '../provider'
import { PANEL_CLASS, usePopover } from './usePopover'

/** Reasoning effort picker over the efforts the selected model actually supports. */
export function ChatReasoningPicker({
  efforts,
  value,
  onChange,
  disabled = false,
  disabledReason,
  defaultLabel,
}: {
  efforts: string[]
  value?: string
  onChange: (effort: string | undefined) => void
  disabled?: boolean
  disabledReason?: string
  /** Shown for "no explicit effort" (the model's default). */
  defaultLabel?: string
}) {
  const { labels } = useChatUi()
  const { open, setOpen, ref } = usePopover()
  const label = value ?? ''
  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        disabled={disabled || efforts.length === 0}
        aria-haspopup="listbox"
        aria-expanded={open}
        data-reasoning-picker
        onClick={() => !disabled && setOpen((o) => !o)}
        className={cn(
          'flex items-center gap-1 rounded-md px-1.5 py-1 text-[12px] hover:bg-white/[0.05] disabled:cursor-not-allowed disabled:opacity-50',
          value ? 'text-violet-300' : 'text-muted-foreground hover:text-foreground'
        )}
        title={disabled && disabledReason ? disabledReason : labels.model.effort}
      >
        <Brain className="h-3.5 w-3.5" />
        {label && <span className="max-w-[80px] truncate">{label}</span>}
        <ChevronDown className="h-3 w-3" />
      </button>
      {open && (
        <div role="listbox" className={cn(PANEL_CLASS, 'w-56')}>
          <div className="px-2.5 py-1 text-[10px] uppercase tracking-wide text-muted-foreground/60">{labels.model.effort}</div>
          {[undefined, ...efforts].map((id) => (
            <button
              key={id ?? '__default'}
              type="button"
              role="option"
              aria-selected={value === id}
              onClick={() => {
                setOpen(false)
                onChange(id)
              }}
              className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left hover:bg-white/[0.05]"
            >
              <span className={cn('min-w-0 flex-1 text-[13px]', id == null ? 'text-muted-foreground' : 'text-foreground')}>
                {id ?? defaultLabel ?? '—'}
              </span>
              <Check className={cn('h-3.5 w-3.5 shrink-0', value === id ? 'opacity-100' : 'opacity-0')} />
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
