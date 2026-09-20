import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, CircleAlert, Clock3, LoaderCircle, Pause } from 'lucide-react'
import { useSettings } from '@/lib/use-settings'
import type { BackgroundCompactionStatus as BackgroundCompactionState } from '../../../shared/background-compaction'

const statusLabelKey: Record<BackgroundCompactionState['status'], string> = {
  idle: 'backgroundCompaction.idle',
  queued: 'backgroundCompaction.queued',
  running: 'backgroundCompaction.running',
  ready: 'backgroundCompaction.ready',
  failed: 'backgroundCompaction.failed',
  paused: 'backgroundCompaction.paused',
}

export function BackgroundCompactionStatus({
  conversationId,
  state,
}: {
  conversationId: string
  state?: BackgroundCompactionState
}) {
  const { t } = useTranslation('chat')
  const { openSettings } = useSettings()
  const [retrying, setRetrying] = useState(false)

  if (!state || state.status === 'idle') return null

  const diagnostic = state.error
    ? t(`backgroundCompaction.errors.${state.error}`, { defaultValue: state.error })
    : undefined
  const active = state.status === 'queued' || state.status === 'running'
  const needsAttention = state.status === 'failed' || (state.status === 'paused' && Boolean(state.error))
  const Icon =
    state.status === 'ready'
      ? Check
      : state.status === 'failed'
        ? CircleAlert
        : state.status === 'paused'
          ? Pause
          : state.status === 'queued'
            ? Clock3
            : LoaderCircle

  const retry = async () => {
    if (retrying) return
    setRetrying(true)
    try {
      await window.api.chatRetryBackgroundCompaction(conversationId)
    } catch {
      // The failed state remains actionable; the next event or hydration supplies backend details.
    } finally {
      setRetrying(false)
    }
  }

  return (
    <span
      data-background-compaction-status={state.status}
      className={
        needsAttention
          ? 'inline-flex min-w-0 items-center gap-1 text-[11px] text-red-300'
          : state.status === 'ready'
            ? 'inline-flex min-w-0 items-center gap-1 text-[11px] text-emerald-300'
            : 'inline-flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground'
      }
      title={diagnostic}
    >
      <Icon aria-hidden="true" className={`h-3 w-3 shrink-0 ${state.status === 'running' ? 'animate-spin' : ''}`} />
      <span role={needsAttention ? 'alert' : 'status'} aria-live="polite" aria-atomic="true">
        {t(statusLabelKey[state.status])}
      </span>
      {needsAttention && diagnostic && <span className="sr-only">{diagnostic}</span>}
      {needsAttention && (
        <>
          <button
            type="button"
            disabled={retrying}
            onClick={() => void retry()}
            className="rounded px-1 py-0.5 font-medium text-red-200 hover:bg-red-400/10 hover:text-red-100 disabled:opacity-50"
          >
            {retrying ? t('backgroundCompaction.retrying') : t('backgroundCompaction.retry')}
          </button>
          <button
            type="button"
            onClick={() => openSettings('chat')}
            className="rounded px-1 py-0.5 font-medium text-red-200 hover:bg-red-400/10 hover:text-red-100"
          >
            {t('backgroundCompaction.settings')}
          </button>
        </>
      )}
      {active && <span className="sr-only">{t('backgroundCompaction.nonBlocking')}</span>}
    </span>
  )
}
