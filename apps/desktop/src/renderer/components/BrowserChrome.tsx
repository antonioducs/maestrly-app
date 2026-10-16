import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, ArrowRight, RotateCw, Plus, X, Bug, Eraser, Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useHostApi } from '@/lib/hosts/host-context'
import { useHostInfo } from '@/lib/hosts/use-hosts'
import { Button } from '@/components/ui/button'
import { useReorder } from '@/components/useReorder'
import { Omnibox, type BrowserChromeHost } from '@/components/browser/Omnibox'
import { usePageOverlay } from '@/components/browser/usePageOverlay'

interface BrowserTabInfo {
  id: string
  title: string
  url: string
  loading: boolean
}
interface BrowserState {
  tabs: BrowserTabInfo[]
  activeId: string | null
  canGoBack: boolean
  canGoForward: boolean
  devtoolsOpen: boolean
}
const EMPTY_BROWSER: BrowserState = {
  tabs: [],
  activeId: null,
  canGoBack: false,
  canGoForward: false,
  devtoolsOpen: false,
}

interface BrowserChromeProps {
  /** The conversation's id on the host the chrome renders for. */
  convId: string | null
  addressRef?: React.Ref<HTMLInputElement>
  /** Where this chrome is shown; Cmd/Ctrl+T focuses the address bar of the matching host only. */
  host?: BrowserChromeHost
  /** Fixed height when the page starts at a set offset below the chrome top (floating and popup hosts). */
  height?: number
  /** True while the address-bar suggestions extend below the chrome over the page area. */
  onOverlayChange?: (active: boolean) => void
}

/**
 * The tabs and address bar of a conversation's browser. A remote host's browser has no DevTools here, and its page is
 * a streamed surface in this window's DOM, which the suggestions simply cover.
 */
export function BrowserChrome({ convId, addressRef, host = 'slot', height, onOverlayChange }: BrowserChromeProps) {
  const { t: tr } = useTranslation('ui')
  const api = useHostApi()
  const remote = useHostInfo().remote
  const [bstate, setBstate] = useState<BrowserState>(EMPTY_BROWSER)
  const stateRef = useRef(bstate)
  stateRef.current = bstate
  const activeTab = bstate.tabs.find((t) => t.id === bstate.activeId)
  const browserReorder = useReorder((f, t) => convId && api.drawerReorderTab(convId, f, t))

  // The suggestions belong to one conversation; switching conversations closes them at once.
  const [suggestionsFor, setSuggestionsFor] = useState<string | null>(null)
  const onSuggestionsChange = useCallback((open: boolean) => setSuggestionsFor(open ? convId : null), [convId])
  const suggestionsOpen = suggestionsFor !== null && suggestionsFor === convId
  // Only a native page of this computer paints above the DOM and must step aside.
  const overlay = usePageOverlay(remote ? null : convId, suggestionsOpen)
  const overlayActive = suggestionsOpen || overlay.frame !== null
  useEffect(() => {
    onOverlayChange?.(overlayActive)
  }, [overlayActive, onOverlayChange])

  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const setInput = useCallback(
    (el: HTMLInputElement | null) => {
      inputRef.current = el
      if (typeof addressRef === 'function') addressRef(el)
      else if (addressRef) (addressRef as React.MutableRefObject<HTMLInputElement | null>).current = el
    },
    [addressRef]
  )
  const focusAddress = useCallback(() => {
    const el = inputRef.current
    if (!el) return
    el.focus({ preventScroll: true })
    el.select()
  }, [])

  // The main window captures Cmd/Ctrl+T and W while the keyboard is in a browser chrome or a streamed page, and hands
  // them back here; the floating chrome has its own capture.
  const reportedFocus = useRef(false)
  const reportFocus = (focused: boolean) => {
    if (host === 'floating' || reportedFocus.current === focused) return
    reportedFocus.current = focused
    window.api.drawerBrowserKeyboardFocus(focused)
  }
  useEffect(
    () => () => {
      if (!reportedFocus.current) return
      reportedFocus.current = false
      window.api.drawerBrowserKeyboardFocus(false)
    },
    []
  )
  useEffect(() => {
    if (host === 'floating' || !convId) return
    return window.api.onBrowserShortcut((action) => {
      const focused = document.activeElement
      const owns =
        !!focused &&
        (rootRef.current?.contains(focused) === true ||
          focused.closest('[data-browser-surface]')?.getAttribute('data-browser-surface') === convId)
      if (!owns) return
      if (action === 'new-tab') {
        api.drawerNewTab(convId)
        focusAddress()
        return
      }
      const { activeId, tabs } = stateRef.current
      if (!activeId) return
      api.drawerCloseTab(convId, activeId)
      // After the last tab the empty browser's address bar takes the keyboard, so typing opens a new tab.
      if (tabs.length <= 1) focusAddress()
    })
  }, [host, convId, api, focusAddress])

  const [cacheCleared, setCacheCleared] = useState(false)
  const cacheTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(cacheTimer.current), [])

  const clearCache = async () => {
    if (!convId) return
    try {
      await api.drawerClearCache(convId)
    } catch (error) {
      // No confirmation for a partial clear; the button stays available to retry.
      console.error('Could not clear browsing data:', error)
      return
    }
    setCacheCleared(true)
    clearTimeout(cacheTimer.current)
    cacheTimer.current = setTimeout(() => setCacheCleared(false), 1500)
  }

  useEffect(() => {
    if (!convId) return
    let alive = true
    void api.getBrowserState(convId).then((s) => {
      if (!alive || s.convId !== convId) return
      setBstate(s)
    })
    return () => {
      alive = false
    }
  }, [convId, api])

  // The address bar decides when page updates may replace its text; state pushes only refresh the tabs.
  useEffect(() => {
    return api.onBrowserState((s) => {
      if (s.convId !== convId) return
      setBstate(s)
    })
  }, [convId, api])

  useEffect(() => {
    setBstate(EMPTY_BROWSER)
  }, [convId])

  return (
    <div
      ref={rootRef}
      className="relative shrink-0"
      style={height ? { height } : undefined}
      onFocus={() => reportFocus(true)}
      onBlur={(e) => {
        if (!rootRef.current?.contains(e.relatedTarget as Node | null)) reportFocus(false)
      }}
    >
      <div className="flex items-center gap-1 overflow-x-auto border-b border-border px-2 py-1">
        {bstate.tabs.map((t, i) => (
          <div
            key={t.id}
            {...browserReorder.props(i)}
            onClick={() => convId && api.drawerSwitchTab(convId, t.id)}
            className={cn(
              'group flex max-w-40 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-xs',
              t.id === bstate.activeId ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:bg-secondary/50',
              browserReorder.overIndex === i && 'ring-1 ring-primary/60'
            )}
          >
            <span className="truncate">{t.loading ? tr('browserChrome.loading') : t.title}</span>
            <X
              className="size-3 shrink-0 opacity-0 hover:text-destructive group-hover:opacity-60"
              onClick={(e) => {
                e.stopPropagation()
                if (convId) api.drawerCloseTab(convId, t.id)
              }}
            />
          </div>
        ))}
        <Button
          variant="ghost"
          size="icon"
          className="size-6 shrink-0"
          onClick={() => convId && api.drawerNewTab(convId)}
          title={tr('browserChrome.newTab')}
        >
          <Plus className="size-3.5" />
        </Button>
      </div>
      {/* Positioned so the address-bar suggestions span the whole toolbar. */}
      <div className="relative flex items-center gap-1 border-b border-border px-2 py-1.5">
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          disabled={!bstate.canGoBack}
          onClick={() => convId && api.drawerBack(convId)}
        >
          <ArrowLeft className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          disabled={!bstate.canGoForward}
          onClick={() => convId && api.drawerForward(convId)}
        >
          <ArrowRight className="size-4" />
        </Button>
        <Button variant="ghost" size="icon" className="size-7" onClick={() => convId && api.drawerReload(convId)}>
          <RotateCw className={cn('size-4', activeTab?.loading && 'animate-spin')} />
        </Button>
        {convId ? (
          <Omnibox
            key={convId}
            convId={convId}
            host={host}
            nativePage={!remote}
            inputRef={setInput}
            activeTabId={bstate.activeId}
            activeUrl={activeTab?.url ?? ''}
            onOpenChange={onSuggestionsChange}
          />
        ) : (
          <input
            ref={setInput}
            disabled
            placeholder={tr('browserChrome.urlPlaceholder')}
            className="h-7 min-w-0 flex-1 rounded-md border border-input bg-transparent px-2 text-xs outline-none"
          />
        )}
        <HoverTip label={tr('browserChrome.clearCache')} align="right">
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={clearCache}
            aria-label={tr('browserChrome.clearCache')}
          >
            {cacheCleared ? <Check className="size-4 text-emerald-400" /> : <Eraser className="size-4" />}
          </Button>
        </HoverTip>
        {!remote && (
          <HoverTip label={tr('browserChrome.toggleDevtools')} align="right">
            <Button
              variant={bstate.devtoolsOpen ? 'secondary' : 'ghost'}
              size="icon"
              className="size-7"
              onClick={() => {
                if (convId) {
                  api.drawerDevTools(convId)
                }
              }}
              aria-label={tr('browserChrome.toggleDevtools')}
            >
              <Bug className="size-4" />
            </Button>
          </HoverTip>
        )}
      </div>
      {overlay.frame?.src && (
        // Frozen frame of the page right where the page is, painted under it first; see usePageOverlay.
        <img
          key={overlay.frame.id}
          src={overlay.frame.src}
          alt=""
          draggable={false}
          onLoad={(e) => {
            const id = overlay.frame?.id
            if (id === undefined) return
            void e.currentTarget
              .decode()
              .catch(() => undefined)
              .then(() => requestAnimationFrame(() => overlay.reveal(id)))
          }}
          className="pointer-events-none absolute inset-x-0 top-full z-30 w-full select-none"
        />
      )}
    </div>
  )
}

function HoverTip({
  label,
  align = 'center',
  children,
}: {
  label: string
  align?: 'center' | 'left' | 'right'
  children: React.ReactNode
}) {
  const pos = align === 'right' ? 'right-0' : align === 'left' ? 'left-0' : 'left-1/2 -translate-x-1/2'
  return (
    <span className="group/tip relative inline-flex">
      {children}
      <span
        role="tooltip"
        className={cn(
          'pointer-events-none absolute bottom-full z-50 mb-1.5 whitespace-nowrap rounded-md border border-border bg-popover px-2 py-1 text-xs text-popover-foreground opacity-0 shadow-md transition-opacity duration-100 group-hover/tip:opacity-100',
          pos
        )}
      >
        {label}
      </span>
    </span>
  )
}
