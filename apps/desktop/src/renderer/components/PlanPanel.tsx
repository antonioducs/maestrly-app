import { useCallback, useEffect, useMemo, useState } from 'react'
import { preparePlanPanelMemoryEviction, usePanelMemoryEviction } from '@/lib/panel-memory-eviction'
import { useTranslation } from 'react-i18next'
import { diffLines } from 'diff'
import {
  Check,
  MessageSquarePlus,
  Trash2,
  Pencil,
  BookOpen,
  GitCompare,
  Sparkles,
  SquarePlus,
  ScanSearch,
  Lock,
  X,
} from 'lucide-react'
import type { PlanReceived, PlanDecision, PlanDecisionResponse } from '../../preload'
import { cn } from '@/lib/utils'
import { useHostApi } from '@/lib/hosts/host-context'
import { Button } from '@/components/ui/button'
import { MarkdownViewer, type CommentCtx } from '@/components/MarkdownViewer'
import { planDecisionError } from '@/lib/plan-decision'
import { MaestroPlanProfileDialog } from '@/components/MaestroPlanProfileDialog'
import { StandardPlanHandoffDialog } from '@/components/StandardPlanHandoffDialog'
import { useConversationReview } from '@/lib/review'
import { reviewLocksConversation } from '../../shared/review'

interface Props {
  plan: PlanReceived
  onDecide: (decision: PlanDecision) => Promise<PlanDecisionResponse | undefined> | void

  onOpenFile?: (filePath: string, line?: number) => void
}

type Mode = 'read' | 'edit' | 'diff'

function planHash(text: string): string {
  let hash = 0
  for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) | 0
  return String(hash)
}

export function PlanPanel({ plan, onDecide, onOpenFile }: Props) {
  const { t } = useTranslation('ui')
  const api = useHostApi()
  const [text, setText] = useState(plan.plan)
  const [feedback, setFeedback] = useState('')
  const [mode, setMode] = useState<Mode>('read')
  const [busy, setBusy] = useState(false)
  const [decisionError, setDecisionError] = useState<string | null>(null)
  const [maestroProfileOpen, setMaestroProfileOpen] = useState(false)
  const [standardHandoffOpen, setStandardHandoffOpen] = useState(false)

  const [lineComments, setLineComments] = useState<Record<number, string>>({})
  const [editingLine, setEditingLine] = useState<number | null>(null)
  // The saved draft loads asynchronously; review findings merge into it only after it has loaded.
  const [draftReady, setDraftReady] = useState(false)

  const { t: tChat } = useTranslation('chat')
  const { review } = useConversationReview(api, plan.agentId)
  // A review (of this plan or of the code) holds the conversation: the plan is decided from its hand-off.
  const underReview = reviewLocksConversation(review)
  const [dismissedCheck, setDismissedCheck] = useState<string | null>(null)
  const planCheck =
    review?.kind === 'check' &&
    review.target === 'plan' &&
    review.status === 'completed' &&
    review.planVersion === plan.version &&
    `${review.reviewId}:${review.finishedAt}` !== dismissedCheck
      ? review
      : null

  const hasPrev = !!plan.previousPlan && plan.version > 1
  const currentHash = planHash(plan.plan)

  useEffect(() => {
    let alive = true
    setBusy(false)
    setDecisionError(null)
    setEditingLine(null)
    setDraftReady(false)
    void api.getPlanDraft(plan.agentId).then((raw) => {
      if (!alive) return
      const draft = raw as {
        version?: number
        planHash?: string
        text?: string
        feedback?: string
        lineComments?: Record<number, string>
        mode?: Mode
      } | null
      if (draft && draft.version === plan.version && draft.planHash === currentHash) {
        setText(typeof draft.text === 'string' ? draft.text : plan.plan)
        setFeedback(typeof draft.feedback === 'string' ? draft.feedback : '')
        setLineComments(draft.lineComments && typeof draft.lineComments === 'object' ? draft.lineComments : {})
        setMode(
          draft.mode === 'edit' || draft.mode === 'diff'
            ? draft.mode
            : plan.previousPlan && plan.version > 1
              ? 'diff'
              : 'read'
        )
        setDraftReady(true)
        return
      }
      api.savePlanDraft(plan.agentId, null)
      setText(plan.plan)
      setFeedback('')
      setLineComments({})
      setMode(plan.previousPlan && plan.version > 1 ? 'diff' : 'read')
      setDraftReady(true)
    })
    return () => {
      alive = false
    }
  }, [currentHash, plan.agentId, plan.plan, plan.previousPlan, plan.version, api])

  const commentList = useMemo(
    () =>
      Object.entries(lineComments)
        .map(([line, body]) => ({ line: Number(line), text: body.trim() }))
        .filter((c) => c.text),
    [lineComments]
  )
  const edited = text.trim() !== plan.plan.trim()
  const canRevise = !!feedback.trim() || edited || commentList.length > 0

  const persistDraft = useCallback(() => {
    api.savePlanDraft(plan.agentId, {
      version: plan.version,
      planHash: currentHash,
      text,
      feedback,
      lineComments,
      mode,
    })
  }, [currentHash, feedback, lineComments, mode, plan.agentId, plan.version, text, api])

  const decide = async (d: PlanDecision) => {
    setBusy(true)
    setDecisionError(null)
    try {
      const result = await onDecide(d)
      const error = planDecisionError(result)
      if (error) {
        setBusy(false)
        setDecisionError(error)
        return false
      }
      api.savePlanDraft(plan.agentId, null)
      return true
    } catch (error) {
      setBusy(false)
      setDecisionError(error instanceof Error ? error.message : String(error))
      return false
    }
  }
  // The review's hand-off merges the person's own comments and edits, so they are saved when the review takes over.
  useEffect(() => {
    if (underReview && draftReady) persistDraft()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [underReview])

  const prepareMemoryEviction = useCallback(
    () => preparePlanPanelMemoryEviction(busy, editingLine, persistDraft),
    [busy, editingLine, persistDraft]
  )
  usePanelMemoryEviction(plan.agentId, 'plan', prepareMemoryEviction)

  const onAddOrEdit = useCallback((line: number) => setEditingLine(line), [])
  const onCancel = useCallback(() => setEditingLine(null), [])
  const onSave = useCallback((line: number, value: string) => {
    setLineComments((prev) => {
      const next = { ...prev }
      const v = value.trim()
      if (v) next[line] = v
      else delete next[line]
      return next
    })
    setEditingLine(null)
  }, [])
  const onRemove = useCallback((line: number) => {
    setLineComments((prev) => {
      const next = { ...prev }
      delete next[line]
      return next
    })
  }, [])

  const commentCtx = useMemo<CommentCtx>(
    () => ({
      comments: lineComments,
      editingLine: underReview ? null : editingLine,
      onAddOrEdit: underReview ? () => undefined : onAddOrEdit,
      onSave,
      onCancel,
      onRemove: underReview ? () => undefined : onRemove,
    }),
    [lineComments, editingLine, onAddOrEdit, onSave, onCancel, onRemove, underReview]
  )
  const locked = busy || underReview

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-border px-3">
        <div className="flex min-w-0 items-center gap-2 text-xs">
          <span className="font-medium text-foreground">{t('plan.agentPlan')}</span>
          {plan.version > 1 && (
            <span className="shrink-0 rounded bg-white/[0.06] px-1.5 py-0.5 text-[10px] text-muted-foreground">
              {t('plan.revision', { version: plan.version })}
            </span>
          )}
          {commentList.length > 0 && (
            <span className="shrink-0 text-[10px] text-primary">
              • {t('plan.comments', { count: commentList.length })}
            </span>
          )}
          {edited && <span className="shrink-0 text-[10px] text-primary">• {t('plan.edited')}</span>}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button
            size="sm"
            variant="ghost"
            className="h-6 gap-1 px-2 text-[11px] text-muted-foreground hover:text-foreground"
            disabled={locked}
            title={t('plan.reviewPlanHint')}
            data-testid="plan-review-button"
            onClick={() => void api.chatReviewOpen(plan.agentId, 'plan')}
          >
            <ScanSearch className="size-3.5" />
            {t('plan.reviewPlan')}
          </Button>
          <div className="flex shrink-0 items-center gap-0.5 rounded-md bg-white/[0.04] p-0.5 ring-1 ring-white/[0.05]">
            <ModeBtn
              icon={<BookOpen className="size-3.5" />}
              label={t('plan.modeRead')}
              active={mode === 'read'}
              onClick={() => setMode('read')}
            />
            <ModeBtn
              icon={<Pencil className="size-3.5" />}
              label={t('plan.modeEdit')}
              active={mode === 'edit'}
              onClick={() => setMode('edit')}
            />
            {hasPrev && (
              <ModeBtn
                icon={<GitCompare className="size-3.5" />}
                label={t('plan.modeDiff')}
                active={mode === 'diff'}
                onClick={() => setMode('diff')}
              />
            )}
          </div>
        </div>
      </div>

      {underReview && review && (
        <div
          role="status"
          data-testid="plan-review-lock"
          className="flex shrink-0 items-center gap-2 border-b border-amber-500/15 bg-amber-500/[0.06] px-3 py-1.5 text-[11px] text-amber-100"
        >
          <Lock className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1">
            {t(
              review.kind === 'check'
                ? 'plan.reviewLockCheck'
                : review.status === 'ready'
                  ? 'plan.reviewLockReady'
                  : review.target === 'plan'
                    ? 'plan.reviewLockRunning'
                    : 'plan.reviewLockCode'
            )}
          </span>
        </div>
      )}
      {!underReview && planCheck && (
        <div
          role="status"
          data-testid="plan-review-status"
          className={cn(
            'flex shrink-0 items-center gap-2 border-b px-3 py-1.5 text-[11px]',
            planCheck.checks?.some((result) => result.state !== 'resolved')
              ? 'border-amber-500/20 bg-amber-500/[0.06] text-amber-100'
              : 'border-emerald-500/20 bg-emerald-500/[0.06] text-emerald-100'
          )}
        >
          <ScanSearch className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1">
            {planCheck.checks?.some((result) => result.state !== 'resolved')
              ? t('plan.reviewCheckOpen', {
                  count: planCheck.checks.filter((result) => result.state !== 'resolved').length,
                })
              : t('plan.reviewCheckResolved', { count: planCheck.checks?.length ?? 0 })}
          </span>
          <button
            type="button"
            onClick={() => setDismissedCheck(`${planCheck.reviewId}:${planCheck.finishedAt}`)}
            className="shrink-0 rounded p-0.5 opacity-70 hover:opacity-100"
            aria-label={tChat('view.dismiss')}
          >
            <X className="size-3.5" />
          </button>
        </div>
      )}

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {mode === 'edit' ? (
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            readOnly={underReview}
            spellCheck={false}
            className="h-full min-h-[280px] w-full resize-none rounded-lg border border-input bg-black/20 p-3 font-mono text-[12.5px] leading-relaxed text-foreground outline-none focus:ring-1 focus:ring-ring"
          />
        ) : mode === 'diff' && plan.previousPlan ? (
          <DiffView before={plan.previousPlan} after={text} />
        ) : (
          <MarkdownViewer markdown={text} onOpenFile={onOpenFile} ctx={commentCtx} />
        )}
      </div>

      <div className="flex shrink-0 flex-col gap-2 border-t border-border bg-black/10 px-3 py-2.5">
        {decisionError && (
          <div
            role="alert"
            className="rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-2 text-xs text-destructive"
          >
            {t('panel.planDecisionFailed', { error: decisionError })}
          </div>
        )}
        <textarea
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
          disabled={underReview}
          placeholder={t('plan.generalCommentPlaceholder')}
          className="h-14 w-full resize-none rounded-lg border border-input bg-black/20 px-3 py-2 text-xs text-foreground outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-ring"
        />
        <div className="grid grid-cols-2 gap-2">
          <Button
            size="sm"
            className="h-8 gap-1.5"
            disabled={locked}
            onClick={() => decide({ action: 'approve', editedPlan: edited ? text : undefined })}
          >
            <Check className="size-4" /> {t('plan.approve')}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            className="h-8 gap-1.5 text-amber-200 hover:text-amber-100"
            disabled={locked}
            title={t('plan.implementWithMaestroHint')}
            onClick={() => setMaestroProfileOpen(true)}
          >
            <Sparkles className="size-4" /> {t('plan.implementWithMaestro')}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            className="col-span-2 h-8 gap-1.5"
            disabled={locked}
            title={t('plan.implementInNewConversationHint')}
            onClick={() => setStandardHandoffOpen(true)}
          >
            <SquarePlus className="size-4" /> {t('plan.implementInNewConversation')}
          </Button>
          <div className="col-span-2 flex items-center gap-2">
            <Button
              size="sm"
              variant="secondary"
              className="h-8 flex-1 gap-1.5"
              disabled={locked || !canRevise}
              title={canRevise ? t('plan.reviseHintEnabled') : t('plan.reviseHintDisabled')}
              onClick={() =>
                decide({
                  action: 'revise',
                  feedback: feedback.trim() || undefined,
                  editedPlan: edited ? text : undefined,
                  lineComments: commentList.length ? commentList : undefined,
                })
              }
            >
              <MessageSquarePlus className="size-4" /> {t('plan.requestRevision')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-8 gap-1.5 text-muted-foreground"
              disabled={locked}
              title={t('plan.discard')}
              onClick={() => decide({ action: 'discard' })}
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
        </div>
      </div>
      <MaestroPlanProfileDialog
        open={maestroProfileOpen}
        busy={busy}
        decisionError={decisionError}
        onOpenChange={setMaestroProfileOpen}
        onConfirm={(profileId) =>
          decide({
            action: 'approve',
            implementationTarget: 'maestro',
            maestroStrategyProfileId: profileId,
            editedPlan: edited ? text : undefined,
          })
        }
      />
      <StandardPlanHandoffDialog
        open={standardHandoffOpen}
        sourceConversationId={plan.agentId}
        busy={busy}
        decisionError={decisionError}
        onOpenChange={setStandardHandoffOpen}
        onConfirm={(standardHandoff) =>
          decide({
            action: 'approve',
            implementationTarget: 'standard',
            standardHandoff,
            editedPlan: edited ? text : undefined,
          })
        }
      />
    </div>
  )
}

function ModeBtn({
  icon,
  label,
  active,
  onClick,
}: {
  icon: React.ReactNode
  label: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-medium transition-all duration-150',
        active
          ? 'bg-white/[0.08] text-foreground shadow-sm ring-1 ring-white/[0.06]'
          : 'text-muted-foreground hover:text-foreground'
      )}
    >
      {icon}
      {label}
    </button>
  )
}

function DiffView({ before, after }: { before: string; after: string }) {
  const rows = useMemo(() => {
    const parts = diffLines(before, after)
    const out: { kind: 'add' | 'del' | 'ctx'; text: string }[] = []
    for (const part of parts) {
      const kind = part.added ? 'add' : part.removed ? 'del' : 'ctx'
      const lines = part.value.replace(/\n$/, '').split('\n')
      for (const ln of lines) out.push({ kind, text: ln })
    }
    return out
  }, [before, after])

  return (
    <div className="overflow-hidden rounded-lg border border-border font-mono text-[12px] leading-relaxed">
      {rows.map((r, i) => (
        <div
          key={i}
          className={cn(
            'flex gap-2 whitespace-pre-wrap break-words px-2 py-px',
            r.kind === 'add' && 'bg-status-ready/10 text-status-ready',
            r.kind === 'del' && 'bg-destructive/10 text-destructive',
            r.kind === 'ctx' && 'text-foreground/45'
          )}
        >
          <span className="select-none opacity-60">{r.kind === 'add' ? '+' : r.kind === 'del' ? '−' : ' '}</span>
          <span className="min-w-0 flex-1">{r.text || ' '}</span>
        </div>
      ))}
    </div>
  )
}
