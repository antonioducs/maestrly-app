import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, ChevronRight, FileCode, Loader2, RotateCcw, ScanSearch, Send, TriangleAlert } from 'lucide-react'
import {
  reviewActedFindings,
  type ChatReviewReport,
  type ReviewCheckResult,
  type ReviewFinding,
  type ReviewJobInfo,
} from '../../../../shared/review'
import { cn } from '../../../lib/utils'
import { findingLocation, formatReviewDuration, reviewModelShortLabel } from '../../../lib/review'
import { DECISION_CHIP, SEVERITY_COLOR, SEVERITY_PILL } from './review-style'

type OpenFileReference = (path: string, startLine?: number, endLine?: number) => void

export interface ReviewReceiptActions {
  /** Sends a saved code report to the agent. */
  send(messageId: string, report: ChatReviewReport): void
  /** Checks the fixes or the revision; resolves to why it could not start, or null. */
  check(messageId: string): Promise<string | null>
  /** Puts a message in the composer for the person to send. */
  sendBack(text: string): void
  /** Localized reason for a failed start. */
  errorText(error: string): string
}

type Step = 'done' | 'now' | 'next' | 'todo'

const BUTTON =
  'inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[12px] font-medium transition-colors disabled:pointer-events-none disabled:opacity-50'

function Journey({ steps }: { steps: Array<[string, Step]> }) {
  const { t } = useTranslation('chat')
  return (
    <ol aria-label={t('review.receipt.progress')} className="my-2.5 flex flex-wrap items-center gap-y-1.5">
      {steps.map(([label, step], index) => (
        <li
          key={label}
          className={cn(
            'flex items-center gap-1.5 text-[12px]',
            step === 'done' && 'text-foreground/80',
            step === 'now' && 'text-sky-300',
            step === 'next' && 'text-foreground/80',
            step === 'todo' && 'text-muted-foreground/60'
          )}
        >
          {index > 0 && <span aria-hidden className="mx-1.5 h-px w-4 bg-white/[0.12]" />}
          <span
            className={cn(
              'grid size-4 shrink-0 place-items-center rounded-full border',
              step === 'done' && 'border-emerald-400/45 bg-emerald-400/15 text-emerald-300',
              step === 'now' && 'border-sky-300/60',
              step === 'next' && 'border-dashed border-white/[0.25]',
              step === 'todo' && 'border-white/[0.12]'
            )}
          >
            {step === 'done' ? (
              <Check className="size-2.5" />
            ) : step === 'now' ? (
              <Loader2 className="size-2.5 animate-spin" />
            ) : null}
          </span>
          {label}
        </li>
      ))}
    </ol>
  )
}

function CheckChip({
  result,
  checking,
  target,
}: {
  result?: ReviewCheckResult
  checking: boolean
  target: 'code' | 'plan'
}) {
  const { t } = useTranslation('chat')
  if (checking && !result) {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-sky-300/40 px-2 text-[11px] leading-5 text-sky-300">
        <Loader2 className="size-2.5 animate-spin" />
        {t('review.receipt.checking')}
      </span>
    )
  }
  if (!result) return null
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full border px-2 text-[11px] leading-5',
        result.state === 'resolved' && 'border-emerald-400/40 bg-emerald-400/[0.08] text-emerald-300',
        result.state === 'open' && 'border-amber-400/45 bg-amber-400/[0.08] text-amber-300',
        result.state === 'unknown' && 'border-white/[0.12] text-muted-foreground'
      )}
    >
      {result.state === 'resolved' && <Check className="size-2.5" />}
      {t(`review.receipt.state.${result.state}${result.state === 'resolved' && target === 'plan' ? 'Plan' : ''}`)}
    </span>
  )
}

function ReceiptRow({
  finding,
  report,
  result,
  checking,
  onOpenFile,
}: {
  finding: ReviewFinding
  report: ChatReviewReport
  result?: ReviewCheckResult
  checking: boolean
  onOpenFile?: OpenFileReference
}) {
  const { t } = useTranslation('chat')
  const [open, setOpen] = useState(false)
  const decision = report.decisions?.[finding.id]
  const where = findingLocation(finding)
  const comment = report.comments?.[finding.id]
  const note = report.notes?.[finding.id]
  return (
    <li className="rounded-md hover:bg-white/[0.02]">
      <div className="flex min-w-0 items-center gap-2 px-1.5 py-1">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <ChevronRight
            className={cn('size-3 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')}
          />
          <span className="w-6 shrink-0 font-mono text-[11px] text-muted-foreground">{finding.id}</span>
          <span
            aria-label={t(`review.severity.${finding.severity}`)}
            className="size-2 shrink-0 rounded-full"
            style={{ background: SEVERITY_COLOR[finding.severity] }}
          />
          <span className="min-w-0 flex-1 truncate text-[13px] text-foreground/90">{finding.title}</span>
        </button>
        {decision && (
          <span className={cn('shrink-0 rounded-full border px-2 text-[11px] leading-5', DECISION_CHIP[decision])}>
            {t(`review.decision.${decision}`)}
          </span>
        )}
        <CheckChip result={result} checking={checking} target={report.target} />
      </div>
      {result?.state === 'open' && result.note && (
        <p className="ml-[3.6rem] pb-1 pr-2 text-[12px] leading-snug text-amber-200/90">{result.note}</p>
      )}
      {open && (
        <div className="ml-[3.6rem] flex flex-col gap-1.5 pb-2 pr-2 text-[12.5px] leading-relaxed text-foreground/85">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={cn('rounded border px-1.5 text-[10px] font-medium uppercase', SEVERITY_PILL[finding.severity])}
            >
              {t(`review.severity.${finding.severity}`)}
            </span>
            {where && (
              <button
                type="button"
                disabled={!onOpenFile}
                onClick={() => onOpenFile?.(finding.path!, finding.line)}
                className="inline-flex items-center gap-1 rounded font-mono text-[11px] text-sky-300/90 hover:underline disabled:text-muted-foreground disabled:no-underline"
              >
                <FileCode className="size-3" />
                {where}
              </button>
            )}
            {finding.planLine && (
              <span className="font-mono text-[11px] text-muted-foreground">
                {t('review.planLine', { line: finding.planLine })}
              </span>
            )}
          </div>
          <p className="whitespace-pre-wrap">{finding.details}</p>
          {finding.evidence && (
            <p className="whitespace-pre-wrap text-foreground/70">
              <span className="text-muted-foreground">{t('review.evidence')}: </span>
              {finding.evidence}
            </p>
          )}
          {finding.suggestion && (
            <p className="whitespace-pre-wrap text-foreground/70">
              <span className="text-muted-foreground">{t('review.suggestion')}: </span>
              {finding.suggestion}
            </p>
          )}
          {comment && (
            <p className="whitespace-pre-wrap text-teal-100/80">
              <span className="text-muted-foreground">{t('review.receipt.yourComment')}: </span>
              {comment}
            </p>
          )}
          {note && (
            <p className="whitespace-pre-wrap text-foreground/70">
              <span className="text-muted-foreground">{t('review.receipt.yourNote')}: </span>
              {note}
            </p>
          )}
        </div>
      )}
    </li>
  )
}

/**
 * A review in the conversation after it was handed off: what was decided, where the hand-off stands, and the check of
 * the fixes (or of the plan revision) the person can run once the agent is done.
 */
export function ReviewReceiptCard({
  messageId,
  report,
  check,
  busy = false,
  actions,
  onOpenFile,
}: {
  messageId: string
  report: ChatReviewReport
  /** A check of this receipt that runs, or just ended. */
  check?: ReviewJobInfo | null
  /** The agent is working in the conversation. */
  busy?: boolean
  /** Absent where the conversation is read-only. */
  actions?: ReviewReceiptActions
  onOpenFile?: OpenFileReference
}) {
  const { t } = useTranslation('chat')
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showDropped, setShowDropped] = useState(false)
  const plan = report.target === 'plan'
  const handoff = report.handoff
  const acted = reviewActedFindings(report)
  const live = check && check.kind === 'check' && check.messageId === messageId ? check : null
  const checking = live?.status === 'running'
  const results = new Map<string, ReviewCheckResult>(
    (checking ? (live?.checks ?? []) : (report.check?.results ?? [])).map((result) => [result.findingId, result])
  )
  const checked = !checking && report.check?.status === 'completed'
  const sentLike = handoff?.state === 'sent' || handoff?.state === 'revised'
  const agentWorking = sentLike && busy && !checking && !report.check

  const runCheck = async () => {
    if (!actions) return
    setStarting(true)
    setError(null)
    const failure = await actions.check(messageId)
    setStarting(false)
    if (failure) setError(actions.errorText(failure))
  }

  const step = (stage: 'agent' | 'check'): Step => {
    if (stage === 'agent') return agentWorking ? 'now' : 'done'
    if (checking) return 'now'
    if (report.check) return 'done'
    return agentWorking || !acted.length ? 'todo' : 'next'
  }
  const steps: Array<[string, Step]> | null = !handoff
    ? null
    : handoff.state === 'saved'
      ? [
          [t('review.receipt.reviewed'), 'done'],
          [t('review.receipt.decided'), 'done'],
          [t('review.receipt.saved'), 'done'],
          ...(plan ? [] : ([[t('review.receipt.sendStep'), 'next']] as Array<[string, Step]>)),
        ]
      : handoff.state === 'approved'
        ? [
            [t('review.receipt.reviewed'), 'done'],
            [t('review.receipt.decided'), 'done'],
            [t('review.receipt.approved'), 'done'],
          ]
        : [
            [t('review.receipt.reviewed'), 'done'],
            [t(plan ? 'review.receipt.commented' : 'review.receipt.decided'), 'done'],
            [t(plan ? 'review.receipt.revisionRequested' : 'review.receipt.sent'), 'done'],
            [t(plan ? 'review.receipt.agentRevising' : 'review.receipt.agentFixing'), step('agent')],
            [t(plan ? 'review.receipt.checkRevision' : 'review.receipt.checkFixes'), step('check')],
          ]

  const open = [...results.values()].filter((result) => result.state === 'open')
  const unknown = [...results.values()].filter((result) => result.state === 'unknown')
  const duration =
    report.finishedAt > report.startedAt ? formatReviewDuration(report.finishedAt - report.startedAt) : ''
  const currentCheck = checking ? acted.find((finding) => !results.has(finding.id)) : undefined

  let footer: ReactNode = null
  if (handoff?.state === 'saved') {
    footer = plan ? (
      <span className="text-muted-foreground">{t('review.receipt.savedPlan')}</span>
    ) : (
      <>
        <span className="min-w-0 flex-1 text-muted-foreground">{t('review.receipt.notSent')}</span>
        {actions && (
          <button
            type="button"
            disabled={busy}
            onClick={() => actions.send(messageId, report)}
            className={cn(BUTTON, 'bg-primary text-primary-foreground hover:bg-primary/90')}
          >
            <Send className="size-3.5" />
            {t('review.receipt.send')}
          </button>
        )}
      </>
    )
  } else if (handoff?.state === 'approved') {
    footer = <span className="text-muted-foreground">{t('review.receipt.approvedNote')}</span>
  } else if (sentLike) {
    if (checking) {
      footer = (
        <span className="flex min-w-0 items-center gap-2 text-sky-200">
          <Loader2 className="size-3.5 shrink-0 animate-spin" />
          {t('review.receipt.checkingNote', { id: currentCheck?.id ?? '' })}
        </span>
      )
    } else if (agentWorking) {
      footer = (
        <span className="flex min-w-0 items-center gap-2 text-muted-foreground">
          <Loader2 className="size-3.5 shrink-0 animate-spin" />
          {t(plan ? 'review.receipt.agentRevisingNote' : 'review.receipt.agentFixingNote', {
            ids: acted.map((finding) => finding.id).join(', '),
          })}
        </span>
      )
    } else if (!acted.length) {
      footer = <span className="text-muted-foreground">{t('review.receipt.nothingToCheck')}</span>
    } else {
      const checkButton = actions && (
        <button
          type="button"
          disabled={starting || busy}
          onClick={() => void runCheck()}
          className={cn(
            BUTTON,
            checked || report.check?.status === 'failed'
              ? 'border border-white/[0.12] text-foreground/85 hover:bg-white/[0.05]'
              : 'bg-primary text-primary-foreground hover:bg-primary/90'
          )}
        >
          {starting ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : checked ? (
            <RotateCcw className="size-3.5" />
          ) : (
            <ScanSearch className="size-3.5" />
          )}
          {checked || report.check?.status === 'failed'
            ? t('review.receipt.checkAgain')
            : t(plan ? 'review.receipt.checkRevision' : 'review.receipt.checkFixes')}
        </button>
      )
      if (report.check?.status === 'failed') {
        footer = (
          <>
            <span className="min-w-0 flex-1 text-amber-200/90">
              {t('review.receipt.checkFailed', { reason: report.check.error ?? '' })}
            </span>
            {checkButton}
          </>
        )
      } else if (checked && open.length) {
        footer = (
          <>
            <span className="min-w-0 flex-1 text-amber-200">
              {t('review.receipt.stillOpen', { count: open.length })}
            </span>
            {checkButton}
            {actions && (
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  actions.sendBack(
                    t('review.receipt.sendBackMessage', {
                      items: open
                        .map((result) => {
                          const finding = report.findings.find((item) => item.id === result.findingId)
                          return `- ${result.findingId}${finding ? ` ${finding.title.replaceAll('`', '')}` : ''}${result.note ? `: ${result.note}` : ''}`
                        })
                        .join('\n'),
                    })
                  )
                }
                className={cn(BUTTON, 'bg-primary text-primary-foreground hover:bg-primary/90')}
              >
                <Send className="size-3.5" />
                {t('review.receipt.sendBack', { ids: open.map((result) => result.findingId).join(', ') })}
              </button>
            )}
          </>
        )
      } else if (checked) {
        footer = (
          <>
            <span className="flex min-w-0 flex-1 items-center gap-1.5 text-emerald-300">
              <Check className="size-3.5 shrink-0" />
              {unknown.length
                ? t('review.receipt.someUnknown', { count: unknown.length })
                : t(plan ? 'review.receipt.allAddressed' : 'review.receipt.allHold', { count: acted.length })}
            </span>
            {checkButton}
          </>
        )
      } else {
        footer = (
          <>
            <span className="min-w-0 flex-1 text-muted-foreground">
              {t(plan ? 'review.receipt.checkRevisionHint' : 'review.receipt.checkFixesHint', {
                ids: acted.map((finding) => finding.id).join(', '),
              })}
            </span>
            {checkButton}
          </>
        )
      }
    }
  }

  return (
    <article
      data-testid="review-receipt"
      aria-label={t(plan ? 'review.planReviewTitle' : 'review.codeReviewTitle')}
      className="min-w-0 max-w-full rounded-xl border border-white/[0.1] bg-[linear-gradient(180deg,rgba(125,211,252,0.045),transparent_60%)] px-3.5 py-3"
    >
      <header className="flex min-w-0 items-center gap-2.5">
        <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-sky-400/10 text-sky-300">
          <ScanSearch className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium text-foreground">
            {t(plan ? 'review.planReviewTitle' : 'review.codeReviewTitle')}
          </div>
          <div className="truncate text-[11.5px] text-muted-foreground">
            {[
              report.model ? reviewModelShortLabel(report.model) : '',
              duration,
              report.findings.length
                ? t('review.receipt.funnel', {
                    candidates: t('review.receipt.candidates', { count: report.candidates }),
                    count: report.findings.length,
                  })
                : t('review.receipt.clean'),
            ]
              .filter(Boolean)
              .join(' · ')}
          </div>
        </div>
      </header>

      {steps && <Journey steps={steps} />}

      {report.unverified && (
        <p className="mb-1.5 flex items-start gap-1.5 text-[12px] text-amber-200/90">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
          {t('review.unverified')}
        </p>
      )}

      {report.findings.length > 0 && (
        <ul className="flex flex-col">
          {report.findings.map((finding) => (
            <ReceiptRow
              key={finding.id}
              finding={finding}
              report={report}
              result={results.get(finding.id)}
              checking={checking && acted.some((item) => item.id === finding.id)}
              onOpenFile={onOpenFile}
            />
          ))}
        </ul>
      )}

      {report.dropped?.length ? (
        <div className="mt-1">
          <button
            type="button"
            onClick={() => setShowDropped((value) => !value)}
            aria-expanded={showDropped}
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11.5px] text-muted-foreground hover:text-foreground"
          >
            <ChevronRight className={cn('size-3 transition-transform', showDropped && 'rotate-90')} />
            {t('review.droppedToggle', { count: report.dropped.length })}
          </button>
          {showDropped && (
            <ul className="ml-5 mt-1 flex flex-col gap-1.5">
              {report.dropped.map((item) => (
                <li key={item.id} className="border-l-2 border-white/[0.1] pl-2.5 text-[12px] text-muted-foreground">
                  <span className="text-foreground/70 line-through decoration-white/30">
                    {item.id} · {item.title}
                  </span>
                  <span className="block">
                    {item.verdict === 'merged' ? t('review.mergedInto', { id: item.into ?? '' }) : item.reason}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}

      {(footer || error) && (
        <footer className="mt-2.5 flex flex-wrap items-center gap-2 border-t border-white/[0.06] pt-2.5 text-[12.5px]">
          {footer}
          {error && (
            <span role="alert" className="w-full text-[12px] text-red-300">
              {error}
            </span>
          )}
        </footer>
      )}
    </article>
  )
}
