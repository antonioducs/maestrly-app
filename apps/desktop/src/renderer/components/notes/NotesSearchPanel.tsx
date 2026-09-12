import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ArrowUp,
  ArrowDown,
  X,
  ChevronRight,
  ChevronDown,
  CaseSensitive,
  WholeWord,
  Regex,
  Replace,
  ReplaceAll,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { SearchOpts, SearchSnapshot } from '@/lib/notes-search'

interface Props {
  query: string
  replacement: string
  opts: SearchOpts
  snapshot: SearchSnapshot
  replaceMode: boolean

  focusSignal: number
  onQueryChange: (q: string) => void
  onReplacementChange: (r: string) => void
  onOptsChange: (o: SearchOpts) => void
  onToggleReplace: () => void
  onPrev: () => void
  onNext: () => void
  onReplace: () => void
  onReplaceAll: () => void
  onClose: () => void
}

export function NotesSearchPanel({
  query,
  replacement,
  opts,
  snapshot,
  replaceMode,
  focusSignal,
  onQueryChange,
  onReplacementChange,
  onOptsChange,
  onToggleReplace,
  onPrev,
  onNext,
  onReplace,
  onReplaceAll,
  onClose,
}: Props) {
  const { t } = useTranslation('ui')
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const el = searchRef.current
    if (!el) return
    el.focus()
    el.select()
  }, [focusSignal])

  const hasError = snapshot.error !== null
  const status = hasError
    ? t('notesSearch.invalidRegex')
    : snapshot.count > 0
      ? t('notesSearch.position', { current: snapshot.current, count: snapshot.count })
      : query
        ? t('notesSearch.noResults')
        : ''

  return (
    <div className="absolute right-3 top-3 z-30 flex w-[min(560px,calc(100%_-_1.5rem))] items-start gap-1 rounded-md border border-border bg-[#24262e] p-1.5 shadow-xl">
      <button
        type="button"
        onClick={onToggleReplace}
        title={replaceMode ? t('notesSearch.hideReplace') : t('notesSearch.showReplace')}
        className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-white/10 hover:text-foreground [&_svg]:size-4"
      >
        {replaceMode ? <ChevronDown /> : <ChevronRight />}
      </button>

      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex min-w-0 items-center gap-1">
          <div
            className={cn(
              'flex min-w-0 flex-1 items-center rounded border bg-black/20',
              hasError ? 'border-destructive/70' : 'border-input focus-within:border-primary/50'
            )}
          >
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => onQueryChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  e.shiftKey ? onPrev() : onNext()
                }
              }}
              placeholder={t('notesSearch.searchPlaceholder')}
              spellCheck={false}
              className="h-7 min-w-0 flex-1 bg-transparent px-2 text-xs text-foreground outline-none placeholder:text-muted-foreground/60"
            />
            <div className="flex items-center gap-0.5 pr-1">
              <Toggle
                active={opts.caseSensitive}
                title={t('notesSearch.matchCase')}
                onClick={() => onOptsChange({ ...opts, caseSensitive: !opts.caseSensitive })}
              >
                <CaseSensitive />
              </Toggle>
              <Toggle
                active={opts.wholeWord}
                title={t('notesSearch.wholeWord')}
                onClick={() => onOptsChange({ ...opts, wholeWord: !opts.wholeWord })}
              >
                <WholeWord />
              </Toggle>
              <Toggle
                active={opts.regex}
                title={t('notesSearch.useRegex')}
                onClick={() => onOptsChange({ ...opts, regex: !opts.regex })}
              >
                <Regex />
              </Toggle>
            </div>
          </div>

          <span
            className={cn(
              'w-20 shrink-0 truncate px-1 text-[11px] tabular-nums',
              hasError ? 'text-destructive' : 'text-muted-foreground'
            )}
            title={hasError ? (snapshot.error ?? undefined) : undefined}
          >
            {status}
          </span>

          <IconBtn title={t('notesSearch.prev')} onClick={onPrev} disabled={snapshot.count === 0}>
            <ArrowUp />
          </IconBtn>
          <IconBtn title={t('notesSearch.next')} onClick={onNext} disabled={snapshot.count === 0}>
            <ArrowDown />
          </IconBtn>
          <IconBtn title={t('notesSearch.close')} onClick={onClose}>
            <X />
          </IconBtn>
        </div>

        {replaceMode && (
          <div className="flex min-w-0 items-center gap-1">
            <div className="flex min-w-0 flex-1 items-center rounded border border-input bg-black/20 focus-within:border-primary/50">
              <input
                value={replacement}
                onChange={(e) => onReplacementChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    onReplace()
                  }
                }}
                placeholder={t('notesSearch.replacePlaceholder')}
                spellCheck={false}
                className="h-7 min-w-0 flex-1 bg-transparent px-2 text-xs text-foreground outline-none placeholder:text-muted-foreground/60"
              />
            </div>
            <IconBtn title={t('notesSearch.replace')} onClick={onReplace} disabled={snapshot.count === 0}>
              <Replace />
            </IconBtn>
            <IconBtn title={t('notesSearch.replaceAll')} onClick={onReplaceAll} disabled={snapshot.count === 0}>
              <ReplaceAll />
            </IconBtn>
          </div>
        )}
      </div>
    </div>
  )
}

function Toggle({
  active,
  title,
  onClick,
  children,
}: {
  active: boolean
  title: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        'flex size-5 items-center justify-center rounded [&_svg]:size-3.5',
        active
          ? 'bg-primary/30 text-primary ring-1 ring-primary/40'
          : 'text-muted-foreground hover:bg-white/10 hover:text-foreground'
      )}
    >
      {children}
    </button>
  )
}

function IconBtn({
  title,
  onClick,
  disabled,
  children,
}: {
  title: string
  onClick: () => void
  disabled?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="flex size-7 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-white/10 hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent [&_svg]:size-4"
    >
      {children}
    </button>
  )
}
