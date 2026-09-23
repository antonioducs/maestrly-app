import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, RotateCcw, TriangleAlert } from 'lucide-react'

/**
 * Shown on a conversation started from another conversation whose first turn could not start. The task is kept
 * in main's journal; retrying starts the same conversation instead of creating another.
 */
export function ConversationDispatchBanner({ conversationId }: { conversationId: string }) {
  const { t } = useTranslation('chat')
  const [status, setStatus] = useState<{ phase: string; error: string | null } | null>(null)
  const [retrying, setRetrying] = useState(false)
  const [retryError, setRetryError] = useState<string | null>(null)

  const load = useCallback(
    (isAlive: () => boolean) =>
      void window.api
        .conversationDispatchStatus(conversationId)
        .then((next) => {
          if (isAlive()) setStatus(next)
        })
        .catch(() => {}),
    [conversationId]
  )

  useEffect(() => {
    let alive = true
    setStatus(null)
    setRetryError(null)
    load(() => alive)
    const unsubscribe = window.api.onConversationDispatchChanged((payload) => {
      if (payload.conversationId === conversationId) load(() => alive)
    })
    return () => {
      alive = false
      unsubscribe()
    }
  }, [conversationId, load])

  if (status?.phase !== 'start-failed') return null

  const retry = async () => {
    setRetrying(true)
    setRetryError(null)
    try {
      const result = await window.api.retryConversationDispatch(conversationId)
      if (!result.ok) setRetryError(result.error ?? null)
    } catch (error) {
      setRetryError(error instanceof Error ? error.message : String(error))
    } finally {
      setRetrying(false)
      load(() => true)
    }
  }

  return (
    <div className="mx-auto mb-1.5 w-full max-w-3xl px-1">
      <div
        role="alert"
        data-testid="conversation-dispatch-banner"
        className="flex items-center gap-2 rounded-lg border border-amber-500/25 bg-amber-500/[0.08] px-3 py-1.5 text-[12px] text-amber-100"
      >
        <TriangleAlert className="size-3.5 shrink-0 text-amber-300" />
        <span className="min-w-0 flex-1">
          <span className="font-medium">{t('dispatch.startFailedTitle')}</span>{' '}
          {t('dispatch.startFailedBody', { error: retryError ?? status.error ?? '—' })}
        </span>
        <button
          type="button"
          disabled={retrying}
          onClick={() => void retry()}
          className="flex shrink-0 items-center gap-1 rounded border border-amber-400/30 px-2 py-0.5 text-amber-100 hover:bg-amber-400/10 disabled:opacity-60"
        >
          {retrying ? <Loader2 className="size-3 animate-spin" /> : <RotateCcw className="size-3" />}
          {retrying ? t('dispatch.retrying') : t('dispatch.retry')}
        </button>
      </div>
    </div>
  )
}
