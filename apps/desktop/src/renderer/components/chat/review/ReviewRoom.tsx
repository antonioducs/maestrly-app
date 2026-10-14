import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Lock, ScanSearch, TriangleAlert, UserRound } from 'lucide-react'
import type { PlanDecision } from '../../../../preload'
import {
  reviewLocksConversation,
  type ReviewDecision,
  type ReviewDraft,
  type ReviewJobInfo,
  type ReviewModelChoice,
  type ReviewTarget,
} from '../../../../shared/review'
import { Button } from '@/components/ui/button'
import { useHostApi } from '@/lib/hosts/host-context'
import { formatReviewClock, planReviewRevision, reviewErrorText, reviewModelShortLabel } from '@/lib/review'
import { planDecisionError } from '@/lib/plan-decision'
import { cn } from '@/lib/utils'
import { ReviewDecideStage } from './ReviewDecideStage'
import { ReviewHandoffStage } from './ReviewHandoffStage'
import { ReviewLiveStage } from './ReviewLiveStage'
import { ReviewScopeStage } from './ReviewScopeStage'

type Stage = 'scope' | 'investigate' | 'verify' | 'decide' | 'handoff'
const STAGES: Stage[] = ['scope', 'investigate', 'verify', 'decide', 'handoff']

function emptyDraft(): ReviewDraft {
  return { decisions: {}, notes: {}, comments: {} }
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])
  return now
}

/**
 * A review takes over the conversation: it moves through its stages here, the conversation stays paused while it
 * runs and until the person hands its result off (or discards it), and the review then continues in the
 * conversation as a receipt.
 */
export function ReviewRoom({
  conversationId,
  conversationName,
  target,
  review,
  lastAgentText,
  onClose,
  onRetry,
  onApply,
  onSendMessage,
  onHandoffError,
  onOpenFile,
  onOpenPlan,
}: {
  conversationId: string
  conversationName: string
  /** The target the first stage offers, when no review is open yet. */
  target: ReviewTarget | null
  /** The open (or failed) review. */
  review: ReviewJobInfo | null
  lastAgentText?: string
  /** Back to the conversation without a review. */
  onClose: () => void
  /** Back to the first stage after a failure. */
  onRetry: (target: ReviewTarget) => void
  onApply: (info: ReviewJobInfo) => void
  /** Sends the message a code review was handed off with. */
  onSendMessage: (message: string) => void
  /** Something went wrong after the review let go of the conversation. */
  onHandoffError: (message: string) => void
  onOpenFile?: (path: string, line?: number) => void
  onOpenPlan?: () => void
}) {
  const { t } = useTranslation('chat')
  const api = useHostApi()
  const [handoffOpen, setHandoffOpen] = useState(false)
  const [draft, setDraft] = useState<ReviewDraft>(() => review?.draft ?? emptyDraft())
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const [plan, setPlan] = useState<string | undefined>(undefined)
  const pending = useRef<{ notes: Record<string, string>; comments: Record<string, string> }>({
    notes: {},
    comments: {},
  })
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const reviewId = review?.reviewId ?? null
  const live = review?.status === 'running' || review?.status === 'verifying'
  const now = useNow(live)

  // A different review (or none) starts over; the person's decisions come from main, which keeps them.
  const seeded = useRef<string | null>(null)
  useEffect(() => {
    setHandoffOpen(false)
    setConfirmDiscard(false)
    setDraft(emptyDraft())
    pending.current = { notes: {}, comments: {} }
  }, [reviewId])
  // Only the arrival of a ready review seeds the local draft; later events would overwrite what is being typed.
  useEffect(() => {
    if (review?.status !== 'ready' || !review.draft || seeded.current === review.reviewId) return
    seeded.current = review.reviewId
    const remote = review.draft
    setDraft((current) => mergeLocal(current, remote))
  }, [review])
  useEffect(() => {
    if (review?.target !== 'plan' || review.status !== 'ready') return
    let alive = true
    void api
      .getPendingPlan(conversationId)
      .then((pendingPlan) => alive && setPlan(pendingPlan?.plan))
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [api, conversationId, review?.target, review?.status])
  useEffect(() => {
    if (!confirmDiscard) return
    const timer = setTimeout(() => setConfirmDiscard(false), 4000)
    return () => clearTimeout(timer)
  }, [confirmDiscard])

  const flush = useCallback(async () => {
    if (flushTimer.current) clearTimeout(flushTimer.current)
    flushTimer.current = null
    const { notes, comments } = pending.current
    pending.current = { notes: {}, comments: {} }
    if (!reviewId || (!Object.keys(notes).length && !Object.keys(comments).length)) return
    await api.chatReviewDraft(conversationId, { reviewId, notes, comments }).catch(() => undefined)
  }, [api, conversationId, reviewId])

  const decide = (findingId: string, decision: ReviewDecision) => {
    setDraft((current) => ({ ...current, decisions: { ...current.decisions, [findingId]: decision } }))
    if (reviewId)
      void api
        .chatReviewDraft(conversationId, { reviewId, decisions: { [findingId]: decision } })
        .catch(() => undefined)
  }
  const queueText = (kind: 'notes' | 'comments', findingId: string, text: string) => {
    setDraft((current) => ({ ...current, [kind]: { ...current[kind], [findingId]: text } }))
    pending.current[kind][findingId] = text
    if (flushTimer.current) clearTimeout(flushTimer.current)
    flushTimer.current = setTimeout(() => void flush(), 400)
  }
  const decideRest = () => {
    const rest: Record<string, ReviewDecision> = {}
    for (const finding of review?.findings ?? []) {
      if (!draft.decisions[finding.id]) rest[finding.id] = review?.target === 'code' ? 'discuss' : 'comment'
    }
    setDraft((current) => ({ ...current, decisions: { ...current.decisions, ...rest } }))
    if (reviewId) void api.chatReviewDraft(conversationId, { reviewId, decisions: rest }).catch(() => undefined)
  }

  const start = async (reviewer?: ReviewModelChoice): Promise<string | null> => {
    if (!target) return null
    try {
      const result = await api.chatReviewStart(conversationId, { target, ...(reviewer ? { reviewer } : {}) })
      if (!result.ok) return result.error
      onApply(result.review)
      return null
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }

  const handoff = async (
    action: 'send' | 'save' | 'revise' | 'approve',
    input: { message?: string; general?: string } = {}
  ): Promise<string | null> => {
    if (!review) return null
    await flush()
    // Main validates the hand-off against the decisions it holds; make sure it holds all of them.
    await api
      .chatReviewDraft(conversationId, {
        reviewId: review.reviewId,
        decisions: draft.decisions,
        notes: draft.notes,
        comments: draft.comments,
      })
      .catch(() => undefined)
    let decision: PlanDecision | null = null
    if (review.target === 'plan' && (action === 'revise' || action === 'approve')) {
      const pendingPlan = await api.getPendingPlan(conversationId).catch(() => null)
      if (!pendingPlan || pendingPlan.version !== review.planVersion) return reviewErrorText(t, 'plan-changed')
      if (action === 'approve') decision = { action: 'approve' }
      else {
        // The person's own comments and edits in the Plan tab go along with the review's.
        const own = (await api.getPlanDraft(conversationId).catch(() => null)) as {
          version?: number
          text?: string
          feedback?: string
          lineComments?: Record<number, string>
        } | null
        const usable = own?.version === pendingPlan.version ? own : null
        const revision = planReviewRevision(pendingPlan.plan, review.findings ?? [], draft, {
          lineComments: usable?.lineComments && typeof usable.lineComments === 'object' ? usable.lineComments : {},
          feedback: [typeof usable?.feedback === 'string' ? usable.feedback : '', input.general ?? '']
            .filter(Boolean)
            .join('\n\n'),
        })
        const editedPlan =
          typeof usable?.text === 'string' && usable.text.trim() !== pendingPlan.plan.trim() ? usable.text : undefined
        decision = {
          action: 'revise',
          ...(revision.feedback ? { feedback: revision.feedback } : {}),
          ...(revision.lineComments.length ? { lineComments: revision.lineComments } : {}),
          ...(editedPlan ? { editedPlan } : {}),
        }
      }
    }
    const result = await api
      .chatReviewHandoff(conversationId, {
        reviewId: review.reviewId,
        action,
        ...(action === 'send' ? { message: input.message ?? '' } : {}),
      })
      .catch((error: unknown) => ({
        ok: false as const,
        error: error instanceof Error ? error.message : String(error),
      }))
    if (!result.ok) return reviewErrorText(t, result.error)
    if (action === 'send' && input.message) onSendMessage(input.message)
    if (decision) {
      const outcome = await api.decidePlan(conversationId, decision).catch((error: unknown) => ({
        ok: false as const,
        error: error instanceof Error ? error.message : String(error),
      }))
      const failure = planDecisionError(outcome)
      if (failure) {
        onHandoffError(t('review.room.planDecisionFailed', { reason: reviewErrorText(t, failure) }))
        return null
      }
      void api.savePlanDraft(conversationId, null)
    }
    return null
  }

  const stage: Stage = !review
    ? 'scope'
    : review.status === 'running'
      ? 'investigate'
      : review.status === 'verifying'
        ? 'verify'
        : review.status === 'ready'
          ? handoffOpen
            ? 'handoff'
            : 'decide'
          : review.verification === 'pending'
            ? 'investigate'
            : review.findings
              ? 'decide'
              : 'verify'
  const failed = review?.status === 'failed'
  const stageIndex = STAGES.indexOf(stage)
  const kind = review?.target ?? target ?? 'code'
  const scope = review?.scope
  const scopeLine =
    scope?.kind === 'code'
      ? t('review.room.codeScopeLine', {
          branch: scope.branch,
          count: scope.filesTotal,
          added: scope.added,
          deleted: scope.deleted,
        })
      : scope?.kind === 'plan'
        ? t('review.room.planScopeLine', { version: scope.version, count: scope.steps.length })
        : t('review.room.scopeSubtitle')
  const elapsed = review ? (review.finishedAt ?? (live ? now : Date.now())) - review.startedAt : 0
  const locked = reviewLocksConversation(review)

  let liveStatus = ''
  if (review?.status === 'running') {
    const reading = review.lenses.filter((lens) => lens.status === 'running').length
    liveStatus = t('review.room.liveReviewers', {
      running: reading,
      total: review.lenses.length,
      count: review.candidateList.length,
    })
  } else if (review?.status === 'verifying') {
    liveStatus = t('review.room.liveVerifier', { done: review.verdicts.length, total: review.candidateList.length })
  }

  return (
    <section
      data-testid="review-room"
      data-stage={failed ? 'failed' : stage}
      aria-label={t(kind === 'code' ? 'review.codeReviewTitle' : 'review.planReviewTitle')}
      className="absolute inset-0 z-30 flex min-h-0 flex-col bg-[#0d0d10] bg-[radial-gradient(120%_50%_at_50%_-12%,rgba(125,211,252,0.06),transparent_62%)]"
    >
      <div className="flex flex-wrap items-center gap-3.5 border-b border-white/[0.07] px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-sky-400/10 text-sky-300">
            <ScanSearch className="size-4" />
          </span>
          <div className="min-w-0">
            <b className="block text-[14px] font-semibold">
              {t(kind === 'code' ? 'review.codeReviewTitle' : 'review.planReviewTitle')}
            </b>
            <small className="block truncate font-mono text-[11.5px] text-muted-foreground">{scopeLine}</small>
          </div>
        </div>
        <span className="flex-1" />
        <div className="flex items-center gap-2">
          {review?.model && (
            <span className="hidden items-center gap-1.5 rounded-full border border-white/[0.12] px-2.5 py-0.5 text-[12px] text-foreground/85 sm:inline-flex">
              <UserRound className="size-3 text-muted-foreground" />
              {reviewModelShortLabel(review.model)}
            </span>
          )}
          {review && (
            <span className="font-mono text-[12px] tabular-nums text-muted-foreground" data-testid="review-clock">
              {formatReviewClock(elapsed)}
            </span>
          )}
          {!review && (
            <Button variant="ghost" size="sm" onClick={onClose}>
              {t('review.room.backToConversation')}
            </Button>
          )}
          {live && (
            <Button
              variant="ghost"
              size="sm"
              className="hover:text-red-300"
              onClick={() => void api.chatReviewCancel(conversationId)}
            >
              {t('review.room.cancelReview')}
            </Button>
          )}
          {review?.status === 'ready' && (
            <Button
              variant="ghost"
              size="sm"
              className={cn(confirmDiscard ? 'text-red-300' : 'hover:text-red-300')}
              onClick={() => {
                if (!confirmDiscard) setConfirmDiscard(true)
                else void api.chatReviewDiscard(conversationId, review.reviewId)
              }}
            >
              {confirmDiscard ? t('review.room.discardConfirm') : t('review.room.discardReview')}
            </Button>
          )}
        </div>
      </div>

      <ol
        aria-label={t('review.room.stages')}
        className="flex items-center border-b border-white/[0.07] bg-black/30 px-4 py-2.5"
      >
        {STAGES.map((item, index) => {
          const done = index < stageIndex
          const now = index === stageIndex
          return (
            <li
              key={item}
              aria-current={now ? 'step' : undefined}
              className={cn(
                'flex min-w-0 items-center gap-2 text-[12px] last:flex-none',
                index < STAGES.length - 1 && 'flex-1',
                done ? 'text-foreground/80' : now ? 'font-medium text-foreground' : 'text-muted-foreground/60'
              )}
            >
              <span
                className={cn(
                  'grid size-5 shrink-0 place-items-center rounded-full border text-[10.5px] tabular-nums',
                  done && 'border-emerald-400/45 bg-emerald-400/15 text-emerald-400',
                  now &&
                    !failed &&
                    'border-sky-300 bg-sky-300 text-[#07131a] shadow-[0_0_0_4px_rgba(125,211,252,0.15)]',
                  now && failed && 'border-amber-400 bg-amber-400 text-[#1a1207]',
                  !done && !now && 'border-white/[0.12]'
                )}
              >
                {done ? <Check className="size-3" /> : now && failed ? '!' : index + 1}
              </span>
              <span className={cn('truncate', !now && 'max-[720px]:hidden')}>{t(`review.room.stage.${item}`)}</span>
              {index < STAGES.length - 1 && (
                <span
                  aria-hidden
                  className={cn(
                    'mx-1.5 h-0.5 min-w-2.5 flex-1 rounded',
                    done ? 'bg-emerald-400/45' : now && live ? 'animate-pulse bg-sky-300/60' : 'bg-white/[0.12]'
                  )}
                />
              )}
            </li>
          )
        })}
      </ol>

      {locked && (
        <div className="flex items-center gap-2.5 border-b border-amber-400/15 bg-amber-400/[0.05] px-4 py-2 text-[12.5px] text-foreground/85">
          <Lock className="size-3.5 shrink-0 text-amber-300" />
          <span className="min-w-0">
            <b className="font-semibold text-foreground">{t('review.room.pausedTitle', { name: conversationName })}</b>{' '}
            {t(kind === 'code' ? 'review.room.pausedCode' : 'review.room.pausedPlan')}
          </span>
          {lastAgentText && (
            <span
              title={lastAgentText}
              className="ml-auto hidden max-w-[34%] truncate text-muted-foreground/70 lg:block"
            >
              {t('review.room.lastMessage', { text: lastAgentText })}
            </span>
          )}
        </div>
      )}

      {failed && review ? (
        <div className="flex min-h-0 flex-1 items-start justify-center overflow-auto p-6">
          <div
            role="alert"
            className="mt-6 w-full max-w-lg rounded-2xl border border-amber-400/20 bg-amber-400/[0.05] p-5"
          >
            <h2 className="mb-1.5 flex items-center gap-2 text-[16px] font-semibold text-amber-100">
              <TriangleAlert className="size-4.5" />
              {t('review.room.failedTitle')}
            </h2>
            <p className="mb-4 text-[13px] text-amber-100/85">{reviewErrorText(t, review.error)}</p>
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="ghost" onClick={onClose}>
                {t('review.room.backToConversation')}
              </Button>
              <Button onClick={() => onRetry(review.target)}>{t('review.room.tryAgain')}</Button>
            </div>
          </div>
        </div>
      ) : stage === 'scope' ? (
        <ReviewScopeStage conversationId={conversationId} target={kind} onStart={start} onBack={onClose} />
      ) : (stage === 'investigate' || stage === 'verify') && review ? (
        <>
          <ReviewLiveStage review={review} />
          <footer className="flex items-center gap-2.5 border-t border-white/[0.07] bg-black/40 px-4 py-2.5 text-[12.5px] text-foreground/85">
            <span className="size-[7px] shrink-0 animate-pulse rounded-full bg-sky-300" />
            <span className="min-w-0 truncate" data-testid="review-live-status">
              {liveStatus}
            </span>
          </footer>
        </>
      ) : stage === 'decide' && review ? (
        <ReviewDecideStage
          review={review}
          draft={draft}
          onDecide={decide}
          onNote={(id, note) => queueText('notes', id, note)}
          onRest={decideRest}
          onContinue={() => setHandoffOpen(true)}
          onCloseClean={(action) => {
            void handoff(action).then((failure) => failure && onHandoffError(failure))
          }}
          onOpenFile={onOpenFile}
          onOpenPlanLine={onOpenPlan ? () => onOpenPlan() : undefined}
        />
      ) : stage === 'handoff' && review ? (
        <ReviewHandoffStage
          review={review}
          draft={draft}
          plan={plan}
          onComment={(id, comment) => queueText('comments', id, comment)}
          onBack={() => setHandoffOpen(false)}
          onHandoff={handoff}
        />
      ) : null}
    </section>
  )
}

/** Local edits win over what main sent back for the same finding. */
function mergeLocal(local: ReviewDraft, remote: ReviewDraft): ReviewDraft {
  return {
    decisions: { ...remote.decisions, ...local.decisions },
    notes: { ...remote.notes, ...local.notes },
    comments: { ...remote.comments, ...local.comments },
  }
}
