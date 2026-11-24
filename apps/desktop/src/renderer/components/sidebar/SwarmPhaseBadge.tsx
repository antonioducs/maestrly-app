import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import type { MaestroSwarmPhase, MaestroSwarmTask } from '../../../shared/maestro-swarm'

export const SWARM_PHASE_DOT_CLASS: Record<MaestroSwarmPhase, string> = {
  queued: 'bg-muted-foreground/60',
  implementing: 'bg-sky-400',
  delivered: 'bg-muted-foreground/60',
  reviewing: 'bg-sky-400',
  changes: 'bg-amber-400',
  merged: 'bg-emerald-400',
  blocked: 'bg-amber-400',
  failed: 'bg-red-400',
}

export const SWARM_PHASE_TEXT_CLASS: Record<MaestroSwarmPhase, string> = {
  queued: 'text-muted-foreground',
  implementing: 'text-sky-300',
  delivered: 'text-muted-foreground',
  reviewing: 'text-sky-300',
  changes: 'text-amber-300',
  merged: 'text-emerald-300',
  blocked: 'text-amber-300',
  failed: 'text-red-300',
}

const SWARM_PHASE_BADGE_CLASS: Record<MaestroSwarmPhase, string> = {
  queued: 'border-white/[0.08] bg-white/[0.04] text-muted-foreground',
  implementing: 'border-sky-400/25 bg-sky-400/[0.08] text-sky-300',
  delivered: 'border-white/[0.08] bg-white/[0.04] text-muted-foreground',
  reviewing: 'border-sky-400/25 bg-sky-400/[0.08] text-sky-300',
  changes: 'border-amber-400/25 bg-amber-400/[0.08] text-amber-300',
  merged: 'border-emerald-400/25 bg-emerald-400/[0.08] text-emerald-300',
  blocked: 'border-amber-400/25 bg-amber-400/[0.08] text-amber-300',
  failed: 'border-red-400/25 bg-red-400/[0.08] text-red-300',
}

export function swarmPhaseLabel(
  t: TFunction<'chat'>,
  task: Pick<MaestroSwarmTask, 'phase' | 'changesReason' | 'reviewRound'>
): string {
  if (task.phase === 'changes') {
    if (task.changesReason === 'conflict') return t('maestro.swarm.phase.changesConflict')
    return t('maestro.swarm.phase.changesReview', { round: Math.max(1, task.reviewRound || 1) })
  }
  return t(`maestro.swarm.phase.${task.phase}`)
}

export function SwarmPhaseBadge({ task, className }: { task: MaestroSwarmTask; className?: string }) {
  const { t } = useTranslation('chat')
  const label = swarmPhaseLabel(t, task)
  return (
    <span
      data-testid="swarm-phase-badge"
      data-swarm-phase={task.phase}
      title={task.note ?? label}
      className={cn(
        'inline-flex shrink-0 items-center rounded border px-1 py-0.5 text-[10px] font-medium leading-none',
        SWARM_PHASE_BADGE_CLASS[task.phase],
        className
      )}
    >
      {label}
    </span>
  )
}
