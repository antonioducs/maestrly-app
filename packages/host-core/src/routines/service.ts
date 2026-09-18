import { randomUUID } from 'node:crypto'
import {
  ROUTINE_LIMITS,
  ROUTINE_MUTATIONS,
  ROUTINE_OCCURRENCE_TERMINAL,
  routineResultSchemas,
  routineSpecSchema,
  type Routine,
  type RoutineCeiling,
  type RoutineMethod,
  type RoutineOccurrence,
  type RoutineOperation,
  type RoutinePreview,
  type RoutineRequest,
  type RoutineResult,
  type RoutineSpec,
  type RoutineWarning,
  type TargetRef,
} from '@maestrly/host-protocol'
import { HostError } from '../errors.js'
import type { BotRepository } from '../bots/repository.js'
import type { RuntimeCoordinator } from '../bots/runtime-coordinator.js'
import type { BotTurns } from '../bots/turns.js'
import type { TeamRepository } from '../teams/repository.js'
import type { TeamService } from '../teams/service.js'
import { RoutineAuthority, digest } from './authority.js'
import { describeSchedule, enumerate, isAmbiguousInstant, localReading, resolveLocal, localPartsOf, type Clock, systemClock } from './calendar.js'
import { RoutineExecutionAdapter } from './execution-adapter.js'
import { RoutineProposals } from './proposals.js'
import { RoutineScheduler } from './scheduler.js'
import { type RoutineRepository, now } from './repository.js'

export interface RoutineServiceOptions {
  routines: RoutineRepository
  bots: BotRepository
  teams: TeamRepository
  turns: BotTurns
  coordinator: RuntimeCoordinator
  teamService: () => TeamService
  hostId: string
  held: (botId: string) => boolean
  vmRunning?: (vmId: string) => boolean
  /** How many background slots are free right now, shared with team work. */
  backgroundAvailable: () => boolean
  clock?: Clock
  tickMs?: number
}

interface StoredPreview {
  preview: RoutinePreview
  spec: RoutineSpec
  targetVersion: string
  ceiling: RoutineCeiling
  proposalId?: string
  expiresAt: number
}

/**
 * The routine domain façade. Two rules shape everything here.
 *
 * Nothing becomes executable without a person confirming the exact object they were shown:
 * there is no code path from a model, a file, a page or an RPC that reaches an active
 * routine without a preview and its fingerprint. And a routine is a calendar entry, not a
 * privilege: activating one never grants a tool, a destination, an account or a quota that
 * the target did not already have.
 */
export class RoutineService {
  readonly repo: RoutineRepository
  readonly authority: RoutineAuthority
  readonly adapter: RoutineExecutionAdapter
  readonly scheduler: RoutineScheduler
  readonly proposals: RoutineProposals
  private readonly previews = new Map<string, StoredPreview>()
  private readonly clock: Clock
  constructor(private readonly options: RoutineServiceOptions) {
    this.repo = options.routines
    this.clock = options.clock ?? systemClock
    this.authority = new RoutineAuthority({
      bots: options.bots,
      teams: options.teams,
      routines: this.repo,
      held: options.held,
      ...(options.vmRunning ? { vmRunning: options.vmRunning } : {}),
    })
    this.adapter = new RoutineExecutionAdapter({
      routines: this.repo,
      bots: options.bots,
      teams: options.teams,
      turns: options.turns,
      coordinator: options.coordinator,
      authority: this.authority,
      teamService: options.teamService,
      event: (input) => this.event(input),
    })
    this.proposals = new RoutineProposals({ routines: this.repo, bots: options.bots, teams: options.teams, authority: this.authority, clock: this.clock })
    this.scheduler = new RoutineScheduler({
      routines: this.repo,
      authority: this.authority,
      adapter: this.adapter,
      coordinator: options.coordinator,
      backgroundAvailable: options.backgroundAvailable,
      event: (input) => this.event(input),
      pauseForReview: (routine, message) => this.pauseForReview(routine, message),
      clock: this.clock,
      ...(options.tickMs !== undefined ? { tickMs: options.tickMs } : {}),
    })
  }
  ready() {
    this.adapter.recover()
    this.scheduler.start()
  }
  async close() {
    await this.scheduler.close()
  }
  isMutation(method: RoutineMethod) {
    return ROUTINE_MUTATIONS.includes(method)
  }

  event(input: { routineId?: string; occurrenceId?: string; target?: TargetRef; kind: 'routine.changed' | 'occurrence.status' | 'proposal.created' | 'proposal.resolved' | 'attention'; summary: string; causeCode?: Parameters<RoutineRepository['appendEvent']>[0]['causeCode']; detail?: Record<string, unknown> }) {
    return this.repo.appendEvent({ ...input, createdAt: now() })
  }

  // ------------------------------------------------------------------------------ preview

  /**
   * Builds the object a person reviews. It resolves real instants in the routine's own zone,
   * intersects the requested ceiling with what the target may actually do, and reports every
   * reason the routine might not fire — instead of discovering them at three in the morning.
   */
  preview(params: { spec: unknown; routineId?: string; expectedRevision?: number; disambiguation?: 'earlier' | 'later'; proposalId?: string }): RoutinePreview {
    const spec = routineSpecSchema.parse(params.spec)
    const target = this.authority.describe(spec.target)
    const warnings: RoutineWarning[] = [...target.warnings]
    let resolved = spec
    if (spec.schedule.kind === 'once' && params.disambiguation) {
      // The person chose which of the two readings they meant; the Host does not guess.
      const parts = localPartsOf(spec.schedule.timeZone, Date.parse(spec.schedule.atUtc))
      const resolution = resolveLocal(spec.schedule.timeZone, parts)
      if (resolution.kind === 'gap') throw new HostError('ROUTINE_SCHEDULE_INVALID', 'Este horário não existe neste dia por causa do horário de verão.')
      if (resolution.kind === 'ambiguous')
        resolved = {
          ...spec,
          schedule: { ...spec.schedule, atUtc: new Date(params.disambiguation === 'later' ? resolution.instants[1] : resolution.instants[0]).toISOString() },
        }
    }
    if (params.routineId) {
      const current = this.repo.routine(params.routineId)
      if (params.expectedRevision !== undefined && current.revision !== params.expectedRevision)
        throw new HostError('REVISION_CONFLICT', 'A rotina mudou; recarregue antes de editar')
      if (current.status === 'archived') throw new HostError('ROUTINE_ARCHIVED', 'Esta rotina está arquivada')
    } else if (this.repo.count() >= ROUTINE_LIMITS.routinesPerHostMax)
      throw new HostError('ROUTINE_LIMIT', `Este Host já tem ${ROUTINE_LIMITS.routinesPerHostMax} rotinas; arquive uma antes de criar outra.`)

    const nowMs = this.clock.now()
    const enumeration = enumerate(resolved.schedule, nowMs, 3)
    warnings.push(...enumeration.warnings)
    if (!enumeration.occurrences.length)
      warnings.push({ code: 'PAST_INSTANT', message: 'Este horário já passou; escolha um horário futuro para a rotina executar.' })
    if (resolved.schedule.kind === 'once' && isAmbiguousInstant(resolved.schedule.timeZone, Date.parse(resolved.schedule.atUtc)) && !params.disambiguation)
      warnings.push({ code: 'AMBIGUOUS_INSTANT', message: 'Neste dia o relógio volta e este horário acontece duas vezes; escolha qual você quer.' })

    const ceiling = this.authority.effectiveCeiling(resolved.ceiling, target.ceiling)
    if (ceiling.permissionMode !== resolved.ceiling.permissionMode || ceiling.activeMs !== resolved.ceiling.activeMs || ceiling.maxTools !== resolved.ceiling.maxTools)
      warnings.push({ code: 'PERMISSION_NARROWED', message: 'O limite desta rotina foi reduzido para caber no que o alvo já pode fazer.' })
    const state = this.authority.admissionState(resolved.target)
    if (!state.ready && state.causeCode === 'COMPUTER_OFF') warnings.push({ code: 'TARGET_OFFLINE', message: 'O computador deste bot está desligado; a rotina espera até ele ligar.' })
    const resources = this.authority.resourceState({ spec: resolved } as Routine)
    if (!resources.ready) warnings.push({ code: 'RESOURCE_REVOKED', message: resources.message ?? 'Um arquivo escolhido não está disponível.' })

    const previewId = randomUUID()
    const fingerprint = digest({
      spec: resolved,
      targetVersion: target.version,
      ceiling,
      routineId: params.routineId ?? null,
      expectedRevision: params.expectedRevision ?? null,
    })
    const preview: RoutinePreview = {
      previewId,
      fingerprint,
      hostId: this.options.hostId,
      spec: resolved,
      targetName: target.name,
      targetVersion: target.version,
      ...(params.routineId ? { routineId: params.routineId } : {}),
      ...(params.expectedRevision !== undefined ? { expectedRevision: params.expectedRevision } : {}),
      occurrences: enumeration.occurrences.map(({ scheduledForUtc, scheduledForLocal }) => ({ scheduledForUtc, scheduledForLocal })),
      effectiveCeiling: ceiling,
      permissionSummary: target.permissionSummary,
      warnings: warnings.slice(0, 8),
      feasible: enumeration.occurrences.length > 0 && resources.ready,
      expiresAt: new Date(nowMs + ROUTINE_LIMITS.previewTtlMs).toISOString(),
    }
    this.previews.set(previewId, {
      preview,
      spec: resolved,
      targetVersion: target.version,
      ceiling,
      ...(params.proposalId ? { proposalId: params.proposalId } : {}),
      expiresAt: nowMs + ROUTINE_LIMITS.previewTtlMs,
    })
    this.sweepPreviews(nowMs)
    return preview
  }
  private sweepPreviews(nowMs: number) {
    for (const [id, stored] of this.previews) if (stored.expiresAt <= nowMs) this.previews.delete(id)
  }

  // ----------------------------------------------------------------------------- activate

  /**
   * Turns a reviewed preview into an executable routine. It revalidates the fingerprint and
   * the target's identity: a change between review and confirmation means the person did not
   * approve what is in front of them now, so the activation is refused rather than adapted.
   */
  activate(params: { previewId: string; fingerprint: string; idempotencyKey: string }): Routine {
    const existing = this.repo.operationByKey(params.idempotencyKey)
    if (existing) {
      if (existing.fingerprint !== params.fingerprint) throw new HostError('IDEMPOTENCY_CONFLICT', 'Esta chave já foi usada com outros parâmetros')
      return this.repo.routine(existing.operation.routineId!)
    }
    const nowMs = this.clock.now()
    const stored = this.previews.get(params.previewId)
    if (!stored || stored.expiresAt <= nowMs) {
      this.previews.delete(params.previewId)
      throw new HostError('ROUTINE_PREVIEW_EXPIRED', 'Esta confirmação expirou; revise a rotina novamente.')
    }
    if (stored.preview.fingerprint !== params.fingerprint) throw new HostError('ROUTINE_PREVIEW_MISMATCH', 'A rotina mudou depois que você revisou; revise novamente.')
    const target = this.authority.describe(stored.spec.target)
    if (target.version !== stored.targetVersion)
      throw new HostError('ROUTINE_PREVIEW_MISMATCH', 'A conta, o modelo ou os participantes do alvo mudaram; revise a rotina novamente.')
    const [next] = enumerate(stored.spec.schedule, nowMs, 1).occurrences
    if (!next) throw new HostError('ROUTINE_SCHEDULE_INVALID', 'Este horário já passou; escolha um horário futuro.')

    const routine = this.repo.transaction(() => {
      const previous = stored.preview.routineId ? this.repo.routine(stored.preview.routineId) : undefined
      if (previous && stored.preview.expectedRevision !== undefined && previous.revision !== stored.preview.expectedRevision)
        throw new HostError('REVISION_CONFLICT', 'A rotina mudou; recarregue antes de editar')
      if (!previous && this.repo.count() >= ROUTINE_LIMITS.routinesPerHostMax)
        throw new HostError('ROUTINE_LIMIT', `Este Host já tem ${ROUTINE_LIMITS.routinesPerHostMax} rotinas; arquive uma antes de criar outra.`)
      const value: Routine = {
        id: previous?.id ?? randomUUID(),
        hostId: this.options.hostId,
        spec: stored.spec,
        status: 'active',
        fingerprint: stored.preview.fingerprint,
        targetVersion: target.version,
        targetName: target.name,
        nextDueUtc: next.scheduledForUtc,
        // Everything before this instant is already decided; editing never replays the past.
        watermarkUtc: new Date(nowMs).toISOString(),
        ...(previous?.lastOccurrenceId ? { lastOccurrenceId: previous.lastOccurrenceId } : {}),
        ...(previous?.lastOutcome ? { lastOutcome: previous.lastOutcome } : {}),
        createdAt: previous?.createdAt ?? now(),
        updatedAt: now(),
        revision: (previous?.revision ?? -1) + 1,
      }
      // An edit invalidates firings of the previous version that never reached a bot; an
      // execution already running keeps its own approved snapshot.
      if (previous) {
        const pending = this.repo.activeOccurrence(previous.id)
        if (pending && !pending.execution)
          this.repo.saveOccurrence({
            ...pending,
            status: 'skipped',
            causeCode: 'ROUTINE_EDITED',
            finishedAt: now(),
            usedActiveMs: 0,
            usedActions: 0,
            revision: pending.revision + 1,
            updatedAt: now(),
          })
      }
      this.repo.saveRoutine(value)
      const operation: RoutineOperation = {
        id: randomUUID(),
        kind: 'routine.activate',
        routineId: value.id,
        status: 'succeeded',
        detail: { name: value.spec.name, schedule: describeSchedule(value.spec.schedule), nextDueUtc: value.nextDueUtc },
        createdAt: now(),
        updatedAt: now(),
      }
      this.repo.insertOperation(operation, params.idempotencyKey, params.fingerprint, { previewId: params.previewId })
      if (stored.proposalId) this.proposals.markActivated(stored.proposalId, value.id)
      return value
    })
    this.previews.delete(params.previewId)
    this.event({
      routineId: routine.id,
      target: routine.spec.target,
      kind: 'routine.changed',
      summary: `Rotina "${routine.spec.name}" ativada: ${describeSchedule(routine.spec.schedule)}`,
      detail: { status: 'active', nextDueUtc: routine.nextDueUtc },
    })
    this.scheduler.kick()
    return routine
  }

  // ------------------------------------------------------------------------- lifecycle

  /** Pausing stops future firings and drops anything not yet dispatched; it never kills a running execution. */
  pause(params: { routineId: string; expectedRevision: number; idempotencyKey: string; resume: boolean }): Routine {
    const existing = this.repo.operationByKey(params.idempotencyKey)
    if (existing) return this.repo.routine(params.routineId)
    const nowMs = this.clock.now()
    const routine = this.repo.transaction(() => {
      const current = this.repo.routine(params.routineId)
      if (current.revision !== params.expectedRevision) throw new HostError('REVISION_CONFLICT', 'A rotina mudou; recarregue antes de alterar')
      if (current.status === 'archived') throw new HostError('ROUTINE_ARCHIVED', 'Esta rotina está arquivada')
      const [next] = params.resume ? enumerate(current.spec.schedule, nowMs, 1).occurrences : []
      const updated: Routine = {
        ...current,
        status: params.resume ? 'active' : 'paused',
        // Resuming looks strictly forward: the pause is not a backlog to catch up on.
        nextDueUtc: params.resume ? next?.scheduledForUtc : undefined,
        watermarkUtc: params.resume ? new Date(nowMs).toISOString() : current.watermarkUtc,
        revision: current.revision + 1,
        updatedAt: now(),
      }
      this.repo.saveRoutine(updated)
      if (!params.resume) {
        const pending = this.repo.activeOccurrence(current.id)
        if (pending && !pending.execution)
          this.repo.saveOccurrence({
            ...pending,
            status: 'skipped',
            causeCode: 'ROUTINE_PAUSED',
            finishedAt: now(),
            usedActiveMs: 0,
            usedActions: 0,
            revision: pending.revision + 1,
            updatedAt: now(),
          })
      }
      this.repo.insertOperation(
        { id: randomUUID(), kind: params.resume ? 'routine.resume' : 'routine.pause', routineId: current.id, status: 'succeeded', createdAt: now(), updatedAt: now() },
        params.idempotencyKey,
        digest(params),
        params
      )
      return updated
    })
    this.event({
      routineId: routine.id,
      target: routine.spec.target,
      kind: 'routine.changed',
      summary: params.resume ? `Rotina "${routine.spec.name}" retomada` : `Rotina "${routine.spec.name}" pausada`,
      detail: { status: routine.status, nextDueUtc: routine.nextDueUtc },
    })
    return routine
  }

  /** Archiving preserves the history; it never deletes what already happened. */
  archive(params: { routineId: string; expectedRevision: number; idempotencyKey: string }): Routine {
    const existing = this.repo.operationByKey(params.idempotencyKey)
    if (existing) return this.repo.routine(params.routineId)
    const routine = this.repo.transaction(() => {
      const current = this.repo.routine(params.routineId)
      if (current.revision !== params.expectedRevision) throw new HostError('REVISION_CONFLICT', 'A rotina mudou; recarregue antes de arquivar')
      const pending = this.repo.activeOccurrence(current.id)
      if (pending?.execution) throw new HostError('ROUTINE_OCCURRENCE_ACTIVE', 'Pare a execução em andamento antes de arquivar esta rotina.')
      if (pending)
        this.repo.saveOccurrence({
          ...pending,
          status: 'skipped',
          causeCode: 'ROUTINE_PAUSED',
          finishedAt: now(),
          usedActiveMs: 0,
          usedActions: 0,
          revision: pending.revision + 1,
          updatedAt: now(),
        })
      const updated: Routine = { ...current, status: 'archived', nextDueUtc: undefined, revision: current.revision + 1, updatedAt: now() }
      this.repo.saveRoutine(updated)
      this.repo.insertOperation(
        { id: randomUUID(), kind: 'routine.archive', routineId: current.id, status: 'succeeded', createdAt: now(), updatedAt: now() },
        params.idempotencyKey,
        digest(params),
        params
      )
      return updated
    })
    this.event({ routineId: routine.id, target: routine.spec.target, kind: 'routine.changed', summary: `Rotina "${routine.spec.name}" arquivada`, detail: { status: 'archived' } })
    return routine
  }

  /** A person asked for one extra firing. It uses the same grant, ceiling and allowance. */
  runNow(params: { routineId: string; expectedRevision: number; idempotencyKey: string }): RoutineOccurrence {
    const key = `manual:${params.idempotencyKey}`
    const existing = this.repo.occurrenceByManualKey(key)
    if (existing) return existing
    const nowMs = this.clock.now()
    const occurrence = this.repo.transaction(() => {
      const routine = this.repo.routine(params.routineId)
      if (routine.revision !== params.expectedRevision) throw new HostError('REVISION_CONFLICT', 'A rotina mudou; recarregue antes de executar')
      if (routine.status === 'archived') throw new HostError('ROUTINE_ARCHIVED', 'Esta rotina está arquivada')
      const target = this.authority.describe(routine.spec.target)
      const ceiling = this.authority.effectiveCeiling(routine.spec.ceiling, target.ceiling)
      const budget = this.authority.canAdmit(routine, ceiling, nowMs)
      if (!budget.ready) throw new HostError('ROUTINE_BUDGET_EXHAUSTED', budget.message ?? 'Esta rotina já atingiu o limite de 24 horas.')
      const value: RoutineOccurrence = {
        id: randomUUID(),
        routineId: routine.id,
        target: routine.spec.target,
        origin: 'manual',
        scheduledForUtc: new Date(nowMs).toISOString(),
        scheduledForLocal: localReading(routine.spec.schedule.timeZone, nowMs),
        timeZone: routine.spec.schedule.timeZone,
        deadlineAt: new Date(nowMs + routine.spec.queueDeadlineMs).toISOString(),
        status: 'pending',
        usedActiveMs: 0,
        usedActions: 0,
        createdAt: now(),
        updatedAt: now(),
        revision: 0,
      }
      this.repo.saveOccurrence(value, key)
      // "Run now" does not move the calendar: the next scheduled firing is untouched.
      this.repo.insertOperation(
        { id: randomUUID(), kind: 'routine.runNow', routineId: routine.id, occurrenceId: value.id, status: 'succeeded', createdAt: now(), updatedAt: now() },
        params.idempotencyKey,
        digest(params),
        params
      )
      return value
    })
    this.event({ routineId: occurrence.routineId, occurrenceId: occurrence.id, kind: 'occurrence.status', summary: 'Execução solicitada por você', detail: { status: 'pending', origin: 'manual' } })
    this.scheduler.kick()
    return occurrence
  }

  /** A target whose approved identity changed stops firing and asks for a new review. */
  private pauseForReview(routine: Routine, message: string) {
    const updated = this.repo.transaction(() => {
      const current = this.repo.routine(routine.id)
      if (current.status !== 'active') return current
      const value: Routine = { ...current, status: 'paused', nextDueUtc: undefined, revision: current.revision + 1, updatedAt: now() }
      this.repo.saveRoutine(value)
      return value
    })
    this.event({ routineId: routine.id, target: routine.spec.target, kind: 'attention', summary: message, causeCode: 'TARGET_CHANGED', detail: { status: updated.status } })
  }

  private details(routineId: string) {
    const routine = this.repo.routine(routineId)
    return { routine, active: this.repo.activeOccurrence(routineId) ?? null, recent: this.repo.occurrences(routineId, undefined, 10) }
  }

  async handle<M extends RoutineMethod>(request: Extract<RoutineRequest, { method: M }>): Promise<RoutineResult<M>> {
    const result = await this.dispatch(request as RoutineRequest)
    return routineResultSchemas[request.method].parse(result) as RoutineResult<M>
  }

  private async dispatch(request: RoutineRequest): Promise<unknown> {
    const p = request.params as any
    switch (request.method) {
      case 'routine.list':
        return this.repo.routines(p.target, p.includeArchived)
      case 'routine.inspect':
        return this.details(p.routineId)
      case 'routine.preview':
        return this.preview(p)
      case 'routine.activate':
        return this.details(this.activate(p).id)
      case 'routine.pause':
        return this.details(this.pause(p).id)
      case 'routine.archive':
        return this.details(this.archive(p).id)
      case 'routine.runNow':
        return this.runNow(p)
      case 'routine.proposals.list':
        return this.proposals.list(p.target)
      case 'routine.proposals.dismiss':
        return this.proposals.dismiss(p.proposalId, p.expectedRevision)
      case 'routine.occurrences.list': {
        const routine = this.repo.routine(p.routineId)
        const page = this.repo.occurrences(p.routineId, p.before, p.limit + 1)
        return { routine, occurrences: page.slice(0, p.limit), hasMore: page.length > p.limit }
      }
      case 'routine.occurrence.inspect':
        return this.repo.occurrence(p.occurrenceId)
      case 'routine.occurrence.cancel': {
        const occurrence = this.repo.occurrence(p.occurrenceId)
        if (ROUTINE_OCCURRENCE_TERMINAL.has(occurrence.status)) return occurrence
        if (occurrence.revision !== p.expectedRevision) throw new HostError('REVISION_CONFLICT', 'A execução mudou; verifique o estado atual antes de parar')
        const existing = this.repo.operationByKey(p.idempotencyKey)
        if (!existing)
          this.repo.transaction(() =>
            this.repo.insertOperation(
              { id: randomUUID(), kind: 'routine.occurrence.cancel', routineId: occurrence.routineId, occurrenceId: occurrence.id, status: 'succeeded', createdAt: now(), updatedAt: now() },
              p.idempotencyKey,
              digest(p),
              p
            )
          )
        return this.adapter.cancel(occurrence.id, 'Execução interrompida por você')
      }
      case 'routine.events.list': {
        const page = this.repo.events(p.after, p.limit, p.routineId)
        return { events: page.events, cursor: page.events.at(-1)?.seq ?? p.after, hasMore: page.hasMore }
      }
      case 'routine.operation.lookup':
        return this.repo.operationByKey(p.idempotencyKey)?.operation ?? null
    }
  }
}
