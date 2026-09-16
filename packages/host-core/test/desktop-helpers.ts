import { randomUUID } from 'node:crypto'
import { duplexPair, type Duplex } from 'node:stream'
import type { BotSession } from '@maestrly/host-protocol'
import { HostError } from '../src/errors.js'
import { FakeConnector } from './bot-helpers.js'

type Hold = { mode: 'bot' | 'acquiring' | 'human' | 'paused' | 'resuming'; epoch: number; automation: 'running' | 'stopped'; sequence: number; leased: boolean }
/**
 * Managed connector with a guest supervisor that mirrors the real desktop control:
 * durable hold, strictly increasing epochs, proven automation stop, sequence checks
 * and single-use viewer grants. Media returns a fake RFB server greeting.
 */
export class DesktopConnector extends FakeConnector {
  holds = new Map<string, Hold>()
  calls: { method: string; params: Record<string, unknown> }[] = []
  applied: unknown[] = []
  grants = new Map<string, { sessionId: string; used: boolean }>()
  media: Duplex[] = []
  generationOfDesktop = 'desktop-gen-1'
  failAcquire = false
  failCapture = false
  onHold?: (session: BotSession) => void | Promise<void>
  constructor() {
    super()
    this.managed = true
  }
  async inspectVm() {
    return { capabilities: ['account.delegation.v1', 'desktop.live.v1', 'desktop.handoff.v1'], capacity: this.capacity }
  }
  hold(sessionId: string): Hold {
    let hold = this.holds.get(sessionId)
    if (!hold) this.holds.set(sessionId, (hold = { mode: 'bot', epoch: 0, automation: 'running', sequence: -1, leased: false }))
    return hold
  }
  async inspectSession(session: BotSession) {
    return { id: session.id, botId: session.botId, profile: session.profile ?? this.capacity.perSession, state: 'running' as const, generation: 1, desiredState: 'running' as const }
  }
  private info(session: BotSession) {
    const hold = this.hold(session.id)
    return { sessionId: session.id, mode: hold.mode, epoch: hold.epoch, desktopGeneration: this.generationOfDesktop, width: 1280, height: 800, automation: hold.automation, services: 'running', viewers: 0, capabilities: ['desktop.live.v1', 'desktop.handoff.v1'] }
  }
  async desktop(session: BotSession, method: string, params: Record<string, unknown>) {
    this.calls.push({ method, params })
    const hold = this.hold(session.id)
    const epoch = Number(params.epoch)
    const fail = (code: string) => { throw new HostError(code, code) }
    switch (method) {
      case 'desktop.inspect':
        return this.info(session)
      case 'desktop.hold':
        if (epoch <= hold.epoch) fail('STALE_DESKTOP')
        Object.assign(hold, { mode: 'acquiring', epoch, leased: false })
        await this.onHold?.(session)
        return this.info(session)
      case 'desktop.acquire':
        if (hold.mode !== 'acquiring' || hold.epoch !== epoch) fail('STALE_DESKTOP')
        if (this.failAcquire) fail('HANDOFF_UNCERTAIN')
        hold.automation = 'stopped'
        // Stopping automation closes the worker's control route.
        this.guests.get(session.id)?.drop()
        Object.assign(hold, { mode: 'human', sequence: -1, leased: true })
        return this.info(session)
      case 'desktop.lease':
        if (hold.mode !== 'human' || hold.epoch !== epoch) fail('CONTROL_EXPIRED')
        return { renewed: true }
      case 'desktop.pause':
        if (epoch < hold.epoch) fail('STALE_DESKTOP')
        Object.assign(hold, { mode: 'paused', epoch, leased: false })
        return this.info(session)
      case 'desktop.input': {
        if (hold.mode !== 'human' || hold.epoch !== epoch) fail('CONTROL_EXPIRED')
        if (params.desktopGeneration !== this.generationOfDesktop) fail('STALE_DESKTOP')
        const sequence = Number(params.sequence)
        if (sequence <= hold.sequence) fail('INPUT_SEQUENCE_INVALID')
        hold.sequence = sequence
        const events = params.events as unknown[]
        this.applied.push(...events)
        return { sequence, applied: events.length }
      }
      case 'desktop.release':
        if (epoch <= hold.epoch || hold.mode === 'bot') fail('STALE_DESKTOP')
        Object.assign(hold, { mode: 'resuming', epoch, leased: false })
        return this.info(session)
      case 'desktop.capture':
        if (hold.epoch !== epoch || this.failCapture) fail(this.failCapture ? 'DESKTOP_UNAVAILABLE' : 'STALE_DESKTOP')
        return { path: `.maestrly/screens/${params.observationId}.png`, name: `${params.observationId}.png`, size: 42, digest: 'b'.repeat(64), desktopGeneration: this.generationOfDesktop, width: 1280, height: 800 }
      case 'desktop.resume':
        if (hold.mode !== 'resuming' || hold.epoch !== epoch) fail('STALE_DESKTOP')
        Object.assign(hold, { mode: 'bot', automation: 'running' })
        return this.info(session)
      case 'desktop.policy':
        return { applied: true }
      case 'desktop.viewer.open':
        this.grants.set(String(params.grantId), { sessionId: session.id, used: false })
        return { width: 1280, height: 800, desktopGeneration: this.generationOfDesktop }
      case 'desktop.viewer.close':
        this.grants.delete(String(params.grantId))
        return { closed: true }
    }
    throw new Error(`unhandled ${method}`)
  }
  async openDesktopMedia(session: BotSession, _generation: number, grantId: string) {
    const grant = this.grants.get(grantId)
    if (!grant || grant.used || grant.sessionId !== session.id) throw new HostError('GRANT_INVALID', 'grant')
    grant.used = true
    const [host, guest] = duplexPair()
    this.media.push(guest)
    guest.write('RFB 003.008\n')
    return host
  }
  count(method: string) {
    return this.calls.filter((call) => call.method === method).length
  }
}
export const token = () => randomUUID().replaceAll('-', '').padEnd(64, '0').slice(0, 64)
