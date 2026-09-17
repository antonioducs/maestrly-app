import type { HostToGuestRequest, TurnSnapshot } from '@maestrly/host-protocol'
import type { Journal } from '../control/journal.js'
import type { FileService } from '../files/service.js'
import type {
  ApprovalRequest,
  ProviderAdapter,
  ProviderEvent,
  QuestionRequest,
  TurnHooks,
  TurnOutcome,
} from '../providers/provider.js'
import { LeaseTracker, ProcessRegistry } from './leases.js'
export function runtimeError(code: string, message: string) {
  return Object.assign(new Error(message), { code })
}
type Interaction = Extract<HostToGuestRequest, { method: 'interaction.resolve' }>['params']
interface Active {
  snapshot: TurnSnapshot
  controller: AbortController
  done: Promise<void>
  cancellation?: { code: string; message: string }
  stopping?: Promise<void>
  actions: Map<
    string,
    { kind: 'approval' | 'question'; resolve: (value: string) => void; reject: (error: Error) => void }
  >
  timer?: NodeJS.Timeout
  /** Execution time still available to this turn, excluding any wait for a person. */
  budgetMs: number
  /** When the running budget started being spent, or undefined while it is held. */
  spendingSince?: number
  deltaTimer?: NodeJS.Timeout
  delta: string
  bytes: number
  tools: number
  finalMessage: boolean
  running: boolean
  produced: Set<string>
}
export class TurnService {
  private active?: Active
  readonly leases = new LeaseTracker()
  readonly processes = new ProcessRegistry()
  constructor(
    private journal: Journal,
    private provider: ProviderAdapter,
    private files: FileService
  ) {}
  toolContext() {
    const active = this.active
    if (!active || active.controller.signal.aborted) throw runtimeError('TURN_UNKNOWN', 'No active turn')
    return {
      snapshot: active.snapshot,
      signal: active.controller.signal,
      processes: this.processes,
      hooks: {
        emit: (event: ProviderEvent) => this.emit(active, event),
        requestApproval: (req: ApprovalRequest) =>
          this.interaction(active, req, 'approval') as Promise<'approve' | 'deny'>,
        askQuestion: (req: QuestionRequest) => this.interaction(active, req, 'question'),
      },
    }
  }
  setProvider(provider: ProviderAdapter) {
    this.provider = provider
  }
  start(snapshot: TurnSnapshot) {
    if (this.journal.reconcile(snapshot.turnId, snapshot.generation).known) return { accepted: true, duplicate: true }
    if (this.active) throw runtimeError('TURN_BUSY', 'A turn is already active')
    this.journal.accept(snapshot)
    const active: Active = {
      snapshot,
      controller: new AbortController(),
      done: Promise.resolve(),
      actions: new Map(),
      delta: '',
      bytes: 0,
      tools: 0,
      finalMessage: false,
      running: false,
      produced: new Set(),
      budgetMs: snapshot.limits.activeMs,
    }
    this.active = active
    this.leases.renew(snapshot.turnId, snapshot.leaseMs, () => {
      void this.cancel(snapshot.turnId, snapshot.generation, { code: 'LEASE_EXPIRED', message: 'Host lease expired' })
    })
    this.spend(active)
    active.done = this.run(active)
    return { accepted: true }
  }
  /**
   * Starts (or resumes) spending the execution budget. The limit covers the time the agent
   * actually works; time a person spends deciding is held separately by the Host, which allows
   * far longer. Charging a human's thinking time to the agent would kill a task for being
   * answered slowly — and with `ask` as the default permission mode, that is the common case.
   */
  private spend(active: Active) {
    clearTimeout(active.timer)
    active.spendingSince = Date.now()
    const { turnId, generation } = active.snapshot
    active.timer = setTimeout(
      () => void this.cancel(turnId, generation, { code: 'TIME_LIMIT', message: 'Active time limit exceeded' }),
      Math.max(0, Math.min(active.budgetMs, 2_147_483_647))
    )
  }
  /** Stops the clock and keeps what is left, so waiting costs the task nothing. */
  private hold(active: Active) {
    if (active.spendingSince === undefined) return
    active.budgetMs = Math.max(0, active.budgetMs - (Date.now() - active.spendingSince))
    active.spendingSince = undefined
    clearTimeout(active.timer)
    active.timer = undefined
  }
  reconcile(turnId: string, generation: number) {
    return this.journal.reconcile(turnId, generation)
  }
  lease(turnId: string, generation: number, leaseMs: number) {
    const active = this.match(turnId, generation)
    if (!active || active.controller.signal.aborted) throw runtimeError('TURN_UNKNOWN', 'Turn is not active')
    this.leases.renew(turnId, leaseMs, () => {
      void this.cancel(turnId, generation, { code: 'LEASE_EXPIRED', message: 'Host lease expired' })
    })
    return { renewed: true }
  }
  private match(turnId: string, generation: number) {
    return this.active?.snapshot.turnId === turnId && this.active.snapshot.generation === generation
      ? this.active
      : undefined
  }
  async cancel(turnId: string, generation: number, error?: { code: string; message: string }) {
    const active = this.match(turnId, generation)
    if (!active) return { cancelled: false }
    if (!active.stopping) {
      active.cancellation = error
      active.controller.abort()
      for (const action of active.actions.values()) action.reject(new Error('Turn cancelled'))
      active.actions.clear()
      active.stopping = Promise.all([
        this.provider.cancelTurn(turnId).catch(async () => {
          // If interruption failed, close the provider process tree before acknowledging cancellation.
          await this.provider.dispose()
        }),
        this.processes.stop(turnId),
      ]).then(() => {})
    }
    await active.stopping
    await active.done
    return { cancelled: true }
  }
  resolve(input: Interaction) {
    const active = this.match(input.turnId, input.generation)
    const action = active?.actions.get(input.actionId)
    if (!active || !action || active.controller.signal.aborted)
      throw runtimeError('INTERACTION_UNKNOWN', 'Unknown or stale interaction')
    if ((action.kind === 'question') !== (input.decision === 'answer'))
      throw runtimeError('INVALID_REQUEST', 'Decision does not match interaction')
    this.journal.append('action.result', {
      turnId: input.turnId,
      generation: input.generation,
      actionId: input.actionId,
      decision: input.decision,
    })
    active.actions.delete(input.actionId)
    // The person answered: the agent is working again, so the clock starts again as well.
    if (!active.actions.size) this.spend(active)
    action.resolve(input.decision === 'answer' ? (input.answer ?? '') : input.decision)
    this.emit(active, { kind: 'turn.status', summary: 'O bot voltou a trabalhar', detail: { status: 'running' } })
    return { applied: true }
  }
  private interaction(
    active: Active,
    req: ApprovalRequest | QuestionRequest,
    kind: 'approval' | 'question'
  ): Promise<string> {
    if (active.controller.signal.aborted) return Promise.reject(new Error('Turn cancelled'))
    if (active.actions.has(req.actionId)) return Promise.reject(new Error('Duplicate action'))
    const { turnId, generation } = active.snapshot
    this.journal.append('action.intent', { turnId, generation, actionId: req.actionId, kind })
    return new Promise((resolve, reject) => {
      active.actions.set(req.actionId, { kind, resolve, reject })
      // From here the turn waits for a person, not for the model: hold the execution budget.
      this.hold(active)
      this.emit(active, {
        kind: 'turn.status',
        summary: req.title,
        detail: { status: kind === 'approval' ? 'waiting_approval' : 'waiting_input' },
      })
      this.emit(active, {
        kind: kind === 'approval' ? 'approval.requested' : 'question.asked',
        summary: req.title,
        detail: { ...req },
      })
    })
  }
  private flush(active: Active) {
    clearTimeout(active.deltaTimer)
    active.deltaTimer = undefined
    if (!active.delta) return
    const text = active.delta
    active.delta = ''
    this.publish(active, { kind: 'assistant.delta', summary: 'Escrevendo…', detail: { text } })
  }
  private emit(active: Active, event: ProviderEvent) {
    if (active !== this.active || active.controller.signal.aborted) return
    if (event.kind === 'assistant.delta') {
      const text = typeof event.detail?.text === 'string' ? event.detail.text : ''
      for (const character of text) {
        if (Buffer.byteLength(active.delta + character) > 4096) this.flush(active)
        active.delta += character
      }
      if (Buffer.byteLength(active.delta) >= 4096) this.flush(active)
      if (active.delta && !active.deltaTimer) active.deltaTimer = setTimeout(() => this.flush(active), 500)
      return
    }
    if (event.kind === 'assistant.message') {
      this.flush(active)
      active.finalMessage = true
    }
    if (event.kind === 'tool.started' && ++active.tools > active.snapshot.limits.maxTools) {
      void this.cancel(active.snapshot.turnId, active.snapshot.generation, {
        code: 'TOOL_LIMIT',
        message: 'Tool call limit exceeded',
      })
      return
    }
    if (event.kind === 'turn.status' && event.detail?.status === 'running') {
      if (
        active.running &&
        this.journal.reconcile(active.snapshot.turnId, active.snapshot.generation).status === 'running'
      )
        return
      active.running = true
    }
    this.publish(active, event)
  }
  private publish(active: Active, event: ProviderEvent) {
    if (event.kind === 'diagnostic' && Buffer.byteLength(JSON.stringify(event.detail ?? {})) > 4096)
      event = { ...event, detail: { message: 'Provider diagnostic exceeded size limit' } }
    active.bytes += Buffer.byteLength(
      JSON.stringify({
        ...event,
        type: 'event',
        runtimeEventId: '00000000-0000-4000-8000-000000000000',
        createdAt: new Date().toISOString(),
        turnId: active.snapshot.turnId,
        generation: active.snapshot.generation,
      })
    )
    if (active.bytes > active.snapshot.limits.maxLogBytes && ['assistant.delta', 'diagnostic'].includes(event.kind))
      return
    const { turnId, generation, conversationId } = active.snapshot
    if (event.kind === 'file.produced') {
      const path = String(event.detail?.path ?? '')
      if (active.produced.has(path) || active.produced.size >= 200) return
      active.produced.add(path)
    }
    this.journal.event({ ...event, turnId, generation })
    if (event.kind === 'turn.status') {
      this.journal.status(turnId, generation, event.detail ?? {})
      if (typeof event.detail?.providerThreadId === 'string')
        this.journal.saveThread(conversationId, event.detail.providerThreadId)
    }
  }
  private async run(active: Active) {
    let outcome: TurnOutcome
    let before = new Map<string, string>()
    try {
      before = await this.files.snapshot()
      const hooks: TurnHooks = {
        emit: (event) => this.emit(active, event),
        requestApproval: (req) => this.interaction(active, req, 'approval') as Promise<'approve' | 'deny'>,
        askQuestion: (req) => this.interaction(active, req, 'question'),
      }
      active.controller.signal.throwIfAborted()
      outcome = await this.provider.startTurn(
        {
          ...active.snapshot,
          providerThreadId: active.snapshot.providerThreadId ?? this.journal.thread(active.snapshot.conversationId),
        },
        hooks,
        active.controller.signal
      )
    } catch {
      outcome = {
        status: active.controller.signal.aborted ? 'cancelled' : 'failed',
        error: active.controller.signal.aborted
          ? undefined
          : { code: 'PROVIDER_ERROR', message: 'Provider failed to complete the turn' },
      }
    }
    try {
      if (active.stopping) await active.stopping
      if (active.controller.signal.aborted)
        outcome = { ...outcome, status: active.cancellation ? 'interrupted' : 'cancelled', error: active.cancellation }
      this.flush(active)
      if (outcome.finalMessage && !active.finalMessage)
        this.publish(active, {
          kind: 'assistant.message',
          summary: 'O bot respondeu',
          detail: { content: outcome.finalMessage },
        })
      try {
        for (const file of await this.files.produced(before))
          this.publish(active, {
            kind: 'file.produced',
            summary: `Arquivo produzido: ${file.name}`.slice(0, 400),
            detail: file,
          })
      } catch {
        this.publish(active, {
          kind: 'diagnostic',
          summary: 'Não foi possível inspecionar todos os arquivos',
          detail: { code: 'FILE_SCAN_FAILED' },
        })
      }
      const { finalMessage: _message, usage, ...detail } = outcome
      // A Host older than the transcript work validates `usage` strictly: the three fields it
      // knows stay there, the richer ones travel beside it and are ignored by a Host that never
      // asked for them.
      const { inputTokens, outputTokens, toolCalls, ...usageDetail } = usage ?? {}
      const legacy = Object.fromEntries(Object.entries({ inputTokens, outputTokens, toolCalls }).filter(([, value]) => value !== undefined))
      this.publish(active, {
        kind: 'turn.status',
        summary: 'Tarefa encerrada',
        detail: { ...detail, ...(usage ? { usage: legacy } : {}), ...(Object.keys(usageDetail).length ? { usageDetail } : {}) },
      })
    } finally {
      active.controller.abort()
      await this.processes.stop(active.snapshot.turnId)
      clearTimeout(active.timer)
      clearTimeout(active.deltaTimer)
      this.leases.clear(active.snapshot.turnId)
      for (const action of active.actions.values()) action.reject(new Error('Turn finished'))
      if (this.active === active) this.active = undefined
    }
  }
  get busy() { return !!this.active }
  async idle() {
    await this.active?.done
  }
  async close() {
    if (this.active) await this.cancel(this.active.snapshot.turnId, this.active.snapshot.generation)
    this.leases.close()
  }
}
