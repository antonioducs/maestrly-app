import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, Check, Search } from 'lucide-react'
import { cn } from '@maestrly/ui'
import { useChatUi } from '../provider'
import { PANEL_CLASS, usePopover } from './usePopover'

export interface ModelOption {
  id: string
  displayName: string
  efforts: string[]
  defaultEffort?: string
  /** Secondary text at the right of the row (a provider or account name). */
  group?: string
}

export interface ModelSelection {
  model: string
  effort?: string
}

/** Searchable model list; the host application decides where the catalogue comes from and how the choice is persisted. */
export function ChatModelChip({
  models,
  value,
  onChange,
  disabled = false,
  disabledReason,
  loading = false,
  searchPlaceholder,
}: {
  models: ModelOption[]
  value: ModelSelection | null
  onChange: (next: ModelSelection) => void
  disabled?: boolean
  disabledReason?: string
  loading?: boolean
  searchPlaceholder?: string
}) {
  const { labels } = useChatUi()
  const { open, setOpen, ref } = usePopover()
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const searchRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (!open) return
    setQuery('')
    setActiveIndex(0)
    const id = setTimeout(() => searchRef.current?.focus(), 0)
    return () => clearTimeout(id)
  }, [open])
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return models.filter((m) => !q || `${m.displayName} ${m.id} ${m.group ?? ''}`.toLowerCase().includes(q))
  }, [models, query])
  useEffect(() => setActiveIndex(0), [query])
  const current = models.find((m) => m.id === value?.model)
  const label = value?.model ? (current?.displayName ?? value.model) : labels.model.title
  const choose = (m: ModelOption) => {
    setOpen(false)
    // Keep the effort when the new model supports it; otherwise fall back to its default.
    const effort = value?.effort && m.efforts.includes(value.effort) ? value.effort : m.defaultEffort
    onChange({ model: m.id, ...(effort ? { effort } : {}) })
  }
  return (
    <div className="relative min-w-0" ref={ref}>
      <button
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        data-model-chip
        onClick={() => !disabled && setOpen((o) => !o)}
        title={disabled && disabledReason ? disabledReason : labels.model.title}
        className="flex min-w-0 max-w-full items-center gap-1 rounded-md px-1.5 py-1 text-[12px] text-muted-foreground hover:bg-white/[0.05] hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
      >
        <span className="truncate">{label}</span>
        <ChevronDown className="h-3 w-3 shrink-0" />
      </button>
      {open && (
        <div role="listbox" className={cn(PANEL_CLASS, 'max-h-[50vh] w-80 p-0')}>
          <div className="flex items-center gap-2 border-b border-white/[0.08] px-2.5 py-2">
            <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown' && filtered.length > 0) {
                  e.preventDefault()
                  setActiveIndex((index) => (index + 1) % filtered.length)
                } else if (e.key === 'ArrowUp' && filtered.length > 0) {
                  e.preventDefault()
                  setActiveIndex((index) => (index - 1 + filtered.length) % filtered.length)
                } else if (e.key === 'Enter') {
                  e.preventDefault()
                  const item = filtered[Math.min(activeIndex, filtered.length - 1)]
                  if (item) choose(item)
                }
              }}
              placeholder={searchPlaceholder ?? labels.model.title}
              className="w-full bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground"
            />
          </div>
          <div className="max-h-[40vh] overflow-auto py-1">
            {loading && <div className="px-3 py-2 text-[12px] text-muted-foreground">…</div>}
            {filtered.map((m, index) => (
              <button
                key={m.id}
                type="button"
                role="option"
                aria-selected={index === activeIndex}
                onClick={() => choose(m)}
                onMouseEnter={() => setActiveIndex(index)}
                className={cn('flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-white/[0.05]', index === activeIndex && 'bg-white/[0.06]')}
              >
                <Check className={cn('h-3.5 w-3.5 shrink-0', value?.model === m.id ? 'opacity-100' : 'opacity-0')} />
                <span className="flex-1 truncate text-[13px] text-foreground">{m.displayName}</span>
                {m.group && <span className="shrink-0 text-[11px] text-muted-foreground">{m.group}</span>}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
