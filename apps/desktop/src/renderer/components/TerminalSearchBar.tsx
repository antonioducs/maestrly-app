import { useEffect, useRef } from 'react'
import { ChevronDown, ChevronUp, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'

interface Props {
  query: string
  index: number
  total: number
  focusSignal: number
  onQueryChange: (query: string) => void
  onPrev: () => void
  onNext: () => void
  onClose: () => void
}

export function TerminalSearchBar({ query, index, total, focusSignal, onQueryChange, onPrev, onNext, onClose }: Props) {
  const { t } = useTranslation('ui')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [focusSignal])

  const count = query ? t('terminal.searchCount', { current: total > 0 ? index + 1 : 0, total }) : ''

  return (
    <div className="pointer-events-none absolute right-4 top-3 z-20">
      <div className="pointer-events-auto flex items-center gap-1 rounded-lg border border-white/[0.12] bg-[#1a1a1f]/95 px-2 py-1.5 shadow-xl backdrop-blur">
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              if (event.shiftKey) onPrev()
              else onNext()
            } else if (event.key === 'Escape') {
              event.preventDefault()
              onClose()
            }
          }}
          placeholder={t('terminal.searchPlaceholder')}
          aria-label={t('terminal.searchPlaceholder')}
          className="w-48 bg-transparent px-1.5 text-[13px] text-foreground placeholder:text-muted-foreground/60 focus:outline-none"
        />
        <span className="min-w-[48px] shrink-0 text-center text-[12px] tabular-nums text-muted-foreground">
          {count}
        </span>
        <button
          type="button"
          onClick={onPrev}
          disabled={total === 0}
          title={t('terminal.searchPrevious')}
          className="rounded p-1 text-muted-foreground hover:bg-white/[0.06] hover:text-foreground disabled:opacity-30"
        >
          <ChevronUp className="size-4" />
        </button>
        <button
          type="button"
          onClick={onNext}
          disabled={total === 0}
          title={t('terminal.searchNext')}
          className="rounded p-1 text-muted-foreground hover:bg-white/[0.06] hover:text-foreground disabled:opacity-30"
        >
          <ChevronDown className="size-4" />
        </button>
        <button
          type="button"
          onClick={onClose}
          title={t('terminal.searchClose')}
          className="rounded p-1 text-muted-foreground hover:bg-white/[0.06] hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      </div>
    </div>
  )
}
