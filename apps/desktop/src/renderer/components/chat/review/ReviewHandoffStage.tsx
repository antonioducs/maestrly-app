import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, Check, Loader2, Send } from 'lucide-react'
import type { ReviewDecision, ReviewDraft, ReviewFinding, ReviewJobInfo } from '../../../../shared/review'
import { Button } from '@/components/ui/button'
import { composeReviewHandoff } from '@/lib/review'
import { cn } from '@/lib/utils'

type Step = 'done' | 'next' | 'todo'

const SEND_SHORTCUT = window.api.platformInfo.os === 'mac' ? '⌘⏎' : 'Ctrl+⏎'

function Preview({ steps }: { steps: Array<[string, Step]> }) {
  return (
    <ol className="flex flex-wrap items-center gap-y-1.5">
      {steps.map(([label, step], index) => (
        <li
          key={label}
          className={cn(
            'flex items-center gap-1.5 text-[12px]',
            step === 'todo' ? 'text-muted-foreground/60' : 'text-foreground/80'
          )}
        >
          {index > 0 && <span aria-hidden className="mx-1.5 h-px w-4 bg-white/[0.12]" />}
          <span
            className={cn(
              'grid size-4 place-items-center rounded-full border',
              step === 'done' && 'border-emerald-400/45 bg-emerald-400/15 text-emerald-300',
              step === 'next' && 'border-dashed border-white/[0.3]',
              step === 'todo' && 'border-white/[0.12]'
            )}
          >
            {step === 'done' && <Check className="size-2.5" />}
          </span>
          {label}
        </li>
      ))}
    </ol>
  )
}

function Column({
  findings,
  decision,
  draft,
}: {
  findings: readonly ReviewFinding[]
  decision: ReviewDecision
  draft: ReviewDraft
}) {
  const { t } = useTranslation('chat')
  const items = findings.filter((finding) => draft.decisions[finding.id] === decision)
  return (
    <section className="min-w-0 rounded-xl border border-white/[0.07] bg-[#16161b] p-3.5" data-column={decision}>
      <h4
        className={cn(
          'mb-2.5 flex items-center gap-2 text-[11.5px] font-semibold uppercase tracking-wide',
          decision === 'fix' && 'text-emerald-300',
          decision === 'discuss' && 'text-sky-300',
          decision === 'dismiss' && 'text-muted-foreground'
        )}
      >
        {t(`review.handoff.column.${decision}`)}
        <span className="font-medium tabular-nums text-muted-foreground">{items.length}</span>
      </h4>
      {items.length ? (
        <ul className="flex flex-col gap-2">
          {items.map((finding) => (
            <li key={finding.id} className="grid grid-cols-[24px_minmax(0,1fr)] gap-1.5 text-[12.5px] leading-snug">
              <span className="font-mono text-[11px] text-muted-foreground">{finding.id}</span>
              <span className="text-foreground/85">{finding.title}</span>
              {decision === 'dismiss' && draft.notes[finding.id] && (
                <small className="col-start-2 text-[11.5px] text-muted-foreground">{draft.notes[finding.id]}</small>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[12px] text-muted-foreground/70">{t('review.handoff.none')}</p>
      )}
    </section>
  )
}

/**
 * The last stage: what goes to the agent. Code reviews send an editable message with the report attached; plan
 * reviews send editable comments on plan lines as a revision request.
 */
export function ReviewHandoffStage({
  review,
  draft,
  plan,
  onComment,
  onBack,
  onHandoff,
}: {
  review: ReviewJobInfo
  draft: ReviewDraft
  /** Plan reviews: the reviewed plan's lines, to quote each comment's line. */
  plan?: string
  onComment: (findingId: string, comment: string) => void
  onBack: () => void
  /** Resolves to why the hand-off failed, or null. */
  onHandoff: (
    action: 'send' | 'save' | 'revise' | 'approve',
    input: { message?: string; general?: string }
  ) => Promise<string | null>
}) {
  const { t } = useTranslation('chat')
  const findings = review.findings ?? []
  const code = review.target === 'code'
  const composed = composeReviewHandoff(t, findings, draft)
  const [message, setMessage] = useState(composed)
  const [edited, setEdited] = useState(false)
  const [general, setGeneral] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!edited) setMessage(composed)
  }, [composed, edited])
  useEffect(() => rootRef.current?.focus(), [])

  const commented = findings.filter((finding) => draft.decisions[finding.id] === 'comment')
  const dismissed = findings.filter((finding) => draft.decisions[finding.id] === 'dismiss')
  const canSend = code
    ? findings.some((finding) => draft.decisions[finding.id] !== 'dismiss') && !!message.trim()
    : commented.length > 0
  const planLines = plan?.split('\n') ?? []

  const run = async (action: 'send' | 'save' | 'revise' | 'approve') => {
    if (busy) return
    setBusy(action)
    setError(null)
    const failure = await onHandoff(action, { message: message.trim(), general: general.trim() })
    setBusy(null)
    if (failure) setError(failure)
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && canSend) {
      event.preventDefault()
      void run(code ? 'send' : 'revise')
    }
  }

  const preview: Array<[string, Step]> = code
    ? [
        [t('review.receipt.reviewed'), 'done'],
        [t('review.receipt.decided'), 'done'],
        [t('review.receipt.sendStep'), 'next'],
        [t('review.receipt.agentFixing'), 'todo'],
        [t('review.receipt.checkFixes'), 'todo'],
      ]
    : [
        [t('review.receipt.reviewed'), 'done'],
        [t('review.receipt.decided'), 'done'],
        [t('review.receipt.revisionRequestStep'), 'next'],
        [t('review.receipt.agentRevising'), 'todo'],
        [t('review.receipt.checkRevision'), 'todo'],
      ]

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="@container flex min-h-0 flex-1 flex-col outline-none"
    >
      <div className="min-h-0 flex-1 overflow-auto p-4">
        <div className="mx-auto flex max-w-[1040px] flex-col gap-4">
          {code ? (
            <>
              <div className="grid gap-3 @3xl:grid-cols-3">
                <Column findings={findings} decision="fix" draft={draft} />
                <Column findings={findings} decision="discuss" draft={draft} />
                <Column findings={findings} decision="dismiss" draft={draft} />
              </div>
              <div>
                <label
                  htmlFor="review-handoff-message"
                  className="mb-2 flex flex-wrap items-baseline gap-2.5 text-[13px] font-medium"
                >
                  {t('review.handoff.messageLabel')}
                  <small className="text-[12px] font-normal text-muted-foreground">
                    {t('review.handoff.messageHint')}
                  </small>
                </label>
                <textarea
                  id="review-handoff-message"
                  data-testid="review-handoff-message"
                  value={message}
                  onChange={(event) => {
                    setMessage(event.target.value)
                    setEdited(true)
                  }}
                  className="min-h-44 w-full resize-y rounded-xl border border-white/[0.12] bg-[#111115] px-3.5 py-3 text-[13.5px] leading-relaxed outline-none focus:border-sky-300/45"
                />
              </div>
            </>
          ) : (
            <>
              <div>
                <div className="mb-2 flex flex-wrap items-baseline gap-2.5 text-[13px] font-medium">
                  {t('review.handoff.commentsLabel')}
                  <small className="text-[12px] font-normal text-muted-foreground">
                    {t('review.handoff.commentsHint')}
                  </small>
                </div>
                {commented.length ? (
                  <div className="grid gap-2.5 [grid-template-columns:repeat(auto-fit,minmax(300px,1fr))]">
                    {commented.map((finding) => (
                      <div
                        key={finding.id}
                        className="flex flex-col gap-2 rounded-xl border border-white/[0.07] bg-[#16161b] p-3"
                      >
                        <div className="flex gap-2.5 text-[13px] text-foreground/85">
                          <span className="shrink-0 pt-0.5 font-mono text-[11px] text-muted-foreground">
                            {finding.planLine ? `L${finding.planLine}` : finding.id}
                          </span>
                          <span className="min-w-0">
                            {finding.planLine
                              ? (planLines[finding.planLine - 1] ?? '').trim() || finding.title
                              : finding.title}
                          </span>
                        </div>
                        <textarea
                          data-comment={finding.id}
                          aria-label={t('review.handoff.commentFor', { id: finding.id })}
                          value={draft.comments[finding.id] ?? ''}
                          rows={Math.min(8, Math.max(3, (draft.comments[finding.id] ?? '').split('\n').length + 1))}
                          onChange={(event) => onComment(finding.id, event.target.value)}
                          className="w-full resize-y rounded-lg border border-teal-300/30 bg-teal-300/[0.04] px-2.5 py-2 text-[13px] outline-none focus:border-teal-300/60"
                        />
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-[12.5px] text-muted-foreground">{t('review.handoff.noComments')}</p>
                )}
              </div>
              {dismissed.length > 0 && (
                <p className="text-[12.5px] text-muted-foreground">
                  {t('review.handoff.dismissedList', {
                    items: dismissed.map((finding) => `${finding.id} ${finding.title}`).join(' · '),
                  })}
                </p>
              )}
              <div>
                <label
                  htmlFor="review-handoff-general"
                  className="mb-2 flex items-baseline gap-2.5 text-[13px] font-medium"
                >
                  {t('review.handoff.generalLabel')}
                  <small className="text-[12px] font-normal text-muted-foreground">
                    {t('review.handoff.optional')}
                  </small>
                </label>
                <textarea
                  id="review-handoff-general"
                  value={general}
                  onChange={(event) => setGeneral(event.target.value)}
                  className="min-h-24 w-full resize-y rounded-xl border border-white/[0.12] bg-[#111115] px-3.5 py-3 text-[13.5px] leading-relaxed outline-none focus:border-sky-300/45"
                />
              </div>
            </>
          )}
          <div className="flex flex-wrap items-center gap-3.5 text-[12.5px] text-muted-foreground">
            <span>{t(code ? 'review.handoff.afterSend' : 'review.handoff.afterRevise')}</span>
            <Preview steps={preview} />
          </div>
        </div>
      </div>
      <footer className="flex flex-wrap items-center gap-2.5 border-t border-white/[0.07] bg-black/40 px-4 py-2.5 text-[12.5px]">
        <Button variant="ghost" onClick={onBack} disabled={!!busy}>
          <ArrowLeft className="size-4" />
          {t('review.handoff.backToDecisions')}
        </Button>
        {error && (
          <span role="alert" className="min-w-0 flex-1 text-[12px] text-red-300">
            {error}
          </span>
        )}
        <span className="flex-1" />
        {code ? (
          <>
            <Button variant="ghost" disabled={!!busy} onClick={() => void run('save')}>
              {busy === 'save' && <Loader2 className="size-4 animate-spin" />}
              {t('review.handoff.saveOnly')}
            </Button>
            <Button disabled={!canSend || !!busy} onClick={() => void run('send')} data-testid="review-send">
              {busy === 'send' ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
              {t('review.handoff.send')}
              <kbd className="ml-1 rounded border border-black/20 px-1 font-mono text-[10px] opacity-70">
                {SEND_SHORTCUT}
              </kbd>
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" disabled={!!busy} onClick={() => void run('approve')}>
              {busy === 'approve' && <Loader2 className="size-4 animate-spin" />}
              {t('review.room.approveAsWritten')}
            </Button>
            <Button disabled={!canSend || !!busy} onClick={() => void run('revise')} data-testid="review-revise">
              {busy === 'revise' && <Loader2 className="size-4 animate-spin" />}
              {t('review.handoff.requestRevision', { count: commented.length })}
              <kbd className="ml-1 rounded border border-black/20 px-1 font-mono text-[10px] opacity-70">
                {SEND_SHORTCUT}
              </kbd>
            </Button>
          </>
        )}
      </footer>
    </div>
  )
}
