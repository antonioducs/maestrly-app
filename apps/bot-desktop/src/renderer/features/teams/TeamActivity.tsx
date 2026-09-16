import { ChevronRight, Activity as ActivityIcon, Monitor } from 'lucide-react'
import { useState } from 'react'
import type { TeamEvent, TeamRun, TeamTask } from '@maestrly/host-protocol'
import { Button } from '../../ui'
import { useT } from '../../i18n'
import type { TranslationKey } from '../../i18n/pt-BR'

const TASK_LABEL: Record<TeamTask['status'], TranslationKey> = {
  planned: 'teamTaskPlanned',
  waiting_bot: 'teamTaskPlanned',
  staging: 'teamTaskPlanned',
  running: 'teamTaskRunning',
  waiting_approval: 'teamTaskWaiting',
  waiting_input: 'teamTaskWaiting',
  paused_human: 'teamTaskPausedHuman',
  needs_attention: 'teamNeedsAttention',
  succeeded: 'teamTaskDone',
  failed: 'teamTaskFailed',
  cancelled: 'teamTaskFailed',
  skipped: 'teamTaskSkipped',
}
/**
 * The detailed work, expandable and never the main screen. It shows who is doing what in
 * plain words: no dependency graph, no CPU or memory, no identifiers, no raw logs.
 */
export function TeamActivity({
  run,
  tasks,
  events,
  names,
  onOpenScreen,
}: {
  run?: TeamRun | null
  tasks: TeamTask[]
  events: TeamEvent[]
  names: Map<string, string>
  onOpenScreen?: (botId: string) => void
}) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const work = tasks.filter((task) => task.kind === 'work')
  if (!run && !work.length) return null
  return (
    <section className="team-activity">
      <Button aria-expanded={open} onClick={() => setOpen(!open)}>
        <ChevronRight size={13} style={{ transform: open ? 'rotate(90deg)' : undefined }} aria-hidden="true" />
        <ActivityIcon size={13} aria-hidden="true" />
        {t('teamViewWork')}
      </Button>
      {open && (
        <ul className="team-tasks">
          {work.map((task) => (
            <li key={task.id} data-status={task.status}>
              <div>
                <strong>{names.get(task.assigneeBotId) ?? t('teamParticipants')}</strong>
                <span>{task.goal}</span>
                <small>{t(TASK_LABEL[task.status])}</small>
                {/* A failure or a wait always says what happens next, in plain words. */}
                {task.attention && <small className="attention">{task.attention}</small>}
                {task.status === 'failed' && task.error && <small className="attention">{task.error.message}</small>}
              </div>
              {onOpenScreen && (
                <Button aria-label={`${t('teamViewScreenOf')} ${names.get(task.assigneeBotId) ?? ''}`} onClick={() => onOpenScreen(task.assigneeBotId)}>
                  <Monitor size={14} aria-hidden="true" />
                </Button>
              )}
            </li>
          ))}
          {!work.length && <li className="empty-task">{t('teamPlanning')}</li>}
          {events
            .filter((event) => event.kind === 'artifact.revoked')
            .slice(-1)
            .map((event) => (
              <li key={event.seq} className="notice">
                {event.summary}
              </li>
            ))}
        </ul>
      )}
    </section>
  )
}
/** A short, factual progress line: who is doing what right now. */
export function progressOf(tasks: TeamTask[], names: Map<string, string>, working: string, organising: string): string {
  const active = tasks.filter((task) => ['running', 'staging', 'waiting_bot'].includes(task.status))
  if (!active.length) return ''
  return active
    .slice(0, 3)
    .map((task) => `${names.get(task.assigneeBotId) ?? ''} ${task.kind === 'work' ? working : organising}`.trim())
    .join(' · ')
}
