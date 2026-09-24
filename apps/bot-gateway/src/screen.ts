import { createConnection, type Socket } from 'node:net'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { token } from './auth.js'
import { GatewayError } from './errors.js'
import type { Lifecycle } from './lifecycle.js'
import { WebSocket, WebSocketServer } from 'ws'

type Mode = 'view' | 'control'
type Ticket = { botId: string; deviceId: string; mode: Mode; expiresAt: number }
type Connection = { botId: string; mode: Mode; ws: WebSocket; tcp: Socket }

export class ScreenProxy {
  readonly server = new WebSocketServer({ noServer: true })
  private readonly tickets = new Map<string, Ticket>()
  private readonly connections = new Set<Connection>()
  constructor(
    readonly lifecycle: Lifecycle,
    readonly host: (botId: string) => string = (id) => 'maestrly-bot-' + id,
    readonly ports: { view: number; control: number } = { view: 5901, control: 5900 },
    readonly now: () => number = Date.now,
    readonly ticketTtlMs = 30000
  ) {
    lifecycle.onCloseScreens = (id, code, mode) => this.closeBot(id, code, mode)
    lifecycle.controlCount = (id) =>
      [...this.connections].filter(
        (entry) => entry.botId === id && entry.mode === 'control' && entry.ws.readyState === WebSocket.OPEN
      ).length
  }
  ticket(botId: string, deviceId: string, mode: Mode) {
    const bot = this.lifecycle.get(botId)
    if (!bot || bot.lifecycle === 'archived') throw new GatewayError('NOT_FOUND', 'Bot not found')
    if (bot.lifecycle !== 'running') throw new GatewayError('BOT_NOT_RUNNING', 'Bot not running')
    if (mode === 'control' && (bot.takeover.state !== 'human' || bot.takeover.deviceId !== deviceId))
      throw new GatewayError('FORBIDDEN', 'Takeover required for control')
    const value = token()
    const expiresAt = this.now() + this.ticketTtlMs
    this.tickets.set(value, { botId, deviceId, mode, expiresAt })
    setTimeout(() => this.tickets.delete(value), this.ticketTtlMs).unref()
    return {
      ticket: value,
      path: '/v1/screen?ticket=' + encodeURIComponent(value),
      expiresAt: new Date(expiresAt).toISOString(),
    }
  }
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    const url = new URL(req.url ?? '/', 'http://gateway')
    const value = url.searchParams.get('ticket') ?? ''
    const ticket = this.tickets.get(value)
    this.tickets.delete(value)
    this.server.handleUpgrade(req, socket, head, (ws) => {
      if (!ticket || ticket.expiresAt <= this.now() || this.lifecycle.get(ticket.botId)?.lifecycle !== 'running') {
        ws.close(4003, 'ticket_invalid')
        return
      }
      if (
        ticket.mode === 'control' &&
        (this.lifecycle.get(ticket.botId)?.takeover.state !== 'human' ||
          this.lifecycle.get(ticket.botId)?.takeover.deviceId !== ticket.deviceId)
      ) {
        ws.close(4003, 'ticket_invalid')
        return
      }
      const active = [...this.connections].filter((entry) => entry.botId === ticket.botId && entry.mode === ticket.mode)
      if (active.length >= (ticket.mode === 'view' ? 4 : 1)) {
        ws.close(4003, 'limit')
        return
      }
      const tcp = createConnection({ host: this.host(ticket.botId), port: this.ports[ticket.mode] })
      const entry: Connection = { botId: ticket.botId, mode: ticket.mode, ws, tcp }
      this.connections.add(entry)
      const cleanup = () => {
        this.connections.delete(entry)
        tcp.destroy()
        if (ws.readyState === WebSocket.OPEN) ws.close(4002, 'bot_offline')
        if (ticket.mode === 'control') this.lifecycle.controllerChanged(ticket.botId)
      }
      tcp.on('data', (chunk) => {
        if (ws.readyState !== WebSocket.OPEN) return
        ws.send(chunk, { binary: true }, (error) => {
          if (error) cleanup()
          else tcp.resume()
        })
        if (ws.bufferedAmount > 256 * 1024) tcp.pause()
      })
      ws.on('message', (data) => {
        if (!tcp.write(Buffer.from(data as Buffer))) ws.pause()
      })
      tcp.on('drain', () => ws.resume())
      tcp.on('error', cleanup)
      tcp.on('close', cleanup)
      ws.on('close', cleanup)
      this.lifecycle.controllerChanged(ticket.botId)
    })
  }
  closeBot(botId: string, code: number, mode?: Mode) {
    for (const entry of this.connections) {
      if (entry.botId !== botId || (mode && entry.mode !== mode)) continue
      entry.ws.close(code, code === 4001 ? 'released' : 'bot_offline')
      entry.tcp.destroy()
      this.connections.delete(entry)
    }
    this.lifecycle.controllerChanged(botId)
  }
  close() {
    for (const entry of this.connections) {
      entry.ws.terminate()
      entry.tcp.destroy()
    }
    this.connections.clear()
    this.server.close()
  }
}
