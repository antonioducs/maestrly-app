import {
  FLEET_DESKTOP_BRIDGE_LIMITS,
  fleetJsonBytes,
  type FleetDesktopCallEvent,
  type FleetDesktopCallResult,
  type FleetDesktopErrorCode,
  type FleetDesktopLinkView,
  type FleetDesktopOp,
  type FleetGatewayEvent,
} from '@maestrly/bot-fleet-protocol'
import { ZodError } from 'zod'
import type { FleetBotGrantInput } from '../../bot/host'
import type { BotLocalConnection } from '../../bot/local-service'
import type { FleetDesktopAccessInput, FleetDesktopAccessView } from '../../../shared/fleet-desktop-access'

/** Each op a bot may ask is the conversation tool of the same name that the local bot service runs. */
export const DESKTOP_OP_TOOLS: Record<FleetDesktopOp, string> = {
  listWorkspaces: 'bot_list_workspaces',
  listSelections: 'bot_list_selections',
  listChats: 'bot_list_chats',
  readChat: 'bot_read_chat',
  readChatHistory: 'bot_read_chat_history',
  waitEvents: 'bot_wait_events',
  createChat: 'bot_create_chat',
  sendMessage: 'bot_send_message',
  configureChat: 'bot_configure_chat',
  cancelTurn: 'bot_cancel_turn',
  answerQuestion: 'bot_answer_question',
}

/** Where the bridge reaches the bot server this computer paired with. */
export interface DesktopBridgeGateway {
  /** The device this computer paired as; null while unpaired. */
  deviceId(): string | null
  /** The name this computer paired under. */
  deviceName(): string | null
  /** Whether the server and the bot both have the desktop bridge, or what is missing. */
  availability(botId: string): FleetDesktopAccessView['availability']
  botName(botId: string): string | null
  /** The bot's links, this computer's marked `self`; null when the bot no longer exists. */
  links(botId: string): Promise<FleetDesktopLinkView[] | null>
  link(botId: string, name: string): Promise<FleetDesktopLinkView>
  unlink(botId: string): Promise<void>
  remove(botId: string, desktopId: string): Promise<void>
  answer(callId: string, result: FleetDesktopCallResult): Promise<void>
}

/** What the bridge uses of the local bot host: its connections, grants, ceiling and tools. */
export interface DesktopBridgeHost {
  fleetConnections(prefix: string): BotLocalConnection[]
  saveFleetConnection(
    prefix: string,
    input: FleetBotGrantInput
  ): Promise<{ connection: BotLocalConnection; created: boolean }>
  revokeFleetConnection(connectionId: string): Promise<void>
  callFleetTool(
    connectionId: string,
    name: string,
    input: Record<string, unknown>,
    signal: AbortSignal
  ): Promise<unknown>
  localDesktopId(): string
}

/** The client id prefix of the connections one fleet bot holds through one pairing. */
export const fleetClientPrefix = (deviceId: string, botId: string) => `fleet:${deviceId}:${botId}:`
const botOfClientId = (clientId: string) => clientId.split(':')[2] ?? ''

const failure = (code: FleetDesktopErrorCode, message: string): FleetDesktopCallResult => ({
  ok: false,
  error: { code, message: message.slice(0, 1_000) },
})

/**
 * Answers a fleet bot's calls on this computer, and keeps this computer's links to fleet bots in step.
 *
 * A call arrives on this computer's own event stream and runs as the conversation tool of that name, under the
 * connection this computer holds for that bot: its grants, ceiling, idempotency and worktrees are this computer's alone, and
 * nothing here can approve a permission or a plan. A call addressed to another computer is ignored, one that arrives after
 * the server gave up is not run, and a bot this computer no longer gives access to is told so. Access exists only while both
 * sides agree: the link on the server and the connection here; whichever is missing takes the other with it.
 */
export class FleetDesktopBridge {
  private readonly chains = new Map<string, Promise<unknown>>()
  /** This computer's own link per bot, as the server last said; absent when not known yet. */
  private readonly selfLinks = new Map<string, FleetDesktopLinkView | null>()
  private readonly seen = new Set<string>()
  private abort = new AbortController()

  constructor(
    private readonly gateway: DesktopBridgeGateway,
    private readonly host: DesktopBridgeHost,
    private readonly notify: (botId: string) => void = () => {},
    private readonly now: () => number = Date.now
  ) {}

  /** The connection this computer holds for a bot through its current pairing, if any. */
  private active(botId: string): BotLocalConnection | null {
    const deviceId = this.gateway.deviceId()
    if (!deviceId) return null
    return this.host.fleetConnections(fleetClientPrefix(deviceId, botId)).find((item) => !item.revokedAt) ?? null
  }

  /** Runs `work` after every earlier change of the same bot, so links and connections never race each other. */
  private serial<T>(botId: string, work: () => Promise<T>): Promise<T> {
    const run = (this.chains.get(botId) ?? Promise.resolve()).then(work, work)
    const settled = run.then(
      () => undefined,
      () => undefined
    )
    this.chains.set(botId, settled)
    void settled.then(() => {
      if (this.chains.get(botId) === settled) this.chains.delete(botId)
    })
    return run
  }

  /** A gateway event for the bridge; returns whether it was one. */
  handle(event: FleetGatewayEvent): boolean {
    if (event.type === 'desktop.call') {
      void this.call(event)
      return true
    }
    if (event.type === 'desktop_link.updated') {
      void this.links(event.botId, event.links)
      return true
    }
    return false
  }

  async call(event: FleetDesktopCallEvent): Promise<void> {
    if (this.seen.has(event.callId)) return
    this.seen.add(event.callId)
    if (this.seen.size > 1_000) this.seen.delete(this.seen.values().next().value as string)
    const remaining = Date.parse(event.expiresAt) - this.now()
    // The server stopped waiting: running it now would change something nobody hears about.
    if (!(remaining > 0)) return
    const answer = (result: FleetDesktopCallResult) => this.gateway.answer(event.callId, result).catch(() => undefined)
    const connection = this.active(event.botId)
    if (!connection) {
      await answer(failure('desktop_not_linked', 'This computer no longer gives you access.'))
      void this.reconcile(event.botId)
      return
    }
    const self = await this.selfLink(event.botId)
    // Not addressed to this computer: it is never answered from here.
    if (!self || self.desktopId !== event.desktopId) return
    const tool = DESKTOP_OP_TOOLS[event.op]
    const signal = AbortSignal.any([AbortSignal.timeout(remaining), this.abort.signal])
    let result: FleetDesktopCallResult
    try {
      const value = await this.host.callFleetTool(connection.id, tool, event.input, signal)
      result = { ok: true, value: this.present(value, self) }
      if (fleetJsonBytes(result) > FLEET_DESKTOP_BRIDGE_LIMITS.resultBytesMax - 4_096)
        result = failure(
          'desktop_unavailable',
          'The answer is too large to send. Read the conversation page by page with desktop_read_chat_history.'
        )
    } catch (error) {
      result = this.failed(error)
    }
    await answer(result)
  }

  /** A failure as the bot may read it: the computer's own refusals word for word, anything else without detail. */
  private failed(error: unknown): FleetDesktopCallResult {
    if (error instanceof ZodError)
      return failure(
        'desktop_refused',
        'Invalid input: ' +
          error.issues.map((issue) => `${issue.path.join('.') || 'input'} ${issue.message}`).join('; ')
      )
    if (error instanceof Error && error.name === 'BotLocalError') return failure('desktop_refused', error.message)
    return failure('desktop_unavailable', 'This computer could not run the call. Tell your owner.')
  }

  /** What a bot reads names this computer by the id and name it knows it by, never by this computer's own id. */
  private present(value: unknown, self: FleetDesktopLinkView): unknown {
    const local = this.host.localDesktopId()
    const rewrite = (item: unknown): unknown => {
      if (item === local) return self.desktopId
      if (Array.isArray(item)) return item.map(rewrite)
      if (item && typeof item === 'object')
        return Object.fromEntries(Object.entries(item).map(([key, entry]) => [key, rewrite(entry)]))
      return item
    }
    const presented = rewrite(value)
    if (presented && typeof presented === 'object' && !Array.isArray(presented) && 'desktop' in presented)
      return { ...presented, desktop: { id: self.desktopId, name: self.name } }
    return presented
  }

  private async selfLink(botId: string): Promise<FleetDesktopLinkView | null> {
    const known = this.selfLinks.get(botId)
    if (known) return known
    const links = await this.gateway.links(botId).catch(() => undefined)
    if (links === undefined) return null
    const self = links?.find((link) => link.self) ?? null
    this.selfLinks.set(botId, self)
    return self
  }

  /** The server says what a bot's links are now; when that disagrees with this computer, it is confirmed before acting. */
  links(botId: string, links: FleetDesktopLinkView[]): Promise<void> {
    return this.serial(botId, async () => {
      const self = links.find((link) => link.self) ?? null
      const connection = this.active(botId)
      if (self && connection) this.selfLinks.set(botId, self)
      // An event may predate this computer's own last change: the server is asked again rather than trusted.
      else if (self || connection) await this.reconcileNow(botId)
      else this.selfLinks.set(botId, null)
      this.notify(botId)
    })
  }

  /** Brings a bot's link on the server and its connection here back in agreement. */
  reconcile(botId: string): Promise<void> {
    return this.serial(botId, () => this.reconcileNow(botId))
  }

  private async reconcileNow(botId: string): Promise<void> {
    let links: FleetDesktopLinkView[] | null
    try {
      links = await this.gateway.links(botId)
    } catch {
      // The server cannot say now; nothing changes until it can.
      return
    }
    const self = links?.find((link) => link.self) ?? null
    const connection = this.active(botId)
    if (self && !connection) {
      await this.gateway.unlink(botId).catch(() => undefined)
      this.selfLinks.set(botId, null)
    } else if (!self && connection) {
      // Removed from another computer, by deleting the bot, or by revoking this computer on the server.
      await this.host.revokeFleetConnection(connection.id)
      this.selfLinks.set(botId, null)
    } else this.selfLinks.set(botId, self)
    this.notify(botId)
  }

  /**
   * Once connected: connections of an earlier pairing of this computer are revoked, and each bot this computer gives access to
   * is checked against the server, which may have removed it while this computer was away.
   */
  async connected(): Promise<void> {
    const deviceId = this.gateway.deviceId()
    if (!deviceId) return
    this.selfLinks.clear()
    const current = `fleet:${deviceId}:`
    const live = this.host.fleetConnections('fleet:').filter((connection) => !connection.revokedAt)
    for (const connection of live)
      if (!connection.clientId.startsWith(current)) await this.host.revokeFleetConnection(connection.id)
    const bots = new Set(
      live.filter((connection) => connection.clientId.startsWith(current)).map((c) => botOfClientId(c.clientId))
    )
    await Promise.all([...bots].map((botId) => this.reconcile(botId)))
  }

  /** This computer unpairs: every access it gave through that pairing ends here too. */
  async unpaired(deviceId: string): Promise<void> {
    this.abort.abort()
    this.abort = new AbortController()
    this.selfLinks.clear()
    for (const connection of this.host.fleetConnections(`fleet:${deviceId}:`))
      if (!connection.revokedAt) await this.host.revokeFleetConnection(connection.id)
  }

  /** One bot's access to computers, as the bot's settings on this computer show it. */
  async state(botId: string): Promise<FleetDesktopAccessView> {
    const defaultName = (this.gateway.deviceName() ?? '').slice(0, FLEET_DESKTOP_BRIDGE_LIMITS.nameMax) || 'Computer'
    const availability = this.gateway.availability(botId)
    const links = availability === 'ready' ? await this.gateway.links(botId).catch(() => null) : null
    const self = links?.find((link) => link.self) ?? null
    if (links) this.selfLinks.set(botId, self)
    const connection = this.active(botId)
    return {
      availability,
      access: connection
        ? {
            macName: self?.name ?? defaultName,
            workspaceIds: connection.workspaceIds,
            actions: connection.actions,
            selections: connection.selections ?? [],
            permissionCeiling: connection.permissionCeiling,
          }
        : null,
      links,
      defaultName,
    }
  }

  /** Gives a bot access to this computer, or changes it; the server learns this computer's name for the bot. */
  save(botId: string, input: FleetDesktopAccessInput): Promise<FleetDesktopAccessView> {
    return this.serial(botId, async () => {
      const deviceId = this.gateway.deviceId()
      const availability = this.gateway.availability(botId)
      if (!deviceId || availability !== 'ready')
        throw new Error(
          availability === 'disconnected'
            ? 'Connect this computer to the bot server first.'
            : 'Update the bot server and restart this bot before giving it access to this computer.'
        )
      const { connection, created } = await this.host.saveFleetConnection(fleetClientPrefix(deviceId, botId), {
        name: this.gateway.botName(botId) ?? botId,
        workspaceIds: input.workspaceIds,
        actions: input.actions,
        providerIds: [...new Set(input.selections.map((selection) => selection.providerId))],
        selections: input.selections,
        permissionCeiling: input.permissionCeiling,
      })
      try {
        this.selfLinks.set(botId, await this.gateway.link(botId, input.macName))
      } catch (error) {
        // Never leave access here that the server does not know about.
        if (created) await this.host.revokeFleetConnection(connection.id)
        throw error
      }
      this.notify(botId)
    }).then(() => this.state(botId))
  }

  /** Takes this computer's access back: at once here, then on the server (a later check finishes it if that fails). */
  disable(botId: string): Promise<FleetDesktopAccessView> {
    return this.serial(botId, async () => {
      const connection = this.active(botId)
      if (connection) await this.host.revokeFleetConnection(connection.id)
      this.selfLinks.set(botId, null)
      await this.gateway.unlink(botId).catch(() => undefined)
      this.notify(botId)
    }).then(() => this.state(botId))
  }

  /** Removes another computer's link; that computer revokes its own side when it hears of it. */
  async removeOther(botId: string, desktopId: string): Promise<FleetDesktopAccessView> {
    const self = await this.selfLink(botId)
    if (self?.desktopId === desktopId) throw new Error('Turn off the access of this computer instead.')
    await this.gateway.remove(botId, desktopId)
    this.notify(botId)
    return this.state(botId)
  }

  stop(): void {
    this.abort.abort()
    this.abort = new AbortController()
  }
}
