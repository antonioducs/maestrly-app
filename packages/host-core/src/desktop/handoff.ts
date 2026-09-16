import { randomUUID } from 'node:crypto'
import {
  DESKTOP_LIMITS,
  TURN_TERMINAL,
  vmDesktopCaptureSchema,
  vmDesktopInfoSchema,
  type BotSession,
  type BotTurn,
  type DesktopOperation,
  type TurnSnapshot,
} from '@maestrly/host-protocol'
import { HostError } from '../errors.js'
import type { BotRepository } from '../bots/repository.js'
import type { RuntimeCoordinator } from '../bots/runtime-coordinator.js'
import { TURN_LIMITS } from '../bots/context.js'
import type { GuestConnector } from '../guest/session.js'
import type { DesktopRecord, DesktopRepository } from './repository.js'

export type ContinuationInput = {
  botId: string
  interruptedTurnId: string
  operationId: string
  capture: { path: string; name: string; size: number; digest: string }
  limits: TurnSnapshot['limits']
}
/** Creates the continuation inside the caller's transaction and returns its turn. */
export type ContinuationFactory = (input: ContinuationInput) => { turnId: string; conversationId: string }
export interface HandoffDeps {
  repo: BotRepository
  store: DesktopRepository
  coordinator: RuntimeCoordinator
  connector: GuestConnector
  continueTask: ContinuationFactory
  event: (botId: string, summary: string, detail: Record<string, unknown>, kind?: 'runtime.changed' | 'attention') => void
  /**
   * Outcome of a return, for domains that track the interrupted work. Returning without a
   * continuation must end the logical task explicitly instead of leaving it paused forever.
   */
  returned?: (input: { botId: string; interruptedTurnId?: string; continuationTurnId?: string; failureCode?: string }) => void
  /** Ceiling of the larger work a turn belongs to, when one exists (a team task parcel). */
  budgetCeiling?: (turnId: string) => { activeMs: number; maxTools: number } | undefined
}
export const stableCode = (error: unknown, fallback: string) => {
  const code = (error as { code?: unknown })?.code
  return typeof code === 'string' && /^[A-Z_]{1,64}$/.test(code) ? code : fallback
}
const within = <T>(promise: Promise<T>, ms: number) =>
  Promise.race([promise, new Promise<never>((_, reject) => setTimeout(() => reject(new HostError('HANDOFF_UNCERTAIN', 'Interrupt timed out')), ms))])
/**
 * A continued task never gets more than the budget of the task it continues. Each
 * handoff subtracts the time and tool calls the interrupted turn already spent.
 */
export function remainingBudget(record: DesktopRecord, turn: BotTurn, ceiling?: { activeMs: number; maxTools: number }) {
  const elapsed = turn.startedAt ? Math.max(0, new Date(turn.finishedAt ?? Date.now()).getTime() - new Date(turn.startedAt).getTime()) : 0
  const chain = record.chain && record.chain.lastTurnId === turn.id ? record.chain : { rootTurnId: turn.id, lastTurnId: turn.id, activeMs: 0, tools: 0 }
  const usedMs = chain.activeMs + elapsed
  const usedTools = chain.tools + (turn.usage?.toolCalls ?? 0)
  // Work that belongs to a larger piece (a team task) is capped by the parcel that work
  // reserved, never by the standalone per-turn ceiling.
  const activeMs = Math.min(ceiling?.activeMs ?? TURN_LIMITS.activeMs, TURN_LIMITS.activeMs) - usedMs
  const maxTools = Math.min(ceiling?.maxTools ?? TURN_LIMITS.maxTools, TURN_LIMITS.maxTools) - usedTools
  if (activeMs < 60_000 || maxTools < 1) return undefined
  return { limits: { activeMs, maxTools, maxLogBytes: TURN_LIMITS.maxLogBytes }, chain: { rootTurnId: chain.rootTurnId, activeMs: usedMs, tools: usedTools } }
}
/**
 * The two asynchronous handoff sequences. Every step is recorded before its effect and
 * failures end in a conservative state (blocked or paused), never a silent resume.
 */
export class HandoffRunner {
  constructor(private readonly deps: HandoffDeps) {}
  private async generation(session: BotSession) {
    if (!this.deps.connector.inspectSession) throw new HostError('DESKTOP_UPDATE_REQUIRED', 'Atualize o ambiente para ver a tela')
    return (await this.deps.connector.inspectSession(session)).generation
  }
  private desktop = () => {
    const request = this.deps.connector.desktop
    if (!request) throw new HostError('DESKTOP_UPDATE_REQUIRED', 'Atualize o ambiente para ver a tela')
    return request.bind(this.deps.connector)
  }
  /** hold → cooperative interrupt → proven stop and drain → human. */
  async acquire(operation: DesktopOperation, session: BotSession) {
    const { store, repo, coordinator } = this.deps
    const epoch = operation.controlEpoch
    const phase = (value: DesktopOperation['phase']) => store.commitTransition(operation.id, { phase: value })
    try {
      const request = this.desktop()
      const generation = await this.generation(session)
      phase('interrupting')
      await request(session, 'desktop.hold', { sessionId: session.id, generation, epoch, idempotencyKey: `${operation.id}:hold`, network: repo.network(operation.botId) })
      const turnId = operation.interruptedTurnId
      if (turnId) {
        const turn = repo.turn(turnId)
        if (!TURN_TERMINAL.has(turn.status)) {
          coordinator.markTakeover(turnId)
          const live = coordinator.liveSession(operation.botId)
          // Cooperative interruption has a deadline; the proven stop below is the guarantee.
          if (live) await within(live.request('turn.cancel', { turnId, generation: turn.generation }, DESKTOP_LIMITS.interruptMs), DESKTOP_LIMITS.interruptMs + 1_000).catch(() => {})
        }
      }
      phase('stopping')
      const info = vmDesktopInfoSchema.parse(await request(session, 'desktop.acquire', { sessionId: session.id, generation, epoch, idempotencyKey: `${operation.id}:acquire` }, 60_000))
      const turn = turnId ? coordinator.interruptForHandoff(turnId) : undefined
      coordinator.dropSession(operation.botId)
      const interrupted = turn?.status === 'interrupted' && turn.error?.code === 'HUMAN_TAKEOVER' ? turn.id : undefined
      store.commitTransition(operation.id, { phase: 'completed', status: 'succeeded', interruptedTurnId: interrupted }, (current) => ({
        ...current,
        mode: 'human',
        desktopGeneration: info.desktopGeneration ?? current.desktopGeneration,
        width: info.width || current.width,
        height: info.height || current.height,
        interruptedTurnId: interrupted,
        reasonCode: undefined,
      }))
      this.deps.event(operation.botId, 'Você está no controle da tela; o bot está pausado', { mode: 'human', interrupted: !!interrupted })
    } catch (error) {
      const code = stableCode(error, 'HANDOFF_UNCERTAIN')
      store.commitTransition(operation.id, { phase: 'failed', status: 'failed', failureCode: code }, (current) =>
        current.controlEpoch === epoch ? { ...current, mode: 'blocked', reasonCode: code } : current)
      this.deps.event(operation.botId, 'Não foi possível confirmar a parada do bot; ele segue bloqueado até você tentar de novo ou devolver o controle', { mode: 'blocked', reasonCode: code }, 'attention')
    }
  }
  /** Revoke input → fresh capture → resume automation → at most one continuation. */
  async return(operation: DesktopOperation, session: BotSession, plan: { continueTask: boolean; interruptedTurnId?: string }) {
    const { store, repo, coordinator } = this.deps
    const epoch = operation.controlEpoch
    const phase = (value: DesktopOperation['phase']) => store.commitTransition(operation.id, { phase: value })
    let resumed = false
    try {
      const request = this.desktop()
      const generation = await this.generation(session)
      const guest = vmDesktopInfoSchema.parse(await request(session, 'desktop.inspect', { sessionId: session.id, generation }))
      let capture: ReturnType<typeof vmDesktopCaptureSchema.parse> | undefined
      if (guest.mode !== 'bot') {
        phase('releasing')
        await request(session, 'desktop.release', { sessionId: session.id, generation, epoch, idempotencyKey: `${operation.id}:release` })
        if (plan.continueTask && plan.interruptedTurnId) {
          phase('capturing')
          // A new capture, never the viewer's cached frame, is the bot's first observation.
          capture = vmDesktopCaptureSchema.parse(await request(session, 'desktop.capture', { sessionId: session.id, generation, epoch, observationId: randomUUID() }, 60_000))
          const expected = store.get(session.id)?.desktopGeneration
          if (expected && capture.desktopGeneration !== expected) throw new HostError('STALE_DESKTOP', 'A tela reiniciou durante a devolução')
        }
        phase('resuming')
        await request(session, 'desktop.resume', { sessionId: session.id, generation, epoch, idempotencyKey: `${operation.id}:resume` }, 60_000)
      }
      resumed = true
      let continuationTurnId: string | undefined
      let failureCode: string | undefined
      if (capture && plan.interruptedTurnId) {
        phase('continuing')
        try {
          const turn = repo.turn(plan.interruptedTurnId)
          const record = store.get(session.id)!
          const budget = remainingBudget(record, turn, this.deps.budgetCeiling?.(turn.id))
          if (!budget) throw new HostError('BUDGET_EXHAUSTED', 'O limite desta tarefa foi atingido')
          const file = { path: capture.path, name: capture.name, size: capture.size, digest: capture.digest }
          repo.transaction(() => {
            const created = this.deps.continueTask({ botId: operation.botId, interruptedTurnId: turn.id, operationId: operation.id, capture: file, limits: budget.limits })
            continuationTurnId = created.turnId
            store.applyTransition(operation.id, { phase: 'completed', status: 'succeeded', continuationTurnId: created.turnId }, (current) => ({
              ...current,
              mode: 'bot',
              interruptedTurnId: undefined,
              reasonCode: undefined,
              chain: { ...budget.chain, lastTurnId: created.turnId },
            }))
          })
        } catch (error) {
          failureCode = stableCode(error, 'CONTINUATION_UNAVAILABLE')
        }
      }
      if (!continuationTurnId)
        store.commitTransition(operation.id, { phase: 'completed', status: 'succeeded', ...(failureCode ? { failureCode } : {}) }, (current) => ({
          ...current,
          mode: 'bot',
          interruptedTurnId: undefined,
          reasonCode: failureCode,
        }))
      this.deps.returned?.({ botId: operation.botId, interruptedTurnId: plan.interruptedTurnId, continuationTurnId, failureCode })
      if (continuationTurnId) {
        const turn = repo.turn(continuationTurnId)
        coordinator.events.record(operation.botId, 'turn.status', 'Tarefa retomada a partir do estado atual da tela', { turnId: turn.id, conversationId: turn.conversationId, detail: { status: 'queued' } })
        this.deps.event(operation.botId, 'Controle devolvido; o bot continua a partir do que você deixou', { mode: 'bot', continued: true })
        void coordinator.drain(operation.botId).catch(() => {})
      } else
        this.deps.event(operation.botId, failureCode ? 'Controle devolvido; a tarefa anterior não pôde continuar' : 'Controle devolvido ao bot', { mode: 'bot', continued: false, ...(failureCode ? { reasonCode: failureCode } : {}) })
    } catch (error) {
      const code = stableCode(error, 'HANDOFF_UNCERTAIN')
      if (resumed) return
      store.commitTransition(operation.id, { phase: 'failed', status: 'failed', failureCode: code }, (current) =>
        current.controlEpoch === epoch ? { ...current, mode: code === 'HANDOFF_UNCERTAIN' || code === 'SESSION_TIMEOUT' ? 'blocked' : 'paused', reasonCode: code } : current)
      this.deps.event(operation.botId, 'Não foi possível devolver o controle; o bot continua pausado', { mode: 'paused', reasonCode: code }, 'attention')
    }
  }
}
