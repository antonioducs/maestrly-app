import http, { type IncomingMessage } from 'node:http'
import type { Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import {
  FLEET_INSTANCE_ROUTES,
  FLEET_PROTOCOL_HEADER,
  FLEET_PROTOCOL_VERSION,
  FLEET_SCREEN_UPGRADE,
} from '@maestrly/bot-fleet-protocol'
import { WebSocket, WebSocketServer } from 'ws'
import { token } from './auth.js'
import { GatewayError } from './errors.js'
import type { Lifecycle } from './lifecycle.js'

type Mode = 'view' | 'control'
type Ticket = { botId: string; deviceId: string; mode: Mode; expiresAt: number }
type Connection = { botId: string; deviceId: string; mode: Mode; ws: WebSocket; tcp: Socket }

export class ScreenProxy {
  readonly server = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 })
  private readonly tickets = new Map<string, Ticket>()
  private readonly connections = new Set<Connection>()
  private readonly pendingConnections = new Set<{ botId: string; deviceId: string; mode: Mode; ws: WebSocket }>()
  constructor(
    readonly lifecycle: Lifecycle,
    readonly host: (botId: string) => string = (id) => 'maestrly-bot-' + id,
    readonly instancePort = 7680,
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
    const value = new URL(req.url ?? '/', 'http://gateway').searchParams.get('ticket') ?? ''
    const ticket = this.tickets.get(value)
    this.tickets.delete(value)
    this.server.handleUpgrade(req, socket, head, (ws) => {
      ws.on('error', () => ws.terminate())
      if (
        !ticket ||
        ticket.expiresAt <= this.now() ||
        this.lifecycle.store.deviceRevoked(ticket.deviceId) ||
        this.lifecycle.get(ticket.botId)?.lifecycle !== 'running'
      ) {
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
      const pendingCount = [...this.pendingConnections].filter(
        (entry) => entry.botId === ticket.botId && entry.mode === ticket.mode
      ).length
      if (active.length + pendingCount >= (ticket.mode === 'view' ? 4 : 1)) {
        ws.close(4003, 'limit')
        return
      }
      const secret = this.lifecycle.store.botSecrets(ticket.botId)?.controlToken
      if (!secret) {
        ws.close(4003, 'ticket_invalid')
        return
      }
      const path =
        ticket.mode === 'view' ? FLEET_INSTANCE_ROUTES.screenView.path : FLEET_INSTANCE_ROUTES.screenControl.path
      const reservation = { botId: ticket.botId, deviceId: ticket.deviceId, mode: ticket.mode, ws }
      this.pendingConnections.add(reservation)
      const request = http.request({
        host: this.host(ticket.botId),
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
        const entry: Connection = { botId: ticket.botId, deviceId: ticket.deviceId, mode: ticket.mode, ws, tcp }
        this.connections.add(entry)
        const cleanup = () => {
          this.connections.delete(entry)
          tcp.destroy()
          if (ws.readyState === WebSocket.OPEN) ws.close(4002, 'bot_offline')
          if (ticket.mode === 'control') this.lifecycle.controllerChanged(ticket.botId)
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
        this.lifecycle.controllerChanged(ticket.botId)
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
    for (const entry of this.pendingConnections)
      if (entry.botId === botId && (!mode || entry.mode === mode))
        entry.ws.close(code, code === 4001 ? 'released' : 'bot_offline')
    for (const entry of [...this.connections]) {
      if (entry.botId !== botId || (mode && entry.mode !== mode)) continue
      entry.ws.close(code, code === 4001 ? 'released' : 'bot_offline')
      entry.tcp.destroy()
      this.connections.delete(entry)
    }
    this.lifecycle.controllerChanged(botId)
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
