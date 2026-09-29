import { randomUUID, createHash } from 'node:crypto'
import {
  FLEET_ROUTINE_RUN_LIMITS,
  type FleetRoutineRun,
  type FleetRoutineRunReport,
  FLEET_ROUTINE_LIMITS,
  isValidTimeZone,
  type FleetRoutine,
  type FleetRoutineSchedule,
  type FleetCreateRoutineRequest,
  type FleetPatchRoutineRequest,
  type FleetWeeklySchedule,
} from '@maestrly/bot-fleet-protocol'
import { GatewayError } from './errors.js'
import type { Lifecycle } from './lifecycle.js'
import type { Store } from './store.js'

type RunFinish = { outcome: 'completed' | 'failed' | 'cancelled'; text: string | null; at: number }

type Parts = { year: number; month: number; day: number; hour: number; minute: number }
function parts(formatter: Intl.DateTimeFormat, value: number): Parts {
  const entries = Object.fromEntries(
    formatter
      .formatToParts(value)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)])
  )
  return entries as Parts
}
function formatter(timezone: string) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
}
function scheduledKey(id: string, due: string): string {
  const hex = createHash('sha256')
    .update(id + ':' + due)
    .digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}
export const runIdFor = (key: string) => {
  const hex = createHash('sha256')
    .update('routine-run:' + key)
    .digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

export function nextWeeklyRun(schedule: FleetWeeklySchedule, after: Date): string {
  if (!isValidTimeZone(schedule.timezone)) throw new GatewayError('INVALID_REQUEST', 'Invalid time zone')
  const fmt = formatter(schedule.timezone)
  const start = parts(fmt, after.getTime())
  const date = Date.UTC(start.year, start.month - 1, start.day)
  const [hour, minute] = schedule.time.split(':').map(Number)
  for (let day = 0; day < 8; day++) {
    const localDate = new Date(date + day * 86400000)
    const year = localDate.getUTCFullYear(),
      month = localDate.getUTCMonth() + 1,
      dayOfMonth = localDate.getUTCDate()
    const isoDay = ((localDate.getUTCDay() + 6) % 7) + 1
    if (schedule.days.length && !schedule.days.includes(isoDay)) continue
    const noon = Date.UTC(year, month - 1, dayOfMonth, 12)
    const noonParts = parts(fmt, noon)
    const offset = Date.UTC(noonParts.year, noonParts.month - 1, noonParts.day, noonParts.hour, noonParts.minute) - noon
    const guess = Date.UTC(year, month - 1, dayOfMonth, hour, minute) - offset
    let first: number | null = null
    let firstAfterGap: number | null = null
    for (let time = guess - 3 * 3600000; time <= guess + 3 * 3600000; time += 60000) {
      const local = parts(fmt, time)
      if (local.year !== year || local.month !== month || local.day !== dayOfMonth) continue
      const localMinute = local.hour * 60 + local.minute
      if (localMinute === hour * 60 + minute) {
        first = time
        break
      }
      if (localMinute > hour * 60 + minute && firstAfterGap === null) firstAfterGap = time
    }
    const candidate = first ?? firstAfterGap
    if (candidate !== null && candidate > after.getTime()) return new Date(candidate).toISOString()
  }
  throw new GatewayError('INVALID_REQUEST', 'Could not calculate next routine run')
}

export function nextRun(schedule: FleetRoutineSchedule, after: Date): string {
  return schedule.kind === 'weekly'
    ? nextWeeklyRun(schedule, after)
    : new Date(after.getTime() + schedule.everyMinutes * 60_000).toISOString()
}

export class Routines {
  private timer: NodeJS.Timeout | null = null
  private ticking = false
  private readonly pendingFinishes = new Map<string, RunFinish>()
  constructor(
    readonly store: Store,
    readonly lifecycle: Lifecycle,
    readonly now: () => number = Date.now,
    readonly tickMs = 15000
  ) {}
  start() {
    this.timer ??= setInterval(() => void this.tick(), this.tickMs)
    void this.tick()
  }
  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
  list(botId: string) {
    return this.store.routines(botId)
  }
  create(botId: string, request: FleetCreateRoutineRequest, createdBy: FleetRoutine['createdBy'] = 'owner') {
    if (request.schedule.kind === 'weekly' && !isValidTimeZone(request.schedule.timezone))
      throw new GatewayError('INVALID_REQUEST', 'Invalid time zone')
    const hash = createHash('sha256').update(JSON.stringify(request)).digest('hex')
    const scope = (createdBy === 'bot' ? 'botRoutineCreate:' : 'routineCreate:') + botId
    const result = this.store.idempotent(scope, request.idempotencyKey, hash, () => {
      if (
        createdBy === 'bot' &&
        this.store.routines(botId).filter((item) => item.createdBy === 'bot').length >=
          FLEET_ROUTINE_LIMITS.botCreatedMax
      )
        throw new GatewayError(
          'CONFLICT',
          `Routine limit reached: this bot already created ${FLEET_ROUTINE_LIMITS.botCreatedMax} routines. Delete one first or ask your owner.`
        )
      const at = new Date(this.now()).toISOString()
      const routine: FleetRoutine = {
        id: randomUUID(),
        botId,
        title: request.title,
        prompt: request.prompt,
        schedule: request.schedule,
        enabled: request.enabled,
        nextRunAt: request.enabled ? nextRun(request.schedule, new Date(this.now())) : null,
        lastRunAt: null,
        lastOutcome: null,
        createdBy,
        createdAt: at,
        updatedAt: at,
      }
      this.store.saveRoutine(routine)
      if (createdBy === 'bot')
        this.lifecycle.recordActivity(botId, 'routine_created', routine.title, { routineId: routine.id })
      return { response: routine, status: 201 }
    })
    return result.response
  }
  patch(botId: string, id: string, request: FleetPatchRoutineRequest, caller: 'owner' | 'bot' = 'owner') {
    const current = this.require(botId, id)
    if (caller === 'bot' && current.createdBy !== 'bot')
      throw new GatewayError('FORBIDDEN', 'Only your owner can change this routine.')
    if (request.schedule?.kind === 'weekly' && !isValidTimeZone(request.schedule.timezone))
      throw new GatewayError('INVALID_REQUEST', 'Invalid time zone')
    const routine = { ...current, ...request, updatedAt: new Date(this.now()).toISOString() }
    if (request.schedule || request.enabled !== undefined)
      routine.nextRunAt = routine.enabled ? nextRun(routine.schedule, new Date(this.now())) : null
    this.store.saveRoutine(routine)
    if (caller === 'bot') this.lifecycle.recordActivity(botId, 'routine_updated', routine.title, { routineId: id })
    return routine
  }
  delete(botId: string, id: string, caller: 'owner' | 'bot' = 'owner') {
    const routine = this.require(botId, id)
    if (caller === 'bot' && routine.createdBy !== 'bot')
      throw new GatewayError('FORBIDDEN', 'Only your owner can change this routine.')
    this.store.deleteRoutine(id)
    if (caller === 'bot') this.lifecycle.recordActivity(botId, 'routine_deleted', routine.title, { routineId: id })
  }
  runs(botId: string, routineId: string): FleetRoutineRun[] {
    this.require(botId, routineId)
    const status = this.lifecycle.statuses.get(botId)
    const live = new Set([
      ...(status?.queue.map((item) => item.inputId) ?? []),
      ...(status?.turn.inputId ? [status.turn.inputId] : []),
    ])
    return this.store
      .routineRuns(routineId, FLEET_ROUTINE_RUN_LIMITS.keepPerRoutine)
      .map(({ inputId, ...run }) =>
        run.status === 'delivered' && !live.has(inputId) ? { ...run, status: 'unknown' as const } : run
      )
  }
  report(botId: string, routineId: string, runId: string, report: FleetRoutineRunReport): FleetRoutineRun {
    this.require(botId, routineId)
    const run = this.store.routineRunById(runId)
    if (!run || run.routineId !== routineId || run.botId !== botId)
      throw new GatewayError('NOT_FOUND', 'Routine run not found')
    const next = { ...run, report }
    this.store.updateRoutineRun(next)
    const { inputId: _inputId, ...visible } = next
    return visible
  }
  finishRun(botId: string, inputId: string, outcome: 'completed' | 'failed' | 'cancelled', text: string | null) {
    this.prunePendingFinishes()
    const key = JSON.stringify([botId, inputId])
    const finish = { outcome, text: text ? text.slice(0, FLEET_ROUTINE_RUN_LIMITS.finalTextMax) : null, at: this.now() }
    if (this.applyFinish(botId, inputId, finish)) return
    const prior = this.pendingFinishes.get(key)
    if (prior && prior.outcome !== 'failed') return
    this.pendingFinishes.delete(key)
    this.pendingFinishes.set(key, finish)
    if (this.pendingFinishes.size > 100) this.pendingFinishes.delete(this.pendingFinishes.keys().next().value!)
  }

  private prunePendingFinishes() {
    for (const [key, finish] of this.pendingFinishes)
      if (this.now() - finish.at >= 5 * 60_000) this.pendingFinishes.delete(key)
  }

  private applyFinish(botId: string, inputId: string, finish: RunFinish): boolean {
    const run = this.store.routineRunByInput(botId, inputId)
    if (!run) return false
    if (run.status !== 'completed' && run.status !== 'cancelled')
      this.store.updateRoutineRun({
        ...run,
        status: finish.outcome,
        finishedAt: new Date(finish.at).toISOString(),
        finalText: finish.text,
      })
    return true
  }

  private require(botId: string, id: string) {
    const routine = this.store.routineById(id)
    if (!routine || routine.botId !== botId) throw new GatewayError('NOT_FOUND', 'Routine not found')
    return routine
  }
  async run(botId: string, id: string) {
    return this.fire(this.require(botId, id), false)
  }
  /** A restored bot's routines resume from now: runs missed while it was archived are neither replayed nor recorded. */
  reschedule(botId: string) {
    const now = new Date(this.now())
    for (const routine of this.store.routines(botId)) {
      if (!routine.enabled) continue
      this.store.saveRoutine({
        ...routine,
        nextRunAt: nextRun(routine.schedule, now),
        updatedAt: now.toISOString(),
      })
    }
  }
  async tick() {
    if (this.ticking) return
    this.ticking = true
    this.prunePendingFinishes()
    try {
      for (const routine of this.store.routines()) {
        if (!routine.enabled || !routine.nextRunAt) continue
        // An archived bot's schedule is frozen: nothing runs or is recorded until it is restored.
        if (this.store.getBot(routine.botId)?.lifecycle === 'archived') continue
        let current = routine
        while (current.nextRunAt && Date.parse(current.nextRunAt) <= this.now()) {
          const due = current.nextRunAt
          current = await this.fire(current, true)
          if (current.nextRunAt === due) break
        }
      }
    } finally {
      this.ticking = false
    }
  }
  private async fire(routine: FleetRoutine, scheduled: boolean): Promise<FleetRoutine> {
    const at = new Date(this.now()).toISOString()
    const bot = this.lifecycle.get(routine.botId)
    let sentRunId: string | null = null
    let outcome: FleetRoutine['lastOutcome']
    if (bot?.paused) outcome = 'skipped_paused'
    else if (bot?.lifecycle !== 'running' || !this.lifecycle.statuses.get(routine.botId)?.ready)
      outcome = 'skipped_offline'
    // A run starting now would keep the waiting update from ever finding the bot idle.
    else if (scheduled && this.lifecycle.updatePending(routine.botId)) outcome = 'skipped_busy'
    else if (scheduled && routine.nextRunAt && this.now() - Date.parse(routine.nextRunAt) > 15 * 60000)
      outcome = 'skipped_missed'
    else if (scheduled && this.busy(routine)) outcome = 'skipped_busy'
    else {
      try {
        const idempotencyKey =
          scheduled && routine.nextRunAt ? scheduledKey(routine.id, routine.nextRunAt) : randomUUID()
        const runId = runIdFor(idempotencyKey)
        const previousRuns = this.runs(routine.botId, routine.id)
          .filter((run) => run.id !== runId)
          .slice(0, FLEET_ROUTINE_RUN_LIMITS.previousRuns)
          .map((run) => ({
            at: run.deliveredAt,
            status: run.status,
            summary:
              run.report?.summary ??
              (run.finalText ? run.finalText.slice(0, FLEET_ROUTINE_RUN_LIMITS.summaryMax) : null),
            pending: run.report?.pending ?? null,
            notes: run.report?.notes ?? null,
          }))
        const receipt = await this.lifecycle.instanceFor(routine.botId).postInput({
          source: 'routine',
          routine: { id: routine.id, title: routine.title, runId, previousRuns },
          text: routine.prompt,
          attachments: [],
          idempotencyKey,
        })
        this.store.setRoutineLastInputId(routine.id, receipt.inputId)
        this.store.insertRoutineRun({
          id: runId,
          routineId: routine.id,
          botId: routine.botId,
          inputId: receipt.inputId,
          trigger: scheduled ? 'schedule' : 'manual',
          status: 'delivered',
          deliveredAt: at,
          finishedAt: null,
          report: null,
          finalText: null,
        })
        this.prunePendingFinishes()
        const finishKey = JSON.stringify([routine.botId, receipt.inputId])
        const finish = this.pendingFinishes.get(finishKey)
        if (finish) {
          this.pendingFinishes.delete(finishKey)
          this.applyFinish(routine.botId, receipt.inputId, finish)
        }
        this.store.pruneRoutineRuns(routine.id, FLEET_ROUTINE_RUN_LIMITS.keepPerRoutine)
        sentRunId = runId
        outcome = 'sent'
      } catch {
        outcome = 'failed'
      }
    }
    const nextAt = scheduled && routine.nextRunAt ? routine.nextRunAt : at
    let nextRunAt = routine.enabled ? nextRun(routine.schedule, new Date(nextAt)) : null
    if (scheduled && routine.schedule.kind === 'interval' && nextRunAt && Date.parse(nextRunAt) <= this.now()) {
      const everyMs = routine.schedule.everyMinutes * 60_000
      const intervals = Math.floor((this.now() - Date.parse(nextAt)) / everyMs) + 1
      nextRunAt = new Date(Date.parse(nextAt) + intervals * everyMs).toISOString()
    }
    const next = {
      ...routine,
      lastRunAt: at,
      lastOutcome: outcome,
      updatedAt: at,
      nextRunAt,
    }
    this.store.saveRoutine(next)
    if (outcome === 'sent' || outcome !== routine.lastOutcome)
      this.lifecycle.recordActivity(routine.botId, outcome === 'sent' ? 'routine_ran' : 'routine_skipped', null, {
        outcome,
        routineId: routine.id,
        ...(sentRunId ? { runId: sentRunId } : {}),
      })
    return next
  }
  private busy(routine: FleetRoutine): boolean {
    const inputId = this.store.routineLastInputId(routine.id)
    if (!inputId) return false
    const status = this.lifecycle.statuses.get(routine.botId)
    return status?.queue.some((item) => item.inputId === inputId) === true || status?.turn.inputId === inputId
  }
}
