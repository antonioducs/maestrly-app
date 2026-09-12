import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronUp, ChevronDown, X, Loader2 } from 'lucide-react'

interface Props {
  query: string
  onQueryChange: (q: string) => void

  total: number

  index: number
  loading: boolean
  onPrev: () => void
  onNext: () => void
  onClose: () => void
}

export function ChatSearchBar({ query, onQueryChange, total, index, loading, onPrev, onNext, onClose }: Props) {
  const { t } = useTranslation('chat')
  const inputRef = useRef<HTMLInputElement>(null)

  // Focus the field whenever the search opens.
  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  return (
    <div className="pointer-events-none absolute left-0 right-0 top-2 z-20 flex justify-center px-4">
      <div className="pointer-events-auto flex items-center gap-1.5 rounded-lg border border-white/[0.1] bg-[#1a1a1f]/95 px-2 py-1.5 shadow-xl backdrop-blur">
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              if (e.shiftKey) onPrev()
              else onNext()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              onClose()
            }
          }}
          placeholder={t('search.placeholder')}
          className="w-56 bg-transparent px-1.5 text-[13px] text-foreground placeholder:text-muted-foreground/60 focus:outline-none"
        />
        <span className="min-w-[58px] shrink-0 text-center text-[12px] tabular-nums text-muted-foreground">
          {loading ? (
            <Loader2 className="mx-auto h-3.5 w-3.5 animate-spin" />
          ) : query && total === 0 ? (
            t('search.noResults')
          ) : total > 0 ? (
            t('search.count', { i: index + 1, total })
          ) : (
            ''
          )}
        </span>
        <button
          type="button"
          onClick={onPrev}
          disabled={total === 0}
          title={t('search.prev')}
          className="rounded p-1 text-muted-foreground hover:bg-white/[0.06] hover:text-foreground disabled:opacity-30"
        >
          <ChevronUp className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={onNext}
          disabled={total === 0}
          title={t('search.next')}
          className="rounded p-1 text-muted-foreground hover:bg-white/[0.06] hover:text-foreground disabled:opacity-30"
        >
          <ChevronDown className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={onClose}
          title={t('search.close')}
          className="rounded p-1 text-muted-foreground hover:bg-white/[0.06] hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  )
}
