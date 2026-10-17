import { randomBytes, randomUUID } from 'node:crypto'
import {
  FLEET_DESKTOP_BRIDGE_LIMITS,
  FLEET_HOST_DESKTOP_CALLS_FEATURE,
  fleetJsonBytes,
  type FleetDesktopCallResult,
  type FleetDesktopErrorCode,
  type FleetDesktopLink,
  type FleetDesktopLinkView,
  type FleetHostDesktopCallRequest,
  type FleetHostDesktopLink,
  type FleetInternalDesktopCallRequest,
} from '@maestrly/bot-fleet-protocol'
import { GatewayError } from './errors.js'
import type { EventHub } from './events.js'
import type { Lifecycle } from './lifecycle.js'
import type { Device, Store, StoredDesktopLink, StoredEnvironmentDesktopLink } from './store.js'

/** Where a call waits for its answer: one computer's event stream, or one workspaces host's control server. */
type Pending = {
  botId: string
  deviceId: string | null
  environmentId: string | null
  name: string
  resolve: (result: FleetDesktopCallResult) => void
  timer: NodeJS.Timeout
  abort: AbortController | null
}

/**
 * How a workspaces environment takes bots' calls now. `online`: it runs a Maestrly that takes them; `stopped`: it can
 * be started; `starting`: it is on its way; `outdated`: it runs a Maestrly that cannot take them; `unavailable`: it is
 * archived, gone, or failed.
 */
export type DesktopHostState = 'online' | 'stopped' | 'starting' | 'outdated' | 'unavailable'

/** What the bridge needs of the server's workspaces environments, to send them the calls of the bots they linked. */
export interface DesktopBridgeHosts {
  state(environmentId: string): DesktopHostState
  /** Starts a stopped environment in the background. */
  wake(environmentId: string): void
  /** Posts one call to the environment's control server and returns its answer. */
  call(environmentId: string, call: FleetHostDesktopCallRequest, signal: AbortSignal): Promise<FleetDesktopCallResult>
  /** Tells a running environment that the gateway changed a bot's link without it; best effort. */
  linksChanged(environmentId: string, botId: string): void
  /** The workspaces environments that take calls now. */
  online(): string[]
}

/** What a gateway's bridge reads from its lifecycle to reach its workspaces environments. */
export function lifecycleDesktopHosts(lifecycle: Lifecycle): DesktopBridgeHosts {
  const state = (environmentId: string): DesktopHostState => {
    const environment = lifecycle.store.getEnvironment(environmentId)
    if (environment?.kind !== 'workspaces' || environment.archivedAt) return 'unavailable'
    switch (environment.lifecycle) {
      case 'running':
        return lifecycle.environmentCapabilities(environmentId).includes(FLEET_HOST_DESKTOP_CALLS_FEATURE)
          ? 'online'
          : 'outdated'
      // One stopping waits for its stop to finish before it starts again.
      case 'stopped':
      case 'stopping':
        return 'stopped'
      case 'creating':
      case 'starting':
      case 'restarting':
        return 'starting'
      default:
        return 'unavailable'
    }
  }
  return {
    state,
    wake: (environmentId) => void lifecycle.startEnvironment(environmentId).catch(() => undefined),
    call: async (environmentId, call, signal) =>
      lifecycle
        .environmentInstance(environmentId)
        .hostDesktopCall(call, FLEET_DESKTOP_BRIDGE_LIMITS.callTimeoutMs + 5_000, signal),
    linksChanged: (environmentId, botId) => {
      if (state(environmentId) !== 'online') return
      try {
        void lifecycle
          .environmentInstance(environmentId)
          .hostDesktopLinksChanged(botId)
          .catch(() => undefined)
      } catch {
        // It stopped meanwhile: it checks its links when it starts again.
      }
    },
    online: () =>
      lifecycle.store
        .listEnvironments()
        .filter((environment) => state(environment.id) === 'online')
        .map((environment) => environment.id),
  }
}

const failure = (code: FleetDesktopErrorCode, message: string): FleetDesktopCallResult => ({
  ok: false,
  error: { code, message },
})
const mintDesktopId = () => 'dsk_' + randomBytes(16).toString('base64url')
const NO_HOSTS: DesktopBridgeHosts = {
  state: () => 'unavailable',
  wake: () => {},
  call: async () => failure('desktop_unavailable', 'This server cannot reach its workspaces environments.'),
  linksChanged: () => {},
  online: () => [],
}

/**
 * Routes a bot's calls to the computers, and the workspaces environments of this server, that gave it access to their
 * workspaces.
 *
 * Each computer links a bot on its own and answers only through its own event stream, which it opened: nothing ever
 * connects to a computer. A workspaces environment links a bot on its own too, with its host token, and is reached at
 * its control server, as the gateway reaches every environment. A call names one link and goes to what that link
 * names alone, its answer is accepted from there alone, and a computer or environment that cannot take it now fails
 * the call at once; nothing waits for it, and nothing else stands in for it, because the conversation and its worktree
 * exist only where they were created. The gateway keeps which computer or environment linked which bot and the name
 * it shows, never a grant, a catalog or a transcript.
 */
export class DesktopBridge {
  private readonly pending = new Map<string, Pending>()
  constructor(
    readonly store: Store,
    readonly events: EventHub,
    readonly options: { timeoutMs?: number; now?: () => number; hosts?: DesktopBridgeHosts } = {}
  ) {}
  private now() {
    return this.options.now?.() ?? Date.now()
  }
  private get hosts(): DesktopBridgeHosts {
    return this.options.hosts ?? NO_HOSTS
  }
  private link(link: StoredDesktopLink): FleetDesktopLink {
    return {
      desktopId: link.desktopId,
      name: link.name,
      kind: 'computer',
      online: this.events.bridgeOnline(link.deviceId),
      lastSeenAt: this.store.device(link.deviceId)?.lastSeenAt ?? null,
      linkedAt: link.linkedAt,
    }
  }
  private environmentLink(link: StoredEnvironmentDesktopLink): FleetDesktopLink {
    return {
      desktopId: link.desktopId,
      name: link.name,
      kind: 'environment',
      online: this.hosts.state(link.environmentId) === 'online',
      lastSeenAt: null,
      linkedAt: link.linkedAt,
    }
  }
  private active(botId: string): StoredDesktopLink[] {
    return this.store.desktopLinks(botId).filter((link) => !this.store.deviceRevoked(link.deviceId))
  }
  /** Every link of a bot, computers and environments, oldest first, each as `present` shows it. */
  private all<T>(
    botId: string,
    present: { device: (link: StoredDesktopLink) => T; environment: (link: StoredEnvironmentDesktopLink) => T }
  ): T[] {
    return [
      ...this.active(botId).map((link) => ({ link, value: present.device(link) })),
      ...this.store.environmentDesktopLinks(botId).map((link) => ({ link, value: present.environment(link) })),
    ]
      .sort(
        (a, b) => a.link.linkedAt.localeCompare(b.link.linkedAt) || a.link.desktopId.localeCompare(b.link.desktopId)
      )
      .map((entry) => entry.value)
  }
  /** The computers and environments linked to a bot, as the bot sees them. */
  links(botId: string): FleetDesktopLink[] {
    return this.all(botId, { device: (link) => this.link(link), environment: (link) => this.environmentLink(link) })
  }
  /** The same links as one of the owner's computers sees them: its own is `self`, and each environment is named. */
  views(botId: string, deviceId: string): FleetDesktopLinkView[] {
    return this.all<FleetDesktopLinkView>(botId, {
      device: (link) => ({ ...this.link(link), self: link.deviceId === deviceId }),
      environment: (link) => ({ ...this.environmentLink(link), self: false, environmentId: link.environmentId }),
    })
  }
  /** The links a workspaces environment holds, one per bot, as its own host token reads them. */
  hostLinks(environmentId: string): FleetHostDesktopLink[] {
    return this.store.desktopLinksOfEnvironment(environmentId).map((link) => ({
      ...this.environmentLink(link),
      self: true,
      environmentId,
      botId: link.botId,
    }))
  }
  private count(botId: string): number {
    return this.store.desktopLinks(botId).length + this.store.environmentDesktopLinks(botId).length
  }
  private room(botId: string, linked: boolean) {
    if (!linked && this.count(botId) >= FLEET_DESKTOP_BRIDGE_LIMITS.linksPerBotMax)
      throw new GatewayError(
        'CONFLICT',
        `A bot can be linked to at most ${FLEET_DESKTOP_BRIDGE_LIMITS.linksPerBotMax} computers and environments.`
      )
  }
  /** The asking computer links the bot under `name`, or renames its link. */
  linkDevice(botId: string, device: Device, name: string): FleetDesktopLinkView {
    const linked = this.store.desktopLinks(botId).some((link) => link.deviceId === device.id)
    this.room(botId, linked)
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
  /** The asking workspaces environment links the bot under `name`, or renames its link. */
  linkEnvironment(botId: string, environmentId: string, name: string): FleetHostDesktopLink {
    const linked = this.store.environmentDesktopLinks(botId).some((link) => link.environmentId === environmentId)
    this.room(botId, linked)
    const saved = this.store.saveEnvironmentDesktopLink(
      botId,
      environmentId,
      name,
      mintDesktopId(),
      new Date(this.now()).toISOString()
    )
    this.notify(botId)
    return { ...this.environmentLink(saved), self: true, environmentId, botId }
  }
  /** The asking workspaces environment takes back its own access. */
  unlinkEnvironment(botId: string, environmentId: string) {
    const removed = this.store.deleteEnvironmentDesktopLink(botId, environmentId)
    if (!removed) return
    this.dropCalls((call) => call.botId === botId && call.environmentId === environmentId, 'desktop_not_linked')
    this.notify(botId)
  }
  /**
   * Any of the owner's computers removes the link of another computer or of an environment; that computer revokes its
   * own side once it hears of it, and the environment is told now.
   */
  remove(botId: string, desktopId: string) {
    const target = this.store.desktopLinkById(desktopId)
    if (!target || target.link.botId !== botId) throw new GatewayError('NOT_FOUND', 'Desktop link not found')
    if (target.kind === 'device') return this.unlinkDevice(botId, target.link.deviceId)
    this.unlinkEnvironment(botId, target.link.environmentId)
    this.hosts.linksChanged(target.link.environmentId, botId)
  }
  /** Runs one call where its link names, or says at once why it cannot. */
  call(botId: string, request: FleetInternalDesktopCallRequest): Promise<FleetDesktopCallResult> {
    const target = this.store.desktopLinkById(request.desktopId)
    if (
      !target ||
      target.link.botId !== botId ||
      (target.kind === 'device' && this.store.deviceRevoked(target.link.deviceId))
    )
      return Promise.resolve(
        failure(
          'desktop_not_linked',
          'No computer or environment with this desktopId gives you access. Call desktop_list_desktops for the ones ' +
            'that do.'
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
    if (target.kind === 'environment') return this.callEnvironment(botId, target.link, request)
    const link = target.link
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
      const timer = this.timeout(callId, link.name, timeoutMs)
      this.pending.set(callId, {
        botId,
        deviceId: link.deviceId,
        environmentId: null,
        name: link.name,
        resolve,
        timer,
        abort: null,
      })
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
  /** A call for a workspaces environment: posted to its control server, which answers it in the same request. */
  private callEnvironment(
    botId: string,
    link: StoredEnvironmentDesktopLink,
    request: FleetInternalDesktopCallRequest
  ): Promise<FleetDesktopCallResult> {
    const state = this.hosts.state(link.environmentId)
    if (state !== 'online') {
      if (state === 'stopped') this.hosts.wake(link.environmentId)
      return Promise.resolve(this.notOnline(link.name, state))
    }
    const timeoutMs = this.options.timeoutMs ?? FLEET_DESKTOP_BRIDGE_LIMITS.callTimeoutMs
    const callId = randomUUID()
    const now = this.now()
    const abort = new AbortController()
    return new Promise((resolve) => {
      const timer = this.timeout(callId, link.name, timeoutMs)
      this.pending.set(callId, {
        botId,
        deviceId: null,
        environmentId: link.environmentId,
        name: link.name,
        resolve,
        timer,
        abort,
      })
      const call: FleetHostDesktopCallRequest = {
        callId,
        botId,
        desktopId: link.desktopId,
        op: request.op,
        input: request.input,
        expiresAt: new Date(now + timeoutMs).toISOString(),
      }
      this.hosts.call(link.environmentId, call, abort.signal).then(
        (result) =>
          this.settle(
            callId,
            fleetJsonBytes(result) > FLEET_DESKTOP_BRIDGE_LIMITS.resultBytesMax
              ? failure('desktop_unavailable', `"${link.name}" answered with more than can be sent. Tell your owner.`)
              : result
          ),
        () =>
          this.settle(
            callId,
            failure(
              'desktop_unavailable',
              `"${link.name}" could not run the call: the workspaces environment did not answer. Tell your owner.`
            )
          )
      )
    })
  }
  /** Why an environment takes no call now; a stopped one is starting already. */
  private notOnline(name: string, state: Exclude<DesktopHostState, 'online'>): FleetDesktopCallResult {
    switch (state) {
      case 'stopped':
        return failure(
          'desktop_offline',
          `"${name}" is a workspaces environment of this server that was stopped; it is starting now. Try again in ` +
            'about a minute with the same input.'
        )
      case 'starting':
        return failure(
          'desktop_offline',
          `"${name}" is a workspaces environment of this server that is starting or restarting now. Try again in ` +
            'about a minute with the same input.'
        )
      case 'outdated':
        return failure(
          'desktop_unavailable',
          `"${name}" runs a Maestrly that cannot take your calls yet. Tell your owner to update this server's ` +
            'workspaces environment.'
        )
      default:
        return failure(
          'desktop_offline',
          `"${name}" is not available on this server now. Tell your owner; do not move this work elsewhere on your ` +
            'own.'
        )
    }
  }
  private timeout(callId: string, name: string, timeoutMs: number): NodeJS.Timeout {
    const timer = setTimeout(
      () =>
        this.settle(
          callId,
          failure(
            'desktop_timeout',
            `"${name}" did not answer within ${Math.round(timeoutMs / 1000)} seconds. A change you asked for ` +
              'may still have happened there: retry with the same idempotencyKey and it runs there only once.'
          )
        ),
      timeoutMs
    )
    timer.unref?.()
    return timer
  }
  /** A computer answers a call it received; only the computer the call was sent to may. */
  result(callId: string, deviceId: string, result: FleetDesktopCallResult) {
    const call = this.pending.get(callId)
    if (!call) throw new GatewayError('NOT_FOUND', 'Desktop call not found or already answered')
    if (call.deviceId !== deviceId) throw new GatewayError('FORBIDDEN', 'This call was sent to another computer')
    this.settle(callId, result)
  }
  /** The calls waiting for a workspaces environment: it is in use while there are any. */
  environmentCalls(environmentId: string): number {
    let count = 0
    for (const call of this.pending.values()) if (call.environmentId === environmentId) count++
    return count
  }
  /** A revoked computer loses every link it had, and the calls waiting for it fail; the other computers are untouched. */
  revokeDevice(deviceId: string) {
    const removed = this.store.deleteDesktopLinksOfDevice(deviceId)
    this.dropCalls((call) => call.deviceId === deviceId, 'desktop_not_linked')
    for (const botId of new Set(removed.map((link) => link.botId))) this.notify(botId)
  }
  /**
   * A deleted bot: its links went with its records; every computer hears it has none left, every environment that runs
   * is told to check its own side, and its calls end.
   */
  botPurged(botId: string) {
    this.dropCalls((call) => call.botId === botId, 'desktop_not_linked')
    for (const environmentId of this.hosts.online()) this.hosts.linksChanged(environmentId, botId)
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
  /**
   * A workspaces environment started, stopped or went away: the calls waiting for one that no longer takes them fail,
   * and every computer sees its state. `formerlyLinked`: the bots whose links went with a deleted environment.
   */
  environmentChanged(environmentId: string, formerlyLinked: string[] = []) {
    if (this.hosts.state(environmentId) !== 'online')
      this.dropCalls(
        (call) => call.environmentId === environmentId,
        'desktop_offline',
        (call) =>
          `"${call.name}" stopped before it answered. A change you asked for may still have happened there: once it ` +
          'runs again, retry with the same idempotencyKey.'
      )
    const linked = this.store.desktopLinksOfEnvironment(environmentId).map((link) => link.botId)
    for (const botId of new Set([...linked, ...formerlyLinked])) this.notify(botId)
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
    // A call that ended here stops waiting for its environment's answer too.
    call.abort?.abort()
    call.resolve(result)
  }
}
