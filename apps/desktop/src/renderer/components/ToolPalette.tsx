/** Popover anchored to the drawer "+" button: searchable list of tools to open as tabs on demand.
 * Plain positioned panel (no Radix Popover dependency); closes on outside click or Escape.
 * The Drawer freezes the docked native view behind it, so this overlay is really visible. */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Search } from 'lucide-react'
import type { DrawerTab } from '../../shared/tool-tabs'
import { cn } from '@/lib/utils'

export interface ToolPaletteItem {
  key: DrawerTab
  label: string
  icon: ReactNode
}

interface Props {
  open: boolean
  items: ToolPaletteItem[]
  openTabs: DrawerTab[]
  onPick: (tab: DrawerTab) => void
  onClose: () => void
  /** Elements that must not count as "outside" (e.g. the trigger button). */
  ignoreRef: React.RefObject<HTMLElement | null>
}

const fold = (s: string): string =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')

export function ToolPalette({ open, items, openTabs, onPick, onClose, ignoreRef }: Props) {
  const { t } = useTranslation('ui')
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const filtered = useMemo(() => {
    const q = fold(query.trim())
    return q ? items.filter((it) => fold(it.label).includes(q)) : items
  }, [items, query])

  useEffect(() => {
    if (!open) return
    setQuery('')
    setIndex(0)
    // Focus without scrolling the drawer (overflow:hidden containers still scroll on focus).
    const raf = requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }))
    return () => cancelAnimationFrame(raf)
  }, [open])

  useEffect(() => {
    if (!open) return
    const onPointer = (e: PointerEvent) => {
      const target = e.target as Node
      if (rootRef.current?.contains(target) || ignoreRef.current?.contains(target)) return
      onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('pointerdown', onPointer, true)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('pointerdown', onPointer, true)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open, onClose, ignoreRef])

  useEffect(() => {
    setIndex((i) => Math.min(i, Math.max(0, filtered.length - 1)))
  }, [filtered.length])

  useEffect(() => {
    rootRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [index, filtered])

  if (!open) return null

  const pick = (tab: DrawerTab) => {
    onPick(tab)
    onClose()
  }

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-label={t('drawer.addTab')}
      className="glass-strong absolute left-2 top-11 z-30 flex w-[min(300px,calc(100%-16px))] flex-col overflow-hidden rounded-xl border border-border-strong bg-popover shadow-2xl shadow-black/50 animate-in fade-in-0 zoom-in-95 duration-150"
      style={{ transformOrigin: 'top left' }}
    >
      <label className="flex items-center gap-2 border-b border-border px-3 py-2.5 text-muted-foreground">
        <Search className="size-4 shrink-0" />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setIndex(0)
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              if (filtered.length) setIndex((i) => (i + 1) % filtered.length)
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              if (filtered.length) setIndex((i) => (i - 1 + filtered.length) % filtered.length)
            } else if (e.key === 'Enter') {
              e.preventDefault()
              const it = filtered[index]
              if (it) pick(it.key)
            }
          }}
          placeholder={t('drawer.paletteSearch')}
          autoComplete="off"
          spellCheck={false}
          className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
        />
        <kbd className="rounded border border-border bg-white/[0.06] px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground">
          esc
        </kbd>
      </label>

      <ul role="listbox" className="max-h-72 overflow-y-auto p-1.5">
        {filtered.length === 0 && (
          <li className="px-3 py-6 text-center text-xs text-muted-foreground">
            {t('drawer.paletteEmpty', { query })}
          </li>
        )}
        {filtered.map((it, i) => {
          const isOpen = openTabs.includes(it.key)
          const active = i === index
          return (
            <li
              key={it.key}
              role="option"
              aria-selected={active}
              data-active={active ? 'true' : undefined}
              onMouseMove={() => {
                if (!active) setIndex(i)
              }}
              onClick={() => pick(it.key)}
              className={cn(
                'flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-foreground transition-colors',
                active && 'bg-white/[0.08]'
              )}
            >
              <span className={cn('shrink-0', active ? 'text-primary' : 'text-muted-foreground')}>{it.icon}</span>
              <span className="min-w-0 flex-1 truncate">{it.label}</span>
              {isOpen && (
                <span className="shrink-0 rounded-full bg-emerald-400/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-300">
                  {t('drawer.paletteOpen')}
                </span>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
