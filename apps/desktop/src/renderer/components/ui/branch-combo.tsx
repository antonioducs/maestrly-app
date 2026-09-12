import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, ChevronDown, RotateCw, Search } from 'lucide-react'
import { cn } from '@/lib/utils'

export function BranchCombo({
  value,
  onChange,
  suggestions,
  invalid = false,
  placeholder,
  disabled = false,
  autoFocus = false,
  onCommit,
  onRefresh,
}: {
  value: string
  onChange: (v: string) => void

  suggestions: string[]

  invalid?: boolean
  placeholder?: string
  disabled?: boolean
  autoFocus?: boolean

  onCommit?: (value: string) => void

  onRefresh?: () => Promise<void>
}) {
  const { t } = useTranslation('ui')
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [up, setUp] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const openPanel = () => {
    const r = inputRef.current?.getBoundingClientRect()
    const PANEL = 280
    setUp(!!r && r.bottom + PANEL > window.innerHeight && r.top > PANEL)
    setQ('')
    setOpen(true)
  }

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) {
        setOpen(false)
        onCommit?.(value)
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, onCommit, value])

  const ql = q.trim().toLowerCase()
  const filtered = ql ? suggestions.filter((s) => s.toLowerCase().includes(ql)) : suggestions

  const pick = (s: string) => {
    onChange(s)
    setOpen(false)
    setQ('')
    onCommit?.(s)
  }

  const doRefresh = async () => {
    if (!onRefresh || refreshing) return
    setRefreshing(true)
    try {
      await onRefresh()
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <div ref={wrapRef} className="relative">
      <div
        className={cn(
          'flex h-8 w-full items-center gap-1 rounded-md border bg-transparent pl-2 pr-1 transition-colors focus-within:ring-1',
          invalid ? 'border-amber-400/60 focus-within:ring-amber-400/40' : 'border-input focus-within:ring-primary/40',
          disabled && 'cursor-not-allowed opacity-60'
        )}
      >
        <input
          ref={inputRef}
          value={value}
          disabled={disabled}
          autoFocus={autoFocus}
          onChange={(e) => {
            onChange(e.target.value)
            if (!open) setOpen(true)
            setQ(e.target.value)
          }}
          onFocus={openPanel}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              setOpen(false)
              onCommit?.(e.currentTarget.value)
            }
          }}
          placeholder={placeholder}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          className="h-full w-full min-w-0 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
        />
        {onRefresh && (
          <button
            type="button"
            disabled={disabled || refreshing}
            onClick={doRefresh}
            title={t('branchCombo.refresh')}
            className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground disabled:opacity-50"
          >
            <RotateCw className={cn('size-3.5', refreshing && 'animate-spin')} />
          </button>
        )}
        <button
          type="button"
          disabled={disabled}
          onClick={() => (open ? setOpen(false) : openPanel())}
          className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground"
          tabIndex={-1}
        >
          <ChevronDown className="size-3.5 opacity-70" />
        </button>
      </div>

      {open && !disabled && (
        <div
          className={cn(
            'absolute left-0 z-[60] w-full overflow-hidden rounded-md border border-border bg-[#1E1E21] shadow-xl',
            up ? 'bottom-full mb-1' : 'top-full mt-1'
          )}
        >
          <div className="flex items-center gap-1.5 border-b border-border px-2">
            <Search className="size-3.5 shrink-0 text-muted-foreground" />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t('branchCombo.search')}
              className="h-8 w-full bg-transparent text-xs outline-none placeholder:text-muted-foreground"
            />
          </div>
          <div className="max-h-56 overflow-y-auto p-1">
            {filtered.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => pick(s)}
                className="flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-left text-xs text-foreground hover:bg-white/[0.06]"
              >
                <Check className={cn('size-3.5 shrink-0', value === s ? 'text-primary opacity-100' : 'opacity-0')} />
                <span className="truncate">{s}</span>
              </button>
            ))}
            {!filtered.length && (
              <div className="px-2 py-3 text-center text-xs text-muted-foreground">
                {ql ? t('branchCombo.useTyped', { branch: q.trim() }) : t('branchCombo.empty')}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
