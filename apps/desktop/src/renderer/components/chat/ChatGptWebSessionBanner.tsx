import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Copy, ExternalLink, KeyRound, Loader2, Power, Square } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ChatGptWebStatusPayload } from '../../../preload'
import type { ChatGptWebReviewLoopInfo } from '../../../shared/chat'
import { isReviewLoopConversationReserved } from '../../../shared/chat'
import { ReviewLoopStatusSummary } from './ReviewLoopBanner'

const CHATGPT_PLUGINS_URL = 'https://chatgpt.com/plugins'

const REVIEW_LOOP_STATUS_KEY: Record<ChatGptWebReviewLoopInfo['status'], string> = {
  reviewing: 'reviewLoopReviewing',
  executing: 'reviewLoopExecuting',
  finishing: 'reviewLoopFinishing',
  cancelling: 'reviewLoopStopping',

  finished: 'reviewLoopFinishing',
  cancelled: 'reviewLoopStopping',
  interrupted: 'reviewLoopInterrupted',
}

const BROWSER_SCOPE_KEY = {
  off: 'scopeOff',
  inspect: 'scopeInspect',
  interact: 'scopeInteract',
} as const

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

export function ChatGptWebSessionBanner({ conversationId, starting }: { conversationId: string; starting: boolean }) {
  const { t } = useTranslation('chat')
  const [status, setStatus] = useState<ChatGptWebStatusPayload | null>(null)
  const [busy, setBusy] = useState<'copyPrompt' | 'copyKey' | 'open' | 'end' | null>(null)
  const [loopBusy, setLoopBusy] = useState(false)
  const [visualBusy, setVisualBusy] = useState(false)
  const [promptCopied, setPromptCopied] = useState(false)
  const [sessionKeyCopied, setSessionKeyCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [, setClock] = useState(0)

  useEffect(() => {
    void window.api.chatGptWebStatus().then(setStatus)
    return window.api.onChatGptWebStatus(setStatus)
  }, [])

  const session = status?.sessions.find((item) => item.conversationId === conversationId && item.state !== 'ended')
  const reviewLoop = session?.reviewLoop ?? null
  const loopActive = isReviewLoopConversationReserved(reviewLoop?.status)
  const loopStopping =
    reviewLoop?.status === 'cancelling' || reviewLoop?.status === 'finished' || reviewLoop?.status === 'cancelled'

  useEffect(() => {
    if (!loopActive) return
    const timer = setInterval(() => setClock((value) => value + 1), 1000)
    return () => clearInterval(timer)
  }, [loopActive])

  if (!session && !starting) return null

  const copyPrompt = async () => {
    setBusy('copyPrompt')
    setError(null)
    try {
      const result = await window.api.chatGptWebCompanionCopyPrompt(conversationId)
      if (!result.ok) throw new Error(result.error || 'session-not-found')
      setPromptCopied(true)
      setTimeout(() => setPromptCopied(false), 2500)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(null)
    }
  }

  const copySessionKey = async () => {
    setBusy('copyKey')
    setError(null)
    try {
      const result = await window.api.chatGptWebCompanionCopySessionKey(conversationId)
      if (!result.ok) throw new Error(result.error || 'session-not-found')
      setSessionKeyCopied(true)
      setTimeout(() => setSessionKeyCopied(false), 2500)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(null)
    }
  }

  const openWindow = async () => {
    setBusy('open')
    setError(null)
    const result = await window.api.chatGptWebCompanionOpen(conversationId)
    if (!result.ok) setError(result.error || t('chatgptWeb.error'))
    setBusy(null)
  }

  const end = async () => {
    setBusy('end')
    setError(null)
    await window.api.chatGptWebCompanionEnd(conversationId)
    setBusy(null)
  }

  const stopLoop = async () => {
    setLoopBusy(true)
    setError(null)
    try {
      await window.api.chatGptWebReviewLoopStop(conversationId)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoopBusy(false)
    }
  }

  const showVisualPreview = async () => {
    setVisualBusy(true)
    setError(null)
    try {
      const result = await window.api.chatGptWebReviewLoopShowPreview(conversationId)
      if (!result.ok) throw new Error(result.error || 'visual-preview-not-active')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setVisualBusy(false)
    }
  }

  const connected = session?.state === 'live'
  const pairingRequired = session?.pairingRequired ?? true
  const appRefreshRequired = status?.appRefreshRequired === true
  const failed = session?.state === 'error' || !!error || status?.tunnelState === 'error'
  const message = starting
    ? t('chatgptWeb.starting')
    : error
      ? error
      : status?.tunnelState === 'error'
        ? status.tunnelError || t('chatgptWeb.error')
        : session?.state === 'error'
          ? session.error || t('chatgptWeb.error')
          : connected
            ? t('chatgptWeb.connected')
            : pairingRequired
              ? t('chatgptWeb.waiting')
              : t('chatgptWeb.resuming')

  const loopStartedAt = reviewLoop?.jobStartedAt ?? reviewLoop?.startedAt ?? 0
  const loopElapsed = loopStartedAt ? formatElapsed(Date.now() - loopStartedAt) : ''

  return (
    <div className="mx-auto mb-1.5 w-full max-w-3xl px-1">
      <div
        className={cn(
          'flex flex-wrap items-center gap-2 rounded-md border px-2.5 py-1.5 text-[11px]',
          failed
            ? 'border-amber-500/30 bg-amber-500/[0.06] text-amber-200'
            : connected
              ? 'border-emerald-500/30 bg-emerald-500/[0.06] text-emerald-200'
              : 'border-violet-500/30 bg-violet-500/[0.06] text-violet-200'
        )}
      >
        {!connected && !failed && <Loader2 className="h-3 w-3 shrink-0 animate-spin" />}
        <span className="min-w-0 flex-1 truncate" title={message}>
          {message}
        </span>
        {session?.capabilities && (
          <span
            className={cn(
              'shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-medium',
              session.capabilities.browser === 'off'
                ? 'border-amber-500/25 bg-amber-500/[0.08] text-amber-200'
                : 'border-violet-400/25 bg-violet-500/[0.08] text-violet-200'
            )}
          >
            {t('chatgptWeb.browserAccessBadge', {
              scope: t(`chatGptWebAccess.${BROWSER_SCOPE_KEY[session.capabilities.browser]}`),
            })}
          </span>
        )}
        {session && (
          <>
            {pairingRequired && (
              <button
                type="button"
                className="inline-flex shrink-0 items-center gap-1 rounded border border-current/30 px-2 py-0.5 hover:opacity-80 disabled:opacity-50"
                disabled={busy !== null}
                onClick={copyPrompt}
              >
                <Copy className="h-3 w-3" />
                {promptCopied ? t('chatgptWeb.copied') : t('chatgptWeb.copyPrompt')}
              </button>
            )}
            <button
              type="button"
              className="inline-flex shrink-0 items-center gap-1 rounded border border-current/30 px-2 py-0.5 hover:opacity-80 disabled:opacity-50"
              disabled={busy !== null}
              onClick={copySessionKey}
            >
              {busy === 'copyKey' ? <Loader2 className="h-3 w-3 animate-spin" /> : <KeyRound className="h-3 w-3" />}
              {sessionKeyCopied ? t('chatgptWeb.copied') : t('chatgptWeb.copySessionKey')}
            </button>
            <button
              type="button"
              className="inline-flex shrink-0 items-center gap-1 rounded bg-violet-600 px-2 py-0.5 text-white hover:bg-violet-500 disabled:opacity-50"
              disabled={busy !== null}
              onClick={openWindow}
            >
              {busy === 'open' ? <Loader2 className="h-3 w-3 animate-spin" /> : <ExternalLink className="h-3 w-3" />}
              {t('chatgptWeb.openWindow')}
            </button>
            <button
              type="button"
              className="inline-flex shrink-0 items-center rounded border border-current/30 px-1.5 py-0.5 hover:opacity-80 disabled:opacity-50"
              disabled={busy !== null || loopActive}
              onClick={end}
              title={loopActive ? t('chatgptWeb.reviewLoopReserved') : t('chatgptWeb.end')}
            >
              <Power className="h-3 w-3" />
            </button>
          </>
        )}
      </div>

      {appRefreshRequired && (
        <div
          role="alert"
          className="mt-1 flex flex-wrap items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/[0.08] px-2.5 py-1.5 text-[11px] text-amber-200"
        >
          <span className="min-w-0 flex-1">{t('chatgptWeb.appRefreshRequired')}</span>
          <button
            type="button"
            className="inline-flex shrink-0 items-center gap-1 rounded border border-current/40 px-2 py-0.5 hover:opacity-80"
            onClick={() => window.api.openExternalUrl(CHATGPT_PLUGINS_URL)}
          >
            <ExternalLink className="h-3 w-3" /> {t('chatgptWeb.openAppSettings')}
          </button>
        </div>
      )}

      {reviewLoop && (
        <div className="mt-1 flex flex-wrap items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/[0.06] px-2.5 py-1.5 text-[11px] text-amber-200">
          <ReviewLoopStatusSummary
            title={t('chatgptWeb.reviewLoopActive', {
              iteration: reviewLoop.iteration,
              max: reviewLoop.maxIterations,
            })}
            status={t(`chatgptWeb.${REVIEW_LOOP_STATUS_KEY[reviewLoop.status]}`)}
            iteration={reviewLoop.iteration}
            maxIterations={reviewLoop.maxIterations}
            showIteration={false}
            modelId={reviewLoop.modelId}
            reasoning={reviewLoop.reasoning}
            fastMode={reviewLoop.fastMode}
            fastLabel={t('fastMode.label')}
            elapsed={loopActive ? loopElapsed : undefined}
          />
          {reviewLoop.reviewScope === 'frontend' && (
            <span className="rounded border border-violet-400/30 bg-violet-500/10 px-1.5 py-px text-[10px] font-medium">
              {t('chatgptWeb.reviewLoopVisual')}
            </span>
          )}
          {(reviewLoop.contextPolicy === 'isolated' || loopActive) && (
            <span
              className="rounded border border-amber-400/25 bg-amber-500/10 px-1.5 py-px text-[10px] font-medium tracking-wide"
              title={t('chatgptWeb.reviewLoopCleanContextTooltip')}
            >
              {t('chatgptWeb.reviewLoopCleanContext')}
            </span>
          )}
          {reviewLoop.reviewScope === 'frontend' && reviewLoop.visual && (
            <>
              <span className="rounded border border-current/20 px-1.5 py-px text-[10px] opacity-85">
                {t(
                  reviewLoop.visual.managedPreview
                    ? 'chatgptWeb.reviewLoopVisualManaged'
                    : 'chatgptWeb.reviewLoopVisualAttached'
                )}
              </span>
              {reviewLoop.visual.url && (
                <span className="max-w-[240px] truncate font-mono text-[10px] opacity-85" title={reviewLoop.visual.url}>
                  {reviewLoop.visual.url}
                </span>
              )}
              <span className="text-[10px] opacity-85">
                {t(
                  reviewLoop.status === 'executing'
                    ? 'chatgptWeb.reviewLoopVisualFixing'
                    : reviewLoop.visual.state === 'starting'
                      ? 'chatgptWeb.reviewLoopVisualStarting'
                      : reviewLoop.visual.state === 'error'
                        ? 'chatgptWeb.reviewLoopVisualError'
                        : reviewLoop.visual.state === 'inspecting'
                          ? 'chatgptWeb.reviewLoopVisualInspecting'
                          : 'chatgptWeb.reviewLoopVisualVerifying'
                )}
              </span>
              <button
                type="button"
                className="inline-flex shrink-0 items-center gap-1 rounded border border-current/30 px-2 py-0.5 hover:opacity-80 disabled:opacity-50"
                disabled={visualBusy || loopStopping || reviewLoop.visual.state === 'starting'}
                onClick={() => void showVisualPreview()}
              >
                {visualBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <ExternalLink className="h-3 w-3" />}
                {t(
                  reviewLoop.visual.managedPreview
                    ? 'chatgptWeb.reviewLoopOpenPreview'
                    : 'chatgptWeb.reviewLoopFocusTab'
                )}
              </button>
            </>
          )}

          {loopActive && !loopStopping && (
            <button
              type="button"
              className="ml-auto inline-flex shrink-0 items-center gap-1 rounded bg-amber-600 px-2 py-0.5 text-white hover:bg-amber-500 disabled:opacity-50"
              disabled={loopBusy}
              onClick={stopLoop}
            >
              {loopBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Square className="h-3 w-3" />}
              {t('chatgptWeb.reviewLoopStop')}
            </button>
          )}
          {loopActive && (
            <span className="w-full opacity-80" title={t('chatgptWeb.reviewLoopReserved')}>
              {t('chatgptWeb.reviewLoopReserved')}
            </span>
          )}
        </div>
      )}
    </div>
  )
}
