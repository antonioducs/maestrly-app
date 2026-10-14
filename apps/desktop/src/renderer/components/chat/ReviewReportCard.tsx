import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronRight, FileCode, MessagesSquare, ScanSearch, TriangleAlert, Wrench } from 'lucide-react'
import type { ChatReviewReport, ReviewFinding, ReviewSeverity } from '../../../shared/review'
import { cn } from '../../lib/utils'

type OpenFileReference = (path: string, startLine?: number, endLine?: number) => void

const ACTION_BUTTON =
  'inline-flex h-7 items-center gap-1.5 rounded-md bg-secondary px-2.5 text-[12px] font-medium text-secondary-foreground ' +
  'transition-colors hover:bg-secondary/80 disabled:pointer-events-none disabled:opacity-50'

const SEVERITY_STYLE: Record<ReviewSeverity, string> = {
  blocking: 'border-red-400/30 bg-red-400/[0.1] text-red-300',
  important: 'border-amber-400/30 bg-amber-400/[0.1] text-amber-200',
  minor: 'border-white/[0.12] bg-white/[0.05] text-muted-foreground',
}

export function SeverityPill({ severity }: { severity: ReviewSeverity }) {
  const { t } = useTranslation('chat')
  return (
    <span
      className={cn(
        'shrink-0 rounded border px-1.5 py-px text-[10px] font-medium uppercase tracking-wide',
        SEVERITY_STYLE[severity]
      )}
    >
      {t(`review.severity.${severity}`)}
    </span>
  )
}

export function formatReviewDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`
}

/** "F1, F3" — the finding ids a card action refers to. */
export function reviewFindingIds(findings: readonly ReviewFinding[]): string {
  return findings.map((finding) => finding.id).join(', ')
}

function FindingRow({
  finding,
  selected,
  onToggle,
  onOpenMention,
  selectable,
}: {
  finding: ReviewFinding
  selected: boolean
  onToggle: () => void
  onOpenMention?: OpenFileReference
  selectable: boolean
}) {
  const { t } = useTranslation('chat')
  const [open, setOpen] = useState(false)
  const location = finding.path ? `${finding.path}${finding.line ? `:${finding.line}` : ''}` : null
  return (
    <li className="rounded-md border border-white/[0.06] bg-white/[0.02]">
      <div className="flex min-w-0 items-start gap-2 px-2.5 py-2">
        {selectable && (
          <input
            type="checkbox"
            checked={selected}
            onChange={onToggle}
            aria-label={t('review.selectFinding', { id: finding.id })}
            className="mt-1 size-3.5 shrink-0 accent-sky-400"
          />
        )}
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-start gap-1.5 text-left"
        >
          <ChevronRight
            className={cn('mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')}
          />
          <span className="shrink-0 font-mono text-[11px] leading-5 text-muted-foreground">{finding.id}</span>
          <SeverityPill severity={finding.severity} />
          <span className="min-w-0 flex-1 text-[13px] leading-5 text-foreground">{finding.title}</span>
        </button>
        {location && (
          <button
            type="button"
            onClick={() => onOpenMention?.(finding.path!, finding.line)}
            disabled={!onOpenMention}
            title={location}
            className="flex max-w-[45%] shrink-0 items-center gap-1 rounded px-1 font-mono text-[11px] leading-5 text-sky-300/90 hover:bg-sky-400/[0.08] disabled:cursor-default disabled:text-muted-foreground disabled:hover:bg-transparent"
          >
            <FileCode className="size-3 shrink-0" />
            <span className="truncate">{location}</span>
          </button>
        )}
      </div>
      {open && (
        <div className="flex flex-col gap-2 border-t border-white/[0.06] px-3 py-2.5 text-[13px] leading-relaxed text-foreground/90">
          <p className="whitespace-pre-wrap">{finding.details}</p>
          {finding.evidence && (
            <p className="whitespace-pre-wrap text-foreground/75">
              <span className="font-medium text-muted-foreground">{t('review.evidence')}: </span>
              {finding.evidence}
            </p>
          )}
          {finding.suggestion && (
            <p className="whitespace-pre-wrap text-foreground/75">
              <span className="font-medium text-muted-foreground">{t('review.suggestion')}: </span>
              {finding.suggestion}
            </p>
          )}
        </div>
      )}
    </li>
  )
}

/**
 * A code review report in the conversation. Nothing changes the code from here: the person picks findings and asks
 * the conversation's model to discuss or fix them.
 */
export function ReviewReportCard({
  report,
  onAction,
  onOpenMention,
}: {
  report: ChatReviewReport
  /** Sends a message to the conversation's model; absent where the conversation is read-only. */
  onAction?: (text: string) => void
  onOpenMention?: OpenFileReference
}) {
  const { t } = useTranslation('chat')
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(report.findings.filter((finding) => finding.severity !== 'minor').map((finding) => finding.id))
  )
  const counts = useMemo(() => {
    const out: Record<ReviewSeverity, number> = { blocking: 0, important: 0, minor: 0 }
    for (const finding of report.findings) out[finding.severity]++
    return out
  }, [report.findings])
  const chosen = report.findings.filter((finding) => selected.has(finding.id))
  const toggle = (id: string) =>
    setSelected((previous) => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const duration =
    report.finishedAt > report.startedAt ? formatReviewDuration(report.finishedAt - report.startedAt) : ''
  const discarded = report.unverified ? 0 : Math.max(0, report.candidates - report.findings.length)

  return (
    <div
      data-testid="review-report-card"
      className="min-w-0 max-w-full rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-2.5"
    >
      <div className="mb-2 flex min-w-0 items-center gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/80">
          <ScanSearch className="size-3.5 shrink-0" />
          <span className="truncate">{t('review.cardTitle')}</span>
        </div>
        <span className="shrink-0 truncate text-[11px] text-muted-foreground/70">
          {[report.model?.modelId, duration].filter(Boolean).join(' · ')}
        </span>
      </div>

      {report.findings.length === 0 ? (
        <p className="text-[13px] text-foreground/90">{t('review.clean')}</p>
      ) : (
        <p className="mb-2 text-[13px] text-foreground/90">
          {t('review.summary', { count: report.findings.length })}
          {(['blocking', 'important', 'minor'] as const)
            .filter((severity) => counts[severity] > 0)
            .map((severity) => ` · ${t(`review.severityCount.${severity}`, { count: counts[severity] })}`)
            .join('')}
        </p>
      )}
      {discarded > 0 && (
        <p className="mt-1 text-[12px] text-muted-foreground">{t('review.discarded', { count: discarded })}</p>
      )}
      {report.unverified && (
        <p className="mb-2 flex items-start gap-1.5 text-[12px] text-amber-200/90">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
          {t('review.unverified')}
        </p>
      )}
      {report.failedLenses?.length ? (
        <p className="mb-2 text-[12px] text-muted-foreground">
          {t('review.lensesFailed', {
            lenses: report.failedLenses.map((lens) => t(`review.lens.${lens}`)).join(', '),
          })}
        </p>
      ) : null}

      {report.findings.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {report.findings.map((finding) => (
            <FindingRow
              key={finding.id}
              finding={finding}
              selected={selected.has(finding.id)}
              onToggle={() => toggle(finding.id)}
              onOpenMention={onOpenMention}
              selectable={!!onAction}
            />
          ))}
        </ul>
      )}

      {onAction && report.findings.length > 0 && (
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={ACTION_BUTTON}
            onClick={() =>
              onAction(t('review.discussMessage', { ids: reviewFindingIds(chosen.length ? chosen : report.findings) }))
            }
          >
            <MessagesSquare className="size-3.5" />
            {t('review.discuss')}
          </button>
          <button
            type="button"
            className={ACTION_BUTTON}
            disabled={chosen.length === 0}
            onClick={() => onAction(t('review.fixMessage', { ids: reviewFindingIds(chosen) }))}
          >
            <Wrench className="size-3.5" />
            {t('review.fixSelected', { count: chosen.length })}
          </button>
          <span className="text-[11px] text-muted-foreground">{t('review.nextMessageHint')}</span>
        </div>
      )}
    </div>
  )
}
