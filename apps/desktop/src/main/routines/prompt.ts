import type { LocalRoutine, LocalRoutineRun, RoutineRunReport, RoutineRunTrigger } from '../../shared/routines'

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

export function formatLocalDateTime(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

export function formatLocalTime(ms: number): string {
  const d = new Date(ms)
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

export function formatRunConversationName(title: string, atMs: number): string {
  return `${title} · ${formatLocalDateTime(atMs)}`
}

export interface PreviousRoutineReport {
  run: Pick<LocalRoutineRun, 'startedAt' | 'scheduledAt' | 'status'>
  report: RoutineRunReport
}

export function buildRoutinePrompt(input: {
  routine: Pick<LocalRoutine, 'title' | 'instruction'>
  trigger: RoutineRunTrigger
  scheduledAt: number
  previousReports: PreviousRoutineReport[]
}): string {
  const base = `Scheduled routine "${input.routine.title}", running on its own on this computer. Do this now:\n\n${input.routine.instruction}`

  const parts: string[] = [base]

  if (input.trigger === 'late') {
    parts.push(
      `This run is late: it was scheduled for ${formatLocalDateTime(input.scheduledAt)} and starts now because the computer was asleep or Maestrly was closed.`
    )
  }

  if (input.previousReports.length > 0) {
    const lines = input.previousReports.map(({ run, report }) => {
      const at = formatLocalDateTime(run.startedAt ?? run.scheduledAt)
      const segments = [`${at}`, report.outcome, `Did: ${report.summary}`]
      if (report.pending) segments.push(`Pending: ${report.pending}`)
      if (report.notes) segments.push(`Notes for this run: ${report.notes}`)
      return `- ${segments.join(' · ')}`
    })
    parts.push(`Previous runs of this routine, newest first:\n${lines.join('\n')}`)
  } else {
    parts.push('This is the first run of this routine.')
  }

  parts.push(
    "This conversation belongs to this run alone. Nobody watches it while it runs: work on your own with your tools; when a tool needs approval, the run waits for the person. Ask the person only when you cannot continue without them, because asking pauses the run. Files you write stay in this routine's folder, which every run shares. The person can read this run later and ask you here for changes."
  )

  parts.push(
    'When you finish, call routine_run_report once with outcome notable when the person should see what you found, nothing_new when nothing changed since the previous run, or done when you did the work and nothing needs attention; a one-line summary; anything still pending; and notes for the next run.'
  )

  return parts.join('\n\n')
}
