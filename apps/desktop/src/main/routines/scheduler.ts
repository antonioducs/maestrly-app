import { powerMonitor } from 'electron'
import { nextRun } from '@maestrly/bot-fleet-protocol'
import {
  ROUTINE_LIMITS,
  type LocalRoutine,
  type LocalRoutineRun,
  type RoutineRunTrigger,
} from '../../shared/routines'
import { deleteRoutineRunConversation } from './runner'
import {
  insertRun,
  listActiveRuns,
  listAllRunsForRetention,
  listRoutines,
  pruneRuns,
  setNextRunAt,
  updateRun,
} from './store'

export interface SkippedSlot {
  scheduledAt: number
  status: 'skipped_asleep' | 'skipped_closed' | 'skipped_busy'
}

export type TickDecision =
  | { kind: 'wait' }
  | { kind: 'fire'; trigger: 'schedule' | 'late'; scheduledAt: number; skipped: SkippedSlot[] }
  | { kind: 'skip'; skipped: SkippedSlot[] }

function collectDueSlots(schedule: LocalRoutine['schedule'], firstDueAt: number, now: number): number[] {
  if (firstDueAt > now) return []
  if (schedule.kind === 'interval') {
    const stepMs = schedule.everyMinutes * 60_000
    const count = Math.floor((now - firstDueAt) / stepMs) + 1
    const startIndex = Math.max(0, count - ROUTINE_LIMITS.skippedSlotsPerGap)
    const slots: number[] = []
    for (let i = startIndex; i < count; i++) {
      slots.push(firstDueAt + i * stepMs)
    }
    return slots
  }

  // Weekly schedules can span long gaps; cap the lookback window to ~60 days before iterating day-by-day.
  const maxWeeklyLookbackMs = 60 * 86_400_000
  const slots: number[] = []
  let cursor = firstDueAt
  if (now - cursor > maxWeeklyLookbackMs) {
    cursor = Date.parse(nextRun(schedule, new Date(now - maxWeeklyLookbackMs)))
  }
  while (cursor <= now) {
    slots.push(cursor)
    if (slots.length > ROUTINE_LIMITS.skippedSlotsPerGap) slots.shift()
    const next = Date.parse(nextRun(schedule, new Date(cursor)))
    if (!(next > cursor)) break
    cursor = next
  }
  return slots
}

function missedSlotStatus(scheduledAt: number, processStartedAt: number): 'skipped_closed' | 'skipped_asleep' {
  return scheduledAt < processStartedAt ? 'skipped_closed' : 'skipped_asleep'
}

export function decideTick(input: {
  routine: Pick<LocalRoutine, 'schedule' | 'missed' | 'enabled' | 'nextRunAt'>
  now: number
  processStartedAt: number
  busy: boolean
}): { decision: TickDecision; nextRunAt: number | null } {
  const { routine, now, processStartedAt, busy } = input
  if (!routine.enabled || routine.nextRunAt === null || routine.nextRunAt > now) {
    return { decision: { kind: 'wait' }, nextRunAt: routine.nextRunAt }
  }

  const dueSlots = collectDueSlots(routine.schedule, routine.nextRunAt, now)
  if (dueSlots.length === 0) {
    return { decision: { kind: 'wait' }, nextRunAt: routine.nextRunAt }
  }

  const nextRunAt = Date.parse(nextRun(routine.schedule, new Date(now)))

  if (busy) {
    return {
      decision: {
        kind: 'skip',
        skipped: dueSlots.map((scheduledAt) => ({ scheduledAt, status: 'skipped_busy' })),
      },
      nextRunAt,
    }
  }

  const newest = dueSlots[dueSlots.length - 1]
  const older = dueSlots.slice(0, -1)
  const age = now - newest
  const olderSkipped: SkippedSlot[] = older.map((scheduledAt) => ({
    scheduledAt,
    status: missedSlotStatus(scheduledAt, processStartedAt),
  }))

  if (age <= ROUTINE_LIMITS.onTimeGraceMs) {
    return {
      decision: {
        kind: 'fire',
        trigger: 'schedule',
        scheduledAt: newest,
        skipped: olderSkipped,
      },
      nextRunAt,
    }
  }

  if (routine.missed === 'catchup' && age <= ROUTINE_LIMITS.catchUpWindowMs) {
    return {
      decision: {
        kind: 'fire',
        trigger: 'late',
        scheduledAt: newest,
        skipped: olderSkipped,
      },
      nextRunAt,
    }
  }

  return {
    decision: {
      kind: 'skip',
      skipped: dueSlots.map((scheduledAt) => ({
        scheduledAt,
        status: missedSlotStatus(scheduledAt, processStartedAt),
      })),
    },
    nextRunAt,
  }
}

export function recoverInterruptedRoutineRuns(now = Date.now()): number {
  const active = listActiveRuns()
  for (const run of active) {
    updateRun(run.id, {
      status: 'stopped',
      finishedAt: now,
      unread: false,
    })
  }
  return active.length
}

export interface RoutineSchedulerDeps {
  runner: {
    isBusy(routineId: string): boolean
    start(routineId: string, trigger: RoutineRunTrigger, scheduledAt: number): Promise<LocalRoutineRun>
  }
  now?: () => number
  processStartedAt?: number
  deleteRunConversation?: (runId: string) => Promise<boolean>
  subscribePower?: (onWake: () => void) => () => void
  onError?: (error: unknown) => void
}

export interface RoutineScheduler {
  start(): void
  stop(): void
  tick(): Promise<void>
  sweepRetention(): Promise<void>
}

function defaultSubscribePower(onWake: () => void): () => void {
  powerMonitor.on('resume', onWake)
  powerMonitor.on('unlock-screen', onWake)
  return () => {
    powerMonitor.removeListener('resume', onWake)
    powerMonitor.removeListener('unlock-screen', onWake)
  }
}

export function createRoutineScheduler(deps: RoutineSchedulerDeps): RoutineScheduler {
  const now = deps.now ?? (() => Date.now())
  const processStartedAt = deps.processStartedAt ?? now()
  const deleteConversationForRun = deps.deleteRunConversation ?? deleteRoutineRunConversation
  const subscribePower = deps.subscribePower ?? defaultSubscribePower
  const logError = deps.onError ?? ((err: unknown) => console.warn('[routines] scheduler error:', err))

  let tickTimer: ReturnType<typeof setInterval> | null = null
  let sweepTimer: ReturnType<typeof setInterval> | null = null
  let unsubPower: (() => void) | null = null
  let ticking = false
  let sweeping = false
  let stopped = false

  async function tick(): Promise<void> {
    if (stopped || ticking) return
    ticking = true
    try {
      const currentNow = now()
      for (const routine of listRoutines()) {
        if (stopped) break
        const { decision, nextRunAt } = decideTick({
          routine,
          now: currentNow,
          processStartedAt,
          busy: deps.runner.isBusy(routine.id),
        })
        if (decision.kind === 'wait') continue

        setNextRunAt(routine.id, nextRunAt)

        for (const slot of decision.skipped) {
          insertRun({
            routineId: routine.id,
            scheduledAt: slot.scheduledAt,
            startedAt: null,
            finishedAt: slot.scheduledAt,
            trigger: 'schedule',
            status: slot.status,
            summary: null,
            report: null,
            error: null,
            conversationId: null,
            conversationDeleted: false,
            pinned: false,
            unread: false,
          })
        }

        if (decision.kind === 'fire') {
          void deps.runner.start(routine.id, decision.trigger, decision.scheduledAt).catch(logError)
        }
      }
    } catch (error) {
      logError(error)
    } finally {
      ticking = false
    }
  }

  async function sweepRetention(): Promise<void> {
    if (stopped || sweeping) return
    sweeping = true
    try {
      const currentNow = now()
      for (const routine of listRoutines()) {
        if (stopped) break
        if (routine.retentionDays !== null) {
          const cutoff = currentNow - routine.retentionDays * 86_400_000
          for (const run of listAllRunsForRetention(routine.id)) {
            const ref = run.finishedAt ?? run.startedAt ?? run.scheduledAt
            if (ref < cutoff) {
              try {
                await deleteConversationForRun(run.id)
              } catch (error) {
                logError(error)
              }
            }
          }
        }
        pruneRuns(routine.id, ROUTINE_LIMITS.runRowsPerRoutine)
      }
    } catch (error) {
      logError(error)
    } finally {
      sweeping = false
    }
  }

  function start(): void {
    if (stopped || tickTimer) return
    recoverInterruptedRoutineRuns(now())
    void tick()
    void sweepRetention()
    tickTimer = setInterval(() => void tick(), ROUTINE_LIMITS.tickMs)
    tickTimer.unref?.()
    sweepTimer = setInterval(() => void sweepRetention(), ROUTINE_LIMITS.sweepMs)
    sweepTimer.unref?.()
    unsubPower = subscribePower(() => void tick())
  }

  function stop(): void {
    stopped = true
    if (tickTimer) {
      clearInterval(tickTimer)
      tickTimer = null
    }
    if (sweepTimer) {
      clearInterval(sweepTimer)
      sweepTimer = null
    }
    unsubPower?.()
    unsubPower = null
  }

  return { start, stop, tick, sweepRetention }
}
