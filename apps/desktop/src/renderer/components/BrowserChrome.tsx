import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, ArrowRight, RotateCw, Plus, X, Bug, Eraser, Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { useReorder } from '@/components/useReorder'

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

export function BrowserChrome({ convId }: { convId: string | null }) {
  const { t: tr } = useTranslation('ui')
  const [bstate, setBstate] = useState<BrowserState>(EMPTY_BROWSER)
  const [urlInput, setUrlInput] = useState('')
  const activeTab = bstate.tabs.find((t) => t.id === bstate.activeId)
  const browserReorder = useReorder((f, t) => convId && window.api.drawerReorderTab(convId, f, t))

  const [cacheCleared, setCacheCleared] = useState(false)
  const cacheTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(cacheTimer.current), [])

  const clearCache = async () => {
    if (!convId) return
    await window.api.drawerClearCache(convId)
    setCacheCleared(true)
    clearTimeout(cacheTimer.current)
    cacheTimer.current = setTimeout(() => setCacheCleared(false), 1500)
  }

  useEffect(() => {
    if (!convId) return
    let alive = true
    void window.api.getBrowserState(convId).then((s) => {
      if (!alive || s.convId !== convId) return
      setBstate(s)
      const act = s.tabs.find((t) => t.id === s.activeId)
      setUrlInput(act?.url ?? '')
    })
    return () => {
      alive = false
    }
  }, [convId])

  useEffect(() => {
    return window.api.onBrowserState((s) => {
      if (s.convId !== convId) return
      setBstate(s)
      const act = s.tabs.find((t) => t.id === s.activeId)
      if (act) setUrlInput(act.url)
    })
  }, [convId])

  useEffect(() => {
    setBstate(EMPTY_BROWSER)
    setUrlInput('')
  }, [convId])

  const submitUrl = (e: React.FormEvent) => {
    e.preventDefault()
    if (convId) {
      window.api.drawerNavigate(convId, urlInput)
    }
  }

  return (
    <>
      <div className="flex items-center gap-1 overflow-x-auto border-b border-border px-2 py-1">
        {bstate.tabs.map((t, i) => (
          <div
            key={t.id}
            {...browserReorder.props(i)}
            onClick={() => convId && window.api.drawerSwitchTab(convId, t.id)}
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
                if (convId) window.api.drawerCloseTab(convId, t.id)
              }}
            />
          </div>
        ))}
        <Button
          variant="ghost"
          size="icon"
          className="size-6 shrink-0"
          onClick={() => convId && window.api.drawerNewTab(convId)}
          title={tr('browserChrome.newTab')}
        >
          <Plus className="size-3.5" />
        </Button>
      </div>
      <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          disabled={!bstate.canGoBack}
          onClick={() => convId && window.api.drawerBack(convId)}
        >
          <ArrowLeft className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          disabled={!bstate.canGoForward}
          onClick={() => convId && window.api.drawerForward(convId)}
        >
          <ArrowRight className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          onClick={() => convId && window.api.drawerReload(convId)}
        >
          <RotateCw className={cn('size-4', activeTab?.loading && 'animate-spin')} />
        </Button>
        <form onSubmit={submitUrl} className="flex-1">
          <input
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            placeholder={tr('browserChrome.urlPlaceholder')}
            className="h-7 w-full rounded-md border border-input bg-transparent px-2 text-xs outline-none focus:ring-1 focus:ring-ring"
          />
        </form>
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
        <HoverTip label={tr('browserChrome.toggleDevtools')} align="right">
          <Button
            variant={bstate.devtoolsOpen ? 'secondary' : 'ghost'}
            size="icon"
            className="size-7"
            onClick={() => {
              if (convId) {
                window.api.drawerDevTools(convId)
              }
            }}
            aria-label={tr('browserChrome.toggleDevtools')}
          >
            <Bug className="size-4" />
          </Button>
        </HoverTip>
      </div>
    </>
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
