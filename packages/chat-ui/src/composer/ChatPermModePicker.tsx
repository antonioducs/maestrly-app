import type { ReactNode } from 'react'
import { ChevronDown, Hand, ShieldAlert, Check } from 'lucide-react'
import { cn } from '@maestrly/ui'
import { useChatUi } from '../provider'
import { PANEL_CLASS, usePopover } from './usePopover'

export interface PermMode<Id extends string = string> {
  id: Id
  label: string
  description: string
  icon?: ReactNode
  danger?: boolean
}

/**
 * Permission picker over any list of modes. The Bot offers "ask" and "full"; the desktop adds its
 * own "auto" mode with the same component, so the two never drift visually.
 */
export function ChatPermModePicker<Id extends string>({
  modes,
  value,
  onChange,
  disabled = false,
  disabledReason,
  title,
}: {
  modes: PermMode<Id>[]
  value: Id
  onChange: (next: Id) => void
  disabled?: boolean
  disabledReason?: string
  title?: string
}) {
  const { open, setOpen, ref } = usePopover()
  const current = modes.find((m) => m.id === value) ?? modes[0]
  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        data-perm-picker
        onClick={() => !disabled && setOpen((o) => !o)}
        className={cn(
          'flex items-center gap-1 rounded-md px-1.5 py-1 text-[12px] hover:bg-white/[0.05] disabled:cursor-not-allowed disabled:opacity-50',
          current.danger ? 'text-amber-400' : 'text-muted-foreground hover:text-foreground'
        )}
        title={disabled && disabledReason ? disabledReason : title}
      >
        {current.icon ?? (current.danger ? <ShieldAlert className="h-3.5 w-3.5" /> : <Hand className="h-3.5 w-3.5" />)}
        <span className="max-w-[140px] truncate">{current.label}</span>
        <ChevronDown className="h-3 w-3" />
      </button>
      {open && (
        <div role="listbox" className={cn(PANEL_CLASS, 'w-80')}>
          {modes.map((m) => (
            <button
              key={m.id}
              type="button"
              role="option"
              aria-selected={value === m.id}
              onClick={() => {
                setOpen(false)
                if (m.id !== value) onChange(m.id)
              }}
              className="flex w-full items-start gap-2 rounded-md px-2.5 py-2 text-left hover:bg-white/[0.05]"
            >
              <span className={cn('mt-0.5 shrink-0', m.danger ? 'text-amber-400' : 'text-muted-foreground')}>
                {m.icon ?? (m.danger ? <ShieldAlert className="h-3.5 w-3.5" /> : <Hand className="h-3.5 w-3.5" />)}
              </span>
              <span className="min-w-0 flex-1">
                <span className={cn('block text-[13px]', m.danger ? 'text-amber-300' : 'text-foreground')}>{m.label}</span>
                <span className="block text-[11px] text-muted-foreground">{m.description}</span>
              </span>
              <Check className={cn('mt-0.5 h-3.5 w-3.5 shrink-0', value === m.id ? 'opacity-100' : 'opacity-0')} />
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** The two modes a Bot has, labelled from the injected copy. */
export function BotPermModePicker({
  value,
  onChange,
  disabled,
  disabledReason,
}: {
  value: 'ask' | 'full'
  onChange: (next: 'ask' | 'full') => void
  disabled?: boolean
  disabledReason?: string
}) {
  const { labels } = useChatUi()
  const modes: PermMode<'ask' | 'full'>[] = [
    { id: 'ask', label: labels.permission.ask, description: labels.permission.askHint },
    { id: 'full', label: labels.permission.full, description: labels.permission.fullHint, danger: true },
  ]
  return <ChatPermModePicker modes={modes} value={value} onChange={onChange} disabled={disabled} disabledReason={disabledReason} />
}
