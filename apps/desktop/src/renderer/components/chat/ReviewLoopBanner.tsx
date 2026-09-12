import { useEffect, useMemo, useState } from 'react'
import { ShieldCheck, Square, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ReviewLoopInfo } from '../../../shared/chat'

interface Props {
  conversationId: string
  loop: ReviewLoopInfo
  onDismiss?: () => void
}

const TERMINAL = new Set<ReviewLoopInfo['status']>(['finished', 'cancelled', 'interrupted'])

function elapsedLabel(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000))
  const minutes = Math.floor(seconds / 60)
  return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`
}

export interface ReviewLoopStatusSummaryProps {
  title: string
  status: string
  iteration: number
  maxIterations: number
  modelId?: string
  reasoning?: string
  fastMode?: boolean
  fastLabel?: string
  elapsed?: string
  showIteration?: boolean
}

/** Shared status projection used by both the Web companion banner and paired-conversation panes. */
export function ReviewLoopStatusSummary({
  title,
  status,
  iteration,
  maxIterations,
  modelId,
  reasoning,
  fastMode,
  fastLabel = 'Fast',
  elapsed,
  showIteration = true,
}: ReviewLoopStatusSummaryProps) {
  return (
    <>
      <span className="font-medium">{title}</span>
      <span className="text-current/60">·</span>
      <span>{status}</span>
      {showIteration && (
        <>
          <span className="text-current/60">·</span>
          <span>
            {iteration}/{maxIterations}
          </span>
        </>
      )}
      {modelId && (
        <span className="max-w-[190px] truncate font-mono text-[10px] opacity-80" title={modelId}>
          {modelId}
          {reasoning && reasoning !== 'off' ? ` · ${reasoning}` : ''}
        </span>
      )}
      {fastMode && <span className="rounded bg-current/10 px-1.5 py-px text-[10px] font-medium">{fastLabel}</span>}
      {elapsed && <span className="tabular-nums opacity-75">{elapsed}</span>}
    </>
  )
}

export function ReviewLoopBanner({ conversationId, loop, onDismiss }: Props) {
  const { t } = useTranslation('chat')
  const [now, setNow] = useState(Date.now())
  const [stopping, setStopping] = useState(false)
  const terminal = TERMINAL.has(loop.status)
  const canStop = loop.status === 'reviewing' || loop.status === 'executing'
  useEffect(() => {
    if (terminal) return
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [terminal])

  const role = loop.participants.executor.conversationId === conversationId ? 'executor' : 'reviewer'
  const self = role === 'executor' ? loop.participants.executor : loop.participants.reviewer
  const partner = role === 'executor' ? loop.participants.reviewer : loop.participants.executor
  const status = useMemo(() => {
    if (loop.status === 'reviewing') return t('reviewLoop.statusReviewing')
    if (loop.status === 'executing') return t('reviewLoop.statusExecuting')
    if (loop.status === 'cancelling') return t('reviewLoop.statusCancelling')
    if (loop.status === 'cancelled') return t('reviewLoop.statusCancelled')
    if (loop.status === 'interrupted') return t('reviewLoop.statusInterrupted')
    if (loop.status === 'finished') {
      const reasonKeys: Record<string, string> = {
        clean: 'finishClean',
        max_iterations: 'finishMaxIterations',
        no_progress: 'finishNoProgress',
        failed: 'finishFailed',
        cancelled: 'finishCancelled',
        executor_unavailable: 'finishExecutorUnavailable',
        reviewer_unavailable: 'finishReviewerUnavailable',
        workspace_changed_externally: 'finishWorkspaceChanged',
        'review-decision-missing': 'finishDecisionMissing',
      }
      const reason = loop.finishReason ? reasonKeys[loop.finishReason] : undefined
      return reason
        ? `${t('reviewLoop.statusFinished')} · ${t(`reviewLoop.${reason}` as 'reviewLoop.finishClean')}`
        : t('reviewLoop.statusFinished')
    }
    return t('reviewLoop.statusFinishing')
  }, [loop.finishReason, loop.status, t])

  const stop = async () => {
    if (stopping || terminal) return
    setStopping(true)
    try {
      await window.api.chatReviewLoopStop(conversationId)
    } finally {
      setStopping(false)
    }
  }

  return (
    <div className="mx-auto mb-1.5 w-full max-w-3xl px-1" data-review-loop-banner={role}>
      <div className="flex items-center gap-2 rounded-lg border border-violet-400/25 bg-violet-500/[0.09] px-3 py-2 text-[12px] text-violet-50">
        <ShieldCheck className="size-4 shrink-0 text-violet-300" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 font-medium">
            <ReviewLoopStatusSummary
              title={t(`reviewLoop.role${role === 'executor' ? 'Executor' : 'Reviewer'}`)}
              status={status}
              iteration={loop.iteration}
              maxIterations={loop.maxIterations}
              elapsed={elapsedLabel(now - loop.startedAt)}
            />
          </div>
          <div className="mt-0.5 truncate text-[11px] text-violet-100/65">
            {self?.modelId || '—'}
            {self?.reasoning && self.reasoning !== 'off' ? ` · ${self.reasoning}` : ''}
            {self?.fastMode ? ' · Fast' : ''}
            {partner ? ` · ${t('reviewLoop.partner', { name: partner.name })}` : ''}
          </div>
        </div>
        {canStop ? (
          <button
            type="button"
            onClick={() => void stop()}
            disabled={stopping}
            className="flex shrink-0 items-center gap-1 rounded-md border border-violet-200/20 px-2 py-1 text-[11px] hover:bg-violet-300/10 disabled:opacity-50"
          >
            <Square className="size-3 fill-current" />
            {stopping ? t('reviewLoop.stopping') : t('reviewLoop.stop')}
          </button>
        ) : terminal && onDismiss ? (
          <button
            type="button"
            onClick={onDismiss}
            className="rounded p-1 text-violet-100/70 hover:bg-violet-300/10 hover:text-violet-50"
            aria-label={t('reviewLoop.dismiss')}
          >
            <X className="size-3.5" />
          </button>
        ) : null}
      </div>
    </div>
  )
}
