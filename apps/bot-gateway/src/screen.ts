import http, { type IncomingMessage } from 'node:http'
import type { Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import {
  buildPath,
  FLEET_INSTANCE_ROUTES,
  FLEET_PORTS,
  FLEET_PROTOCOL_HEADER,
  FLEET_PROTOCOL_VERSION,
  FLEET_SCREEN_UPGRADE,
  type FleetScreenSurface,
} from '@maestrly/bot-fleet-protocol'
import { WebSocket, WebSocketServer } from 'ws'
import { token } from './auth.js'
import { GatewayError } from './errors.js'
import type { Lifecycle } from './lifecycle.js'

type Mode = 'view' | 'control'
/** A bot's browser area or apps display, or the environment screen (its Maestrly settings window). */
type Surface = FleetScreenSurface | 'environment'
type Target = { environmentId: string; botId: string | null; surface: Surface }
type Ticket = Target & { deviceId: string; mode: Mode; expiresAt: number }
type Connection = Target & { deviceId: string; mode: Mode; ws: WebSocket; tcp: Socket }
type Reservation = Target & { deviceId: string; mode: Mode; ws: WebSocket }
export const SCREEN_CONTROLLED = 'Another screen in this environment is being controlled.'
export const RESTART_TO_OPEN_SCREEN = 'Restart this environment to update it before opening this screen.'
/** Browser areas and the environment screen are tiles of one display, whose pointer and keyboard they share. */
const onSharedDisplay = (surface: Surface) => surface !== 'apps'
const sameTarget = (a: Target, b: Target) =>
  a.environmentId === b.environmentId && a.botId === b.botId && a.surface === b.surface

export class ScreenProxy {
  readonly server = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 })
  private readonly tickets = new Map<string, Ticket>()
  private readonly connections = new Set<Connection>()
  private readonly pendingConnections = new Set<Reservation>()
  constructor(
    readonly lifecycle: Lifecycle,
    readonly host: (environmentId: string) => string = (id) =>
      lifecycle.store.getEnvironment(id)?.containerName ?? 'maestrly-env-' + id,
    readonly instancePort: number = FLEET_PORTS.instanceControl,
    readonly now: () => number = Date.now,
    readonly ticketTtlMs = 30000
  ) {
    lifecycle.onCloseScreens = (id, code, mode) => this.closeBot(id, code, mode)
    lifecycle.onCloseEnvironmentScreens = (id, code) => this.closeEnvironment(id, code)
    lifecycle.controlCount = (id) =>
      [...this.connections].filter(
        (entry) => entry.botId === id && entry.mode === 'control' && entry.ws.readyState === WebSocket.OPEN
      ).length
  }
  /** A ticket for a bot's browser area or apps display; control needs the device's takeover of the bot. */
  ticket(botId: string, deviceId: string, mode: Mode, surface: FleetScreenSurface = 'browser') {
    const bot = this.lifecycle.get(botId)
    if (!bot || bot.lifecycle === 'archived') throw new GatewayError('NOT_FOUND', 'Bot not found')
    if (bot.lifecycle !== 'running') throw new GatewayError('BOT_NOT_RUNNING', 'Bot not running')
    const environmentId = bot.environmentId!
    // An instance from before environments has one display, the bot's browser area.
    if (surface !== 'browser' && this.lifecycle.environmentCapable(environmentId) !== true)
      throw new GatewayError('CONFLICT', RESTART_TO_OPEN_SCREEN)
    if (mode === 'control' && (bot.takeover.state !== 'human' || bot.takeover.deviceId !== deviceId))
      throw new GatewayError('FORBIDDEN', 'Takeover required for control')
    return this.issue({ environmentId, botId, surface }, deviceId, mode)
  }
  /** A ticket for the environment screen: it shows only Maestrly's settings, so control needs no takeover. */
  environmentTicket(environmentId: string, deviceId: string, mode: Mode) {
    const environment = this.lifecycle.environment(environmentId)
    if (!environment) throw new GatewayError('NOT_FOUND', 'Environment not found')
    if (environment.lifecycle !== 'running') throw new GatewayError('BOT_NOT_RUNNING', 'Environment not running')
    if (this.lifecycle.environmentCapable(environmentId) !== true)
      throw new GatewayError('CONFLICT', RESTART_TO_OPEN_SCREEN)
    return this.issue({ environmentId, botId: null, surface: 'environment' }, deviceId, mode)
  }
  private issue(target: Target, deviceId: string, mode: Mode) {
    if (mode === 'control' && onSharedDisplay(target.surface) && this.displayControls(target).length)
      throw new GatewayError('CONFLICT', SCREEN_CONTROLLED)
    const value = token()
    const expiresAt = this.now() + this.ticketTtlMs
    this.tickets.set(value, { ...target, deviceId, mode, expiresAt })
    setTimeout(() => this.tickets.delete(value), this.ticketTtlMs).unref()
    return {
      ticket: value,
      path: '/v1/screen?ticket=' + encodeURIComponent(value),
      expiresAt: new Date(expiresAt).toISOString(),
    }
  }
  /**
   * Control sessions, open or connecting, on the environment display of `target`'s environment for another target
   * than `target` itself (a second session for the same target is refused by the per-target limit instead).
   */
  private displayControls(target: Target, includeSame = false) {
    return [...this.connections, ...this.pendingConnections].filter(
      (entry) =>
        entry.environmentId === target.environmentId &&
        entry.mode === 'control' &&
        onSharedDisplay(entry.surface) &&
        (includeSame || !sameTarget(entry, target))
    )
  }
  /** Whether a ticket may still be used: its environment runs and, for a bot surface, its bot runs there. */
  private usable(ticket: Ticket): boolean {
    if (this.lifecycle.store.deviceRevoked(ticket.deviceId)) return false
    const environment = this.lifecycle.environment(ticket.environmentId)
    if (environment?.lifecycle !== 'running') return false
    if (ticket.botId === null) return true
    const bot = this.lifecycle.get(ticket.botId)
    if (bot?.lifecycle !== 'running' || bot.environmentId !== ticket.environmentId) return false
    return ticket.mode === 'view' || (bot.takeover.state === 'human' && bot.takeover.deviceId === ticket.deviceId)
  }
  /** The instance's screen route for a ticket; an instance from before environments has only the bot's browser. */
  private upstreamPath(ticket: Ticket): string | null {
    const view = ticket.mode === 'view'
    if (this.lifecycle.environmentCapable(ticket.environmentId) !== true)
      return ticket.surface === 'browser'
        ? view
          ? FLEET_INSTANCE_ROUTES.screenView.path
          : FLEET_INSTANCE_ROUTES.screenControl.path
        : null
    if (ticket.botId === null)
      return view
        ? FLEET_INSTANCE_ROUTES.environmentScreenView.path
        : FLEET_INSTANCE_ROUTES.environmentScreenControl.path
    return buildPath(view ? FLEET_INSTANCE_ROUTES.botScreenView.path : FLEET_INSTANCE_ROUTES.botScreenControl.path, {
      botId: ticket.botId,
      surface: ticket.surface,
    })
  }
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    const value = new URL(req.url ?? '/', 'http://gateway').searchParams.get('ticket') ?? ''
    const ticket = this.tickets.get(value)
    this.tickets.delete(value)
    this.server.handleUpgrade(req, socket, head, (ws) => {
      ws.on('error', () => ws.terminate())
      if (!ticket || ticket.expiresAt <= this.now() || !this.usable(ticket)) {
        ws.close(4003, 'ticket_invalid')
        return
      }
      const same = [...this.connections, ...this.pendingConnections].filter(
        (entry) => sameTarget(entry, ticket) && entry.mode === ticket.mode
      ).length
      // Tickets can be issued while the display is free and used later: the display is checked again on use.
      if (
        same >= (ticket.mode === 'view' ? 4 : 1) ||
        (ticket.mode === 'control' && onSharedDisplay(ticket.surface) && this.displayControls(ticket, true).length)
      ) {
        ws.close(4003, 'limit')
        return
      }
      const secret = this.lifecycle.store.environmentSecrets(ticket.environmentId)?.controlToken
      const path = this.upstreamPath(ticket)
      if (!secret || !path) {
        ws.close(4003, 'ticket_invalid')
        return
      }
      const target: Target = { environmentId: ticket.environmentId, botId: ticket.botId, surface: ticket.surface }
      // Reserved before connecting upstream, so a concurrent use of another ticket sees it.
      const reservation: Reservation = { ...target, deviceId: ticket.deviceId, mode: ticket.mode, ws }
      this.pendingConnections.add(reservation)
      const request = http.request({
        host: this.host(ticket.environmentId),
        port: this.instancePort,
        path,
        method: 'GET',
        headers: {
          [FLEET_PROTOCOL_HEADER]: String(FLEET_PROTOCOL_VERSION),
          Authorization: 'Bearer ' + secret,
          Connection: 'Upgrade',
          Upgrade: FLEET_SCREEN_UPGRADE,
        },
      })
      let connected = false
      let relay: Socket | null = null
      const pending: Buffer[] = []
      ws.on('message', (data) => {
        const bytes = Buffer.from(data as Buffer)
        if (relay) {
          if (!relay.write(bytes)) ws.pause()
        } else if (pending.reduce((size, item) => size + item.length, 0) + bytes.length <= 256 * 1024)
          pending.push(bytes)
        else ws.close(4003, 'limit')
      })
      const controllerChanged = () => {
        if (ticket.botId !== null && ticket.mode === 'control') this.lifecycle.controllerChanged(ticket.botId)
      }
      const fail = () => {
        this.pendingConnections.delete(reservation)
        if (!connected && ws.readyState === WebSocket.OPEN) ws.close(4002, 'bot_offline')
      }
      request.on('response', fail)
      request.on('error', fail)
      request.on('upgrade', (response, tcp, extra) => {
        this.pendingConnections.delete(reservation)
        if (ws.readyState !== WebSocket.OPEN) {
          tcp.destroy()
          return
        }
        if (response.headers.upgrade?.toLowerCase() !== FLEET_SCREEN_UPGRADE) {
          tcp.destroy()
          fail()
          return
        }
        connected = true
        relay = tcp
        for (const bytes of pending) if (!tcp.write(bytes)) ws.pause()
        pending.length = 0
        const entry: Connection = { ...target, deviceId: ticket.deviceId, mode: ticket.mode, ws, tcp }
        this.connections.add(entry)
        const cleanup = () => {
          this.connections.delete(entry)
          tcp.destroy()
          if (ws.readyState === WebSocket.OPEN) ws.close(4002, 'bot_offline')
          controllerChanged()
        }
        const send = (chunk: Buffer) => {
          if (ws.readyState !== WebSocket.OPEN) return
          ws.send(chunk, { binary: true }, (error) => {
            if (error) cleanup()
            else tcp.resume()
          })
          if (ws.bufferedAmount > 256 * 1024) tcp.pause()
        }
        if (extra.length) send(extra)
        tcp.on('data', send)
        tcp.on('drain', () => ws.resume())
        tcp.on('error', cleanup)
        tcp.on('close', cleanup)
        ws.on('close', cleanup)
        if (ticket.botId !== null) this.lifecycle.controllerChanged(ticket.botId)
      })
      ws.on('close', () => {
        this.pendingConnections.delete(reservation)
        request.destroy()
      })
      request.end()
    })
  }
  closeDevice(deviceId: string) {
    for (const entry of this.pendingConnections) if (entry.deviceId === deviceId) entry.ws.close(4003, 'ticket_invalid')
    for (const [value, ticket] of this.tickets) if (ticket.deviceId === deviceId) this.tickets.delete(value)
    for (const entry of [...this.connections])
      if (entry.deviceId === deviceId) {
        entry.ws.close(4003, 'ticket_invalid')
        entry.tcp.destroy()
        this.connections.delete(entry)
      }
  }
  closeBot(botId: string, code: number, mode?: Mode) {
    this.closeWhere((entry) => entry.botId === botId && (!mode || entry.mode === mode), code)
    this.lifecycle.controllerChanged(botId)
  }
  /** Closes every screen of an environment: its container stops or goes away. */
  closeEnvironment(environmentId: string, code: number) {
    this.closeWhere((entry) => entry.environmentId === environmentId, code)
  }
  private closeWhere(matches: (entry: Target & { mode: Mode }) => boolean, code: number) {
    const reason = code === 4001 ? 'released' : 'bot_offline'
    for (const entry of this.pendingConnections) if (matches(entry)) entry.ws.close(code, reason)
    for (const entry of [...this.connections]) {
      if (!matches(entry)) continue
      entry.ws.close(code, reason)
      entry.tcp.destroy()
      this.connections.delete(entry)
    }
  }
  close() {
    for (const entry of this.pendingConnections) entry.ws.terminate()
    this.pendingConnections.clear()
    for (const entry of this.connections) {
      entry.ws.terminate()
      entry.tcp.destroy()
    }
    this.connections.clear()
    this.server.close()
  }
}
