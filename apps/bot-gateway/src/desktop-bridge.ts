import { randomBytes, randomUUID } from 'node:crypto'
import {
  FLEET_DESKTOP_BRIDGE_LIMITS,
  type FleetDesktopCallResult,
  type FleetDesktopErrorCode,
  type FleetDesktopLink,
  type FleetDesktopLinkView,
  type FleetInternalDesktopCallRequest,
} from '@maestrly/bot-fleet-protocol'
import { GatewayError } from './errors.js'
import type { EventHub } from './events.js'
import type { Device, Store, StoredDesktopLink } from './store.js'

type Pending = {
  botId: string
  deviceId: string
  name: string
  resolve: (result: FleetDesktopCallResult) => void
  timer: NodeJS.Timeout
}

const failure = (code: FleetDesktopErrorCode, message: string): FleetDesktopCallResult => ({
  ok: false,
  error: { code, message },
})
const mintDesktopId = () => 'dsk_' + randomBytes(16).toString('base64url')

/**
 * Routes a bot's calls to the computers that gave it access to their workspaces.
 *
 * Each computer links a bot on its own and answers only through its own event stream, which it opened: nothing ever
 * connects to a computer. A call names one computer and goes to that computer alone, its answer is accepted from that computer alone, and a
 * computer that is not connected now fails the call at once; nothing waits for it, and no other computer stands in for it,
 * because the conversation and its worktree exist only on the computer that created them. The gateway keeps which computer
 * linked which bot and the name it shows, never a grant, a catalog or a transcript.
 */
export class DesktopBridge {
  private readonly pending = new Map<string, Pending>()
  constructor(
    readonly store: Store,
    readonly events: EventHub,
    readonly options: { timeoutMs?: number; now?: () => number } = {}
  ) {}
  private now() {
    return this.options.now?.() ?? Date.now()
  }
  private link(link: StoredDesktopLink): FleetDesktopLink {
    return {
      desktopId: link.desktopId,
      name: link.name,
      online: this.events.bridgeOnline(link.deviceId),
      lastSeenAt: this.store.device(link.deviceId)?.lastSeenAt ?? null,
      linkedAt: link.linkedAt,
    }
  }
  private active(botId: string): StoredDesktopLink[] {
    return this.store.desktopLinks(botId).filter((link) => !this.store.deviceRevoked(link.deviceId))
  }
  /** The computers linked to a bot, as the bot sees them. */
  links(botId: string): FleetDesktopLink[] {
    return this.active(botId).map((link) => this.link(link))
  }
  /** The computers linked to a bot, as one of the owner's computers sees them. */
  views(botId: string, deviceId: string): FleetDesktopLinkView[] {
    return this.active(botId).map((link) => ({ ...this.link(link), self: link.deviceId === deviceId }))
  }
  /** The asking computer links the bot under `name`, or renames its link. */
  linkDevice(botId: string, device: Device, name: string): FleetDesktopLinkView {
    const existing = this.store.desktopLinks(botId)
    if (
      !existing.some((link) => link.deviceId === device.id) &&
      existing.length >= FLEET_DESKTOP_BRIDGE_LIMITS.linksPerBotMax
    )
      throw new GatewayError(
        'CONFLICT',
        `A bot can be linked to at most ${FLEET_DESKTOP_BRIDGE_LIMITS.linksPerBotMax} computers.`
      )
    const saved = this.store.saveDesktopLink(
      botId,
      device.id,
      name,
      mintDesktopId(),
      new Date(this.now()).toISOString()
    )
    this.notify(botId)
    return { ...this.link(saved), self: true }
  }
  /** The asking computer takes back its own access. */
  unlinkDevice(botId: string, deviceId: string) {
    const removed = this.store.deleteDesktopLink(botId, deviceId)
    if (!removed) return
    this.dropCalls((call) => call.botId === botId && call.deviceId === deviceId, 'desktop_not_linked')
    this.notify(botId)
  }
  /** Any of the owner's computers removes the link of another; that computer revokes its own side once it hears of it. */
  remove(botId: string, desktopId: string) {
    const link = this.store.desktopLinkById(desktopId)
    if (!link || link.botId !== botId) throw new GatewayError('NOT_FOUND', 'Desktop link not found')
    this.unlinkDevice(botId, link.deviceId)
  }
  /** Runs one call on the computer it names, or says at once why it cannot. */
  call(botId: string, request: FleetInternalDesktopCallRequest): Promise<FleetDesktopCallResult> {
    const link = this.store.desktopLinkById(request.desktopId)
    if (!link || link.botId !== botId || this.store.deviceRevoked(link.deviceId))
      return Promise.resolve(
        failure(
          'desktop_not_linked',
          'No computer with this desktopId gives you access. Call desktop_list_desktops for the ones that do.'
        )
      )
    let waiting = 0
    for (const call of this.pending.values()) if (call.botId === botId) waiting++
    if (waiting >= FLEET_DESKTOP_BRIDGE_LIMITS.pendingPerBotMax)
      return Promise.resolve(
        failure(
          'desktop_busy',
          'Too many of your calls to computers are still waiting. Let them finish, then try again.'
        )
      )
    const offline = failure(
      'desktop_offline',
      `"${link.name}" is offline: Maestrly is closed there, the computer is asleep, or it lost its connection to this ` +
        'server. Tell your owner; do not move this work to another computer on your own.'
    )
    if (!this.events.bridgeOnline(link.deviceId)) return Promise.resolve(offline)
    const timeoutMs = this.options.timeoutMs ?? FLEET_DESKTOP_BRIDGE_LIMITS.callTimeoutMs
    const callId = randomUUID()
    const now = this.now()
    return new Promise((resolve) => {
      const timer = setTimeout(
        () =>
          this.settle(
            callId,
            failure(
              'desktop_timeout',
              `"${link.name}" did not answer within ${Math.round(timeoutMs / 1000)} seconds. A change you asked for ` +
                'may still have happened there: retry with the same idempotencyKey and that computer runs it only once.'
            )
          ),
        timeoutMs
      )
      timer.unref?.()
      this.pending.set(callId, { botId, deviceId: link.deviceId, name: link.name, resolve, timer })
      const sent = this.events.sendToDevice(link.deviceId, {
        type: 'desktop.call',
        at: new Date(now).toISOString(),
        callId,
        botId,
        desktopId: link.desktopId,
        op: request.op,
        input: request.input,
        expiresAt: new Date(now + timeoutMs).toISOString(),
      })
      if (!sent) this.settle(callId, offline)
    })
  }
  /** A computer answers a call it received; only the computer the call was sent to may. */
  result(callId: string, deviceId: string, result: FleetDesktopCallResult) {
    const call = this.pending.get(callId)
    if (!call) throw new GatewayError('NOT_FOUND', 'Desktop call not found or already answered')
    if (call.deviceId !== deviceId) throw new GatewayError('FORBIDDEN', 'This call was sent to another computer')
    this.settle(callId, result)
  }
  /** A revoked computer loses every link it had, and the calls waiting for it fail; the other computers are untouched. */
  revokeDevice(deviceId: string) {
    const removed = this.store.deleteDesktopLinksOfDevice(deviceId)
    this.dropCalls((call) => call.deviceId === deviceId, 'desktop_not_linked')
    for (const botId of new Set(removed.map((link) => link.botId))) this.notify(botId)
  }
  /** A deleted bot: its links went with its records; every computer hears it has none left, and its calls end. */
  botPurged(botId: string) {
    this.dropCalls((call) => call.botId === botId, 'desktop_not_linked')
    this.notify(botId)
  }
  /** A computer connected or disconnected: the calls waiting for a computer now offline fail, and every computer sees its state. */
  deviceChanged(deviceId: string) {
    if (!this.events.bridgeOnline(deviceId))
      this.dropCalls(
        (call) => call.deviceId === deviceId,
        'desktop_offline',
        (call) => `"${call.name}" went offline before it answered. Tell your owner; do not retry on another computer.`
      )
    for (const botId of new Set(this.store.desktopLinksOfDevice(deviceId).map((link) => link.botId))) this.notify(botId)
  }
  close() {
    this.dropCalls(
      () => true,
      'desktop_unavailable',
      () => 'The bot server is shutting down.'
    )
  }
  /** Tells every connected computer the links of a bot, each seeing its own as `self`. */
  private notify(botId: string) {
    const at = new Date(this.now()).toISOString()
    this.events.emitToBridges((deviceId) => ({
      type: 'desktop_link.updated',
      at,
      botId,
      links: this.views(botId, deviceId),
    }))
  }
  private dropCalls(
    match: (call: Pending) => boolean,
    code: FleetDesktopErrorCode,
    message: (call: Pending) => string = (call) => `"${call.name}" no longer gives you access.`
  ) {
    for (const [callId, call] of [...this.pending]) if (match(call)) this.settle(callId, failure(code, message(call)))
  }
  private settle(callId: string, result: FleetDesktopCallResult) {
    const call = this.pending.get(callId)
    if (!call) return
    this.pending.delete(callId)
    clearTimeout(call.timer)
    call.resolve(result)
  }
}
