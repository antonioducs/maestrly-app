/** Position native panel views inside the drawer slot and synchronize floating-window state.
 * Keep native surfaces aligned when surrounding layout changes, including sidebar resizes. */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import {
  Globe,
  Monitor,
  Code2,
  SquareTerminal,
  Maximize2,
  Minimize2,
  ClipboardList,
  GitPullRequest,
  StickyNote,
  Files,
  PictureInPicture2,
  PictureInPicture,
  RotateCw,
  X,
  Plus,
  LayoutGrid,
} from 'lucide-react'
import type { Conversation, DrawerPlacement, PlanReceived } from '../../preload'
import type { DrawerTab } from '../../shared/tool-tabs'
import { cn } from '@/lib/utils'
import { useHostApi } from '@/lib/hosts/host-context'
import { isRemoteKey, rawId } from '@/lib/hosts/shell-keys'
import { useReorder } from '@/lib/use-reorder'
import { Button } from '@/components/ui/button'
import { BrowserChrome } from '@/components/BrowserChrome'
import { RemoteBrowserSurface } from '@/components/RemoteBrowserSurface'
import { ConversationComputer } from '@/components/ConversationComputer'
import { ToolPalette } from '@/components/ToolPalette'

export type Tab = DrawerTab

interface Props {
  activeConv: Conversation | null

  visible: boolean

  suspended: boolean
  onClose: () => void

  isFull: boolean
  onToggleFull: () => void

  activePlan: PlanReceived | null

  /** Active tab; null when no tool is open (empty state). */
  tab: Tab | null
  /** Activates (and opens when needed) a tab. */
  onTabChange: (tab: Tab) => void

  /** Tabs currently shown in the bar, in display order. */
  openTabs: Tab[]
  onCloseTab: (tab: Tab) => void
  onReorderOpenTabs: (from: number, to: number) => void
  /** Catalog order used by the "+" palette (Settings → tab order). */
  catalogOrder: Tab[]
}

export interface TermTab {
  id: string
  cwd: string

  label?: string
}

const DETACHABLE = new Set<Tab>(['vscode', 'notes', 'review', 'plan', 'browser', 'computer', 'terminal', 'files'])

const SLOT_TABS = new Set<Tab>(['browser', 'vscode', 'notes', 'review', 'plan', 'terminal', 'files'])
const PANEL_TABS_UI = new Set<Tab>(['notes', 'review', 'plan', 'terminal', 'files']) // panel.html hosts the second renderer.

const mainTabDefs = (t: TFunction): Record<Tab, { label: string; icon: React.ReactNode }> => ({
  browser: { label: t('drawer.tabBrowser'), icon: <Globe className="size-4" /> },
  computer: { label: t('drawer.tabComputer'), icon: <Monitor className="size-4" /> },
  vscode: { label: t('drawer.tabCode'), icon: <Code2 className="size-4" /> },
  terminal: { label: t('drawer.tabTerminal'), icon: <SquareTerminal className="size-4" /> },
  files: { label: t('drawer.tabFiles'), icon: <Files className="size-4" /> },
  plan: { label: t('drawer.tabPlan'), icon: <ClipboardList className="size-4" /> },
  review: { label: t('drawer.tabReview'), icon: <GitPullRequest className="size-4" /> },
  notes: { label: t('drawer.tabNotes'), icon: <StickyNote className="size-4" /> },
})

export function Drawer({
  activeConv,
  visible,
  suspended,
  isFull,
  onToggleFull,
  activePlan,
  tab,
  onTabChange,
  openTabs,
  onCloseTab,
  onReorderOpenTabs,
  catalogOrder,
}: Props) {
  const { t } = useTranslation('ui')
  const api = useHostApi()
  const tabDefs = mainTabDefs(t)
  const convId = activeConv?.id ?? null
  // The window knows a remote host's conversation by its host key; that host's API takes its own id. A remote
  // host's browser is streamed into the drawer (RemoteBrowserSurface) instead of placed as a native view.
  const remoteConv = convId !== null && isRemoteKey(convId)
  const hostConvId = convId === null ? null : rawId(convId)
  const addressRef = useRef<HTMLInputElement>(null)
  const focusAddress = useCallback(() => {
    addressRef.current?.focus()
    addressRef.current?.select()
  }, [])
  const setTab = onTabChange

  const selectTab = (key: Tab): void => {
    setTab(key)
  }

  const tabsReorder = useReorder(onReorderOpenTabs, { noDragSelector: '[data-tab-close]' })
  // Native views paint above the DOM. While the palette is open, the docked view moves offscreen and a
  // frozen frame of it (captured just before) fills the slot, so the popover floats over a still image.
  const [palette, setPalette] = useState<{ open: boolean; snapshot: string | null }>({ open: false, snapshot: null })
  const paletteOpen = palette.open
  const addBtnRef = useRef<HTMLButtonElement>(null)
  const closePalette = useCallback(() => setPalette({ open: false, snapshot: null }), [])
  const openPalette = useCallback(async () => {
    let snapshot: string | null = null
    if (convId) {
      try {
        snapshot = await window.api.drawerCaptureSlot(convId)
      } catch {
        snapshot = null
      }
    }
    setPalette({ open: true, snapshot })
  }, [convId])
  const paletteItems = catalogOrder.map((key) => ({ key, label: tabDefs[key].label, icon: tabDefs[key].icon }))

  const slotRef = useRef<HTMLDivElement>(null)

  const [floating, setFloating] = useState<Set<Tab>>(new Set())
  const isFloating = (t: Tab): boolean => floating.has(t)
  // The tabs main placed out of the slot (popup or floating window). Unknown until main answers for this conversation.
  const [placement, setPlacement] = useState<DrawerPlacement | null>(null)
  // A host streams a browser to one viewer at a time: out of the slot, the popup or window streams it instead. The
  // computer, likewise, is watched from its popup or window while it is out of the slot.
  const remoteBrowserDocked = placement?.convId === convId && !placement.outOfSlot.includes('browser')
  const remoteComputerDocked = placement?.convId === convId && !placement.outOfSlot.includes('computer')

  const [restarting, setRestarting] = useState(false)
  // Closing a floating tab reattaches it first so the native view returns to the drawer slot.
  const closeTab = (t: Tab): void => {
    if (convId && floating.has(t)) window.api.drawerReattach(convId, t)
    onCloseTab(t)
  }
  const toggleDetach = (t: Tab): void => {
    if (!convId || !DETACHABLE.has(t)) return
    if (floating.has(t)) {
      window.api.drawerReattach(convId, t)
      return
    }
    if (t === 'browser' && hostConvId) api.drawerEnsureBrowser(hostConvId)
    if (t === 'vscode') {
      if (!activeConv) return
      void window.api
        .drawerLoadVSCode(activeConv.id, activeConv.cwd)
        .then(() => window.api.drawerDetach(convId, t))
        .catch((e) => console.error('vscode:', e))
      return
    }
    window.api.drawerDetach(convId, t)
  }

  const restartVSCode = (): void => {
    if (restarting) return
    setRestarting(true)
    void window.api
      .drawerRestartVSCode(convId ?? undefined)
      .catch((e) => console.error('vscode restart:', e))
      .finally(() => setRestarting(false))
  }

  useEffect(() => {
    setFloating(new Set())
    if (convId) {
      let alive = true
      void window.api.getFloatingState(convId).then((s) => {
        if (alive && s.convId === convId) setFloating(new Set<Tab>(s.floating))
      })
      const off = window.api.onFloatingState((s) => {
        if (s.convId !== convId) return
        setFloating(new Set<Tab>(s.floating))
      })
      return () => {
        alive = false
        off()
      }
    }
    return window.api.onFloatingState((s) => {
      if (s.convId !== convId) return
      setFloating(new Set<Tab>(s.floating))
    })
  }, [convId])

  useEffect(() => {
    setPlacement(null)
    if (!convId) return
    let alive = true
    // Main answers and pushes in order: the answer holds every change pushed before it.
    const apply = (next: DrawerPlacement): void => {
      if (alive && next.convId === convId) setPlacement(next)
    }
    void window.api.getDrawerPlacement(convId).then(apply)
    const off = window.api.onDrawerPlacement(apply)
    return () => {
      alive = false
      off()
    }
  }, [convId])

  useLayoutEffect(() => {
    const kind =
      visible && tab && SLOT_TABS.has(tab) && !suspended && !paletteOpen && convId && !floating.has(tab) ? tab : null
    const el = slotRef.current
    if (!kind || !el || !convId) {
      window.api.drawerLayout({ convId, visibleKind: null })
      return
    }

    let last = ''
    let raf: number | null = null
    const measure = () => {
      raf = null
      const r = el.getBoundingClientRect()
      if (r.width > 0 && r.height > 0) {
        const key = `${Math.round(r.left)}:${Math.round(r.top)}:${Math.round(r.width)}:${Math.round(r.height)}`
        if (key !== last) {
          last = key
          window.api.drawerLayout({
            convId,
            visibleKind: kind,
            bounds: { x: r.left, y: r.top, width: r.width, height: r.height },
          })
        }
      }
    }
    const scheduleMeasure = () => {
      if (raf !== null) return
      raf = requestAnimationFrame(measure)
    }
    scheduleMeasure()
    const settleTimer = window.setTimeout(scheduleMeasure, 100)
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(scheduleMeasure) : null
    ro?.observe(el)
    // The slot can move when a sibling/sidebar changes width without changing its own box. These
    // event-driven signals cover that case and remain idle while the layout is stable.
    if (el.parentElement) ro?.observe(el.parentElement)
    window.addEventListener('resize', scheduleMeasure)
    window.addEventListener('scroll', scheduleMeasure, true)
    window.visualViewport?.addEventListener('resize', scheduleMeasure)
    window.visualViewport?.addEventListener('scroll', scheduleMeasure)
    return () => {
      window.clearTimeout(settleTimer)
      if (raf !== null) cancelAnimationFrame(raf)
      ro?.disconnect()
      window.removeEventListener('resize', scheduleMeasure)
      window.removeEventListener('scroll', scheduleMeasure, true)
      window.visualViewport?.removeEventListener('resize', scheduleMeasure)
      window.visualViewport?.removeEventListener('scroll', scheduleMeasure)
      window.api.drawerLayout({ convId, visibleKind: null })
    }
  }, [tab, suspended, paletteOpen, convId, visible, floating])

  useEffect(() => {
    if (visible && tab === 'browser' && hostConvId) api.drawerEnsureBrowser(hostConvId)
  }, [visible, tab, hostConvId, api])

  useEffect(() => {
    if (visible && tab === 'vscode' && activeConv) {
      window.api.drawerLoadVSCode(activeConv.id, activeConv.cwd).catch((e) => console.error('vscode:', e))
    }
  }, [visible, tab, activeConv?.id, activeConv?.cwd])

  useEffect(() => {
    if (visible && convId && tab && !isFloating(tab) && PANEL_TABS_UI.has(tab)) {
      window.api.drawerEnsurePanel(convId, tab as 'terminal' | 'files' | 'plan' | 'review' | 'notes')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, tab, convId, floating])

  return (
    <aside className="glass relative flex h-full min-w-0 flex-1 flex-col bg-surface">
      <div className="drag flex h-10 items-center gap-1 hairline-b px-2">
        <div
          role="tablist"
          aria-label={t('drawer.tabsLabel')}
          className="no-drag flex min-w-0 items-center gap-0.5 overflow-x-auto py-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {openTabs.map((key, i) => (
            <OpenTab
              key={key}
              icon={tabDefs[key].icon}
              label={tabDefs[key].label}
              active={tab === key}
              dot={key === 'plan' && !!activePlan}
              closeLabel={t('drawer.closeTab', { tab: tabDefs[key].label })}
              onClick={() => selectTab(key)}
              onClose={() => closeTab(key)}
              onNavigate={(dir) => {
                const next = openTabs[(i + dir + openTabs.length) % openTabs.length]
                if (next) selectTab(next)
              }}
              dragProps={tabsReorder.props(i)}
              dropTarget={tabsReorder.overIndex === i}
            />
          ))}
        </div>
        <button
          ref={addBtnRef}
          type="button"
          aria-haspopup="dialog"
          aria-expanded={paletteOpen}
          title={t('drawer.addTab')}
          onClick={() => (paletteOpen ? closePalette() : void openPalette())}
          className={cn(
            'no-drag flex size-7 shrink-0 items-center justify-center rounded-md transition-all duration-150',
            paletteOpen
              ? 'rotate-45 bg-primary/15 text-primary'
              : 'text-muted-foreground hover:bg-white/[0.06] hover:text-foreground'
          )}
        >
          <Plus className="size-4" />
        </button>
        <div className="min-w-0 flex-1" />
        {tab === 'vscode' && activeConv && (
          <Button
            variant="ghost"
            size="icon"
            className="no-drag size-7 shrink-0"
            onClick={restartVSCode}
            disabled={restarting}
            title={t('drawer.restartVSCode')}
          >
            <RotateCw className={cn('size-4', restarting && 'animate-spin')} />
          </Button>
        )}
        {tab && DETACHABLE.has(tab) && (
          <Button
            variant={isFloating(tab) ? 'secondary' : 'ghost'}
            size="icon"
            className="no-drag size-7 shrink-0"
            onClick={() => toggleDetach(tab)}
            title={isFloating(tab) ? t('drawer.reattach') : t('drawer.detach')}
          >
            {isFloating(tab) ? <PictureInPicture className="size-4" /> : <PictureInPicture2 className="size-4" />}
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="no-drag size-7 shrink-0"
          onClick={onToggleFull}
          title={isFull ? t('drawer.restoreSize') : t('drawer.fullScreen')}
        >
          {isFull ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
        </Button>
      </div>

      <ToolPalette
        open={paletteOpen}
        items={paletteItems}
        openTabs={openTabs}
        onPick={selectTab}
        onClose={closePalette}
        ignoreRef={addBtnRef}
      />

      {tab === 'browser' && !isFloating('browser') && hostConvId && (
        <BrowserChrome convId={hostConvId} addressRef={addressRef} />
      )}

      <div className="relative min-h-0 flex-1">
        {tab === null && (
          <EmptyState
            title={t('drawer.emptyTitle')}
            hint={t('drawer.emptyHint')}
            more={t('drawer.emptyMore')}
            quick={(['browser', 'terminal', 'vscode'] as Tab[])
              .filter((k) => catalogOrder.includes(k))
              .map((k) => ({ key: k, label: tabDefs[k].label, icon: tabDefs[k].icon }))}
            onPick={selectTab}
          />
        )}

        {tab === 'browser' && remoteConv && hostConvId && remoteBrowserDocked && (
          <RemoteBrowserSurface key={convId} convId={hostConvId} active={visible} onFocusAddress={focusAddress} />
        )}

        {tab === 'computer' && remoteConv && hostConvId && remoteComputerDocked && (
          <ConversationComputer key={convId} convId={hostConvId} active={visible} />
        )}

        {tab && SLOT_TABS.has(tab) && convId && !isFloating(tab) && !(tab === 'browser' && remoteConv) && (
          <div ref={slotRef} className="absolute inset-0 bg-[#0A0A0B]">
            {paletteOpen && palette.snapshot && (
              <img
                src={palette.snapshot}
                alt=""
                draggable={false}
                className="pointer-events-none absolute inset-0 h-full w-full select-none object-cover object-left-top"
              />
            )}
          </div>
        )}

        {tab && isFloating(tab) && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-[#111113] p-6 text-center">
            <div className="flex size-12 items-center justify-center rounded-2xl bg-white/[0.04] ring-1 ring-white/[0.06]">
              <PictureInPicture2 className="size-6 text-muted-foreground" />
            </div>
            <p className="text-sm text-muted-foreground">{t('drawer.floatingNotice', { tab: tabDefs[tab].label })}</p>
            <Button variant="secondary" size="sm" className="gap-1.5" onClick={() => toggleDetach(tab)}>
              <PictureInPicture className="size-4" /> {t('drawer.reattach')}
            </Button>
          </div>
        )}

        {tab === 'vscode' && !activeConv && <Hint>{t('drawer.vscodeSelectConv')}</Hint>}
      </div>
    </aside>
  )
}

/** Pill for an open tool. Middle click / Delete close it; ←/→ move focus between open tabs. */
function OpenTab({
  icon,
  label,
  active,
  onClick,
  onClose,
  onNavigate,
  closeLabel,
  dot,
  dragProps,
  dropTarget,
}: {
  icon: React.ReactNode
  label: string
  active: boolean
  onClick: () => void
  onClose: () => void
  onNavigate: (dir: -1 | 1) => void
  closeLabel: string
  dot?: boolean
  dragProps?: React.HTMLAttributes<HTMLDivElement> & { draggable?: boolean }
  dropTarget?: boolean
}) {
  return (
    <div
      role="tab"
      tabIndex={active ? 0 : -1}
      aria-selected={active}
      title={label}
      onClick={onClick}
      onAuxClick={(e) => {
        if (e.button === 1) {
          e.preventDefault()
          onClose()
        }
      }}
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
          e.preventDefault()
          onNavigate(e.key === 'ArrowRight' ? 1 : -1)
        } else if (e.key === 'Delete' || e.key === 'Backspace') {
          e.preventDefault()
          onClose()
        } else if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onClick()
        }
      }}
      {...dragProps}
      className={cn(
        'group relative flex h-7 shrink-0 cursor-pointer select-none items-center gap-1.5 whitespace-nowrap rounded-md pl-2 pr-1 text-xs font-medium outline-none transition-all duration-150',
        'focus-visible:ring-2 focus-visible:ring-ring',
        active
          ? 'bg-white/[0.08] text-foreground shadow-sm ring-1 ring-white/[0.08]'
          : 'text-muted-foreground hover:bg-white/[0.05] hover:text-foreground',
        dropTarget && 'ring-1 ring-primary/60'
      )}
    >
      {icon}
      <span>{label}</span>
      {dot && (
        <span className="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-primary shadow-[0_0_6px_rgba(237,234,227,0.5)]" />
      )}
      <button
        type="button"
        data-tab-close
        tabIndex={-1}
        aria-label={closeLabel}
        title={closeLabel}
        onClick={(e) => {
          e.stopPropagation()
          onClose()
        }}
        className={cn(
          'flex size-4 items-center justify-center rounded text-muted-foreground transition-all duration-150 hover:bg-white/[0.12] hover:text-foreground',
          active ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'
        )}
      >
        <X className="size-3" />
      </button>
      {active && (
        <span className="pointer-events-none absolute inset-x-2 -bottom-[5px] h-0.5 rounded-full bg-primary/90" />
      )}
    </div>
  )
}

function EmptyState({
  title,
  hint,
  more,
  quick,
  onPick,
}: {
  title: string
  hint: string
  more: string
  quick: Array<{ key: Tab; label: string; icon: React.ReactNode }>
  onPick: (tab: Tab) => void
}) {
  return (
    <div className="flex h-full items-center justify-center overflow-auto p-8 [background:radial-gradient(520px_240px_at_50%_0%,rgba(237,234,227,0.05),transparent_60%)]">
      <div className="flex w-full max-w-sm flex-col items-center gap-3 text-center">
        <div className="flex size-14 items-center justify-center rounded-2xl border border-border-strong bg-surface-elevated text-primary shadow-xl shadow-black/30">
          <LayoutGrid className="size-6" />
        </div>
        <h2 className="mt-1 text-base font-semibold tracking-tight text-foreground">{title}</h2>
        <p className="text-sm leading-5 text-muted-foreground">{hint}</p>
        {quick.length > 0 && (
          <div className="mt-2 grid w-full grid-cols-3 gap-2">
            {quick.map((q) => (
              <button
                key={q.key}
                type="button"
                onClick={() => onPick(q.key)}
                className="flex flex-col items-start gap-2 rounded-lg border border-border bg-white/[0.03] p-3 text-left text-xs text-foreground transition-all duration-150 hover:-translate-y-px hover:border-border-strong hover:bg-white/[0.06]"
              >
                <span className="text-muted-foreground">{q.icon}</span>
                <span>{q.label}</span>
              </button>
            ))}
          </div>
        )}
        <p className="text-[11px] text-muted-foreground/80">{more}</p>
      </div>
    </div>
  )
}

function Hint({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
      {children}
    </div>
  )
}
