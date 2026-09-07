import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Bot, ChevronDown, Loader2, PanelRightClose, ShieldCheck, TriangleAlert } from 'lucide-react'
import type { ChatModelMeta, SubagentSessionSummary, SubagentTranscriptPage } from '../../../shared/chat'
import type { OpenFileReference } from '@/components/MarkdownViewer'
import { cn } from '@/lib/utils'
import { subagentEffortLabel, subagentRunCost, subagentRunDisplay } from '@/lib/subagent-profile-display'
import { ChatMessageList } from './ChatMessageList'

function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1_000))
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`
}

function isLive(status: SubagentSessionSummary['status']): boolean {
  return status === 'preparing' || status === 'running'
}

function StatusIcon({ session }: { session: SubagentSessionSummary }) {
  if (isLive(session.status)) return <Loader2 className="size-3.5 animate-spin text-sky-300" />
  if (session.status === 'completed') return <ShieldCheck className="size-3.5 text-emerald-400" />
  return <TriangleAlert className="size-3.5 text-amber-300" />
}

export function SubagentSessionPanel({
  conversationId,
  sessionId,
  sessions,
  onSelect,
  onClose,
  onOpenMention,
}: {
  conversationId: string
  sessionId: string
  sessions: SubagentSessionSummary[]
  onSelect: (sessionId: string) => void
  onClose: () => void
  onOpenMention?: OpenFileReference
}) {
  const { t } = useTranslation('chat')
  const [page, setPage] = useState<SubagentTranscriptPage | null>(null)
  const [loading, setLoading] = useState(true)
  const scrollRef = useRef<HTMLDivElement>(null)
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const activeSessionRef = useRef(sessionId)
  activeSessionRef.current = sessionId
  const [, tick] = useState(0)

  const refresh = () => {
    setLoading((current) => current && page === null)
    void window.api
      .chatSubagentTranscript(conversationId, sessionId, { limit: 1_000 })
      .then((next) => {
        if (activeSessionRef.current !== sessionId) return
        setPage(next)
        setLoading(false)
      })
      .catch(() => {
        if (activeSessionRef.current === sessionId) setLoading(false)
      })
  }

  useEffect(() => {
    setPage(null)
    setLoading(true)
    refresh()
    const off = window.api.onChatSubagentSession(conversationId, (event) => {
      if (event.sessionId !== sessionId) return
      if (refreshTimer.current) return
      refreshTimer.current = setTimeout(() => {
        refreshTimer.current = null
        refresh()
      }, 120)
    })
    return () => {
      off()
      if (refreshTimer.current) clearTimeout(refreshTimer.current)
      refreshTimer.current = null
    }
  }, [conversationId, sessionId])

  const session = page?.session ?? sessions.find((item) => item.id === sessionId) ?? null
  const live = session != null && isLive(session.status)
  const effective = session?.profile?.effective
  const providerId = effective?.providerId
  const modelId = effective?.modelId
  const [modelInfo, setModelInfo] = useState<{
    providerId: string
    modelId: string
    providerName: string | null
    metadata: ChatModelMeta | null
  } | null>(null)

  useEffect(() => {
    if (!live) return
    const timer = setInterval(() => tick((value) => value + 1), 1_000)
    return () => clearInterval(timer)
  }, [live])

  useEffect(() => {
    if (!providerId || !modelId) return
    let cancelled = false
    void Promise.all([
      window.api
        .chatConfig()
        .then((config) => config.providers.find((provider) => provider.id === providerId)?.name ?? null)
        .catch(() => null),
      window.api.chatModelMeta(modelId, providerId).catch(() => null),
    ]).then(([providerName, metadata]) => {
      if (!cancelled) setModelInfo({ providerId, modelId, providerName, metadata })
    })
    return () => {
      cancelled = true
    }
  }, [providerId, modelId])

  const currentModelInfo = modelInfo?.providerId === providerId && modelInfo?.modelId === modelId ? modelInfo : null
  const display = subagentRunDisplay(undefined, session)
  const cost =
    session?.usage || display.runtimeEstimatedCostUsd != null
      ? subagentRunCost(display, currentModelInfo?.metadata ?? null)
      : null
  const duration = session
    ? (session.durationMs ??
      Math.max(0, (session.finishedAt ?? (live ? Date.now() : session.lastActivityAt)) - session.startedAt))
    : 0
  const model = effective
    ? `${currentModelInfo?.providerName ?? t('subagentSession.providerUnavailable')} · ${effective.modelId}`
    : t('subagentSession.modelUnavailable')
  const orderedSessions = useMemo(
    () => [...sessions].sort((left, right) => right.startedAt - left.startedAt),
    [sessions]
  )

  return (
    <section
      aria-label={t('subagentSession.title')}
      className="flex h-full min-h-0 min-w-0 flex-col border-l border-violet-400/20 bg-[#111018] shadow-[-18px_0_40px_rgba(0,0,0,0.22)]"
    >
      <header className="border-b border-violet-400/15 bg-violet-400/[0.045] px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <div className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-violet-400/10 ring-1 ring-violet-400/20">
            <Bot className="size-4 text-violet-300" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="truncate text-xs font-semibold text-violet-100">
                {session?.agentName ?? t('subagentSession.title')}
              </span>
              {session && <StatusIcon session={session} />}
            </div>
            <div className="break-words text-[10px] text-muted-foreground">{model}</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 text-muted-foreground hover:bg-white/[0.06] hover:text-foreground"
            title={t('subagentSession.close')}
            aria-label={t('subagentSession.close')}
          >
            <PanelRightClose className="size-4" />
          </button>
        </div>

        {orderedSessions.length > 1 && (
          <label className="relative mt-2 block">
            <span className="sr-only">{t('subagentSession.select')}</span>
            <select
              value={sessionId}
              onChange={(event) => onSelect(event.target.value)}
              className="h-7 w-full appearance-none rounded-md border border-white/[0.08] bg-black/20 px-2 pr-7 text-[11px] text-foreground outline-none focus:border-violet-400/40"
            >
              {orderedSessions.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.agentName} · {t(`subagentSession.status.${item.status}`)}
                </option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-2 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" />
          </label>
        )}

        {session && (
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
            <span className={cn(isLive(session.status) && 'text-sky-200')}>
              {t(`subagentSession.status.${session.status}`)}
            </span>
            <span>
              {t('subagentSession.duration')}:{' '}
              <span className="font-mono tabular-nums text-foreground">{elapsed(duration)}</span>
            </span>
            <span>
              Tokens:{' '}
              <span className="font-mono tabular-nums text-foreground">
                {session.usage ? display.totalTokens.toLocaleString() : '—'}
              </span>
            </span>
            <span title={cost == null ? t('subagent.costUnavailable') : t('subagentSession.costHint')}>
              {t('subagentSession.estimatedCost')}:{' '}
              <span className="font-mono tabular-nums text-foreground">
                {cost == null ? '—' : `$${cost.toFixed(4)}`}
              </span>
            </span>
            <span>
              Effort:{' '}
              <span className="text-violet-200">
                {effective ? subagentEffortLabel(effective.sentEffort ?? 'off', t) : '—'}
              </span>
            </span>
            <span className={cn(effective?.fastMode === true && 'text-amber-200')}>
              Fast:{' '}
              {effective?.fastMode == null
                ? '—'
                : t(effective.fastMode ? 'subagentSession.enabled' : 'subagentSession.disabled')}
            </span>
            {live && (
              <div className="flex w-full flex-wrap gap-x-3 gap-y-1 border-t border-white/[0.06] pt-1.5">
                <span>{session.currentTool ?? t(`subagentSession.status.${session.status}`)}</span>
                <span>
                  {t('subagentSession.lastActivity')}: {elapsed(Date.now() - session.lastActivityAt)}
                </span>
              </div>
            )}
          </div>
        )}
      </header>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        {loading && !page ? (
          <div className="flex h-full items-center justify-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> {t('subagentSession.loading')}
          </div>
        ) : page ? (
          <ChatMessageList
            messages={page.messages}
            readOnly
            experience="standard"
            streaming={isLive(page.session.status)}
            visible
            editingId={null}
            onStartEdit={() => undefined}
            onCancelEdit={() => undefined}
            onSubmitEdit={() => undefined}
            onOpenMention={onOpenMention}
            scrollContainerRef={scrollRef}
          />
        ) : (
          <div className="flex h-full items-center justify-center px-6 text-center text-xs text-muted-foreground">
            {t('subagentSession.unavailable')}
          </div>
        )}
      </div>
    </section>
  )
}
