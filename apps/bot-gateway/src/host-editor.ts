import http, { type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import {
  FLEET_HOST_EDITOR_FEATURE,
  FLEET_HOST_EDITOR_GATEWAY_ERRORS,
  FLEET_HOST_EDITOR_LIMITS,
  FLEET_INSTANCE_EDITOR_PREFIX,
  FLEET_PROTOCOL_HEADER,
  FLEET_PROTOCOL_VERSION,
} from '@maestrly/bot-fleet-protocol'
import { lifecycleBridgeDeps } from './bridge.js'
import { GatewayError } from './errors.js'
import { endToEnd, upstreamHeaders } from './forward-headers.js'
import type { Lifecycle } from './lifecycle.js'

export interface HostEditorProxyDeps {
  host: (environmentId: string) => string | null
  secret: (environmentId: string) => string | null
  /** Whether the environment's Maestrly serves its editor. */
  supports: (environmentId: string) => boolean
  instancePort: number
  /** An HTTP request whose environment says nothing for this long is cut. */
  idleTimeoutMs: number
  /** Editor WebSockets one device may hold open at once. */
  socketsPerDevice: number
}

/** What a gateway's editor proxy reads from its lifecycle and store: the same container the bridge reaches. */
export function lifecycleHostEditorDeps(lifecycle: Lifecycle): HostEditorProxyDeps {
  const bridge = lifecycleBridgeDeps(lifecycle)
  return {
    host: bridge.host,
    secret: bridge.secret,
    instancePort: bridge.instancePort,
    supports: (id) => lifecycle.environmentCapabilities(id).includes(FLEET_HOST_EDITOR_FEATURE),
    idleTimeoutMs: FLEET_HOST_EDITOR_LIMITS.idleTimeoutMs,
    socketsPerDevice: FLEET_HOST_EDITOR_LIMITS.socketsPerDevice,
  }
}

// What only the device and the gateway share: never forwarded to the environment. The editor's cookies are its own and
// pass through.
const CALLER_HEADERS = ['authorization', 'host', 'origin', FLEET_PROTOCOL_HEADER.toLowerCase()]
const WEBSOCKET_HEADERS = [
  'sec-websocket-key',
  'sec-websocket-version',
  'sec-websocket-protocol',
  'sec-websocket-extensions',
]

type Request = { deviceId: string; environmentId: string; request: IncomingMessage; response: ServerResponse }
type Socket = { deviceId: string; environmentId: string; upstream: Duplex | null }

function headerLines(statusLine: string, rawHeaders: string[]): string {
  const lines = [statusLine]
  for (let index = 0; index < rawHeaders.length; index += 2)
    lines.push(`${rawHeaders[index]}: ${rawHeaders[index + 1]}`)
  return lines.join('\r\n') + '\r\n\r\n'
}

/**
 * The editor of a paired device's workspaces environment (VS Code's serve-web, behind the environment's control
 * server), passed through as it is: requests, WebSocket upgrades, cookies and answers stream untouched, with the
 * environment's control token in place of the device's. The gateway only checks who asks and bounds how many editor
 * connections a device holds; the host adds the editor's own token, which never leaves the environment.
 */
export class HostEditorProxy {
  private readonly requests = new Set<Request>()
  private readonly sockets = new Map<Duplex, Socket>()

  constructor(private readonly deps: HostEditorProxyDeps) {}

  /** The environment's control server and token, or why the editor cannot be reached now. */
  private target(environmentId: string): { host: string; secret: string } {
    const host = this.deps.host(environmentId)
    const secret = this.deps.secret(environmentId)
    if (!host || !secret) throw new GatewayError('CONFLICT', FLEET_HOST_EDITOR_GATEWAY_ERRORS.notRunning)
    if (!this.deps.supports(environmentId))
      throw new GatewayError('CONFLICT', FLEET_HOST_EDITOR_GATEWAY_ERRORS.updateHost)
    return { host, secret }
  }

  private headers(request: IncomingMessage, secret: string): OutgoingHttpHeaders {
    const headers = upstreamHeaders(request)
    for (const name of CALLER_HEADERS) delete headers[name]
    headers[FLEET_PROTOCOL_HEADER] = String(FLEET_PROTOCOL_VERSION)
    headers.authorization = 'Bearer ' + secret
    return headers
  }

  /** An HTTP request for `editorPath` (path and query of the editor) of the device's environment. */
  forward(
    environmentId: string,
    editorPath: string,
    request: IncomingMessage,
    response: ServerResponse,
    deviceId: string
  ): Promise<void> {
    const { host, secret } = this.target(environmentId)
    const entry: Request = { deviceId, environmentId, request, response }
    this.requests.add(entry)
    return new Promise<void>((resolve) => {
      const upstream = http.request({
        host,
        port: this.deps.instancePort,
        method: request.method,
        path: FLEET_INSTANCE_EDITOR_PREFIX + editorPath,
        headers: this.headers(request, secret),
        agent: false,
      })
      upstream.setTimeout(this.deps.idleTimeoutMs, () => upstream.destroy(new Error('The editor went silent')))
      upstream.on('response', (incoming) => {
        response.writeHead(incoming.statusCode ?? 502, endToEnd(incoming.headers))
        incoming.on('error', () => response.destroy())
        incoming.on('aborted', () => response.destroy())
        incoming.pipe(response)
      })
      upstream.on('error', () => {
        if (response.headersSent) return void response.destroy()
        response.writeHead(503, {
          'Content-Type': 'application/json; charset=utf-8',
          'X-Content-Type-Options': 'nosniff',
        })
        response.end(
          JSON.stringify({ code: 'INSTANCE_UNAVAILABLE', message: 'The workspaces environment did not answer.' })
        )
      })
      response.on('close', () => {
        if (!response.writableFinished) upstream.destroy()
        this.requests.delete(entry)
        resolve()
      })
      request.on('aborted', () => upstream.destroy())
      request.pipe(upstream)
    })
  }

  /**
   * A WebSocket upgrade for `editorPath` of the device's environment. What makes it impossible now is thrown before
   * anything is written; the environment's own refusal is passed back as it answered.
   */
  upgrade(
    environmentId: string,
    editorPath: string,
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    deviceId: string
  ): void {
    if (request.headers.upgrade?.toLowerCase() !== 'websocket')
      throw new GatewayError('INVALID_REQUEST', 'WebSocket upgrade required')
    const { host, secret } = this.target(environmentId)
    const held = [...this.sockets.values()].filter((entry) => entry.deviceId === deviceId).length
    if (held >= this.deps.socketsPerDevice)
      throw new GatewayError('RATE_LIMITED', FLEET_HOST_EDITOR_GATEWAY_ERRORS.tooManySockets)

    // Counted from here, so that upgrades still connecting upstream also count against the device's limit.
    const entry: Socket = { deviceId, environmentId, upstream: null }
    this.sockets.set(socket, entry)
    const done = (): void => {
      this.sockets.delete(socket)
      entry.upstream?.destroy()
      socket.destroy()
    }
    socket.on('error', done)
    socket.on('close', done)

    const headers = this.headers(request, secret)
    headers.connection = 'Upgrade'
    headers.upgrade = 'websocket'
    for (const name of WEBSOCKET_HEADERS) {
      const value = request.headers[name]
      if (typeof value === 'string') headers[name] = value
    }
    const upstream = http.request({
      host,
      port: this.deps.instancePort,
      method: 'GET',
      path: FLEET_INSTANCE_EDITOR_PREFIX + editorPath,
      headers,
      agent: false,
    })
    upstream.on('upgrade', (incoming, tcp, extra) => {
      if (socket.destroyed) return void tcp.destroy()
      entry.upstream = tcp
      socket.write(headerLines(`HTTP/1.1 101 ${incoming.statusMessage || 'Switching Protocols'}`, incoming.rawHeaders))
      if (extra.length) socket.write(extra)
      if (head.length) tcp.write(head)
      tcp.on('error', done)
      tcp.on('close', done)
      socket.pipe(tcp).pipe(socket)
    })
    // The environment answered without upgrading: its refusal goes back as it is.
    upstream.on('response', (incoming) => {
      if (socket.destroyed) return void incoming.resume()
      // The body is written as Node decoded it, so it ends with the connection instead of its own framing.
      const raw = incoming.rawHeaders.filter((_, index, all) => {
        const name = (index % 2 === 0 ? all[index] : all[index - 1]).toLowerCase()
        return name !== 'connection' && name !== 'transfer-encoding' && name !== 'keep-alive'
      })
      socket.write(
        headerLines(`HTTP/1.1 ${incoming.statusCode ?? 502} ${incoming.statusMessage ?? ''}`.trim(), [
          ...raw,
          'Connection',
          'close',
        ])
      )
      incoming.pipe(socket)
    })
    upstream.on('error', () => {
      if (!socket.destroyed) socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
      this.sockets.delete(socket)
    })
    upstream.end()
  }

  /** A revoked device loses its editor connections and requests. */
  closeDevice(deviceId: string): void {
    for (const entry of [...this.requests]) if (entry.deviceId === deviceId) this.cut(entry)
    for (const [socket, entry] of [...this.sockets]) if (entry.deviceId === deviceId) socket.destroy()
  }
  /** The environment's container stops or goes away. */
  closeEnvironment(environmentId: string): void {
    for (const entry of [...this.requests]) if (entry.environmentId === environmentId) this.cut(entry)
    for (const [socket, entry] of [...this.sockets]) if (entry.environmentId === environmentId) socket.destroy()
  }
  close(): void {
    for (const entry of [...this.requests]) this.cut(entry)
    for (const socket of [...this.sockets.keys()]) socket.destroy()
  }
  private cut(entry: Request): void {
    this.requests.delete(entry)
    entry.request.destroy()
    entry.response.destroy()
  }
}
