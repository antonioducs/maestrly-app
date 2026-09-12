import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, Check, Search } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface SearchOption {
  id: string
  label: string

  hint?: string

  searchText?: string

  disabled?: boolean
}

export function SearchSelect({
  value,
  options,
  onChange,
  placeholder,
  defaultLabel,
  allowCustom = false,
  customLabel,
  invalid = false,
  disabled = false,
  ariaLabel,
  className,
  contentClassName,
  avoidOverflow = false,
  panelWidth,
  panelAlign = 'start',
}: {
  value?: string
  options: SearchOption[]
  onChange: (id: string | undefined) => void
  placeholder?: string

  defaultLabel?: string

  allowCustom?: boolean

  customLabel?: (value: string) => string

  invalid?: boolean
  disabled?: boolean
  ariaLabel?: string
  className?: string
  contentClassName?: string

  avoidOverflow?: boolean
  panelWidth?: number
  panelAlign?: 'start' | 'end'
}) {
  const { t } = useTranslation('ui')
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [up, setUp] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)
  const [panelStyle, setPanelStyle] = useState<CSSProperties>()
  const wrapRef = useRef<HTMLDivElement>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([])
  const listboxId = useId()

  const positionPanel = useCallback(() => {
    const r = btnRef.current?.getBoundingClientRect()
    if (!r) return
    const PANEL = 280
    const opensUp = r.bottom + PANEL > window.innerHeight && r.top > PANEL
    setUp(opensUp)
    if (avoidOverflow) {
      const width = panelWidth ?? r.width
      setPanelStyle({
        position: 'fixed',
        left: panelAlign === 'end' ? Math.max(8, r.right - width) : Math.min(r.left, window.innerWidth - width - 8),
        top: opensUp ? undefined : r.bottom + 4,
        bottom: opensUp ? window.innerHeight - r.top + 4 : undefined,
        width,
      })
    }
  }, [avoidOverflow, panelAlign, panelWidth])

  const openPanel = () => {
    positionPanel()
    setQ('')
    setActiveIndex(-1)
    setOpen(true)
  }

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    const onViewportChange = () => positionPanel()
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    if (avoidOverflow) {
      window.addEventListener('resize', onViewportChange)
      window.addEventListener('scroll', onViewportChange, true)
    }
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onViewportChange)
      window.removeEventListener('scroll', onViewportChange, true)
    }
  }, [open, avoidOverflow, positionPanel])

  useEffect(() => {
    if (activeIndex >= 0) optionRefs.current[activeIndex]?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  const current = value ? options.find((o) => o.id === value) : undefined

  const triggerLabel = value ? (current?.label ?? value) : (defaultLabel ?? placeholder ?? t('searchSelect.select'))
  const showingPlaceholder = !value && !defaultLabel
  const customValue = q.trim()
  const ql = customValue.toLowerCase()
  const filtered = ql
    ? options.filter((o) => `${o.label} ${o.id} ${o.hint ?? ''} ${o.searchText ?? ''}`.toLowerCase().includes(ql))
    : options
  const exactOption = ql
    ? options.find((option) => option.id.toLowerCase() === ql || option.label.toLowerCase() === ql)
    : undefined
  const showSearch = allowCustom || options.length > 8
  const visibleRows: Array<{
    id: string | undefined
    label: string
    hint?: string
    disabled?: boolean
    key: string
  }> = [
    ...(defaultLabel && !ql ? [{ id: undefined, label: defaultLabel, key: '__default__' }] : []),
    ...filtered.map((option) => ({ ...option, key: option.id })),
    ...(allowCustom && customValue && !exactOption
      ? [
          {
            id: customValue,
            label: customLabel?.(customValue) ?? t('searchSelect.useCustom', { value: customValue }),
            key: '__custom__',
          },
        ]
      : []),
  ]

  const pick = (id: string | undefined) => {
    if (id && options.find((option) => option.id === id)?.disabled) return
    onChange(id)
    setOpen(false)
    setQ('')
    setActiveIndex(-1)
  }

  const onListKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (!visibleRows.length) return
      const direction = event.key === 'ArrowDown' ? 1 : -1
      setActiveIndex((currentIndex) => {
        if (currentIndex < 0) return direction > 0 ? 0 : visibleRows.length - 1
        return (currentIndex + direction + visibleRows.length) % visibleRows.length
      })
      return
    }
    if (event.key !== 'Enter') return
    event.preventDefault()
    const active = visibleRows[activeIndex]
    if (active) pick(active.id)
    else if (exactOption) pick(exactOption.id)
    else if (allowCustom && customValue) pick(customValue)
  }

  const row = (item: (typeof visibleRows)[number], index: number) => {
    const selected = item.id === value || (!item.id && !value)
    return (
      <button
        ref={(node) => {
          optionRefs.current[index] = node
        }}
        id={`${listboxId}-option-${index}`}
        key={item.key}
        type="button"
        role="option"
        aria-disabled={item.disabled || undefined}
        aria-selected={selected}
        tabIndex={-1}
        onMouseEnter={() => setActiveIndex(index)}
        onClick={() => pick(item.id)}
        className={cn(
          'flex w-full items-center gap-1.5 rounded-sm px-2 py-1.5 text-left text-xs outline-none hover:bg-accent hover:text-accent-foreground',
          activeIndex === index && 'bg-accent text-accent-foreground',
          selected && 'text-foreground',
          item.disabled && 'cursor-not-allowed opacity-45 hover:bg-transparent'
        )}
      >
        <Check className={cn('size-3.5 shrink-0', selected ? 'opacity-100' : 'opacity-0')} />

        <span className="min-w-0 flex-1 truncate" title={item.hint ? `${item.label} · ${item.hint}` : item.label}>
          {item.label}
        </span>
        {item.hint && <span className="shrink-0 text-[10px] text-muted-foreground">{item.hint}</span>}
      </button>
    )
  }

  return (
    <div ref={wrapRef} data-search-select className={cn('relative', className)}>
      <button
        ref={btnRef}
        type="button"
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        onKeyDown={(event) => {
          if (open) {
            onListKeyDown(event)
            return
          }
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            openPanel()
          }
        }}
        onClick={() => (open ? setOpen(false) : openPanel())}
        className={cn(
          'flex h-8 w-full items-center justify-between gap-2 rounded-md border bg-transparent px-3 py-2 text-xs text-foreground shadow-sm focus:outline-none focus:ring-1 focus:ring-ring',
          invalid ? 'border-amber-400/60' : 'border-input',
          disabled && 'cursor-not-allowed opacity-50'
        )}
      >
        <span
          title={current?.hint ? `${triggerLabel} · ${current.hint}` : triggerLabel}
          className={cn('truncate', showingPlaceholder && (invalid ? 'text-amber-300/90' : 'text-muted-foreground'))}
        >
          {triggerLabel}
        </span>
        <ChevronDown className={cn('size-3.5 shrink-0', invalid ? 'text-amber-300/70' : 'opacity-50')} />
      </button>

      {open && (
        <div
          style={avoidOverflow ? panelStyle : undefined}
          className={cn(
            'absolute left-0 z-[60] w-full overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-md',
            !avoidOverflow && (up ? 'bottom-full mb-1' : 'top-full mt-1'),
            contentClassName
          )}
        >
          {showSearch && (
            <div className="flex items-center gap-1.5 border-b border-border px-2">
              <Search className="size-3.5 shrink-0 text-muted-foreground" />
              <input
                autoFocus
                role="combobox"
                aria-label={ariaLabel}
                aria-autocomplete="list"
                aria-expanded={open}
                aria-controls={listboxId}
                aria-activedescendant={activeIndex >= 0 ? `${listboxId}-option-${activeIndex}` : undefined}
                value={q}
                onChange={(e) => {
                  setQ(e.target.value)
                  setActiveIndex(-1)
                }}
                onKeyDown={onListKeyDown}
                placeholder={t(allowCustom ? 'searchSelect.searchOrType' : 'searchSelect.search')}
                className="h-8 w-full bg-transparent text-xs outline-none placeholder:text-muted-foreground"
              />
            </div>
          )}
          <div
            id={listboxId}
            role="listbox"
            aria-label={ariaLabel}
            onKeyDown={showSearch ? undefined : onListKeyDown}
            tabIndex={showSearch ? undefined : 0}
            className="max-h-56 overflow-y-auto p-1"
          >
            {visibleRows.map(row)}
            {!visibleRows.length && (
              <div className="px-2 py-3 text-center text-xs text-muted-foreground">{t('searchSelect.empty')}</div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
