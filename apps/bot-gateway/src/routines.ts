import { randomUUID, createHash } from 'node:crypto'
import {
  FLEET_ROUTINE_CONVERSATIONS_FEATURE,
  fleetInstanceTurns,
  FLEET_ROUTINE_RUN_LIMITS,
  FLEET_ROUTINE_RUN_SETTINGS_DEFAULT,
  type FleetActivityEntry,
  type FleetInputReceipt,
  type FleetRoutineRun,
  type FleetRoutineRunCitation,
  type FleetRoutineRunMedia,
  type FleetRoutineRunPage,
  type FleetRoutineRunPatchRequest,
  type FleetRoutineRunReport,
  type FleetRoutineRunSettings,
  type FleetSendMessageRequest,
  type FleetTranscriptPage,
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
import type { Store, StoredRoutineRun } from './store.js'

type RunFinish = {
  outcome: 'completed' | 'failed' | 'cancelled'
  text: string | null
  at: number
  media?: FleetRoutineRunMedia | null
}
/** A turn the bot finished, as its event names it. */
export interface FinishedTurn {
  inputId: string
  outcome: 'completed' | 'failed' | 'cancelled'
  text: string | null
  /** The routine run whose own conversation it worked in, if any. */
  runId?: string | null
  media?: FleetRoutineRunMedia | null
}
const DAY = 86_400_000
/** How often the retention of runs' conversations is applied, and how many it deletes at most each time. */
const SWEEP_MS = 10 * 60_000
const SWEEP_MAX = 20

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
  private sweptAt = 0
  private readonly pendingFinishes = new Map<string, RunFinish>()
  /** Runs whose conversations are being deleted, so a sweep and the owner never delete one twice. */
  private readonly deleting = new Map<string, Promise<FleetRoutineRun>>()
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
  /** The inputs the bot has queued or is answering now: a run delivered with none of them was lost. */
  private live(botId: string): Set<string> {
    const status = this.lifecycle.statuses.get(botId)
    return new Set([
      ...(status?.queue.map((item) => item.inputId) ?? []),
      ...(status ? fleetInstanceTurns(status).map((turn) => turn.inputId) : []),
    ])
  }
  /** Whether a bot's Maestrly runs routines in conversations of their own (`routine-conversations`). */
  isolates(botId: string): boolean {
    return this.lifecycle.statuses.get(botId)?.capabilities.includes(FLEET_ROUTINE_CONVERSATIONS_FEATURE) === true
  }
  /** How a bot keeps its runs' conversations: the owner's choice, or the defaults. */
  settings(botId: string): FleetRoutineRunSettings {
    return this.store.runSettings(botId) ?? FLEET_ROUTINE_RUN_SETTINGS_DEFAULT
  }
  saveSettings(botId: string, settings: FleetRoutineRunSettings): FleetRoutineRunSettings {
    this.store.saveRunSettings(botId, settings)
    this.lifecycle.botChanged(botId)
    // New limits apply at once, not at the next scheduled sweep.
    this.sweptAt = 0
    return settings
  }
  /** When retention deletes a finished run's conversation; null when it never does on its own. */
  private expiresAt(run: StoredRoutineRun, settings: FleetRoutineRunSettings, live: Set<string>): string | null {
    if (run.conversation !== 'own' || run.pinned || (run.status === 'delivered' && live.has(run.inputId))) return null
    const days: number[] = []
    if (settings.retentionDays !== null) days.push(settings.retentionDays)
    if (settings.quietEarly && run.quiet) days.push(FLEET_ROUTINE_RUN_LIMITS.quietRetentionDays)
    if (!days.length) return null
    const from = Date.parse(run.lastActivityAt ?? run.finishedAt ?? run.deliveredAt)
    return new Date(from + Math.min(...days) * DAY).toISOString()
  }
  /** A run as devices see it: without its input id, with when its conversation expires, and lost runs as unknown. */
  view(run: StoredRoutineRun, live = this.live(run.botId), settings = this.settings(run.botId)): FleetRoutineRun {
    const { inputId, ...visible } = run
    return {
      ...visible,
      status: run.status === 'delivered' && !live.has(inputId) ? 'unknown' : run.status,
      expiresAt: this.expiresAt(run, settings, live),
    }
  }
  /** Runs that left a bot's history. */
  private removed(botId: string, runIds: string[]) {
    const at = new Date(this.now()).toISOString()
    for (const runId of runIds) this.lifecycle.onEvent({ type: 'routine_run.removed', at, botId, runId })
  }
  private emit(run: StoredRoutineRun) {
    this.lifecycle.onEvent({
      type: 'routine_run.updated',
      at: new Date(this.now()).toISOString(),
      botId: run.botId,
      run: this.view(run),
    })
  }
  runs(botId: string, routineId: string): FleetRoutineRun[] {
    this.require(botId, routineId)
    const live = this.live(botId)
    const settings = this.settings(botId)
    return this.store
      .routineRuns(routineId, FLEET_ROUTINE_RUN_LIMITS.keepPerRoutine)
      .map((run) => this.view(run, live, settings))
  }
  /** Every run of a bot, newest first, a page at a time; runs outlive their routines. */
  page(
    botId: string,
    options: { before?: string | null; limit?: number; routineId?: string | null } = {}
  ): FleetRoutineRunPage {
    const limit = Math.max(1, Math.min(FLEET_ROUTINE_RUN_LIMITS.pageMax, options.limit ?? 100))
    const before = options.before ? this.store.routineRunById(options.before) : null
    if (options.before && before?.botId !== botId) throw new GatewayError('NOT_FOUND', 'Routine run not found')
    const rows = this.store.botRoutineRuns(botId, { limit: limit + 1, before, routineId: options.routineId })
    const live = this.live(botId)
    const settings = this.settings(botId)
    const runs = rows.slice(0, limit).map((run) => this.view(run, live, settings))
    return { runs, before: rows.length > limit ? runs[runs.length - 1].id : null }
  }
  private requireRun(botId: string, runId: string): StoredRoutineRun {
    const run = this.store.routineRunById(runId)
    if (!run || run.botId !== botId) throw new GatewayError('NOT_FOUND', 'Routine run not found')
    return run
  }
  /** A run with a conversation of its own that is still there. */
  private requireConversation(botId: string, runId: string): StoredRoutineRun {
    const run = this.requireRun(botId, runId)
    if (run.conversation === 'primary')
      throw new GatewayError('CONFLICT', "This run happened in the bot's conversation: it has none of its own.")
    if (run.conversation === 'deleted') throw new GatewayError('NOT_FOUND', "This run's conversation was deleted.")
    return run
  }
  get(botId: string, runId: string): FleetRoutineRun {
    return this.view(this.requireRun(botId, runId))
  }
  /** What the owner changes of a run: whether they keep it, and that they opened it. */
  patchRun(botId: string, runId: string, request: FleetRoutineRunPatchRequest): FleetRoutineRun {
    let run = this.get(botId, runId)
    if (request.pinned !== undefined) run = this.setPinned(botId, runId, request.pinned)
    if (request.seen) run = this.setSeen(botId, runId)
    return run
  }
  setPinned(botId: string, runId: string, pinned: boolean): FleetRoutineRun {
    const run = { ...this.requireRun(botId, runId), pinned }
    this.store.updateRoutineRun(run)
    this.emit(run)
    return this.view(run)
  }
  /** The owner opened a run on one of their devices: it is no longer new on any of them. */
  setSeen(botId: string, runId: string): FleetRoutineRun {
    const run = this.requireRun(botId, runId)
    if (run.seenAt !== null) return this.view(run)
    const next = { ...run, seenAt: new Date(this.now()).toISOString() }
    this.store.setRoutineRunSeen(run.id, next.seenAt)
    this.emit(next)
    return this.view(next)
  }
  /** A run an owner's message in the bot's conversation refers to. */
  citation(botId: string, runId: string): FleetRoutineRunCitation {
    const run = this.requireRun(botId, runId)
    const title = run.routineTitle ?? this.store.routineById(run.routineId)?.title ?? ''
    return { runId: run.id, routineTitle: title.slice(0, 80), at: run.deliveredAt }
  }
  transcript(
    botId: string,
    runId: string,
    before: string | undefined,
    limit: number,
    reasoning: boolean
  ): Promise<FleetTranscriptPage> {
    this.requireConversation(botId, runId)
    return this.lifecycle.instanceFor(botId).runTranscript(runId, before, limit, reasoning)
  }
  /** An owner's message in a run's conversation: the bot answers it there, with what the run did. */
  async message(botId: string, runId: string, input: FleetSendMessageRequest): Promise<FleetInputReceipt> {
    this.requireConversation(botId, runId)
    const receipt: FleetInputReceipt = await this.lifecycle.instanceFor(botId).postInput({
      source: 'owner',
      text: input.text,
      attachments: input.attachments,
      idempotencyKey: input.idempotencyKey,
      run: { id: runId },
    })
    // Read again: the run may have changed while the message was on its way.
    const run = this.store.routineRunById(runId)
    if (run) {
      const at = new Date(this.now()).toISOString()
      // The owner wrote there: they saw the run, whatever device they did it from.
      const next = { ...run, adjustments: run.adjustments + 1, lastActivityAt: at, seenAt: run.seenAt ?? at }
      this.store.updateRoutineRun(next)
      if (!run.seenAt) this.store.setRoutineRunSeen(run.id, at)
      this.emit(next)
    }
    return receipt
  }
  /**
   * Deletes a run's conversation in the bot; its report stays, with what the bot kept of it (its images and
   * attachments, in a folder of the bot's conversation, and the files it had shared). A run that is working is refused.
   */
  deleteConversation(botId: string, runId: string): Promise<FleetRoutineRun> {
    const run = this.requireRun(botId, runId)
    if (run.conversation === 'deleted') return Promise.resolve(this.view(run))
    this.requireConversation(botId, runId)
    const pending = this.deleting.get(runId)
    if (pending) return pending
    if (run.status === 'delivered' && this.live(botId).has(run.inputId))
      throw new GatewayError('CONFLICT', 'The run is still working. Stop it or wait for it to end.')
    const task = (async () => {
      let kept: FleetRoutineRun['kept'] = null
      try {
        kept = (await this.lifecycle.instanceFor(botId).deleteRun(runId)).kept
      } catch (error) {
        // A conversation the bot no longer has is deleted already.
        if (!(error instanceof GatewayError && error.code === 'NOT_FOUND')) throw error
      }
      const current = this.store.routineRunById(runId) ?? run
      const next: StoredRoutineRun = {
        ...current,
        conversation: 'deleted',
        conversationDeletedAt: new Date(this.now()).toISOString(),
        kept,
      }
      this.store.updateRoutineRun(next)
      this.emit(next)
      return this.view(next)
    })()
    this.deleting.set(runId, task)
    const clear = () => this.deleting.delete(runId)
    task.then(clear, clear)
    return task
  }
  report(botId: string, routineId: string, runId: string, report: FleetRoutineRunReport): FleetRoutineRun {
    const run = this.store.routineRunById(runId)
    // A run outlives its routine: its conversation may still update its report.
    if (!run || run.routineId !== routineId || run.botId !== botId) {
      this.require(botId, routineId)
      throw new GatewayError('NOT_FOUND', 'Routine run not found')
    }
    const next = { ...run, report, quiet: report.quiet ?? run.quiet }
    this.store.updateRoutineRun(next)
    this.emit(next)
    return this.view(next)
  }
  /**
   * A turn the bot finished: the run of its input, or a turn in a run's own conversation, records how it went. Answers
   * what its activity says of the run, for alerts: which run, whether it found nothing new and whether the owner hears.
   */
  finishRun(botId: string, turn: FinishedTurn): FleetActivityEntry['data'] {
    this.prunePendingFinishes()
    const { inputId, outcome } = turn
    const key = JSON.stringify([botId, inputId])
    const finish: RunFinish = {
      outcome,
      text: turn.text ? turn.text.slice(0, FLEET_ROUTINE_RUN_LIMITS.finalTextMax) : null,
      at: this.now(),
      media: turn.media ?? null,
    }
    if (this.applyFinish(botId, inputId, finish)) return this.alert(this.store.routineRunByInput(botId, inputId))
    if (turn.runId) {
      // The owner's change in the run's conversation: the run is as its latest turn left it.
      const run = this.store.routineRunById(turn.runId)
      if (run?.botId === botId) {
        const at = new Date(finish.at).toISOString()
        const next: StoredRoutineRun = {
          ...run,
          status: outcome,
          finishedAt: at,
          lastActivityAt: at,
          finalText: finish.text ?? run.finalText,
          media: finish.media ?? run.media,
        }
        this.store.updateRoutineRun(next)
        this.emit(next)
        return { runId: run.id }
      }
    }
    const prior = this.pendingFinishes.get(key)
    if (prior && prior.outcome !== 'failed') return {}
    this.pendingFinishes.delete(key)
    this.pendingFinishes.set(key, finish)
    if (this.pendingFinishes.size > 100) this.pendingFinishes.delete(this.pendingFinishes.keys().next().value!)
    return {}
  }
  /** What a finished run's activity says: alerts follow the bot's settings, and runs that found nothing new stay quiet. */
  private alert(run: StoredRoutineRun | null): FleetActivityEntry['data'] {
    if (!run) return {}
    const { notify } = this.settings(run.botId)
    const alert = notify === 'all' || (notify === 'notable' && !run.quiet)
    return { runId: run.id, quiet: run.quiet, alert }
  }

  private prunePendingFinishes() {
    for (const [key, finish] of this.pendingFinishes)
      if (this.now() - finish.at >= 5 * 60_000) this.pendingFinishes.delete(key)
  }

  private applyFinish(botId: string, inputId: string, finish: RunFinish): boolean {
    const run = this.store.routineRunByInput(botId, inputId)
    if (!run) return false
    if (run.status !== 'completed' && run.status !== 'cancelled') {
      const at = new Date(finish.at).toISOString()
      const next: StoredRoutineRun = {
        ...run,
        status: finish.outcome,
        finishedAt: at,
        finalText: finish.text,
        ...(run.conversation === 'own' ? { lastActivityAt: at, media: finish.media ?? run.media } : {}),
      }
      this.store.updateRoutineRun(next)
      this.emit(next)
    }
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
      if (this.now() - this.sweptAt >= SWEEP_MS) {
        this.sweptAt = this.now()
        await this.sweep()
      }
    } finally {
      this.ticking = false
    }
  }
  /** How many runs of one routine a bot keeps: its newest, as its settings say. */
  private keepPerRoutine(botId: string): number {
    return this.settings(botId).capPerRoutine
      ? FLEET_ROUTINE_RUN_LIMITS.keepPerRoutine
      : FLEET_ROUTINE_RUN_LIMITS.storedPerRoutineMax
  }
  /**
   * Retention: deletes the conversations of finished runs past their time, and of each routine's runs past the newest
   * it keeps, which then leave the history too. Runs the owner keeps, and those still working, stay. Only bots running
   * now are swept; the others wait for the next sweep, and at most `SWEEP_MAX` conversations go each time.
   */
  async sweep(): Promise<void> {
    let budget = SWEEP_MAX
    const byBot = new Map<string, StoredRoutineRun[]>()
    for (const run of this.store.ownRoutineRuns()) byBot.set(run.botId, [...(byBot.get(run.botId) ?? []), run])
    for (const [botId, runs] of byBot) {
      if (budget <= 0) return
      const bot = this.lifecycle.get(botId)
      if (bot?.lifecycle !== 'running' || !this.lifecycle.statuses.get(botId)?.ready) continue
      const live = this.live(botId)
      const settings = this.settings(botId)
      const keep = this.keepPerRoutine(botId)
      const counted = new Map<string, number>()
      const due: StoredRoutineRun[] = []
      const capped = new Set<string>()
      // Newest first: a routine's runs past the ones it keeps go, kept and working ones aside.
      for (const run of this.store.botRoutineRuns(botId, { limit: 100_000 })) {
        if (run.pinned) continue
        const seen = (counted.get(run.routineId) ?? 0) + 1
        counted.set(run.routineId, seen)
        if (seen > keep && run.conversation === 'own' && !(run.status === 'delivered' && live.has(run.inputId))) {
          due.push(run)
          capped.add(run.routineId)
        }
      }
      for (const run of runs) {
        const expires = this.expiresAt(run, settings, live)
        if (expires && Date.parse(expires) <= this.now() && !due.includes(run)) due.push(run)
      }
      for (const run of due) {
        if (budget-- <= 0) break
        await this.deleteConversation(botId, run.id).catch(() => undefined)
      }
      for (const routineId of capped) this.removed(botId, this.store.pruneRoutineRuns(routineId, keep))
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
        // A bot whose Maestrly can gives the run a conversation of its own, out of the owner's conversation.
        const own = this.isolates(routine.botId)
        const receipt = await this.lifecycle.instanceFor(routine.botId).postInput({
          source: 'routine',
          routine: { id: routine.id, title: routine.title, runId, previousRuns },
          text: routine.prompt,
          attachments: [],
          idempotencyKey,
          ...(own ? { run: { id: runId } } : {}),
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
          routineTitle: routine.title,
          conversation: own ? 'own' : 'primary',
          quiet: false,
          pinned: false,
          lastActivityAt: own ? at : null,
          expiresAt: null,
          conversationDeletedAt: null,
          media: null,
          kept: null,
          adjustments: 0,
          seenAt: null,
        })
        this.prunePendingFinishes()
        const finishKey = JSON.stringify([routine.botId, receipt.inputId])
        const finish = this.pendingFinishes.get(finishKey)
        if (finish) {
          this.pendingFinishes.delete(finishKey)
          this.applyFinish(routine.botId, receipt.inputId, finish)
        }
        const inserted = this.store.routineRunById(runId)
        if (inserted) this.emit(inserted)
        this.removed(routine.botId, this.store.pruneRoutineRuns(routine.id, this.keepPerRoutine(routine.botId)))
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
    return (
      status?.queue.some((item) => item.inputId === inputId) === true ||
      (!!status && fleetInstanceTurns(status).some((turn) => turn.inputId === inputId))
    )
  }
}
