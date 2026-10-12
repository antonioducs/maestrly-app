/** Address bar of the drawer browser with Chrome-like suggestions: what was typed (or the inline completion of a
 * frequently used site), matching open tabs, history, and Google search suggestions. */
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AppWindow, Clock, Globe, Search, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useHostApi } from '@/lib/hosts/host-context'
import {
  browserHistoryKey,
  buildOmniboxSuggestions,
  displayUrl,
  foldText,
  isSearchSuggestEligible,
  omniboxFillText,
  searchQueryFromUrl,
  type OmniboxHistoryItem,
  type OmniboxSuggestion,
  type OmniboxTabItem,
} from '../../../shared/browser-omnibox'

/** Where a browser chrome is shown; main addresses focus requests to one of them. */
export type BrowserChromeHost = 'slot' | 'popup' | 'floating'

const SUGGEST_DEBOUNCE_MS = 120

interface Props {
  /** The conversation's id on the host the chrome renders for. */
  convId: string
  host: BrowserChromeHost
  /** The page is a native view of this computer, which paints above the DOM; a remote host's page is not. */
  nativePage: boolean
  /** Receives the address input, so the window can focus it (Cmd/Ctrl+L over a streamed page). */
  inputRef?: (el: HTMLInputElement | null) => void
  activeTabId: string | null
  activeUrl: string
  /** The suggestion list wants to cover the page, or no longer does. */
  onOpenChange: (open: boolean) => void
}

function isRemovable(row: OmniboxSuggestion): boolean {
  return row.kind !== 'tab' && row.removable
}

/**
 * Input plus listbox. The list is positioned against the nearest positioned ancestor (the toolbar row), so it spans
 * the whole toolbar rather than only the input.
 */
export function Omnibox({
  convId,
  host,
  nativePage,
  inputRef: exposeInput,
  activeTabId,
  activeUrl,
  onOpenChange,
}: Props) {
  const { t, i18n } = useTranslation('ui')
  const api = useHostApi()
  const listId = useId()
  const inputRef = useRef<HTMLInputElement | null>(null)
  const setInputEl = useCallback(
    (el: HTMLInputElement | null) => {
      inputRef.current = el
      exposeInput?.(el)
    },
    [exposeInput]
  )
  const focusedRef = useRef(false)
  const [focused, setFocused] = useState(false)
  // What the user typed. The input shows it, its inline completion, or the suggestion picked with the arrows.
  const [typed, setTyped] = useState(activeUrl)
  const [edited, setEdited] = useState(false)
  const [open, setOpen] = useState(false)
  const [allowInline, setAllowInline] = useState(false)
  const [selected, setSelected] = useState(0)
  const [previewing, setPreviewing] = useState(false)
  const [local, setLocal] = useState<{ history: OmniboxHistoryItem[]; tabs: OmniboxTabItem[] }>({
    history: [],
    tabs: [],
  })
  const [remote, setRemote] = useState<{ input: string; suggestions: string[] }>({ input: '', suggestions: [] })
  const [refresh, setRefresh] = useState(0)

  // Page state never overwrites text while the input has focus; a tab switch always resets it.
  const lastTabRef = useRef(activeTabId)
  // A new tab's address can arrive after its focus request (Cmd/Ctrl+T); it must stay selected for typing.
  const selectAfterSyncRef = useRef(false)
  useEffect(() => {
    const tabChanged = lastTabRef.current !== activeTabId
    lastTabRef.current = activeTabId
    if (!tabChanged && focusedRef.current) return
    const el = inputRef.current
    if (tabChanged && el && document.activeElement === el && el.value !== activeUrl) selectAfterSyncRef.current = true
    setTyped(activeUrl)
    setEdited(false)
    setPreviewing(false)
    setAllowInline(false)
    if (tabChanged) setOpen(false)
  }, [activeTabId, activeUrl])
  useLayoutEffect(() => {
    if (!selectAfterSyncRef.current) return
    selectAfterSyncRef.current = false
    if (document.activeElement === inputRef.current) inputRef.current?.select()
  }, [typed])

  const query = typed.trim()
  useEffect(() => {
    if (!open || !query) return
    let alive = true
    api.drawerOmniboxQuery(convId, typed).then(
      (result) => {
        if (alive) setLocal({ history: result.history, tabs: result.tabs })
      },
      () => {}
    )
    let timer: ReturnType<typeof setTimeout> | undefined
    if (isSearchSuggestEligible(typed)) {
      timer = setTimeout(() => {
        api.drawerOmniboxQuery(convId, typed, { search: true, locale: i18n.language }).then(
          (result) => {
            if (alive) setRemote({ input: typed, suggestions: result.searchSuggestions })
          },
          () => {}
        )
      }, SUGGEST_DEBOUNCE_MS)
    }
    return () => {
      alive = false
      if (timer) clearTimeout(timer)
    }
  }, [api, convId, typed, query, open, refresh, i18n.language])

  // Older suggestions stay visible while typing on, as long as they still extend the text.
  const searchSuggestions = useMemo(() => {
    if (remote.input === typed) return remote.suggestions
    const prefix = foldText(query)
    return remote.suggestions.filter((suggestion) => foldText(suggestion).startsWith(prefix))
  }, [remote, typed, query])

  const built = useMemo(
    () =>
      buildOmniboxSuggestions({
        input: typed,
        history: local.history,
        tabs: local.tabs,
        activeTabId,
        searchSuggestions,
        now: Date.now(),
        allowInline,
      }),
    [typed, local, activeTabId, searchSuggestions, allowInline]
  )
  const rows = built.suggestions
  const dropdown = open && focused && query !== '' && rows.length > 0
  const active = Math.min(selected, Math.max(0, rows.length - 1))
  const inline = allowInline && !previewing ? built.inlineCompletion : null
  const previewRow = previewing ? rows[active] : undefined
  const shown = previewRow ? omniboxFillText(previewRow) : (inline ?? typed)

  useEffect(() => {
    onOpenChange(dropdown)
  }, [dropdown, onOpenChange])

  // The completed remainder stays selected, so typing on replaces it and Backspace removes it.
  useLayoutEffect(() => {
    const el = inputRef.current
    if (!el || !inline || document.activeElement !== el || el.value !== inline) return
    el.setSelectionRange(typed.length, inline.length)
  }, [inline, typed])

  useEffect(
    () =>
      api.onBrowserFocusUrl((payload) => {
        if (payload.convId !== convId || payload.placement !== host) return
        requestAnimationFrame(() => {
          const el = inputRef.current
          if (!el) return
          el.focus({ preventScroll: true })
          el.select()
        })
      }),
    [api, convId, host]
  )

  const closeList = () => {
    setOpen(false)
    setPreviewing(false)
    setSelected(0)
  }

  const leave = () => {
    closeList()
    setEdited(false)
    setAllowInline(false)
    // Restore the page before acting, so the next page never shows under a stale frame.
    if (nativePage) void window.api.drawerOmniboxOverlay(convId, 'close').catch(() => null)
    inputRef.current?.blur()
  }

  const navigate = (text: string) => {
    const target = text.trim()
    if (!target) return
    leave()
    setTyped(target)
    api.drawerNavigate(convId, target, { typed: true })
  }

  const activate = (row: OmniboxSuggestion) => {
    if (row.kind === 'tab') {
      leave()
      api.drawerSwitchTab(convId, row.tabId)
      return
    }
    navigate(row.url)
  }

  const remove = (row: OmniboxSuggestion) => {
    const url = row.kind === 'search' ? row.historyUrl : row.kind === 'url' && row.removable ? row.url : undefined
    if (!url) return
    api.drawerRemoveHistoryEntry(url)
    const key = browserHistoryKey(url)
    const removedQuery = row.kind === 'search' ? foldText(row.query) : null
    setLocal((previous) => ({
      ...previous,
      history: previous.history.filter((entry) => {
        if (browserHistoryKey(entry.url) === key) return false
        const other = removedQuery === null ? null : searchQueryFromUrl(entry.url)
        return other === null || foldText(other) !== removedQuery
      }),
    }))
    setPreviewing(false)
    setRefresh((n) => n + 1)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!dropdown) {
        if (edited && query) {
          e.preventDefault()
          setOpen(true)
        }
        return
      }
      e.preventDefault()
      const n = rows.length
      const next = e.key === 'ArrowDown' ? (active + 1) % n : (active - 1 + n) % n
      setSelected(next)
      setPreviewing(next !== 0)
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      const row = dropdown ? rows[active] : undefined
      if (row) activate(row)
      else navigate(shown)
      return
    }
    if (e.key === 'Escape') {
      // First Escape closes the list, the second restores the page address.
      if (dropdown) {
        e.preventDefault()
        e.stopPropagation()
        closeList()
        setAllowInline(false)
      } else if (edited) {
        e.preventDefault()
        e.stopPropagation()
        setTyped(activeUrl)
        setEdited(false)
        setAllowInline(false)
        requestAnimationFrame(() => inputRef.current?.select())
      }
      return
    }
    if (e.key === 'Delete' && e.shiftKey && dropdown) {
      const row = rows[active]
      if (row && isRemovable(row)) {
        e.preventDefault()
        remove(row)
      }
    }
  }

  const onChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value
    const native = e.nativeEvent as InputEvent
    const atEnd = e.target.selectionStart === value.length && e.target.selectionEnd === value.length
    selectAfterSyncRef.current = false
    setAllowInline(native.inputType === 'insertText' && !native.isComposing && atEnd)
    setTyped(value)
    setEdited(true)
    setPreviewing(false)
    setSelected(0)
    setOpen(value.trim() !== '')
  }

  return (
    <div className="min-w-0 flex-1">
      <input
        ref={setInputEl}
        role="combobox"
        aria-expanded={dropdown}
        aria-controls={dropdown ? listId : undefined}
        aria-autocomplete="both"
        aria-activedescendant={dropdown ? `${listId}-${active}` : undefined}
        value={shown}
        onChange={onChange}
        onKeyDown={onKeyDown}
        onMouseDown={(e) => {
          // The first click selects the whole address, as in a regular browser.
          const el = inputRef.current
          if (el && document.activeElement !== el) {
            e.preventDefault()
            el.focus({ preventScroll: true })
            el.select()
          }
        }}
        onFocus={() => {
          focusedRef.current = true
          setFocused(true)
        }}
        onBlur={() => {
          focusedRef.current = false
          setFocused(false)
          closeList()
          setAllowInline(false)
          if (!edited) setTyped(activeUrl)
        }}
        placeholder={t('browserChrome.urlPlaceholder')}
        spellCheck={false}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        className="h-7 w-full rounded-md border border-input bg-transparent px-2 text-xs outline-none focus:ring-1 focus:ring-ring"
      />
      {dropdown && (
        <ul
          id={listId}
          role="listbox"
          aria-label={t('browserChrome.suggestions')}
          // Clicks inside the list must not take focus from the input.
          onMouseDown={(e) => e.preventDefault()}
          // Opaque (the --popover color without its alpha): the list covers arbitrary page content.
          className="absolute inset-x-1.5 top-full z-40 mt-1 overflow-hidden rounded-xl border border-border-strong bg-[#1a1a1d] p-1 text-popover-foreground shadow-2xl shadow-black/50"
        >
          {rows.map((row, index) => (
            <SuggestionRow
              key={row.id}
              id={`${listId}-${index}`}
              row={row}
              typed={query}
              active={index === active}
              onHover={() => {
                if (index === active) return
                setSelected(index)
                setPreviewing(false)
              }}
              onPick={() => activate(row)}
              onRemove={() => remove(row)}
            />
          ))}
        </ul>
      )}
    </div>
  )
}

function SuggestionRow({
  id,
  row,
  typed,
  active,
  onHover,
  onPick,
  onRemove,
}: {
  id: string
  row: OmniboxSuggestion
  typed: string
  active: boolean
  onHover: () => void
  onPick: () => void
  onRemove: () => void
}) {
  const { t } = useTranslation('ui')
  const removable = isRemovable(row)
  return (
    <li
      id={id}
      role="option"
      aria-selected={active}
      onMouseMove={onHover}
      onClick={onPick}
      className={cn(
        'group flex h-8 cursor-pointer items-center gap-2.5 rounded-lg px-2.5 text-xs text-foreground',
        active && 'bg-white/[0.08]'
      )}
    >
      <RowIcon row={row} />
      <span className="min-w-0 flex-1 truncate">
        <RowText row={row} typed={typed} />
      </span>
      {row.kind === 'tab' && (
        <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-[10px] text-muted-foreground">
          {t('browserChrome.switchToTab')}
        </span>
      )}
      {removable && (
        <button
          type="button"
          tabIndex={-1}
          aria-label={t('browserChrome.removeFromHistory')}
          title={t('browserChrome.removeFromHistory')}
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => {
            e.stopPropagation()
            onRemove()
          }}
          className={cn(
            'shrink-0 rounded p-0.5 text-muted-foreground transition-opacity hover:bg-white/10 hover:text-foreground',
            active ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
          )}
        >
          <X className="size-3.5" />
        </button>
      )}
    </li>
  )
}

function RowIcon({ row }: { row: OmniboxSuggestion }) {
  if (row.kind !== 'search' && row.icon) {
    return <img src={row.icon} alt="" draggable={false} className="size-4 shrink-0 rounded-sm object-contain" />
  }
  const className = 'size-4 shrink-0 text-muted-foreground'
  if (row.kind === 'tab') return <AppWindow className={className} />
  if (row.kind === 'url') return <Globe className={className} />
  if (row.source === 'history') return <Clock className={className} />
  return <Search className={className} />
}

function RowText({ row, typed }: { row: OmniboxSuggestion; typed: string }) {
  const { t } = useTranslation('ui')
  if (row.kind === 'search') {
    if (row.source === 'input') {
      return (
        <>
          {row.query}
          <span className="text-muted-foreground"> – {t('browserChrome.searchWith')}</span>
        </>
      )
    }
    return <Completion text={row.query} typed={typed} />
  }
  const address = displayUrl(row.url)
  if (!row.title || row.title === address) {
    return <span className={row.kind === 'url' && row.source === 'input' ? undefined : 'text-sky-400'}>{address}</span>
  }
  return (
    <>
      {row.title}
      <span className="text-muted-foreground"> – </span>
      <span className="text-sky-400">{address}</span>
    </>
  )
}

/** Like Chrome, the part of a suggestion beyond what was typed is emphasized. */
function Completion({ text, typed }: { text: string; typed: string }) {
  if (typed && foldText(text.slice(0, typed.length)) === foldText(typed)) {
    return (
      <>
        {text.slice(0, typed.length)}
        <span className="font-semibold">{text.slice(typed.length)}</span>
      </>
    )
  }
  return <>{text}</>
}
