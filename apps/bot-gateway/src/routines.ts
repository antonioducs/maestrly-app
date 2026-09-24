import { randomUUID, createHash } from 'node:crypto'
import {
  isValidTimeZone,
  type FleetRoutine,
  type FleetRoutineSchedule,
  type FleetCreateRoutineRequest,
  type FleetPatchRoutineRequest,
} from '@maestrly/bot-fleet-protocol'
import { GatewayError } from './errors.js'
import type { Lifecycle } from './lifecycle.js'
import type { Store } from './store.js'

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
export function nextWeeklyRun(schedule: FleetRoutineSchedule, after: Date): string {
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

export class Routines {
  private timer: NodeJS.Timeout | null = null
  private ticking = false
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
  create(botId: string, request: FleetCreateRoutineRequest) {
    if (!isValidTimeZone(request.schedule.timezone)) throw new GatewayError('INVALID_REQUEST', 'Invalid time zone')
    const hash = createHash('sha256').update(JSON.stringify(request)).digest('hex')
    const result = this.store.idempotent('routineCreate:' + botId, request.idempotencyKey, hash, () => {
      const at = new Date(this.now()).toISOString()
      const routine: FleetRoutine = {
        id: randomUUID(),
        botId,
        title: request.title,
        prompt: request.prompt,
        schedule: request.schedule,
        enabled: request.enabled,
        nextRunAt: request.enabled ? nextWeeklyRun(request.schedule, new Date(this.now())) : null,
        lastRunAt: null,
        lastOutcome: null,
        createdAt: at,
        updatedAt: at,
      }
      this.store.saveRoutine(routine)
      return { response: routine, status: 201 }
    })
    return result.response
  }
  patch(botId: string, id: string, request: FleetPatchRoutineRequest) {
    const current = this.require(botId, id)
    if (request.schedule && !isValidTimeZone(request.schedule.timezone))
      throw new GatewayError('INVALID_REQUEST', 'Invalid time zone')
    const routine = { ...current, ...request, updatedAt: new Date(this.now()).toISOString() }
    if (request.schedule || request.enabled !== undefined)
      routine.nextRunAt = routine.enabled ? nextWeeklyRun(routine.schedule, new Date(this.now())) : null
    this.store.saveRoutine(routine)
    return routine
  }
  delete(botId: string, id: string) {
    this.require(botId, id)
    this.store.deleteRoutine(id)
  }
  private require(botId: string, id: string) {
    const routine = this.store.routineById(id)
    if (!routine || routine.botId !== botId) throw new GatewayError('NOT_FOUND', 'Routine not found')
    return routine
  }
  async run(botId: string, id: string) {
    return this.fire(this.require(botId, id), false)
  }
  async tick() {
    if (this.ticking) return
    this.ticking = true
    try {
      for (const routine of this.store.routines()) {
        if (!routine.enabled || !routine.nextRunAt) continue
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
    let outcome: FleetRoutine['lastOutcome']
    if (bot?.paused) outcome = 'skipped_paused'
    else if (bot?.lifecycle !== 'running' || !this.lifecycle.statuses.get(routine.botId)?.ready)
      outcome = 'skipped_offline'
    else if (scheduled && routine.nextRunAt && this.now() - Date.parse(routine.nextRunAt) > 15 * 60000)
      outcome = 'skipped_missed'
    else {
      try {
        await this.lifecycle.instanceFor(routine.botId).postInput({
          source: 'routine',
          routine: { id: routine.id, title: routine.title },
          text: routine.prompt,
          idempotencyKey: scheduled && routine.nextRunAt ? scheduledKey(routine.id, routine.nextRunAt) : randomUUID(),
        })
        outcome = 'sent'
      } catch {
        outcome = 'failed'
      }
    }
    const next = {
      ...routine,
      lastRunAt: at,
      lastOutcome: outcome,
      updatedAt: at,
      nextRunAt: routine.enabled
        ? nextWeeklyRun(routine.schedule, new Date(scheduled && routine.nextRunAt ? routine.nextRunAt : at))
        : null,
    }
    this.store.saveRoutine(next)
    this.lifecycle.recordActivity(routine.botId, outcome === 'sent' ? 'routine_ran' : 'routine_skipped', null, {
      outcome,
    })
    return next
  }
}
