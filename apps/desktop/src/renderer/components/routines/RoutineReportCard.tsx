import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'
import { toolOutputText, type MessagePart } from '../../../shared/chat'
import type { RoutineRunReport } from '../../../shared/routines'
import { ToolCallCard } from '@/components/chat/ToolCallCard'
import { RoutineOutcomePill } from './RoutineOutcomeBadge'

type ToolPart = Extract<MessagePart, { type: 'tool' }>

export function parseRoutineRunReportInput(input: unknown): RoutineRunReport | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const raw = input as Record<string, unknown>
  const outcome = raw.outcome
  if (outcome !== 'notable' && outcome !== 'nothing_new' && outcome !== 'done') return null
  if (typeof raw.summary !== 'string' || raw.summary.trim().length === 0) return null
  const pending = typeof raw.pending === 'string' && raw.pending.trim().length > 0 ? raw.pending.trim() : null
  const notesRaw = raw.notes_for_next_run ?? raw.notes
  const notes = typeof notesRaw === 'string' && notesRaw.trim().length > 0 ? notesRaw.trim() : null
  return {
    outcome,
    summary: raw.summary.trim(),
    pending,
    notes,
  }
}

export function RoutineReportCardBody({
  outcome,
  summary,
  pending,
  notes,
}: RoutineRunReport) {
  const { t } = useTranslation('routines')

  return (
    <div className="routine-report" data-testid="routine-report-card">
      <div className="routine-report-top">
        <span className="routine-eyebrow flex-1">{t('run.reportTitle')}</span>
        <RoutineOutcomePill status={outcome} />
      </div>
      <dl className="routine-report-dl">
        <dt>{t('run.reportDid')}</dt>
        <dd>{summary}</dd>
        {pending && (
          <>
            <dt>{t('run.reportPending')}</dt>
            <dd>{pending}</dd>
          </>
        )}
        {notes && (
          <>
            <dt>{t('run.reportNotes')}</dt>
            <dd>{notes}</dd>
          </>
        )}
      </dl>
      <span className="text-[11px] text-muted-foreground/65">{t('run.reportNextHint')}</span>
    </div>
  )
}

export function RoutineReportCard({
  part,
  conversationId,
  messageId,
}: {
  part: ToolPart
  conversationId: string
  messageId: string
}) {
  const { t } = useTranslation('routines')

  if (
    part.state.status === 'pending' ||
    part.state.status === 'running' ||
    part.state.status === 'awaiting-permission'
  ) {
    return (
      <div className="flex min-w-0 max-w-full items-center gap-2 rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-2 text-[12px] text-muted-foreground">
        <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
        <span>{t('run.reportTitle')}</span>
      </div>
    )
  }

  if (part.state.status !== 'completed') {
    return <ToolCallCard part={part} conversationId={conversationId} messageId={messageId} />
  }

  const out = toolOutputText(part.state.output)
  if (out.startsWith('Could not save run report:')) {
    return <ToolCallCard part={part} conversationId={conversationId} messageId={messageId} />
  }

  const parsed = parseRoutineRunReportInput(part.input)
  if (!parsed) {
    return <ToolCallCard part={part} conversationId={conversationId} messageId={messageId} />
  }

  return (
    <RoutineReportCardBody
      outcome={parsed.outcome}
      summary={parsed.summary}
      pending={parsed.pending}
      notes={parsed.notes}
    />
  )
}
