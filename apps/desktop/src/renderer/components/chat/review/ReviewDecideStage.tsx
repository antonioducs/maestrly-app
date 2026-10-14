import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ArrowRight,
  Ban,
  BadgeCheck,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  FileCode,
  GitMerge,
  MessageSquarePlus,
  MessagesSquare,
  TriangleAlert,
  Wrench,
  type LucideIcon,
} from 'lucide-react'
import {
  reviewDecisionsFor,
  type ReviewDecision,
  type ReviewDraft,
  type ReviewFinding,
  type ReviewJobInfo,
  type ReviewSnippet,
} from '../../../../shared/review'
import { Button } from '@/components/ui/button'
import { droppedCandidates, findingLocation } from '@/lib/review'
import { cn } from '@/lib/utils'
import { DECISION_CHIP, LANE_STYLE, SEVERITY_COLOR, SEVERITY_PILL } from './review-style'

const DECISION_ICON: Record<ReviewDecision, LucideIcon> = {
  fix: Wrench,
  discuss: MessagesSquare,
  comment: MessageSquarePlus,
  dismiss: Ban,
}

export const DECISION_KEY: Record<ReviewDecision, string> = { fix: 'f', discuss: 'd', comment: 'c', dismiss: 'x' }

const DECISION_ON: Record<ReviewDecision, string> = {
  fix: 'border-emerald-300/55 bg-emerald-300/10 text-emerald-100',
  discuss: 'border-sky-300/55 bg-sky-300/10 text-sky-100',
  comment: 'border-teal-300/55 bg-teal-300/10 text-teal-100',
  dismiss: 'border-white/[0.25] bg-white/[0.06] text-foreground',
}

function Snippet({ snippet, severity }: { snippet: ReviewSnippet; severity: ReviewFinding['severity'] }) {
  const { t } = useTranslation('chat')
  const color = snippet.source === 'plan' ? '#7dd3fc' : SEVERITY_COLOR[severity]
  return (
    <figure className="mb-3 overflow-hidden rounded-lg border border-white/[0.07] bg-[#09090c]">
      <figcaption className="flex items-center gap-1.5 border-b border-white/[0.07] bg-white/[0.02] px-2.5 py-1.5 font-mono text-[11.5px] text-muted-foreground">
        {snippet.source === 'plan' ? <ClipboardList className="size-3" /> : <FileCode className="size-3" />}
        {snippet.source === 'plan' ? t('review.room.planSnippet') : snippet.path}
      </figcaption>
      <pre className="overflow-auto py-1.5 font-mono text-[12.5px] leading-[1.7]">
        {snippet.lines.map((line, index) => {
          const number = snippet.start + index
          const highlighted = number === snippet.highlight
          return (
            <span
              key={number}
              className="flex min-w-max"
              style={highlighted ? { background: `${color}1f`, boxShadow: `inset 2px 0 0 ${color}` } : undefined}
            >
              <span
                className="w-11 shrink-0 select-none pr-3.5 text-right text-muted-foreground/60"
                style={highlighted ? { color } : undefined}
              >
                {number}
              </span>
              <span
                className={cn(
                  'pr-4 text-[#d4d4dc]',
                  snippet.source === 'plan' ? 'whitespace-pre-wrap' : 'whitespace-pre'
                )}
              >
                {line || ' '}
              </span>
            </span>
          )
        })}
      </pre>
    </figure>
  )
}

function FindingCard({
  review,
  finding,
  index,
  draft,
  onDecide,
  onNote,
  onMove,
  onOpenFile,
  onOpenPlanLine,
}: {
  review: ReviewJobInfo
  finding: ReviewFinding
  index: number
  draft: ReviewDraft
  onDecide: (decision: ReviewDecision) => void
  onNote: (note: string) => void
  onMove: (delta: number) => void
  onOpenFile?: (path: string, line?: number) => void
  onOpenPlanLine?: (line: number) => void
}) {
  const { t } = useTranslation('chat')
  const findings = review.findings ?? []
  const decision = draft.decisions[finding.id]
  const where = findingLocation(finding)
  const noteRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (decision === 'dismiss') noteRef.current?.focus()
  }, [decision, finding.id])
  return (
    <article
      aria-label={finding.id}
      data-testid="review-finding"
      className="relative min-w-0 rounded-2xl border border-white/[0.07] bg-[#16161b] px-5 pb-5 pt-4"
    >
      <span
        aria-hidden
        className="absolute bottom-4 left-[-1px] top-4 w-[3px] rounded-r"
        style={{ background: SEVERITY_COLOR[finding.severity] }}
      />
      <header className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[12px] text-foreground/85">{finding.id}</span>
        <span
          className={cn('rounded border px-1.5 text-[10px] font-semibold uppercase', SEVERITY_PILL[finding.severity])}
        >
          {t(`review.severity.${finding.severity}`)}
        </span>
        <span className="inline-flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
          <i className="size-[7px] rounded-full" style={{ background: LANE_STYLE[finding.lens].color }} />
          {t(`review.lens.${finding.lens}`)}
        </span>
        {finding.merged?.length ? (
          <span className="inline-flex items-center gap-1 rounded border border-white/[0.12] px-1.5 text-[10.5px] text-muted-foreground">
            <GitMerge className="size-3" />
            {t('review.room.mergedFrom', { ids: finding.merged.join(', ') })}
          </span>
        ) : null}
        <span className="flex-1" />
        <span className="text-[12px] tabular-nums text-muted-foreground">
          {index + 1} / {findings.length}
        </span>
        <button
          type="button"
          aria-label={t('review.room.previous')}
          disabled={index === 0}
          onClick={() => onMove(-1)}
          className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-white/[0.06] hover:text-foreground disabled:opacity-40"
        >
          <ChevronLeft className="size-4" />
        </button>
        <button
          type="button"
          aria-label={t('review.room.next')}
          disabled={index === findings.length - 1}
          onClick={() => onMove(1)}
          className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-white/[0.06] hover:text-foreground disabled:opacity-40"
        >
          <ChevronRight className="size-4" />
        </button>
      </header>
      <h2 className="mb-1.5 mt-3 text-[19px] font-semibold leading-snug [text-wrap:balance]">{finding.title}</h2>
      <div className="-ml-1.5 flex flex-wrap items-center gap-x-2">
        {finding.planLine && (
          <button
            type="button"
            disabled={!onOpenPlanLine}
            onClick={() => onOpenPlanLine?.(finding.planLine!)}
            className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 font-mono text-[12px] text-sky-300 hover:bg-sky-300/[0.08] disabled:hover:bg-transparent"
          >
            <ClipboardList className="size-3.5" />
            {t('review.planLine', { line: finding.planLine })}
          </button>
        )}
        {where && (
          <button
            type="button"
            disabled={!onOpenFile}
            onClick={() => onOpenFile?.(finding.path!, finding.line)}
            className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 font-mono text-[12px] text-sky-300 hover:bg-sky-300/[0.08] disabled:hover:bg-transparent"
          >
            <FileCode className="size-3.5" />
            {where}
          </button>
        )}
      </div>
      <p className="mb-3.5 mt-2.5 max-w-[72ch] whitespace-pre-wrap text-[14px] leading-relaxed text-foreground/85">
        {finding.details}
      </p>
      {finding.snippet && <Snippet snippet={finding.snippet} severity={finding.severity} />}
      <dl className="mb-4 mt-3.5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-[13px]">
        {finding.evidence && (
          <>
            <dt className="pt-px text-[12px] text-muted-foreground">{t('review.evidence')}</dt>
            <dd className="whitespace-pre-wrap text-foreground/85">{finding.evidence}</dd>
          </>
        )}
        {finding.suggestion && (
          <>
            <dt className="pt-px text-[12px] text-muted-foreground">{t('review.suggestion')}</dt>
            <dd className="whitespace-pre-wrap text-foreground/85">{finding.suggestion}</dd>
          </>
        )}
      </dl>
      <p className="-mt-1 mb-3.5 flex items-start gap-1.5 text-[12px] text-muted-foreground">
        {finding.unverified ? (
          <>
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-300" />
            {t('review.room.unverifiedNote')}
          </>
        ) : (
          <>
            <BadgeCheck className="mt-0.5 size-3.5 shrink-0 text-emerald-400" />
            {finding.fromSeverity
              ? t('review.room.confirmedAdjusted', {
                  from: t(`review.severity.${finding.fromSeverity}`),
                  to: t(`review.severity.${finding.severity}`),
                })
              : t('review.room.confirmedNote')}
          </>
        )}
      </p>
      <div className="border-t border-white/[0.07] pt-3.5">
        <div className="mb-2 text-[12.5px] text-muted-foreground">
          {t('review.room.decisionQuestion', { id: finding.id })}
        </div>
        <div
          role="radiogroup"
          aria-label={t('review.room.decisionFor', { id: finding.id })}
          className="grid gap-2"
          style={{ gridTemplateColumns: `repeat(${reviewDecisionsFor(review.target).length}, minmax(0, 1fr))` }}
        >
          {reviewDecisionsFor(review.target).map((option) => {
            const Icon = DECISION_ICON[option]
            const checked = decision === option
            return (
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={checked}
                data-decision={option}
                onClick={() => onDecide(option)}
                className={cn(
                  'flex h-11 min-w-0 items-center justify-center gap-2 rounded-xl border px-2 text-[13.5px] transition-colors',
                  checked
                    ? DECISION_ON[option]
                    : 'border-white/[0.12] bg-white/[0.02] text-foreground/80 hover:bg-white/[0.05]'
                )}
              >
                <Icon className="size-4 shrink-0" />
                <span className="truncate">{t(`review.decisionAction.${option}`)}</span>
                <kbd className="hidden rounded border border-white/[0.15] border-b-2 px-1 font-mono text-[10px] text-muted-foreground @md:inline">
                  {DECISION_KEY[option].toUpperCase()}
                </kbd>
              </button>
            )
          })}
        </div>
        {decision === 'dismiss' && (
          <input
            ref={noteRef}
            data-note={finding.id}
            value={draft.notes[finding.id] ?? ''}
            onChange={(event) => onNote(event.target.value)}
            placeholder={t('review.room.dismissPlaceholder')}
            aria-label={t('review.room.dismissReason', { id: finding.id })}
            maxLength={1000}
            className="mt-2.5 h-9 w-full rounded-lg border border-white/[0.12] bg-[#111115] px-3 text-[13px] outline-none focus:border-sky-300/50"
          />
        )}
      </div>
    </article>
  )
}

/** One finding at a time, decided with buttons or the keyboard; the list keeps the overview. */
export function ReviewDecideStage({
  review,
  draft,
  onDecide,
  onNote,
  onRest,
  onContinue,
  onCloseClean,
  onOpenFile,
  onOpenPlanLine,
}: {
  review: ReviewJobInfo
  draft: ReviewDraft
  onDecide: (findingId: string, decision: ReviewDecision) => void
  onNote: (findingId: string, note: string) => void
  /** Decides every undecided finding: discuss (code) or comment (plan). */
  onRest: () => void
  onContinue: () => void
  /** No findings: end the review. */
  onCloseClean: (action: 'save' | 'approve') => void
  onOpenFile?: (path: string, line?: number) => void
  onOpenPlanLine?: (line: number) => void
}) {
  const { t } = useTranslation('chat')
  const findings = review.findings ?? []
  const [focus, setFocus] = useState(() =>
    Math.max(
      0,
      findings.findIndex((finding) => !draft.decisions[finding.id])
    )
  )
  const [showDropped, setShowDropped] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const dropped = droppedCandidates(review)
  const decided = findings.filter((finding) => draft.decisions[finding.id]).length
  const all = decided === findings.length
  const current = findings[Math.min(focus, findings.length - 1)]
  const options = reviewDecisionsFor(review.target)

  useEffect(() => rootRef.current?.focus(), [])

  const move = (delta: number) => setFocus((index) => Math.min(findings.length - 1, Math.max(0, index + delta)))
  const advance = (from: number) => {
    for (let step = 1; step <= findings.length; step++) {
      const index = (from + step) % findings.length
      if (!draft.decisions[findings[index].id] && index !== from) {
        setFocus(index)
        return true
      }
    }
    return false
  }
  const decide = (decision: ReviewDecision) => {
    if (!current) return
    onDecide(current.id, decision)
    // A dismissal stays on the finding so the reason can be typed; anything else moves on at once.
    if (decision !== 'dismiss') advance(focus)
    else rootRef.current?.focus()
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented) return
    const element = event.target as HTMLElement
    if (element.matches('input[data-note]')) {
      if (event.key === 'Enter' || event.key === 'Escape') {
        event.preventDefault()
        rootRef.current?.focus()
        if (!advance(focus) && event.key === 'Enter' && all) onContinue()
      }
      return
    }
    if (element.closest('input, textarea')) return
    const key = event.key.toLowerCase()
    const decision = options.find((option) => DECISION_KEY[option] === key)
    if (key === 'j' || event.key === 'ArrowDown') move(1)
    else if (key === 'k' || event.key === 'ArrowUp') move(-1)
    else if (decision) decide(decision)
    else if (event.key === 'Enter' && !element.closest('button')) {
      if (!advance(focus) && all) onContinue()
    } else return
    event.preventDefault()
  }

  if (!findings.length) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 overflow-auto p-4">
          <div
            className="mx-auto mt-6 max-w-xl rounded-2xl border border-white/[0.07] bg-[#16161b] p-5"
            data-testid="review-clean"
          >
            <h2 className="mb-1.5 flex items-center gap-2 text-[17px] font-semibold">
              <BadgeCheck className="size-5 text-emerald-400" />
              {t('review.room.cleanTitle')}
            </h2>
            <p className="text-[13.5px] text-muted-foreground">
              {t(review.candidateList.length ? 'review.room.cleanDropped' : 'review.room.cleanNone', {
                count: review.candidateList.length,
              })}
            </p>
            {dropped.length > 0 && (
              <ul className="mt-3 flex flex-col gap-2">
                {dropped.map(({ candidate, verdict }) => (
                  <li
                    key={candidate.id}
                    className="border-l-2 border-white/[0.12] py-0.5 pl-2.5 text-[12px] text-muted-foreground"
                  >
                    <b className="block font-medium text-foreground/75 line-through decoration-white/30">
                      {candidate.id} · {candidate.title}
                    </b>
                    {verdict.verdict === 'merged' ? t('review.mergedInto', { id: verdict.into ?? '' }) : verdict.reason}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
        <footer className="flex flex-wrap items-center justify-end gap-2.5 border-t border-white/[0.07] bg-black/40 px-4 py-2.5">
          {review.target === 'plan' && (
            <Button variant="ghost" onClick={() => onCloseClean('approve')}>
              {t('review.room.approveAsWritten')}
            </Button>
          )}
          <Button onClick={() => onCloseClean('save')}>{t('review.room.closeReview')}</Button>
        </footer>
      </div>
    )
  }

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="@container flex min-h-0 flex-1 flex-col outline-none"
    >
      <div className="min-h-0 flex-1 overflow-auto p-4">
        <div className="mx-auto grid max-w-[1180px] items-start gap-4.5 @3xl:grid-cols-[280px_minmax(0,1fr)]">
          <aside aria-label={t('review.room.findings')} className="flex flex-col gap-2.5 @3xl:sticky @3xl:top-0">
            <ol className="flex flex-col gap-1">
              {findings.map((finding, index) => {
                const decision = draft.decisions[finding.id]
                return (
                  <li key={finding.id}>
                    <button
                      type="button"
                      aria-current={index === focus}
                      onClick={() => setFocus(index)}
                      className={cn(
                        'grid w-full grid-cols-[24px_minmax(0,1fr)_auto] items-start gap-2 rounded-xl border px-2.5 py-2 text-left',
                        index === focus
                          ? 'border-white/[0.12] bg-[#16161b]'
                          : 'border-transparent hover:bg-white/[0.03]'
                      )}
                    >
                      <span className="pt-px font-mono text-[11px] text-muted-foreground">{finding.id}</span>
                      <span className="min-w-0">
                        <span className="block text-[12.5px] leading-snug text-foreground/85">{finding.title}</span>
                        <span className="mt-1 flex items-center gap-1.5">
                          <span
                            className={cn(
                              'rounded border px-1.5 text-[10px] font-semibold uppercase',
                              SEVERITY_PILL[finding.severity]
                            )}
                          >
                            {t(`review.severity.${finding.severity}`)}
                          </span>
                          {finding.unverified && (
                            <span className="text-[10.5px] text-amber-200/80">{t('review.room.unverifiedTag')}</span>
                          )}
                        </span>
                      </span>
                      {decision ? (
                        <span className={cn('rounded-full border px-2 text-[11px] leading-5', DECISION_CHIP[decision])}>
                          {t(`review.decision.${decision}`)}
                        </span>
                      ) : (
                        <span />
                      )}
                    </button>
                  </li>
                )
              })}
            </ol>
            {dropped.length > 0 && (
              <button
                type="button"
                aria-expanded={showDropped}
                onClick={() => setShowDropped((value) => !value)}
                className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-left text-[12px] text-muted-foreground hover:bg-white/[0.03] hover:text-foreground"
              >
                {showDropped ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                {t('review.droppedToggle', { count: dropped.length })}
              </button>
            )}
            {showDropped && (
              <ul className="flex flex-col gap-2 px-1">
                {dropped.map(({ candidate, verdict }) => (
                  <li
                    key={candidate.id}
                    className="border-l-2 border-white/[0.12] py-0.5 pl-2.5 text-[12px] text-muted-foreground"
                  >
                    <b className="block font-medium text-foreground/75 line-through decoration-white/30">
                      {candidate.id} · {candidate.title}
                    </b>
                    {verdict.verdict === 'merged' ? t('review.mergedInto', { id: verdict.into ?? '' }) : verdict.reason}
                  </li>
                ))}
              </ul>
            )}
            <div className="flex flex-wrap gap-x-2.5 gap-y-1 px-2.5 text-[11.5px] text-muted-foreground/70">
              <span>
                <kbd className="font-mono">J</kbd> <kbd className="font-mono">K</kbd> {t('review.room.keyMove')}
              </span>
              {options.map((option) => (
                <span key={option}>
                  <kbd className="font-mono">{DECISION_KEY[option].toUpperCase()}</kbd> {t(`review.room.key.${option}`)}
                </span>
              ))}
            </div>
          </aside>
          {current && (
            <FindingCard
              key={current.id}
              review={review}
              finding={current}
              index={Math.min(focus, findings.length - 1)}
              draft={draft}
              onDecide={decide}
              onNote={(note) => onNote(current.id, note)}
              onMove={move}
              onOpenFile={onOpenFile}
              onOpenPlanLine={onOpenPlanLine}
            />
          )}
        </div>
      </div>
      <footer className="flex flex-wrap items-center gap-2.5 border-t border-white/[0.07] bg-black/40 px-4 py-2.5 text-[12.5px]">
        <div className="flex items-center gap-2.5 tabular-nums">
          <div className="h-[5px] w-28 overflow-hidden rounded bg-white/[0.08]">
            <i
              className="block h-full rounded bg-emerald-400 transition-[width]"
              style={{ width: `${(decided / findings.length) * 100}%` }}
            />
          </div>
          <span>{t('review.room.decidedCount', { done: decided, total: findings.length })}</span>
        </div>
        <span className="flex-1" />
        {!all && (
          <Button variant="ghost" onClick={onRest}>
            {t(review.target === 'code' ? 'review.room.discussRest' : 'review.room.commentRest')}
          </Button>
        )}
        <Button disabled={!all} onClick={onContinue} data-testid="review-to-handoff">
          {t('review.room.toHandoff')}
          <ArrowRight className="size-4" />
        </Button>
      </footer>
    </div>
  )
}
