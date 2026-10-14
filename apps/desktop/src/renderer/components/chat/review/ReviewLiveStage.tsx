import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { ArrowRight, Check, Flag, GitMerge, Loader2, X } from 'lucide-react'
import type {
  ReviewActivity,
  ReviewCandidate,
  ReviewJobInfo,
  ReviewLane,
  ReviewLensState,
  ReviewVerdict,
} from '../../../../shared/review'
import { buildEvidenceMap } from '@/lib/review'
import { cn } from '@/lib/utils'
import { ACTIVITY_ICON, LANE_STYLE, SEVERITY_COLOR, SEVERITY_PILL } from './review-style'

const basename = (path: string): string => path.split('/').filter(Boolean).pop() ?? path

function ActivityLine({ activity }: { activity: ReviewActivity }) {
  const { t } = useTranslation('chat')
  const Icon = ACTIVITY_ICON[activity.kind]
  const running = activity.status === 'running'
  let body: ReactNode
  if (activity.kind === 'note') body = <span className="italic text-muted-foreground">{activity.text}</span>
  else if (activity.kind === 'diff') body = <span className="text-muted-foreground/80">git_diff</span>
  else if (activity.kind === 'submit') {
    body = (
      <span className="text-muted-foreground">
        {running ? t('review.room.submitting') : t('review.room.submitted', { count: activity.count ?? 0 })}
      </span>
    )
  } else {
    body = (
      <>
        <span className="mr-1.5 text-muted-foreground/70">{activity.kind === 'tool' ? '' : activity.kind}</span>
        <span className="font-mono text-[11.5px] text-foreground">{activity.text}</span>
        {activity.range && <span className="font-mono text-[11.5px] text-muted-foreground/70">:{activity.range}</span>}
      </>
    )
  }
  const meta =
    !running && activity.kind === 'grep'
      ? t('review.room.matches', { count: activity.count ?? 0 })
      : !running && activity.kind === 'glob'
        ? t('review.room.files', { count: activity.count ?? 0 })
        : null
  return (
    <li
      className={cn(
        'flex items-start gap-2 rounded-md px-1.5 py-1 text-[12px] leading-snug text-foreground/85',
        running && 'bg-[color-mix(in_srgb,var(--lane)_9%,transparent)]',
        activity.status === 'failed' && 'opacity-60'
      )}
    >
      <span className={cn('mt-px shrink-0', running ? 'text-[var(--lane)]' : 'text-muted-foreground/60')}>
        {running && activity.kind !== 'note' ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <Icon className="size-3.5" />
        )}
      </span>
      <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{body}</span>
      {meta && <span className="shrink-0 text-[11px] text-muted-foreground/70">{meta}</span>}
    </li>
  )
}

function CandidateChip({ candidate }: { candidate: ReviewCandidate }) {
  return (
    <div
      title={candidate.title}
      className="flex min-w-0 animate-in fade-in zoom-in-95 items-center gap-2 rounded-lg border border-white/[0.07] border-l-2 bg-[#1d1d23] px-2 py-1.5 text-[12px]"
      style={{ borderLeftColor: SEVERITY_COLOR[candidate.severity] }}
    >
      <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{candidate.id}</span>
      <span className="size-2 shrink-0 rounded-full" style={{ background: SEVERITY_COLOR[candidate.severity] }} />
      <span className="min-w-0 truncate">{candidate.title}</span>
    </div>
  )
}

function laneStatus(
  t: TFunction,
  lens: ReviewLensState,
  current: ReviewActivity | undefined,
  last: ReviewActivity | undefined
): string {
  if (lens.status === 'pending') return t('review.room.laneWaiting')
  if (lens.status === 'failed') return t('review.room.laneFailed')
  if (lens.status === 'done') return t('review.room.laneDone', { count: lens.candidates ?? 0 })
  if (!current) {
    // Between tool calls the model is working on its next step, or wrapping up after submitting.
    if (!last) return t('review.room.laneStarting')
    return last.kind === 'submit' ? t('review.room.laneFinishing') : t('review.room.laneThinking')
  }
  if (current.kind === 'read' && current.path) return t('review.room.laneReading', { file: basename(current.path) })
  if (current.kind === 'diff') return t('review.room.laneDiff')
  if (current.kind === 'grep' || current.kind === 'glob') return t('review.room.laneSearching')
  if (current.kind === 'submit') return t('review.room.laneSubmitting')
  return t('review.room.laneThinking')
}

function useStickToBottom(dependency: unknown) {
  const ref = useRef<HTMLOListElement>(null)
  useEffect(() => {
    const element = ref.current
    if (element) element.scrollTop = element.scrollHeight
  }, [dependency])
  return ref
}

function Lane({ review, lens }: { review: ReviewJobInfo; lens: ReviewLensState }) {
  const { t } = useTranslation('chat')
  const { color, icon: Icon } = LANE_STYLE[lens.id]
  const activity = review.activity[lens.id] ?? []
  const current = [...activity].reverse().find((item) => item.status === 'running')
  const candidates = review.candidateList.filter((candidate) => candidate.lens === lens.id)
  const trail = useStickToBottom(activity.length)
  const running = lens.status === 'running'
  return (
    <section
      aria-label={t(`review.lens.${lens.id}`)}
      data-lane={lens.id}
      className="relative flex min-h-0 flex-col overflow-hidden rounded-xl border border-white/[0.07] bg-[#16161b]"
      style={{ '--lane': color } as CSSProperties}
    >
      <span
        aria-hidden
        className={cn('absolute inset-x-0 top-0 h-0.5', running && 'animate-pulse')}
        style={{ background: color, opacity: lens.status === 'pending' ? 0.3 : 1 }}
      />
      <header className="flex items-start gap-2.5 border-b border-white/[0.07] px-3 pb-2.5 pt-3">
        <span
          className="grid size-7 shrink-0 place-items-center rounded-lg"
          style={{ color, background: `${color}24` }}
        >
          <Icon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <b className="block text-[13px] font-semibold">{t(`review.lens.${lens.id}`)}</b>
          <small className="block text-[11.5px] leading-snug text-muted-foreground">
            {t(`review.lensGoal.${lens.id}`)}
          </small>
        </div>
        <span
          className={cn(
            'shrink-0 pt-0.5 text-[11px]',
            running ? 'text-[var(--lane)]' : lens.status === 'done' ? 'text-emerald-400' : 'text-muted-foreground'
          )}
        >
          {laneStatus(t, lens, current, activity.at(-1))}
        </span>
      </header>
      <ol ref={trail} aria-live="off" className="flex min-h-[150px] flex-1 flex-col gap-0.5 overflow-auto p-2">
        {activity.map((item) => (
          <ActivityLine key={item.id} activity={item} />
        ))}
      </ol>
      <div className="flex min-h-11 flex-col gap-1.5 border-t border-white/[0.07] bg-white/[0.012] p-2">
        {candidates.length ? (
          candidates.map((candidate) => <CandidateChip key={candidate.id} candidate={candidate} />)
        ) : (
          <span className="p-1 text-[11.5px] text-muted-foreground/70">{t('review.room.noCandidatesYet')}</span>
        )}
      </div>
    </section>
  )
}

function VerdictRow({
  review,
  candidate,
  verdict,
}: {
  review: ReviewJobInfo
  candidate: ReviewCandidate
  verdict?: ReviewVerdict
}) {
  const { t } = useTranslation('chat')
  const severity = verdict?.severity ?? candidate.severity
  const dropped = verdict && verdict.verdict !== 'confirmed'
  const adjusted = verdict?.verdict === 'confirmed' && verdict.severity && verdict.severity !== candidate.severity
  const waiting = !verdict
  return (
    <li
      data-vrow={candidate.id}
      className={cn(
        'grid grid-cols-[28px_8px_auto_minmax(0,1fr)_auto] items-center gap-2.5 rounded-lg border border-white/[0.07] bg-[#16161b] px-3 py-2.5 transition-opacity',
        waiting && review.verification === 'running' && 'opacity-60'
      )}
    >
      <span className="font-mono text-[11px] text-muted-foreground">{candidate.id}</span>
      <span
        className="size-2 rounded-full"
        style={{ background: LANE_STYLE[candidate.lens].color }}
        title={t(`review.lens.${candidate.lens}`)}
      />
      <span className={cn('rounded border px-1.5 text-[10px] font-semibold uppercase', SEVERITY_PILL[severity])}>
        {t(`review.severity.${severity}`)}
      </span>
      <div className="min-w-0">
        <span
          className={cn(
            'text-[13px]',
            dropped ? 'text-muted-foreground line-through decoration-white/30' : 'text-foreground'
          )}
        >
          {candidate.title}
        </span>
        {verdict?.verdict === 'merged' && (
          <small className="mt-0.5 flex items-center gap-1 text-[12px] text-muted-foreground">
            <GitMerge className="size-3" />
            {t('review.mergedInto', { id: verdict.into ?? '' })}
          </small>
        )}
        {verdict?.verdict === 'discarded' && verdict.reason && (
          <small className="mt-0.5 block text-[12px] text-muted-foreground">{verdict.reason}</small>
        )}
        {adjusted && (
          <small className="mt-0.5 block text-[12px] text-muted-foreground">
            {t('review.room.severityAdjusted', {
              from: t(`review.severity.${candidate.severity}`),
              to: t(`review.severity.${severity}`),
            })}
            {verdict?.reason ? `: ${verdict.reason}` : ''}
          </small>
        )}
      </div>
      <span
        className={cn(
          'inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide',
          !verdict && 'border-white/[0.12] text-muted-foreground/70',
          verdict?.verdict === 'confirmed' && 'border-emerald-400/45 bg-emerald-400/[0.08] text-emerald-400',
          verdict?.verdict === 'discarded' && 'border-white/[0.12] text-muted-foreground',
          verdict?.verdict === 'merged' && 'border-violet-400/40 text-violet-300'
        )}
      >
        {!verdict ? (
          t('review.room.verdictPending')
        ) : verdict.verdict === 'confirmed' ? (
          <>
            <Check className="size-3" />
            {t('review.room.verdictConfirmed')}
          </>
        ) : verdict.verdict === 'merged' ? (
          <>
            <GitMerge className="size-3" />
            {t('review.room.verdictMerged')}
          </>
        ) : (
          <>
            <X className="size-3" />
            {t('review.room.verdictDiscarded')}
          </>
        )}
      </span>
    </li>
  )
}

function VerifyPanel({ review }: { review: ReviewJobInfo }) {
  const { t } = useTranslation('chat')
  const byId = new Map(review.verdicts.map((verdict) => [verdict.candidateId, verdict]))
  const confirmed = review.verdicts.filter((verdict) => verdict.verdict === 'confirmed').length
  const discarded = review.verdicts.filter((verdict) => verdict.verdict === 'discarded').length
  const merged = review.verdicts.filter((verdict) => verdict.verdict === 'merged').length
  const verifier = review.activity.verifier ?? []
  const trail = useStickToBottom(verifier.length)
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-4 rounded-xl border border-white/[0.07] bg-[#16161b] px-4 py-3.5">
        <div>
          <b className="block text-[28px] font-semibold leading-none tabular-nums">{review.candidateList.length}</b>
          <span className="text-[12px] text-muted-foreground">{t('review.room.funnelCandidates')}</span>
        </div>
        <ArrowRight className="size-4.5 text-muted-foreground/60" />
        <div>
          <b className="block text-[28px] font-semibold leading-none tabular-nums text-emerald-400">{confirmed}</b>
          <span className="text-[12px] text-muted-foreground">{t('review.room.funnelConfirmed')}</span>
        </div>
        <div className="ml-auto flex flex-col gap-0.5 text-[12px] tabular-nums text-muted-foreground">
          <span>{t('review.room.funnelDiscarded', { count: discarded })}</span>
          <span>{t('review.room.funnelMerged', { count: merged })}</span>
        </div>
      </div>
      <p className="text-[12.5px] text-muted-foreground">{t('review.room.verifyIntro')}</p>
      {verifier.length > 0 && (
        <section
          aria-label={t('review.room.verifierActivity')}
          className="rounded-xl border border-white/[0.07] bg-[#111115]"
          style={{ '--lane': LANE_STYLE.verifier.color } as CSSProperties}
        >
          <ol ref={trail} className="flex max-h-36 flex-col gap-0.5 overflow-auto p-2">
            {verifier.slice(-12).map((item) => (
              <ActivityLine key={item.id} activity={item} />
            ))}
          </ol>
        </section>
      )}
      <ol className="flex flex-col gap-1.5" data-testid="review-verdicts">
        {review.candidateList.map((candidate) => (
          <VerdictRow key={candidate.id} review={review} candidate={candidate} verdict={byId.get(candidate.id)} />
        ))}
      </ol>
    </div>
  )
}

/** Which files the reviewers read or matched, in the change and outside it, and where candidates point. */
export function EvidenceMap({ review }: { review: ReviewJobInfo }) {
  const { t } = useTranslation('chat')
  const rows = buildEvidenceMap(review)
  const lanes: ReviewLane[] = [
    ...review.lenses.map((lens) => lens.id),
    ...(review.verification === 'pending' ? [] : ['verifier' as const]),
  ]
  const inScope = rows.filter((row) => row.inScope)
  const outside = rows.filter((row) => !row.inScope)
  const planLines =
    review.target === 'plan'
      ? review.candidateList.filter((candidate) => {
          const verdict = review.verdicts.find((item) => item.candidateId === candidate.id)
          return candidate.planLine && (!verdict || verdict.verdict === 'confirmed')
        })
      : []
  const row = (entry: (typeof rows)[number]) => (
    <li
      key={entry.path}
      data-evidence-row={entry.path}
      className={cn(
        'grid grid-cols-[minmax(0,1fr)_auto] gap-x-2 gap-y-1.5 rounded-lg border border-transparent px-2 py-1.5',
        entry.flags > 0 && 'border-amber-400/20 bg-amber-400/[0.035]'
      )}
    >
      <span
        title={entry.path}
        className={cn(
          'truncate font-mono text-[11.5px]',
          entry.inScope ? 'text-foreground/85' : 'text-muted-foreground'
        )}
      >
        {entry.path}
      </span>
      {entry.added !== undefined ? (
        <span className="flex gap-1.5 font-mono text-[10.5px]">
          <span className="text-emerald-400">+{entry.added}</span>
          <span className="text-red-400">−{entry.deleted ?? 0}</span>
        </span>
      ) : (
        <span />
      )}
      <span className="flex min-h-2 flex-wrap items-center gap-[3px]">
        {lanes.flatMap((lane) =>
          Array.from({ length: Math.min(5, entry.touches[lane] ?? 0) }, (_, index) => (
            <i
              key={`${lane}:${index}`}
              title={t(lane === 'verifier' ? 'review.room.verifier' : `review.lens.${lane}`)}
              className="size-2 rounded-[2px]"
              style={{ background: LANE_STYLE[lane].color }}
            />
          ))
        )}
        {!Object.keys(entry.touches).length && (
          <span className="text-[10.5px] text-muted-foreground/60">{t('review.room.notReadYet')}</span>
        )}
      </span>
      {entry.flags > 0 ? (
        <span className="flex items-center justify-end gap-1 whitespace-nowrap text-[10.5px] text-amber-200">
          <Flag className="size-2.5" />
          {t('review.room.flags', { count: entry.flags })}
        </span>
      ) : (
        <span />
      )}
    </li>
  )
  return (
    <aside
      data-testid="review-evidence"
      aria-label={t('review.room.evidenceTitle')}
      className="flex min-h-0 flex-col overflow-auto rounded-xl border border-white/[0.07] bg-[#111115] px-3 py-3"
    >
      <header>
        <b className="block text-[11.5px] font-semibold uppercase tracking-wide text-muted-foreground">
          {t('review.room.evidenceTitle')}
        </b>
        <small className="text-[12px] text-muted-foreground/70">
          {t(review.target === 'code' ? 'review.room.evidenceHintCode' : 'review.room.evidenceHintPlan')}
        </small>
      </header>
      <ul className="my-2.5 flex flex-col gap-0.5">
        {inScope.map(row)}
        {planLines.length > 0 && (
          <>
            <li className="mx-1 mb-0.5 mt-2 text-[10.5px] uppercase tracking-wide text-muted-foreground/70">
              {t('review.room.evidencePlanLines')}
            </li>
            {planLines.map((candidate) => (
              <li
                key={candidate.id}
                className="flex min-w-0 items-center gap-2 rounded-lg border border-amber-400/20 bg-amber-400/[0.035] px-2 py-1.5 text-[12px]"
              >
                <span className="font-mono text-[10.5px] text-muted-foreground">L{candidate.planLine}</span>
                <span
                  className="size-2 shrink-0 rounded-full"
                  style={{ background: SEVERITY_COLOR[candidate.severity] }}
                />
                <span className="min-w-0 truncate text-foreground/85">{candidate.title}</span>
              </li>
            ))}
          </>
        )}
        {outside.length > 0 && (
          <>
            <li className="mx-1 mb-0.5 mt-2 text-[10.5px] uppercase tracking-wide text-muted-foreground/70">
              {t(review.target === 'code' ? 'review.room.evidenceOutside' : 'review.room.evidenceRepository')}
            </li>
            {outside.map(row)}
          </>
        )}
        {!rows.length && !planLines.length && (
          <li className="px-2 py-1 text-[12px] text-muted-foreground/70">{t('review.room.evidenceEmpty')}</li>
        )}
      </ul>
      <div className="mt-auto flex flex-wrap gap-x-3 gap-y-1.5 border-t border-white/[0.07] pt-2.5 text-[11px] text-muted-foreground">
        {lanes.map((lane) => (
          <span key={lane} className="inline-flex items-center gap-1.5">
            <i className="size-2 rounded-[2px]" style={{ background: LANE_STYLE[lane].color }} />
            {t(lane === 'verifier' ? 'review.room.verifier' : `review.lens.${lane}`)}
          </span>
        ))}
      </div>
    </aside>
  )
}

/** Investigate and verify: the reviewers' columns, then the verifier's rulings, beside the evidence map. */
export function ReviewLiveStage({ review }: { review: ReviewJobInfo }) {
  const verifying = review.status === 'verifying'
  return (
    <div className="@container min-h-0 flex-1 overflow-auto p-4">
      <div className="grid min-h-full gap-3.5 @5xl:h-full @5xl:grid-cols-[minmax(0,1fr)_296px]">
        {verifying ? (
          <VerifyPanel review={review} />
        ) : (
          <div
            data-testid="review-lanes"
            className="grid min-h-[420px] gap-3 @3xl:[grid-template-columns:repeat(var(--lanes),minmax(0,1fr))]"
            style={{ '--lanes': review.lenses.length } as CSSProperties}
          >
            {review.lenses.map((lens) => (
              <Lane key={lens.id} review={review} lens={lens} />
            ))}
          </div>
        )}
        <EvidenceMap review={review} />
      </div>
    </div>
  )
}
