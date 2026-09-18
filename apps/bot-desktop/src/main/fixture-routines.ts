import { createHash, randomUUID } from 'node:crypto'
import {
  ROUTINE_LIMITS,
  routineSpecSchema,
  type Routine,
  type RoutineEvent,
  type RoutineOccurrence,
  type RoutineOperation,
  type RoutinePreview,
  type RoutineProposal,
  type RoutineSpec,
  type TargetRef,
} from '@maestrly/host-protocol'
import { HostRequestError } from './host-client'

const now = () => new Date().toISOString()
const fail = (code: string, message: string) => new HostRequestError(message, code)
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

/**
 * Development-only in-memory routines domain for interface work. It mirrors exactly the rules
 * the interface depends on — a preview that expires, an activation bound to the fingerprint
 * that was shown, a proposal that is inert until confirmed, pause that does not catch up — and
 * nothing else. It is never hardware evidence, and the packaged runtime has no fixtures at all.
 */
export class FixtureRoutines {
  routines = new Map<string, Routine>()
  occurrences = new Map<string, RoutineOccurrence[]>()
  proposals = new Map<string, RoutineProposal>()
  operations = new Map<string, RoutineOperation>()
  private previews = new Map<string, { preview: RoutinePreview; expiresAt: number }>()
  private keys = new Map<string, RoutineOperation>()
  events: RoutineEvent[] = []
  private sequence = 0
  constructor(
    private readonly hostId: string,
    private readonly targetName: (target: TargetRef) => string
  ) {}

  /** Seeds one suggestion, the way a bot would leave one during a conversation. */
  suggest(target: TargetRef, input: { name: string; request: string; schedule: RoutineSpec['schedule'] }) {
    const proposal: RoutineProposal = {
      id: randomUUID(),
      target,
      proposedByBotId: target.id,
      turnId: randomUUID(),
      name: input.name,
      request: input.request,
      schedule: input.schedule,
      status: 'pending',
      createdAt: now(),
      expiresAt: new Date(Date.now() + ROUTINE_LIMITS.proposalTtlMs).toISOString(),
      revision: 0,
    }
    this.proposals.set(proposal.id, proposal)
    return proposal
  }

  private next(_spec: RoutineSpec, count: number) {
    const start = Date.now() + 60_000
    return Array.from({ length: count }, (_, index) => {
      const at = new Date(start + index * 24 * 60 * 60_000)
      return { scheduledForUtc: at.toISOString(), scheduledForLocal: at.toISOString().slice(0, 16).replace('T', ' ') }
    })
  }
  private details(routineId: string) {
    const routine = this.routines.get(routineId)
    if (!routine) throw fail('ROUTINE_NOT_FOUND', 'Esta rotina não existe neste Host')
    const list = this.occurrences.get(routineId) ?? []
    return {
      routine,
      active: list.find((entry) => ['pending', 'running', 'waiting_user'].includes(entry.status)) ?? null,
      recent: list.slice(-10).reverse(),
    }
  }

  request(method: string, p: Record<string, unknown>): unknown {
    switch (method) {
      case 'routine.list': {
        const target = p.target as TargetRef | undefined
        return [...this.routines.values()].filter(
          (routine) =>
            (!target || (routine.spec.target.kind === target.kind && routine.spec.target.id === target.id)) &&
            (p.includeArchived === true || routine.status !== 'archived')
        )
      }
      case 'routine.inspect':
        return this.details(String(p.routineId))
      case 'routine.preview': {
        const spec = routineSpecSchema.parse(p.spec)
        const preview: RoutinePreview = {
          previewId: randomUUID(),
          fingerprint: digest({ spec, routineId: p.routineId ?? null }),
          hostId: this.hostId,
          spec,
          targetName: this.targetName(spec.target),
          targetVersion: digest(spec.target),
          ...(p.routineId ? { routineId: String(p.routineId) } : {}),
          ...(p.expectedRevision !== undefined ? { expectedRevision: Number(p.expectedRevision) } : {}),
          occurrences: this.next(spec, 3),
          effectiveCeiling: spec.ceiling,
          permissionSummary: ['Pede permissão antes de ações sensíveis'],
          warnings: [],
          feasible: true,
          expiresAt: new Date(Date.now() + ROUTINE_LIMITS.previewTtlMs).toISOString(),
        }
        this.previews.set(preview.previewId, { preview, expiresAt: Date.now() + ROUTINE_LIMITS.previewTtlMs })
        if (typeof p.proposalId === 'string') this.previews.get(preview.previewId)!.preview.routineId ??= undefined
        return preview
      }
      case 'routine.activate': {
        const existing = this.keys.get(String(p.idempotencyKey))
        if (existing?.routineId) return this.details(existing.routineId)
        const stored = this.previews.get(String(p.previewId))
        if (!stored || stored.expiresAt <= Date.now())
          throw fail('ROUTINE_PREVIEW_EXPIRED', 'Esta confirmação expirou; revise a rotina novamente.')
        if (stored.preview.fingerprint !== p.fingerprint)
          throw fail('ROUTINE_PREVIEW_MISMATCH', 'A rotina mudou depois que você revisou; revise novamente.')
        const previous = stored.preview.routineId ? this.routines.get(stored.preview.routineId) : undefined
        const routine: Routine = {
          id: previous?.id ?? randomUUID(),
          hostId: this.hostId,
          spec: stored.preview.spec,
          status: 'active',
          fingerprint: stored.preview.fingerprint,
          targetVersion: stored.preview.targetVersion,
          targetName: stored.preview.targetName,
          nextDueUtc: stored.preview.occurrences[0]?.scheduledForUtc,
          watermarkUtc: now(),
          createdAt: previous?.createdAt ?? now(),
          updatedAt: now(),
          revision: (previous?.revision ?? -1) + 1,
        }
        this.routines.set(routine.id, routine)
        this.previews.delete(stored.preview.previewId)
        for (const proposal of this.proposals.values())
          if (proposal.status === 'pending' && proposal.name === routine.spec.name)
            this.proposals.set(proposal.id, {
              ...proposal,
              status: 'activated',
              routineId: routine.id,
              revision: proposal.revision + 1,
            })
        const operation: RoutineOperation = {
          id: randomUUID(),
          kind: 'routine.activate',
          routineId: routine.id,
          status: 'succeeded',
          createdAt: now(),
          updatedAt: now(),
        }
        this.operations.set(operation.id, operation)
        this.keys.set(String(p.idempotencyKey), operation)
        this.events.push({
          seq: ++this.sequence,
          routineId: routine.id,
          kind: 'routine.changed',
          summary: `Rotina "${routine.spec.name}" ativada`,
          createdAt: now(),
        })
        return this.details(routine.id)
      }
      case 'routine.pause': {
        const routine = this.routines.get(String(p.routineId))
        if (!routine) throw fail('ROUTINE_NOT_FOUND', 'Esta rotina não existe')
        if (routine.revision !== p.expectedRevision)
          throw fail('REVISION_CONFLICT', 'A rotina mudou; recarregue antes de alterar')
        this.routines.set(routine.id, {
          ...routine,
          status: p.resume === true ? 'active' : 'paused',
          nextDueUtc: p.resume === true ? this.next(routine.spec, 1)[0]?.scheduledForUtc : undefined,
          revision: routine.revision + 1,
          updatedAt: now(),
        })
        return this.details(routine.id)
      }
      case 'routine.archive': {
        const routine = this.routines.get(String(p.routineId))
        if (!routine) throw fail('ROUTINE_NOT_FOUND', 'Esta rotina não existe')
        this.routines.set(routine.id, {
          ...routine,
          status: 'archived',
          nextDueUtc: undefined,
          revision: routine.revision + 1,
          updatedAt: now(),
        })
        return this.details(routine.id)
      }
      case 'routine.runNow': {
        const routine = this.routines.get(String(p.routineId))
        if (!routine) throw fail('ROUTINE_NOT_FOUND', 'Esta rotina não existe')
        const list = this.occurrences.get(routine.id) ?? []
        const occurrence: RoutineOccurrence = {
          id: randomUUID(),
          routineId: routine.id,
          target: routine.spec.target,
          origin: 'manual',
          scheduledForUtc: now(),
          scheduledForLocal: now().slice(0, 16).replace('T', ' '),
          timeZone: routine.spec.schedule.timeZone,
          deadlineAt: new Date(Date.now() + routine.spec.queueDeadlineMs).toISOString(),
          status: 'succeeded',
          summary: 'Resumo preparado (fixture).',
          usedActiveMs: 42_000,
          usedActions: 3,
          finishedAt: now(),
          createdAt: now(),
          updatedAt: now(),
          revision: 1,
        }
        this.occurrences.set(routine.id, [...list, occurrence])
        return occurrence
      }
      case 'routine.proposals.list': {
        const target = p.target as TargetRef | undefined
        return [...this.proposals.values()].filter(
          (proposal) =>
            proposal.status === 'pending' &&
            (!target || (proposal.target.kind === target.kind && proposal.target.id === target.id))
        )
      }
      case 'routine.proposals.dismiss': {
        const proposal = this.proposals.get(String(p.proposalId))
        if (!proposal) throw fail('ROUTINE_PROPOSAL_INVALID', 'Esta sugestão não existe mais')
        const updated: RoutineProposal = { ...proposal, status: 'dismissed', revision: proposal.revision + 1 }
        this.proposals.set(proposal.id, updated)
        return updated
      }
      case 'routine.occurrences.list': {
        const routine = this.routines.get(String(p.routineId))
        if (!routine) throw fail('ROUTINE_NOT_FOUND', 'Esta rotina não existe')
        const list = [...(this.occurrences.get(routine.id) ?? [])].reverse()
        return { routine, occurrences: list.slice(0, Number(p.limit ?? 50)), hasMore: false }
      }
      case 'routine.occurrence.inspect': {
        for (const list of this.occurrences.values()) {
          const found = list.find((entry) => entry.id === p.occurrenceId)
          if (found) return found
        }
        throw fail('ROUTINE_NOT_FOUND', 'Esta execução não existe')
      }
      case 'routine.occurrence.cancel': {
        for (const [routineId, list] of this.occurrences)
          for (const entry of list)
            if (entry.id === p.occurrenceId) {
              const cancelled: RoutineOccurrence = {
                ...entry,
                status: 'cancelled',
                causeCode: 'STOPPED_BY_USER',
                finishedAt: now(),
                revision: entry.revision + 1,
                updatedAt: now(),
              }
              this.occurrences.set(
                routineId,
                list.map((candidate) => (candidate.id === entry.id ? cancelled : candidate))
              )
              return cancelled
            }
        throw fail('ROUTINE_NOT_FOUND', 'Esta execução não existe')
      }
      case 'routine.events.list': {
        const after = Number(p.after ?? 0)
        const events = this.events
          .filter((event) => event.seq > after && (!p.routineId || event.routineId === p.routineId))
          .slice(0, Number(p.limit ?? 100))
        return { events, cursor: events.at(-1)?.seq ?? after, hasMore: false }
      }
      case 'routine.operation.lookup':
        return this.keys.get(String(p.idempotencyKey)) ?? null
      default:
        throw fail('INVALID_REQUEST', 'Fixture: unknown routine method')
    }
  }
}
