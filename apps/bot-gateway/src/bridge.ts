import http from 'node:http'
import type { Duplex } from 'node:stream'
import {
  FLEET_BRIDGE_LIMITS,
  FLEET_GATEWAY_ROUTES,
  FLEET_INSTANCE_BRIDGE_PATH,
  FLEET_PORTS,
  FLEET_PROTOCOL_HEADER,
  FLEET_PROTOCOL_VERSION,
  type FleetBridgeTicketResponse,
} from '@maestrly/bot-fleet-protocol'
import { token } from './auth.js'
import type { Lifecycle } from './lifecycle.js'

type Ticket = { environmentId: string; deviceId: string; expiresAt: number }

export interface BridgeProxyDeps {
  now: () => number
  token: () => string
  /** Where the control server of a running workspaces environment listens, or null when it has none now. */
  host: (environmentId: string) => string | null
  /** The control token of the environment, which never leaves the gateway. */
  secret: (environmentId: string) => string | null
  deviceActive: (deviceId: string) => boolean
  instancePort: number
}

/** What a gateway's bridge proxy reads from its lifecycle and store. */
export function lifecycleBridgeDeps(lifecycle: Lifecycle): BridgeProxyDeps {
  return {
    now: Date.now,
    token,
    host: (id) => {
      const environment = lifecycle.store.getEnvironment(id)
      return environment?.kind === 'workspaces' && environment.lifecycle === 'running' && !environment.archivedAt
        ? environment.containerName
        : null
    },
    secret: (id) => lifecycle.store.environmentSecrets(id)?.controlToken ?? null,
    deviceActive: (id) => !lifecycle.store.deviceRevoked(id),
    instancePort: FLEET_PORTS.instanceControl,
  }
}

// What a WebSocket client and server agree on in the handshake; the gateway passes these through untouched.
const HANDSHAKE_HEADERS = [
  'sec-websocket-key',
  'sec-websocket-version',
  'sec-websocket-protocol',
  'sec-websocket-extensions',
]

/**
 * The bridge between a paired computer and a workspaces environment. The computer asks for a one-use ticket with its
 * device token, then opens a WebSocket with the ticket. The gateway does not take part in that WebSocket: it forwards
 * the handshake to the environment's control server, adding the control token, and then passes bytes both ways. What
 * the two ends say to each other is theirs (Maestrly's bridge protocol between the two desktops).
 */
export class BridgeProxy {
  private readonly tickets = new Map<string, Ticket>()
  private readonly open = new Map<Duplex, { deviceId: string; environmentId: string; upstream: Duplex | null }>()

  constructor(private readonly deps: BridgeProxyDeps) {}

  ticket(environmentId: string, deviceId: string): FleetBridgeTicketResponse {
    const value = this.deps.token()
    const expiresAt = this.deps.now() + FLEET_BRIDGE_LIMITS.ticketTtlMs
    this.tickets.set(value, { environmentId, deviceId, expiresAt })
    setTimeout(() => this.tickets.delete(value), FLEET_BRIDGE_LIMITS.ticketTtlMs).unref()
    return {
      ticket: value,
      path: FLEET_GATEWAY_ROUTES.bridge.path + '?ticket=' + encodeURIComponent(value),
      expiresAt: new Date(expiresAt).toISOString(),
    }
  }

  upgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    socket.on('error', () => socket.destroy())
    const reject = (status: number, text: string): void => {
      if (!socket.destroyed) socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
    }
    const value = new URL(req.url ?? '/', 'http://gateway').searchParams.get('ticket') ?? ''
    const ticket = this.tickets.get(value)
    // One use: a ticket is spent whether or not the upgrade then succeeds.
    this.tickets.delete(value)
    if (!ticket || ticket.expiresAt <= this.deps.now() || !this.deps.deviceActive(ticket.deviceId))
      return reject(403, 'Forbidden')
    if (req.headers.upgrade?.toLowerCase() !== 'websocket') return reject(400, 'Bad Request')
    const held = [...this.open.values()].filter((entry) => entry.deviceId === ticket.deviceId).length
    if (held >= FLEET_BRIDGE_LIMITS.perDevice) return reject(429, 'Too Many Requests')
    const host = this.deps.host(ticket.environmentId)
    const secret = this.deps.secret(ticket.environmentId)
    if (!host || !secret) return reject(503, 'Service Unavailable')

    // Counted from here, so that upgrades still connecting upstream also count against the device's limit.
    const entry = { deviceId: ticket.deviceId, environmentId: ticket.environmentId, upstream: null as Duplex | null }
    this.open.set(socket, entry)
    const done = (): void => {
      this.open.delete(socket)
      entry.upstream?.destroy()
      socket.destroy()
    }
    socket.on('close', done)

    const headers: Record<string, string> = {
      [FLEET_PROTOCOL_HEADER]: String(FLEET_PROTOCOL_VERSION),
      Authorization: 'Bearer ' + secret,
      Connection: 'Upgrade',
      Upgrade: 'websocket',
    }
    for (const name of HANDSHAKE_HEADERS) {
      const header = req.headers[name]
      if (typeof header === 'string') headers[name] = header
    }
    const upstream = http.request({
      host,
      port: this.deps.instancePort,
      path: FLEET_INSTANCE_BRIDGE_PATH,
      method: 'GET',
      headers,
    })
    const fail = (): void => {
      reject(502, 'Bad Gateway')
      this.open.delete(socket)
    }
    upstream.on('upgrade', (response, tcp, extra) => {
      if (socket.destroyed) return void tcp.destroy()
      entry.upstream = tcp
      const lines = ['HTTP/1.1 101 Switching Protocols']
      for (let index = 0; index < response.rawHeaders.length; index += 2)
        lines.push(`${response.rawHeaders[index]}: ${response.rawHeaders[index + 1]}`)
      socket.write(lines.join('\r\n') + '\r\n\r\n')
      if (extra.length) socket.write(extra)
      if (head.length) tcp.write(head)
      tcp.on('error', done)
      tcp.on('close', done)
      socket.pipe(tcp).pipe(socket)
    })
    // The environment answered without upgrading (it refused, or it is not a workspaces host).
    upstream.on('response', (response) => {
      response.resume()
      fail()
    })
    upstream.on('error', fail)
    upstream.end()
  }

  /** A revoked device loses its tickets and its open bridges. */
  closeDevice(deviceId: string): void {
    for (const [value, ticket] of this.tickets) if (ticket.deviceId === deviceId) this.tickets.delete(value)
    for (const [socket, entry] of this.open) if (entry.deviceId === deviceId) socket.destroy()
  }

  /** The environment's container stops or goes away. */
  closeEnvironment(environmentId: string): void {
    for (const [value, ticket] of this.tickets) if (ticket.environmentId === environmentId) this.tickets.delete(value)
    for (const [socket, entry] of this.open) if (entry.environmentId === environmentId) socket.destroy()
  }

  close(): void {
    this.tickets.clear()
    for (const socket of [...this.open.keys()]) socket.destroy()
  }
}
