import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Copy, ExternalLink, KeyRound, Loader2, Power } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useHostApi } from '@/lib/hosts/host-context'
import type { ChatGptWebStatusPayload } from '../../../preload'

const CHATGPT_PLUGINS_URL = 'https://chatgpt.com/plugins'

const BROWSER_SCOPE_KEY = {
  off: 'scopeOff',
  inspect: 'scopeInspect',
  interact: 'scopeInteract',
} as const

export function ChatGptWebSessionBanner({ conversationId, starting }: { conversationId: string; starting: boolean }) {
  const { t } = useTranslation('chat')
  const api = useHostApi()
  const [status, setStatus] = useState<ChatGptWebStatusPayload | null>(null)
  const [busy, setBusy] = useState<'copyPrompt' | 'copyKey' | 'open' | 'end' | null>(null)
  const [promptCopied, setPromptCopied] = useState(false)
  const [sessionKeyCopied, setSessionKeyCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void api.chatGptWebStatus().then(setStatus)
    return api.onChatGptWebStatus(setStatus)
  }, [api])

  const session = status?.sessions.find((item) => item.conversationId === conversationId && item.state !== 'ended')

  if (!session && !starting) return null

  const copyPrompt = async () => {
    setBusy('copyPrompt')
    setError(null)
    try {
      const result = await api.chatGptWebCompanionCopyPrompt(conversationId)
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
      const result = await api.chatGptWebCompanionCopySessionKey(conversationId)
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
    const result = await api.chatGptWebCompanionOpen(conversationId)
    if (!result.ok) setError(result.error || t('chatgptWeb.error'))
    setBusy(null)
  }

  const end = async () => {
    setBusy('end')
    setError(null)
    await api.chatGptWebCompanionEnd(conversationId)
    setBusy(null)
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
              disabled={busy !== null}
              onClick={end}
              title={t('chatgptWeb.end')}
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
    </div>
  )
}
