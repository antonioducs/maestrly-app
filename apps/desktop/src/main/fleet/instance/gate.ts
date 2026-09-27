import type { FleetInstanceHold } from '@maestrly/bot-fleet-protocol'
import { isBotMode } from './config'
import { abortScreenActions } from '../../mcp/tools/computer'
import { InstanceHttpError } from './server'

const refusal = {
  takeover: 'The owner has taken over your screen. End your turn now.',
  paused: 'The owner has paused you. End your turn now.',
}
/**
 * The hold (takeover or pause) of one bot. `conversationId` names the bot's conversation: a hold cancels only that
 * conversation's screen actions, so holding one bot never interrupts another bot of the environment. Without it, the
 * conversation registered through `registerInstanceHoldGate` is used, and without either, every screen action.
 */
export class InstanceHoldManager {
  private current: FleetInstanceHold = { state: 'none', reason: null, since: null, interruptedTurn: false }
  private inflight = 0
  private pausedAfterTakeover = false
  private settling: Promise<void> | null = null
  private waiters = new Set<() => void>()
  /** The conversation this manager gates, set by `registerInstanceHoldGate`. */
  gatedConversationId: string | null = null
  constructor(
    private readonly onChange: () => void = () => {},
    private readonly conversationId?: () => string | null
  ) {}
  private abortScreen(): void {
    if (this.conversationId) {
      const id = this.conversationId()
      if (id) abortScreenActions(id)
      return
    }
    abortScreenActions(this.gatedConversationId ?? undefined)
  }
  get state(): FleetInstanceHold {
    return { ...this.current }
  }
  get activeCalls(): number {
    return this.inflight
  }
  get releaseKeepsPaused(): boolean {
    return this.pausedAfterTakeover
  }
  async gate<T>(conversationId: string, primaryConversationId: string | null, call: () => Promise<T>): Promise<T> {
    if (!isBotMode() || conversationId !== primaryConversationId) return call()
    if (this.current.state !== 'none') throw new Error(refusal[this.current.reason ?? 'takeover'])
    this.inflight++
    try {
      return await call()
    } finally {
      this.inflight--
      if (!this.inflight) {
        for (const wake of this.waiters) wake()
        this.waiters.clear()
      }
    }
  }
  async hold(
    reason: 'takeover' | 'paused',
    running: boolean,
    cancel: () => Promise<unknown>
  ): Promise<FleetInstanceHold> {
    if (this.current.state !== 'none') {
      if (
        (reason === 'takeover' && this.current.reason === 'paused') ||
        (reason === 'paused' && this.current.reason === 'takeover')
      )
        this.pausedAfterTakeover = true
      if (reason === 'paused') this.current.reason = 'paused'
      this.onChange()
      await this.settling
      return this.state
    }
    this.current = { state: 'holding', reason, since: new Date().toISOString(), interruptedTurn: false }
    this.onChange()
    this.settling = (async () => {
      try {
        this.abortScreen()
        const cancellation = running
          ? cancel().then(
              () => null,
              (error: unknown) => error
            )
          : Promise.resolve(null)
        if (this.inflight) {
          const drained = await new Promise<boolean>((resolve) => {
            const wake = () => {
              clearTimeout(timer)
              this.waiters.delete(wake)
              resolve(true)
            }
            const timer = setTimeout(() => {
              this.waiters.delete(wake)
              resolve(false)
            }, 10_000)
            this.waiters.add(wake)
          })
          if (!drained || this.inflight)
            throw new InstanceHttpError(409, 'CONFLICT', 'The bot is finishing a step; try again in a moment.')
        }
        const cancelError = await cancellation
        if (cancelError) throw cancelError
        this.current = { ...this.current, state: 'held', interruptedTurn: running }
        this.onChange()
      } catch (error) {
        this.current = { state: 'none', reason: null, since: null, interruptedTurn: false }
        this.pausedAfterTakeover = false
        this.onChange()
        throw error
      }
    })()
    try {
      await this.settling
    } finally {
      this.settling = null
    }
    return this.state
  }
  release(): FleetInstanceHold {
    if (this.current.state !== 'held') return this.state
    if (this.pausedAfterTakeover) {
      this.pausedAfterTakeover = false
      this.current = { ...this.current, state: 'held', reason: 'paused' }
    } else this.current = { state: 'none', reason: null, since: null, interruptedTurn: false }
    this.onChange()
    return this.state
  }
}

/** The hold gate of each bot conversation of this environment. */
const gates = new Map<string, InstanceHoldManager>()
export function registerInstanceHoldGate(manager: InstanceHoldManager, conversationId: string): () => void {
  gates.set(conversationId, manager)
  manager.gatedConversationId = conversationId
  return () => {
    if (gates.get(conversationId) !== manager) return
    gates.delete(conversationId)
    if (manager.gatedConversationId === conversationId) manager.gatedConversationId = null
  }
}
/** Runs an app tool of a conversation through its bot's hold gate; other conversations are not gated. */
export async function gateInstanceAppTool<T>(conversationId: string, call: () => Promise<T>): Promise<T> {
  const manager = isBotMode() ? gates.get(conversationId) : undefined
  if (!manager) return call()
  return manager.gate(conversationId, conversationId, call)
}
