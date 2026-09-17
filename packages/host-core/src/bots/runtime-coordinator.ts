import type { AccountDelegation } from '../accounts/delegation.js'
import { randomUUID } from 'node:crypto'
import {
  ROUTINE_CAPABILITY,
  TURN_TERMINAL,
  turnStatusSchema,
  usageSchema,
  type Bot,
  type BotTurn,
  type CollaborationRequest,
  type GuestEvent,
  type RoutineRuntimeRequest,
  type Vm,
} from '@maestrly/host-protocol'
import { HostError } from '../errors.js'
import type { GuestConnector, GuestSession } from '../guest/session.js'
import { BotEvents } from './events.js'
import { BotInteractions } from './interactions.js'
import { TURN_LIMITS, workedMs } from './context.js'
import { type BotRepository, now } from './repository.js'

export interface CoordinatorHost {
  vm(id: string): Vm
  hostGeneration: number
}
/**
 * Owns guest sessions per bot, drains the durable outbox, persists events before ACK,
 * renews leases while allowed, and reconciles conservatively after any loss.
 */
export class RuntimeCoordinator {
  private sessions = new Map<string, GuestSession>()
  private connecting = new Map<string, Promise<GuestSession>>()
  private draining = new Set<string>()
  private assistantBuffers = new Map<string, string>()
  private timer?: ReturnType<typeof setInterval>
  private closed = false
  private accounts?: AccountDelegation
  setAccounts(accounts: AccountDelegation) { this.accounts = accounts }
  private extensions?: { prepare(bot: Bot, session: GuestSession, turnId: string): Promise<void> }
  /** Installed once the chat domains exist; a bot without extensions never sees a request. */
  setExtensions(delivery: { prepare(bot: Bot, session: GuestSession, turnId: string): Promise<void> }) { this.extensions = delivery }
  private collaboration?: (botId: string, request: CollaborationRequest) => Promise<Record<string, unknown>>
  /** Installed by the teams domain; without it the collaboration lane simply does not exist. */
  setCollaboration(handler: (botId: string, request: CollaborationRequest) => Promise<Record<string, unknown>>) {
    this.collaboration = handler
  }
  private routineLane?: (botId: string, request: RoutineRuntimeRequest) => Promise<Record<string, unknown>>
  /** Installed by the routines domain; without it a guest simply has no proposal tools. */
  setRoutineLane(handler: (botId: string, request: RoutineRuntimeRequest) => Promise<Record<string, unknown>>) {
    this.routineLane = handler
  }
  private takeovers = new Set<string>()
  private holdCheck?: (botId: string) => boolean
  private turnListener?: (turnId: string) => void
  private dispatchGuard?: (turnId: string) => { code: string; message: string } | undefined
  /** Observes every turn transition so another domain can mirror it onto its own records. */
  onTurnChanged(listener: (turnId: string) => void) {
    this.turnListener = listener
  }
  /**
   * Last authorization check before a queued turn is written to the guest. An authorization
   * that was reduced after admission blocks the outbox item instead of letting it run.
   */
  setDispatchGuard(guard: (turnId: string) => { code: string; message: string } | undefined) {
    this.dispatchGuard = guard
  }
  private notify(turnId: string) {
    try {
      this.turnListener?.(turnId)
    } catch {
      /* a listener must never break the turn engine */
    }
  }
  /** Public entry point for domains that change a turn outside this coordinator. */
  turnChanged(turnId: string) {
    this.notify(turnId)
  }
  /** While a person holds the desktop, nothing connects, dispatches or reconciles bot work. */
  setDesktopHold(check: (botId: string) => boolean) { this.holdCheck = check }
  held(botId: string) { return this.holdCheck?.(botId) === true }
  /** The next terminal cancel/interrupt of this turn comes from a human takeover. */
  markTakeover(turnId: string) { this.takeovers.add(turnId) }
  liveSession(botId: string) {
    const session = this.sessions.get(botId)
    return session?.alive ? session : undefined
  }
  /** After automation is proven stopped: an unfinished turn is interrupted, a finished one keeps its real result. */
  interruptForHandoff(turnId: string): BotTurn {
    const turn = this.repo.turn(turnId)
    if (!TURN_TERMINAL.has(turn.status)) this.finish(turn, 'interrupted', { code: 'HUMAN_TAKEOVER', message: 'Tarefa pausada para você usar a tela. Ela pode continuar quando você devolver o controle.' })
    this.takeovers.delete(turnId)
    return this.repo.turn(turnId)
  }
  readonly events: BotEvents
  readonly interactions: BotInteractions
  constructor(
    private readonly repo: BotRepository,
    private readonly connector: GuestConnector,
    private readonly host: CoordinatorHost,
    private readonly limits = TURN_LIMITS
  ) {
    this.events = new BotEvents(repo)
    this.interactions = new BotInteractions(repo)
  }
  start() {
    this.timer ??= setInterval(() => void this.tick().catch(() => {}), this.limits.renewMs)
    this.timer.unref?.()
    // Reconcile uncertain work right away instead of waiting for the first lease tick.
    for (const turn of this.repo.activeTurns()) this.scheduleReconcile(turn.botId, 50)
  }
  /** First failed attempt to open the session of a queued turn, per turn. */
  private dispatchFailures = new Map<string, { botId: string; first: number }>()
  /** Starts queued work now; when the bot's session cannot open, the turn never waits silently. */
  kick(botId: string) {
    void this.drain(botId).then(
      () => this.dispatchSucceeded(botId),
      (error) => this.dispatchFailed(botId, error)
    )
  }
  private dispatchSucceeded(botId: string) {
    for (const [turnId, entry] of this.dispatchFailures) if (entry.botId === botId) this.dispatchFailures.delete(turnId)
  }
  /**
   * A queued turn whose session keeps failing to open asks for attention with a stable code. It
   * stays durable: its outbox item is kept, and the next successful reconcile starts it once.
   */
  private dispatchFailed(botId: string, error: unknown) {
    const turn = this.repo.activeTurn(botId)
    if (turn?.status !== 'queued' || this.held(botId) || this.closed) return
    const first = this.dispatchFailures.get(turn.id)?.first ?? Date.now()
    this.dispatchFailures.set(turn.id, { botId, first })
    if (Date.now() - first < this.limits.dispatchAttentionMs) return
    const code = error instanceof HostError ? error.code : 'RUNTIME_UNREACHABLE'
    const marked = this.repo.transaction(() => {
      const current = this.repo.turn(turn.id)
      if (current.status !== 'queued') return false
      this.repo.saveTurn({
        ...current,
        status: 'needs_attention',
        attention: 'Não foi possível abrir a área de trabalho do bot. A tarefa continua guardada e começa sozinha quando o computador responder; se isso persistir, verifique Ambientes.',
        revision: current.revision + 1,
        updatedAt: now(),
      })
      return true
    })
    if (marked) this.events.record(botId, 'attention', 'A área de trabalho do bot não abriu; a tarefa aguarda', { turnId: turn.id, conversationId: turn.conversationId, detail: { code } })
  }
  private scheduleReconcile(botId: string, delayMs: number) {
    const timer = setTimeout(() => void this.reconcile(botId).catch(() => this.scheduleReconcile(botId, Math.min(delayMs * 2, this.limits.renewMs))), delayMs)
    timer.unref?.()
  }
  async close() {
    this.closed = true
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    for (const session of this.sessions.values()) session.close()
    this.sessions.clear()
  }
  /** Conservative recovery after Host restart: nothing is replayed; uncertain turns need attention. */
  async recover() {
    for (const turn of this.repo.activeTurns()) {
      if (turn.status === 'queued') continue // outbox still holds turn.start; it will be dispatched once
      this.repo.transaction(() =>
        this.repo.saveTurn({
          ...turn,
          status: 'needs_attention',
          attention: 'O Host reiniciou durante a tarefa. Estamos verificando com o computador do bot se ela terminou.',
          revision: turn.revision + 1,
          updatedAt: now(),
        })
      )
      this.events.record(turn.botId, 'attention', 'Host reiniciou durante a tarefa; verificando o resultado', { turnId: turn.id, conversationId: turn.conversationId })
    }
  }
  hasSession(botId: string) {
    return this.sessions.get(botId)?.alive === true
  }
  /** The VM stopped or rebooted: any session to it is stale by definition. */
  dropSession(botId: string) {
    const session = this.sessions.get(botId)
    this.sessions.delete(botId)
    session?.close()
  }
  async session(bot: Bot): Promise<GuestSession> {
    if (this.closed) throw new HostError('CLOSED', 'Host service is closed')
    if (this.held(bot.id)) throw new HostError('BOT_PAUSED_BY_USER', 'O bot está pausado enquanto você usa a tela')
    const existing = this.sessions.get(bot.id)
    if (existing?.alive) return existing
    if (!bot.vmId) throw new HostError('RUNTIME_UNREACHABLE', 'O bot ainda não tem um computador')
    const vm = this.host.vm(bot.vmId)
    if (vm.state !== 'running') throw new HostError('VM_STOPPED', 'O computador do bot está desligado')
    const pending = this.connecting.get(bot.id)
    if (pending) return pending
    const identity = this.repo.session(bot.id)
    if (!identity || identity.issue) throw new HostError('SESSION_UNAVAILABLE', 'A área de trabalho requer migração ou reconciliação')
    const attempt = this.connector
      .connect({ vmId: bot.vmId, sessionId: identity.id, hostGeneration: this.host.hostGeneration, transport: identity.transport })
      .then(async (session) => {
        // A fresh guest proxy starts offline. Restore Host authority before making
        // this session available to account RPCs or accepted turns.
        try {
          let synchronized = false
          for (let attempt = 0; attempt < 4; attempt++) {
            const network = this.repo.network(bot.id)
            const permissionMode = this.repo.bot(bot.id).permissionMode
            const result = await session.request('policy.update', { network, permissionMode }) as { applied?: boolean }
            if (result?.applied !== true || !session.alive || this.closed)
              throw new HostError('RUNTIME_POLICY_UNAVAILABLE', 'O computador do bot não confirmou as permissões atuais')
            if (this.repo.network(bot.id).revision === network.revision && this.repo.bot(bot.id).permissionMode === permissionMode) {
              synchronized = true
              break
            }
          }
          if (!synchronized) throw new HostError('RUNTIME_POLICY_UNAVAILABLE', 'As permissões mudaram durante a conexão; reconecte o computador')
        } catch (error) {
          session.close()
          throw error
        }
        session.setAccountHandler?.((forceRefresh, credentialHash) => {
          if (this.sessions.get(bot.id) !== session || !session.alive || !this.accounts)
            return Promise.reject(new HostError('ACCOUNT_UNAVAILABLE', 'O canal desta conta está indisponível'))
          return this.accounts.credential(bot.id, forceRefresh, credentialHash)
        })
        // The acting bot is this session's bot, decided here and never by the frame.
        session.setCollaborationHandler?.((request) => {
          if (this.sessions.get(bot.id) !== session || !session.alive || !this.collaboration)
            return Promise.reject(new HostError('TEAM_STAGE_INVALID', 'Esta sessão não pode colaborar agora'))
          return this.collaboration(bot.id, request)
        })
        // Same rule for routine proposals: the acting bot is this session's bot, decided here.
        session.setRoutineHandler?.((request) => {
          if (this.sessions.get(bot.id) !== session || !session.alive || !this.routineLane)
            return Promise.reject(new HostError('ROUTINE_UPDATE_REQUIRED', 'Esta sessão não pode sugerir rotinas agora'))
          return this.routineLane(bot.id, request)
        })
        this.sessions.set(bot.id, session)
        session.onEvent((event, ack) => this.handleEvent(bot.id, event, ack))
        session.onClose(() => {
          if (this.sessions.get(bot.id) === session) this.sessions.delete(bot.id)
          this.onSessionLost(bot.id)
        })
        this.recordRuntime(bot.id, session)
        void this.reconcile(bot.id).catch(() => {})
        return session
      })
      .finally(() => this.connecting.delete(bot.id))
    this.connecting.set(bot.id, attempt)
    return attempt
  }
  private recordRuntime(botId: string, session: GuestSession) {
    const bot = this.repo.bot(botId)
    if (bot.runtimeState !== 'ready') {
      this.repo.transaction(() => this.repo.saveBot({ ...bot, runtimeState: 'ready', revision: bot.revision + 1, updatedAt: now() }))
      this.events.record(botId, 'runtime.changed', 'Computador do bot conectado', { detail: { version: session.runtimeVersion, bootId: session.bootId } })
    }
    const binding = this.repo.binding(botId)
    if (binding && (binding.runtimeVersion !== session.runtimeVersion || binding.guestGeneration !== session.generation))
      this.repo.saveBinding({ ...binding, runtimeVersion: session.runtimeVersion, guestGeneration: session.generation })
  }
  private onSessionLost(botId: string) {
    const turn = this.repo.activeTurn(botId)
    if (!turn || turn.status === 'queued' || turn.status === 'needs_attention' || this.takeovers.has(turn.id)) return
    this.repo.transaction(() =>
      this.repo.saveTurn({
        ...turn,
        status: 'needs_attention',
        attention: 'A conexão com o computador do bot caiu. Estamos verificando se a tarefa terminou.',
        revision: turn.revision + 1,
        updatedAt: now(),
      })
    )
    this.events.record(botId, 'attention', 'Conexão com o computador do bot perdida; verificando a tarefa', { turnId: turn.id, conversationId: turn.conversationId })
    if (!this.closed) this.scheduleReconcile(botId, 500)
  }
  /** Ask the guest journal about an uncertain turn; never re-send turn.start. */
  async reconcile(botId: string) {
    if (this.closed) return
    const turn = this.repo.activeTurn(botId)
    const bot = this.repo.bot(botId)
    if (!turn) {
      await this.drain(botId)
      return
    }
    if (turn.status === 'queued') {
      try {
        await this.drain(botId)
      } catch (error) {
        // The session did not open: the turn stays durable but asks for attention after a while.
        this.dispatchFailed(botId, error)
        throw error
      }
      this.dispatchSucceeded(botId)
      return
    }
    const session = await this.session(bot)
    const result = (await session.request('turn.reconcile', { turnId: turn.id, generation: turn.generation })) as {
      known: boolean
      status?: string
      providerThreadId?: string
      providerTurnId?: string
    }
    const latest = this.repo.turn(turn.id)
    if (TURN_TERMINAL.has(latest.status)) return
    if (!result.known) {
      // The guest never saw the dispatch: the durable outbox item (if any) is safe to send once.
      if (this.repo.outbox(botId).some((item) => item.turnId === turn.id && item.kind === 'turn.start')) {
        this.repo.transaction(() => this.repo.saveTurn({ ...latest, status: 'queued', attention: undefined, revision: latest.revision + 1, updatedAt: now() }))
        await this.drain(botId)
        return
      }
      this.finish(latest, 'interrupted', { code: 'INTERRUPTED', message: 'O computador do bot não tem registro desta tarefa; ela não foi executada.' })
      return
    }
    const parsed = turnStatusSchema.safeParse(result.status)
    if (parsed.success && TURN_TERMINAL.has(parsed.data)) this.finish(latest, parsed.data, undefined, result)
    else if (parsed.success)
      this.repo.transaction(() => this.repo.saveTurn({ ...latest, status: parsed.data, attention: undefined, revision: latest.revision + 1, updatedAt: now() }))
    await this.drain(botId)
  }
  async drain(botId: string) {
    if (this.draining.has(botId) || this.held(botId)) return
    this.draining.add(botId)
    try {
      for (;;) {
        const item = this.repo.outbox(botId)[0]
        if (!item) return
        const bot = this.repo.bot(botId)
        const turn = this.repo.turn(item.turnId)
        if (TURN_TERMINAL.has(turn.status)) {
          this.repo.dequeue(item.id)
          continue
        }
        const session = await this.session(bot)
        if (item.kind === 'turn.start') {
          if (item.attempts > 0) {
            const known = (await session.request('turn.reconcile', { turnId: turn.id, generation: turn.generation })) as { known: boolean }
            if (known.known) {
              this.repo.dequeue(item.id)
              continue
            }
          }
          if (bot.accountId) {
            try { await this.accounts?.prepare(bot, session, turn.id) }
            catch (error) {
              this.repo.dequeue(item.id)
              this.finish(turn, 'failed', { code: error instanceof HostError ? error.code : 'ACCOUNT_UNAVAILABLE', message: 'Não foi possível acessar a conta geral. Verifique Contas antes de tentar novamente.' })
              continue
            }
          }
          // Extensions (MCP servers, skills) reach the guest before the turn that will use them.
          try { await this.extensions?.prepare(bot, session, turn.id) }
          catch (error) {
            this.repo.dequeue(item.id)
            this.finish(turn, 'failed', { code: error instanceof HostError ? error.code : 'EXTENSIONS_UNAVAILABLE', message: 'As extensões deste bot não puderam ser preparadas. Revise MCP e skills nas configurações.' })
            continue
          }
          // Authorization is revalidated here, immediately before the wire write.
          const blocked = this.dispatchGuard?.(turn.id)
          if (blocked) {
            this.repo.dequeue(item.id)
            this.finish(turn, 'cancelled', blocked)
            continue
          }
          // Persist the dispatch attempt before the wire write: a lost reply is reconciled, never replayed.
          this.repo.transaction(() => {
            this.repo.enqueue({ ...item, attempts: item.attempts + 1 })
            this.repo.saveTurn({ ...turn, status: 'starting', startedAt: turn.startedAt ?? now(), revision: turn.revision + 1, updatedAt: now() })
          })
          await this.accounts?.renew(bot, turn.id)
          const identity = this.repo.session(bot.id)
          if (identity?.transport === 'managed') await this.connector.renewSessionLease?.(identity, turn.id, this.limits.leaseMs)
          // Compatibility is decided here, against the guest that is actually connected: a runtime
          // that never announced routines receives the exact shape it knows. Its snapshot schema is
          // strict, so one unknown field would make it refuse every turn — seen on real hardware,
          // where a Host newer than its guest retried the same turn.start for twelve minutes.
          const body = this.compatibleSnapshot(session, item.body as Record<string, unknown>)
          try {
            await session.request('turn.start', body as any, 60_000)
          } catch (error) {
            if (error instanceof HostError && error.code === 'INVALID_REQUEST') {
              // The guest understood the request and rejected its shape: sending it again can only
              // produce the same answer. Fail the turn with a reason a person can act on.
              this.repo.dequeue(item.id)
              this.finish(this.repo.turn(turn.id), 'failed', { code: 'RUNTIME_UPDATE_REQUIRED', message: 'O computador deste bot precisa ser atualizado antes de executar esta tarefa.' })
              continue
            }
            throw error
          }
          this.repo.transaction(() => {
            this.repo.dequeue(item.id)
            const current = this.repo.turn(turn.id)
            if (current.status === 'starting')
              this.repo.saveTurn({ ...current, status: 'running', leaseExpiresAt: new Date(Date.now() + this.limits.leaseMs).toISOString(), revision: current.revision + 1, updatedAt: now() })
          })
          this.events.record(botId, 'turn.status', 'O bot começou a trabalhar', { turnId: turn.id, conversationId: turn.conversationId, detail: { status: 'running' } })
          this.notify(turn.id)
        } else if (item.kind === 'turn.cancel') {
          await session.request('turn.cancel', { turnId: turn.id, generation: turn.generation }, 60_000)
          const identity = this.repo.session(bot.id)
          if (identity?.transport === 'managed' && this.connector.stopSession) {
            await this.connector.stopSession(identity, `${turn.id}:cancel-session`)
            this.dropSession(bot.id)
            const current = this.repo.session(bot.id)!
            this.repo.saveSession({ ...current, state: 'stopped', revision: current.revision + 1, updatedAt: now() })
            this.finish(this.repo.turn(turn.id), 'cancelled')
          }
          this.repo.dequeue(item.id)
        } else {
          await session.request('interaction.resolve', item.body as any, 60_000)
          this.repo.transaction(() => {
            this.repo.dequeue(item.id)
            const current = this.repo.turn(turn.id)
            if (current.status === 'waiting_approval' || current.status === 'waiting_input')
              this.repo.saveTurn({ ...current, status: 'running', revision: current.revision + 1, updatedAt: now() })
          })
          // The answer reached the bot: whoever tracks this work must stop showing a wait.
          this.notify(turn.id)
        }
      }
    } finally {
      this.draining.delete(botId)
    }
  }
  private async tick() {
    if (this.closed) return
    await Promise.allSettled(this.repo.activeTurns().map(async turn => {
      if (this.held(turn.botId)) return
      const session = this.sessions.get(turn.botId)
      if (['running', 'waiting_approval', 'waiting_input', 'cancelling'].includes(turn.status) && session?.alive) {
        try {
          await this.accounts?.renew(this.repo.bot(turn.botId), turn.id)
          const identity = this.repo.session(turn.botId)
          if (identity?.transport === 'managed') await this.connector.renewSessionLease?.(identity, turn.id, this.limits.leaseMs)
          await session.request('turn.lease', { turnId: turn.id, generation: turn.generation, leaseMs: this.limits.leaseMs }, 5_000)
          const current = this.repo.turn(turn.id)
          if (!TURN_TERMINAL.has(current.status))
            this.repo.transaction(() => this.repo.saveTurn({ ...current, leaseExpiresAt: new Date(Date.now() + this.limits.leaseMs).toISOString(), revision: current.revision + 1, updatedAt: now() }))
        } catch {
          /* lost lease renewals surface through session close or reconcile */
        }
      }
      if (turn.status === 'running' && turn.startedAt && this.workedMs(turn) > this.limits.activeMs && session?.alive)
        await this.requestCancel(turn.botId, turn.id, 'Tempo máximo de execução atingido').catch(() => {})
      if (turn.status === 'needs_attention' || (turn.status === 'queued' && !this.draining.has(turn.botId)))
        void this.reconcile(turn.botId).catch(() => {})
    }))
  }
  private workedMs(turn: BotTurn): number {
    return workedMs(turn, this.repo.interactionsOfTurn(turn.id))
  }
  async requestCancel(botId: string, turnId: string, reason: string) {
    const turn = this.repo.turn(turnId)
    if (TURN_TERMINAL.has(turn.status)) return turn
    const updated = this.repo.transaction(() => {
      const current = this.repo.turn(turnId)
      const next: BotTurn = { ...current, status: 'cancelling', cancelRequestedAt: current.cancelRequestedAt ?? now(), attention: undefined, revision: current.revision + 1, updatedAt: now() }
      this.repo.saveTurn(next)
      this.interactions.invalidatePending(turnId, botId)
      // Never dispatched: queued, or waiting for attention before its first start (startedAt is
      // persisted before any turn.start is written to the guest). The computer never saw it.
      if (current.status === 'queued' || (current.status === 'needs_attention' && !current.startedAt)) {
        for (const item of this.repo.outbox(botId)) if (item.turnId === turnId) this.repo.dequeue(item.id)
        this.finish(next, 'cancelled')
        return this.repo.turn(turnId)
      }
      this.repo.enqueue({ id: `${turnId}:cancel`, botId, turnId, kind: 'turn.cancel', body: { reason }, createdAt: now(), attempts: 0 })
      return next
    })
    this.events.record(botId, 'turn.status', 'Parando a tarefa…', { turnId, conversationId: turn.conversationId, detail: { status: 'cancelling', reason } })
    void this.drain(botId).catch(() => {})
    return updated
  }
  /** The snapshot as the connected guest can parse it: optional sections it never announced are left out. */
  private compatibleSnapshot(session: GuestSession, snapshot: Record<string, unknown>): Record<string, unknown> {
    if (!('routines' in snapshot) || session.capabilities.includes(ROUTINE_CAPABILITY)) return snapshot
    const { routines: _omitted, ...rest } = snapshot
    return rest
  }
  private finish(turn: BotTurn, status: BotTurn['status'], error?: { code: string; message: string }, extra: Record<string, unknown> = {}) {
    this.repo.transaction(() => {
      const current = this.repo.turn(turn.id)
      if (TURN_TERMINAL.has(current.status)) return
      const finished: BotTurn = {
        ...current,
        status,
        finishedAt: now(),
        attention: undefined,
        ...(error ? { error } : {}),
        ...(typeof extra.providerThreadId === 'string' ? { providerThreadId: extra.providerThreadId } : {}),
        ...(typeof extra.providerTurnId === 'string' ? { providerTurnId: extra.providerTurnId } : {}),
        ...(mergedUsage(extra) ? { usage: mergedUsage(extra) } : {}),
        revision: current.revision + 1,
        updatedAt: now(),
      }
      this.repo.saveTurn(finished)
      // The ledger row is derived here, in the same transaction, so usage can never be counted twice.
      if (finished.usage)
        this.repo.saveTurnUsage({
          turnId: finished.id,
          botId: finished.botId,
          finishedAt: finished.finishedAt ?? now(),
          provider: 'codex',
          model: finished.model?.model ?? 'unknown',
          input: finished.usage.inputTokens ?? 0,
          cachedInput: finished.usage.cachedInputTokens ?? 0,
          output: finished.usage.outputTokens ?? 0,
          reasoningOutput: finished.usage.reasoningOutputTokens ?? 0,
          toolCalls: finished.usage.toolCalls ?? 0,
        })
      this.interactions.invalidatePending(turn.id, turn.botId)
      const conversation = this.repo.conversation(turn.conversationId)
      this.repo.saveConversation({
        ...conversation,
        activeTurnId: undefined,
        ...(typeof extra.providerThreadId === 'string' ? { providerThreadId: extra.providerThreadId } : {}),
        revision: conversation.revision + 1,
        updatedAt: now(),
      })
      const bot = this.repo.bot(turn.botId)
      this.repo.saveBot({ ...bot, activeTurnId: undefined, revision: bot.revision + 1, updatedAt: now() })
    })
    void this.accounts?.release(this.repo.bot(turn.botId), turn.id).catch(() => {})
    this.assistantBuffers.delete(turn.id)
    const identity = this.repo.session(turn.botId)
    if (identity?.transport === 'managed') void this.connector.releaseSessionLease?.(identity, turn.id).catch(() => {})
    const labels: Record<string, string> = { succeeded: 'Tarefa concluída', failed: 'A tarefa falhou', cancelled: 'Tarefa interrompida', interrupted: 'A tarefa foi interrompida' }
    this.events.record(turn.botId, 'turn.status', error?.code === 'HUMAN_TAKEOVER' ? 'Tarefa pausada para você usar a tela' : labels[status] ?? status, { turnId: turn.id, conversationId: turn.conversationId, detail: { status, ...(error ? { error } : {}) } })
    this.notify(turn.id)
  }
  /** Events are persisted first; ACK follows the commit so a crash re-delivers instead of losing. */
  private handleEvent(botId: string, event: GuestEvent, ack: () => void) {
    try {
      const turn = event.turnId ? this.repo.turn(event.turnId) : undefined
      if (turn && (turn.botId !== botId || (event.generation !== undefined && event.generation !== turn.generation))) {
        ack() // foreign or stale generation: acknowledge to unblock the guest, but never apply
        return
      }
      const common = { turnId: turn?.id, conversationId: turn?.conversationId, runtimeEventId: event.runtimeEventId, generation: event.generation, detail: event.detail }
      const stale = turn && TURN_TERMINAL.has(turn.status)
      switch (event.kind) {
        case 'turn.status': {
          if (!turn || stale) break
          const parsed = turnStatusSchema.safeParse(event.detail?.status)
          if (!parsed.success) break
          if (TURN_TERMINAL.has(parsed.data)) {
            if (this.takeovers.has(turn.id) && (parsed.data === 'cancelled' || parsed.data === 'interrupted')) {
              this.takeovers.delete(turn.id)
              this.finish(turn, 'interrupted', { code: 'HUMAN_TAKEOVER', message: 'Tarefa pausada para você usar a tela. Ela pode continuar quando você devolver o controle.' }, event.detail)
              break
            }
            // Worker cancellation alone cannot prove a detached process left its session cgroup.
            if (parsed.data === 'cancelled' && turn.cancelRequestedAt && this.repo.session(botId)?.transport === 'managed' && this.connector.stopSession) break
            const error = event.detail?.error && typeof event.detail.error === 'object' ? (event.detail.error as { code: string; message: string }) : undefined
            this.finish(turn, parsed.data, error, event.detail)
          } else if (turn.status !== 'cancelling' || parsed.data === 'cancelling') {
            this.repo.transaction(() =>
              this.repo.saveTurn({
                ...turn,
                status: parsed.data,
                ...(typeof event.detail?.providerThreadId === 'string' ? { providerThreadId: event.detail.providerThreadId } : {}),
                ...(typeof event.detail?.providerTurnId === 'string' ? { providerTurnId: event.detail.providerTurnId } : {}),
                revision: turn.revision + 1,
                updatedAt: now(),
              })
            )
            this.events.record(botId, 'turn.status', event.summary, common)
            this.notify(turn.id)
          }
          break
        }
        case 'assistant.delta': {
          if (!turn || stale) break
          const text = typeof event.detail?.text === 'string' ? event.detail.text : ''
          const buffer = (this.assistantBuffers.get(turn.id) ?? '') + text
          this.assistantBuffers.set(turn.id, buffer.slice(-64 * 1024))
          // Deltas are aggregated: one bounded event per delivery instead of token-by-token rows.
          this.events.record(botId, 'assistant.delta', event.summary || 'Escrevendo…', { ...common, detail: { text: text.slice(0, 4096) } })
          break
        }
        case 'assistant.message': {
          if (!turn || stale) break
          const content = typeof event.detail?.content === 'string' ? event.detail.content : (this.assistantBuffers.get(turn.id) ?? '')
          this.assistantBuffers.delete(turn.id)
          this.repo.transaction(() => {
            const conversation = this.repo.conversation(turn.conversationId)
            const existing = this.repo.messageByClientId(conversation.id, event.runtimeEventId)
            if (existing) return
            const sequence = conversation.lastSequence + 1
            this.repo.saveMessage({
              id: randomUUID(),
              conversationId: conversation.id,
              clientMessageId: event.runtimeEventId,
              role: 'assistant',
              content: content.slice(0, 64 * 1024),
              turnId: turn.id,
              sequence,
              attachments: Array.isArray(event.detail?.attachments) ? (event.detail.attachments as any[]).slice(0, 16) : [],
              createdAt: now(),
            })
            this.repo.saveConversation({ ...conversation, lastSequence: sequence, revision: conversation.revision + 1, updatedAt: now() })
          })
          this.events.record(botId, 'assistant.message', event.summary || 'O bot respondeu', { ...common, detail: { preview: content.slice(0, 400) } })
          break
        }
        case 'approval.requested':
        case 'question.asked': {
          if (!turn || stale || turn.status === 'cancelling') break
          const interaction = this.interactions.fromEvent(turn, event, this.repo.network(botId).revision)
          if (!interaction) break
          this.repo.transaction(() =>
            this.repo.saveTurn({ ...turn, status: event.kind === 'question.asked' ? 'waiting_input' : 'waiting_approval', revision: turn.revision + 1, updatedAt: now() })
          )
          this.events.record(botId, event.kind, event.summary || interaction.title, { ...common, detail: { interactionId: interaction.id, title: interaction.title } })
          this.notify(turn.id)
          break
        }
        case 'account.changed': {
          const bot = this.repo.bot(botId)
          if (bot.accountId) {
            this.events.record(botId, 'runtime.changed', 'Conexão da área de trabalho atualizada', common)
            break
          }
          const state = event.detail?.state
          if (state !== bot.accountState && (state === 'connected' || state === 'disconnected' || state === 'incompatible' || state === 'expired' || state === 'connecting'))
            this.repo.transaction(() => this.repo.saveBot({ ...bot, accountState: state, revision: bot.revision + 1, updatedAt: now() }))
          this.events.record(botId, 'account.changed', event.summary, common)
          break
        }
        default:
          this.events.record(botId, event.kind, event.summary, common)
      }
      ack()
    } catch {
      // Persistence failed: do not ACK; the guest keeps the event for redelivery.
    }
  }
}


/**
 * Usage as a guest reports it: the legacy trio in `usage`, richer counters in `usageDetail`
 * (kept apart so an older Host never sees keys it would refuse). Anything malformed is dropped
 * rather than allowed to fail the transaction that ends a turn.
 */
export function mergedUsage(extra: Record<string, unknown>): BotTurn['usage'] | undefined {
  if (!extra.usage || typeof extra.usage !== 'object') return undefined
  const detail = extra.usageDetail && typeof extra.usageDetail === 'object' ? (extra.usageDetail as Record<string, unknown>) : {}
  const parsed = usageSchema.safeParse({ ...(extra.usage as Record<string, unknown>), ...detail })
  if (parsed.success) return parsed.data
  const legacy = usageSchema.safeParse(extra.usage)
  return legacy.success ? legacy.data : undefined
}
