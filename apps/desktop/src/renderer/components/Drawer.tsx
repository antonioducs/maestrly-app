/** Position native panel views inside the drawer slot and synchronize floating-window state.
 * Keep native surfaces aligned when surrounding layout changes, including sidebar resizes. */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import {
  Globe,
  Code2,
  SquareTerminal,
  Maximize2,
  Minimize2,
  ClipboardList,
  GitPullRequest,
  StickyNote,
  MessageCircle,
  PictureInPicture2,
  PictureInPicture,
  RotateCw,
  Loader2,
  ArrowUpRight,
  Check,
  Copy,
  Link2,
  ShieldCheck,
  Settings2,
  Shield,
  X,
} from 'lucide-react'
import type { ChatGptWebSessionInfo, Conversation, PlanReceived } from '../../preload'
import type { ChatGptWebCapabilitiesInfo } from '../../shared/chat'
import { isReviewLoopConversationReserved } from '../../shared/chat'
import type { DrawerTab } from '../../shared/tool-tabs'
import { cn } from '@/lib/utils'
import { useReorder } from '@/lib/use-reorder'
import { Button } from '@/components/ui/button'
import { BrowserChrome } from '@/components/BrowserChrome'
import { restartChatGptWebCompanion, startChatGptWebCompanion } from '@/lib/chatgpt-web'
import { ChatGptWebAccessEditor } from '@/components/chat/ChatGptWebAccessEditor'

export type Tab = DrawerTab

interface Props {
  activeConv: Conversation | null

  visible: boolean

  suspended: boolean
  onClose: () => void

  isFull: boolean
  onToggleFull: () => void

  activePlan: PlanReceived | null

  tab: Tab
  onTabChange: (tab: Tab) => void

  mainTabOrder: Tab[]
  onReorderMainTabs: (from: number, to: number) => void

  chatGptWebEnabled: boolean
}

export interface TermTab {
  id: string
  cwd: string

  label?: string
}

const DETACHABLE = new Set<Tab>(['vscode', 'notes', 'review', 'plan', 'browser', 'terminal', 'chatgpt'])

const SLOT_TABS = new Set<Tab>(['browser', 'vscode', 'notes', 'review', 'plan', 'terminal', 'chatgpt'])
const PANEL_TABS_UI = new Set<Tab>(['notes', 'review', 'plan', 'terminal']) // panel.html hosts the second renderer.

const mainTabDefs = (t: TFunction): Record<Tab, { label: string; icon: React.ReactNode }> => ({
  browser: { label: t('drawer.tabBrowser'), icon: <Globe className="size-4" /> },
  vscode: { label: t('drawer.tabCode'), icon: <Code2 className="size-4" /> },
  terminal: { label: t('drawer.tabTerminal'), icon: <SquareTerminal className="size-4" /> },
  plan: { label: t('drawer.tabPlan'), icon: <ClipboardList className="size-4" /> },
  review: { label: t('drawer.tabReview'), icon: <GitPullRequest className="size-4" /> },
  notes: { label: t('drawer.tabNotes'), icon: <StickyNote className="size-4" /> },

  chatgpt: { label: t('drawer.tabChatGpt'), icon: <MessageCircle className="size-4" /> },
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
  mainTabOrder,
  onReorderMainTabs,
  chatGptWebEnabled,
}: Props) {
  const { t } = useTranslation('ui')
  const tabDefs = mainTabDefs(t)
  const convId = activeConv?.id ?? null
  const setTab = onTabChange

  const selectTab = (key: Tab): void => {
    setTab(key)
  }

  const mainReorder = useReorder(onReorderMainTabs)

  const slotRef = useRef<HTMLDivElement>(null)

  const [floating, setFloating] = useState<Set<Tab>>(new Set())
  const isFloating = (t: Tab): boolean => floating.has(t)
  const [chatGptSession, setChatGptSession] = useState<ChatGptWebSessionInfo | null>(null)
  const [chatGptStarting, setChatGptStarting] = useState(false)
  const [chatGptError, setChatGptError] = useState<string | null>(null)
  const [chatGptPromptCopied, setChatGptPromptCopied] = useState(false)
  const [chatGptCopying, setChatGptCopying] = useState(false)
  const [chatGptCapabilities, setChatGptCapabilities] = useState<ChatGptWebCapabilitiesInfo | null>(null)
  const [chatGptAccessOpen, setChatGptAccessOpen] = useState(false)
  const [chatGptAccessBusy, setChatGptAccessBusy] = useState(false)
  const chatGptSessionActive = chatGptSession !== null
  const chatGptPairingRequired = chatGptSession?.pairingRequired === true
  const chatGptReviewLoopActive = isReviewLoopConversationReserved(chatGptSession?.reviewLoop?.status)

  const [restarting, setRestarting] = useState(false)
  const toggleDetach = (t: Tab): void => {
    if (!convId || !DETACHABLE.has(t)) return
    if (floating.has(t)) {
      window.api.drawerReattach(convId, t)
      return
    }
    if (t === 'browser') window.api.drawerEnsureBrowser(convId)
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
      .drawerRestartVSCode()
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
    if (!convId || !chatGptWebEnabled) {
      setChatGptSession(null)
      return
    }
    let alive = true
    const apply = (status: { sessions: Array<{ conversationId: string; state: string }> }) => {
      if (!alive) return
      setChatGptSession(
        (status.sessions.find((s) => s.conversationId === convId && s.state !== 'ended') as
          | ChatGptWebSessionInfo
          | undefined) ?? null
      )
    }
    void window.api
      .chatGptWebStatus()
      .then(apply)
      .catch(() => setChatGptSession(null))
    const off = window.api.onChatGptWebStatus(apply)
    return () => {
      alive = false
      off()
    }
  }, [convId, chatGptWebEnabled])

  useEffect(() => {
    setChatGptError(null)
    setChatGptStarting(false)
    setChatGptPromptCopied(false)
    setChatGptCopying(false)
    setChatGptAccessOpen(false)
    setChatGptAccessBusy(false)
  }, [convId, chatGptWebEnabled])

  useEffect(() => {
    if (!convId || !chatGptWebEnabled) {
      setChatGptCapabilities(null)
      return
    }
    let alive = true
    setChatGptCapabilities(null)
    void window.api
      .chatGptWebCapabilities(convId)
      .then((value) => {
        if (alive) setChatGptCapabilities(value)
      })
      .catch((cause) => {
        if (alive) setChatGptError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => {
      alive = false
    }
  }, [convId, chatGptWebEnabled, chatGptSessionActive])

  const startCompanion = async (): Promise<void> => {
    if (!convId || chatGptStarting || !chatGptCapabilities?.editable) return
    setChatGptStarting(true)
    setChatGptError(null)
    try {
      const saved = await window.api.chatGptWebSetCapabilities(convId, chatGptCapabilities.capabilities)
      const result = await startChatGptWebCompanion(convId)
      setChatGptCapabilities({ ...saved, editable: false })
      setChatGptPromptCopied(result.promptCopied)
    } catch (cause) {
      setChatGptError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setChatGptStarting(false)
    }
  }

  const restartCompanionWithAccess = async (): Promise<void> => {
    if (!convId || !chatGptCapabilities || chatGptAccessBusy || chatGptReviewLoopActive) return
    setChatGptAccessBusy(true)
    setChatGptError(null)
    let previousSessionEnded = false
    try {
      const capabilities = chatGptCapabilities.capabilities

      const result = await restartChatGptWebCompanion(convId, capabilities, chatGptReviewLoopActive, {
        chatGptWebCompanionStart: (conversationId) => window.api.chatGptWebCompanionStart(conversationId),
        chatGptWebCompanionCopyPrompt: (conversationId) => window.api.chatGptWebCompanionCopyPrompt(conversationId),
        chatGptWebCompanionOpen: (conversationId) => window.api.chatGptWebCompanionOpen(conversationId),
        chatGptWebSetCapabilities: (conversationId, value) =>
          window.api.chatGptWebSetCapabilities(conversationId, value),
        chatGptWebCompanionEnd: async (conversationId) => {
          const ended = await window.api.chatGptWebCompanionEnd(conversationId)
          previousSessionEnded = ended.ok
          return ended
        },
      })
      setChatGptCapabilities({ ...result.capabilities, editable: false })
      setChatGptPromptCopied(result.promptCopied)
      setChatGptAccessOpen(false)
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause)
      if (previousSessionEnded) {
        try {
          setChatGptCapabilities(await window.api.chatGptWebCapabilities(convId))
        } catch {}
      }
      setChatGptError(
        previousSessionEnded
          ? t('drawer.chatgptRestartAfterEndError', { error: detail })
          : t('drawer.chatgptRestartError', { error: detail })
      )
    } finally {
      setChatGptAccessBusy(false)
    }
  }

  const openCompanionAccess = async (): Promise<void> => {
    if (!convId) return
    setChatGptError(null)
    try {
      setChatGptCapabilities(await window.api.chatGptWebCapabilities(convId))
      setChatGptAccessOpen(true)
    } catch (cause) {
      setChatGptError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const copyPairingPrompt = async (): Promise<void> => {
    if (!convId || chatGptCopying) return
    setChatGptCopying(true)
    try {
      const result = await window.api.chatGptWebCompanionCopyPrompt(convId)
      setChatGptPromptCopied(result.ok)
    } catch {
      setChatGptPromptCopied(false)
    } finally {
      setChatGptCopying(false)
    }
  }

  useLayoutEffect(() => {
    const kind = visible && SLOT_TABS.has(tab) && !suspended && convId && !floating.has(tab) ? tab : null
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
  }, [tab, suspended, convId, visible, floating, chatGptSessionActive, chatGptAccessOpen])

  useEffect(() => {
    if (visible && tab === 'browser' && convId) window.api.drawerEnsureBrowser(convId)
  }, [visible, tab, convId])

  useEffect(() => {
    if (visible && tab === 'vscode' && activeConv) {
      window.api.drawerLoadVSCode(activeConv.id, activeConv.cwd).catch((e) => console.error('vscode:', e))
    }
  }, [visible, tab, activeConv?.id, activeConv?.cwd])

  useEffect(() => {
    if (visible && convId && !isFloating(tab) && PANEL_TABS_UI.has(tab)) {
      window.api.drawerEnsurePanel(convId, tab as 'terminal' | 'plan' | 'review' | 'notes')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, tab, convId, floating])

  return (
    <aside className="glass flex h-full min-w-0 flex-1 flex-col bg-surface">
      <div className="drag flex h-10 items-center gap-1 hairline-b px-2">
        <div className="no-drag min-w-0 flex-1 overflow-x-auto">
          <div className="flex w-max items-center gap-0.5 rounded-lg bg-white/[0.04] p-0.5 ring-1 ring-white/[0.05]">
            {mainTabOrder.map((key, i) => (
              <MainTab
                key={key}
                icon={tabDefs[key].icon}
                label={tabDefs[key].label}
                active={tab === key}
                dot={key === 'plan' && !!activePlan}
                onClick={() => selectTab(key)}
                dragProps={mainReorder.props(i)}
                dropTarget={mainReorder.overIndex === i}
              />
            ))}
          </div>
        </div>
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
        {DETACHABLE.has(tab) && (tab !== 'chatgpt' || chatGptSessionActive) && (
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

      {tab === 'browser' && !isFloating('browser') && convId && <BrowserChrome convId={convId} />}

      <div className="relative min-h-0 flex-1">
        {SLOT_TABS.has(tab) &&
          convId &&
          !isFloating(tab) &&
          (tab !== 'chatgpt' || (chatGptSessionActive && !chatGptAccessOpen)) && (
            <div
              ref={slotRef}
              className={cn(
                'absolute inset-x-0 bottom-0 bg-[#0A0A0B]',
                tab === 'chatgpt' ? (chatGptPairingRequired ? 'top-[120px]' : 'top-11') : 'top-0'
              )}
            />
          )}

        {tab === 'chatgpt' && chatGptSessionActive && !isFloating('chatgpt') && (
          <div className="absolute inset-x-0 top-0 flex h-11 items-center gap-2 border-b border-white/[0.08] bg-[#111113] px-3 text-[11px] text-muted-foreground">
            <span
              className={cn(
                'size-2 shrink-0 rounded-full',
                chatGptSession.state === 'live' ? 'bg-emerald-400' : 'bg-violet-400'
              )}
            />
            <span className="shrink-0 font-medium text-foreground">
              {chatGptSession.state === 'live' ? t('drawer.chatgptConnected') : t('drawer.chatgptConnecting')}
            </span>
            {chatGptSession.capabilities && (
              <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
                <span
                  className={cn(
                    'shrink-0 rounded border px-1.5 py-0.5 font-medium',
                    chatGptSession.capabilities.browser === 'off'
                      ? 'border-amber-500/25 bg-amber-500/[0.07] text-amber-200'
                      : 'border-violet-400/25 bg-violet-500/[0.08] text-violet-200'
                  )}
                >
                  {t('drawer.chatgptBrowserBadge', {
                    scope: t(`drawer.chatgptBrowser_${chatGptSession.capabilities.browser}`),
                  })}
                </span>
                <span className="shrink-0 rounded bg-white/[0.05] px-1.5 py-0.5">
                  {t('drawer.chatgptGitBadge', {
                    state: t(
                      chatGptSession.capabilities.gitRead ? 'drawer.chatgptAccessOn' : 'drawer.chatgptAccessOff'
                    ),
                  })}
                </span>
                <span className="shrink-0 rounded bg-white/[0.05] px-1.5 py-0.5">
                  {t('drawer.chatgptGhBadge', {
                    state: t(chatGptSession.capabilities.ghRead ? 'drawer.chatgptAccessOn' : 'drawer.chatgptAccessOff'),
                  })}
                </span>
                {(chatGptSession.capabilities.mcpRead > 0 || chatGptSession.capabilities.mcpWrite > 0) && (
                  <span className="shrink-0 rounded bg-white/[0.05] px-1.5 py-0.5">
                    {t('drawer.chatgptMcpBadge', {
                      read: chatGptSession.capabilities.mcpRead,
                      write: chatGptSession.capabilities.mcpWrite,
                    })}
                  </span>
                )}
              </div>
            )}
            <Button
              variant={chatGptAccessOpen ? 'secondary' : 'ghost'}
              size="sm"
              className="h-7 shrink-0 gap-1.5 px-2"
              disabled={chatGptAccessBusy}
              onClick={() => (chatGptAccessOpen ? setChatGptAccessOpen(false) : void openCompanionAccess())}
            >
              {chatGptAccessOpen ? <X className="size-3.5" /> : <Settings2 className="size-3.5" />}
              {chatGptAccessOpen ? t('drawer.chatgptCloseAccess') : t('drawer.chatgptAccess')}
            </Button>
          </div>
        )}

        {tab === 'chatgpt' && chatGptSessionActive && chatGptAccessOpen && !isFloating('chatgpt') && (
          <div className="absolute inset-x-0 bottom-0 top-11 overflow-y-auto bg-surface p-4 sm:p-6">
            <div className="mx-auto w-full max-w-3xl">
              <div className="mb-4 flex items-start gap-3 rounded-xl border border-violet-400/20 bg-violet-500/[0.07] p-3 text-[11px] text-violet-100">
                <Shield className="mt-0.5 size-4 shrink-0 text-violet-300" />
                <div>
                  <p className="font-medium text-foreground">{t('drawer.chatgptAccessFrozenTitle')}</p>
                  <p className="mt-0.5 leading-relaxed text-muted-foreground">
                    {t('drawer.chatgptAccessFrozenDescription')}
                  </p>
                </div>
              </div>
              {chatGptCapabilities ? (
                <ChatGptWebAccessEditor
                  info={chatGptCapabilities}
                  capabilities={chatGptCapabilities.capabilities}
                  editable
                  disabled={chatGptAccessBusy}
                  onChange={(capabilities) =>
                    setChatGptCapabilities((current) => (current ? { ...current, capabilities } : current))
                  }
                />
              ) : (
                <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" /> {t('drawer.chatgptAccessLoading')}
                </div>
              )}
              {chatGptReviewLoopActive && (
                <div className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/[0.07] px-3 py-2 text-[11px] text-amber-200">
                  {t('drawer.chatgptRestartBlockedByReview')}
                </div>
              )}
              {chatGptError && (
                <div
                  role="alert"
                  className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/[0.07] px-3 py-2 text-[11px] text-amber-200"
                >
                  {chatGptError}
                </div>
              )}
              <div className="mt-4 flex justify-end">
                <Button
                  className="gap-1.5 bg-violet-500 text-white hover:bg-violet-400"
                  disabled={!chatGptCapabilities || chatGptAccessBusy || chatGptReviewLoopActive}
                  onClick={() => void restartCompanionWithAccess()}
                >
                  {chatGptAccessBusy ? <Loader2 className="size-4 animate-spin" /> : <RotateCw className="size-4" />}
                  {chatGptAccessBusy ? t('drawer.chatgptRestarting') : t('drawer.chatgptRestartToApply')}
                </Button>
              </div>
            </div>
          </div>
        )}

        {tab === 'chatgpt' && chatGptWebEnabled && !chatGptSessionActive && (
          <div className="h-full overflow-auto p-5 sm:p-8">
            <div className="relative mx-auto w-full max-w-3xl overflow-hidden rounded-3xl border border-white/[0.09] bg-gradient-to-b from-white/[0.055] to-white/[0.025] p-5 shadow-2xl shadow-black/20 sm:p-7">
              <div className="pointer-events-none absolute -right-16 -top-20 size-52 rounded-full bg-violet-500/10 blur-3xl" />
              <div className="relative">
                <div className="mb-5 flex items-center gap-3">
                  <div className="flex size-11 items-center justify-center rounded-2xl bg-violet-500/15 ring-1 ring-violet-400/20">
                    <Link2 className="size-5 text-violet-300" />
                  </div>
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-violet-300/80">
                      {t('drawer.chatgptEyebrow')}
                    </p>
                    <h2 className="mt-0.5 text-lg font-semibold tracking-tight text-foreground">
                      {t('drawer.chatgptTitle')}
                    </h2>
                  </div>
                </div>

                <p className="max-w-lg text-sm leading-6 text-muted-foreground">{t('drawer.chatgptDescription')}</p>

                <div className="my-5 grid gap-2.5 sm:grid-cols-3">
                  {[
                    [t('drawer.chatgptStepConnect'), t('drawer.chatgptStepConnectHint')],
                    [t('drawer.chatgptStepPaste'), t('drawer.chatgptStepPasteHint')],
                    [t('drawer.chatgptStepContinue'), t('drawer.chatgptStepContinueHint')],
                  ].map(([title, hint], index) => (
                    <div key={title} className="rounded-xl border border-white/[0.07] bg-black/10 p-3 text-left">
                      <div className="mb-2 flex size-5 items-center justify-center rounded-full bg-white/[0.07] text-[10px] font-semibold text-foreground/80">
                        {index + 1}
                      </div>
                      <p className="text-xs font-medium text-foreground">{title}</p>
                      <p className="mt-1 text-[11px] leading-4 text-muted-foreground">{hint}</p>
                    </div>
                  ))}
                </div>

                {chatGptCapabilities ? (
                  <ChatGptWebAccessEditor
                    info={chatGptCapabilities}
                    capabilities={chatGptCapabilities.capabilities}
                    editable={chatGptCapabilities.editable}
                    disabled={chatGptStarting}
                    onChange={(capabilities) =>
                      setChatGptCapabilities((current) => (current ? { ...current, capabilities } : current))
                    }
                  />
                ) : (
                  <div className="my-5 flex items-center gap-2 rounded-xl border border-white/[0.08] bg-white/[0.03] px-3 py-4 text-sm text-muted-foreground">
                    <Loader2 className="size-4 animate-spin" /> {t('drawer.chatgptAccessLoading')}
                  </div>
                )}

                <Button
                  size="lg"
                  className="mt-5 h-11 w-full rounded-xl bg-violet-500 text-white shadow-lg shadow-violet-950/30 hover:bg-violet-400 sm:w-auto"
                  disabled={chatGptStarting || !chatGptCapabilities?.editable}
                  onClick={() => void startCompanion()}
                >
                  {chatGptStarting ? <Loader2 className="size-4 animate-spin" /> : <ArrowUpRight className="size-4" />}
                  {chatGptStarting
                    ? t('drawer.chatgptStarting')
                    : chatGptCapabilities
                      ? t('drawer.chatgptStartWithBrowser', {
                          scope: t(`drawer.chatgptBrowser_${chatGptCapabilities.capabilities.browser}`),
                        })
                      : t('drawer.chatgptStart')}
                </Button>

                <div className="mt-4 flex items-start gap-2 text-left text-[11px] leading-4 text-muted-foreground">
                  <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-emerald-400/80" />
                  <span>{t('drawer.chatgptPrivacy')}</span>
                </div>

                {chatGptError && (
                  <div
                    role="alert"
                    className="mt-4 rounded-xl border border-amber-500/25 bg-amber-500/[0.07] px-3 py-2 text-xs text-amber-200"
                  >
                    {t('drawer.chatgptStartError', { error: chatGptError })}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {tab === 'chatgpt' &&
          chatGptSessionActive &&
          chatGptPairingRequired &&
          !chatGptAccessOpen &&
          !isFloating('chatgpt') && (
            <div
              role="status"
              aria-live="polite"
              className="absolute inset-x-0 top-11 flex h-[76px] items-center gap-3 border-b border-violet-400/15 bg-violet-500/[0.07] px-4"
            >
              <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-violet-500/15 ring-1 ring-violet-400/20">
                {chatGptPromptCopied ? (
                  <Check className="size-4 text-emerald-300" />
                ) : (
                  <Copy className="size-4 text-violet-300" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium text-foreground">
                  {chatGptPromptCopied ? t('drawer.chatgptPairingCopied') : t('drawer.chatgptPairingReady')}
                </p>
                <p className="truncate text-[11px] text-muted-foreground">
                  {t('drawer.chatgptPairingInstruction', {
                    shortcut: window.api.platformInfo.os === 'mac' ? '⌘V' : 'Ctrl+V',
                  })}
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="h-8 shrink-0 gap-1.5 border-violet-400/20 bg-violet-500/[0.07] text-violet-100 hover:bg-violet-500/15"
                disabled={chatGptCopying}
                onClick={() => void copyPairingPrompt()}
              >
                {chatGptCopying ? <Loader2 className="size-3.5 animate-spin" /> : <Copy className="size-3.5" />}
                {chatGptPromptCopied ? t('drawer.chatgptCopyAgain') : t('drawer.chatgptCopy')}
              </Button>
            </div>
          )}

        {isFloating(tab) && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-surface p-6 text-center">
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

function MainTab({
  icon,
  label,
  active,
  onClick,
  dot,
  dragProps,
  dropTarget,
  disabled,
}: {
  icon: React.ReactNode
  label: string
  active: boolean
  onClick: () => void
  dot?: boolean
  dragProps?: React.HTMLAttributes<HTMLButtonElement> & { draggable?: boolean }
  dropTarget?: boolean

  disabled?: boolean
}) {
  const tabDragProps =
    disabled && dragProps
      ? { ...dragProps, draggable: false, onPointerDown: undefined, onDragStart: undefined }
      : dragProps

  return (
    <button
      onClick={disabled ? undefined : onClick}
      aria-disabled={disabled || undefined}
      {...tabDragProps}
      className={cn(
        'relative flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1 text-xs font-medium transition-all duration-150',
        disabled
          ? 'cursor-not-allowed text-muted-foreground opacity-40'
          : cn(
              'cursor-pointer',
              active
                ? 'bg-white/[0.08] text-foreground shadow-sm ring-1 ring-white/[0.06]'
                : 'text-muted-foreground hover:text-foreground'
            ),
        dropTarget && 'ring-1 ring-primary/60'
      )}
    >
      {icon}
      {label}
      {dot && (
        <span className="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-primary shadow-[0_0_6px_rgba(237,234,227,0.5)]" />
      )}
    </button>
  )
}

function Hint({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
      {children}
    </div>
  )
}
