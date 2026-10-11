import http, {
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from 'node:http'
import type { Duplex } from 'node:stream'
import {
  FLEET_HOST_EDITOR_FORWARDED_HOST,
  FLEET_PROTOCOL_HEADER,
  isFleetHostEditorForwardedHost,
} from '@maestrly/bot-fleet-protocol'

/** Where the host's editor server (`code serve-web`) listens on its loopback, and the token it requires. */
export interface HostEditorServer {
  port: number
  token: string
}

export interface HostEditorDeps {
  /** The editor server, started when it does not run; rejects when it cannot start. */
  ensureServer(): Promise<HostEditorServer>
  /**
   * The editor is in use: `openSockets` editor connections are open now. While any is open the editor server is not
   * stopped for being idle; requests without one restart its idle period.
   */
  onActivity(openSockets: number): void
}

/**
 * The cookie `serve-web` reads its connection token from, and the workbench page too: the page sends the token in the
 * handshake of its connection to the editor's server, which refuses a connection without it ("auth mismatch").
 */
const TOKEN_COOKIE = 'vscode-tkn'
/** As long as serve-web keeps the cookie itself. */
const TOKEN_COOKIE_MAX_AGE_S = 7 * 24 * 60 * 60
/** Requests restart the editor's idle period at most this often. */
const ACTIVITY_INTERVAL_MS = 10_000
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])
/** What only the caller and this control server share, and what would let a caller choose another origin. */
const CALLER_HEADERS = [
  'authorization',
  'host',
  'origin',
  FLEET_PROTOCOL_HEADER.toLowerCase(),
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-proto',
  'x-forwarded-port',
  FLEET_HOST_EDITOR_FORWARDED_HOST,
]
const WEBSOCKET_HEADERS = [
  'sec-websocket-key',
  'sec-websocket-version',
  'sec-websocket-protocol',
  'sec-websocket-extensions',
]

function endToEnd(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const listed = new Set(
    String(headers.connection ?? '')
      .split(',')
      .map((token) => token.trim().toLowerCase())
      .filter(Boolean)
  )
  const result: OutgoingHttpHeaders = {}
  for (const [name, value] of Object.entries(headers))
    if (value !== undefined && !HOP_BY_HOP.has(name) && !listed.has(name)) result[name] = value
  return result
}

const isTokenCookie = (pair: string): boolean =>
  pair
    .trim()
    .toLowerCase()
    .startsWith(TOKEN_COOKIE + '=')

/** The caller's cookies without any token it sent, and the host's own token. */
function cookieWithToken(cookie: string | string[] | undefined, token: string): string {
  const pairs = (Array.isArray(cookie) ? cookie.join('; ') : (cookie ?? ''))
    .split(';')
    .map((pair) => pair.trim())
    .filter((pair) => pair && !isTokenCookie(pair))
  return [...pairs, `${TOKEN_COOKIE}=${token}`].join('; ')
}

/** The workbench page: the editor's root, whatever its query. */
const isWorkbench = (editorPath: string): boolean => editorPath === '/' || editorPath.startsWith('/?')

/**
 * The answer's headers, with the token cookie on the workbench page: serve-web sets it there itself, and is given it
 * here when it did not, so the page can authenticate its connection whatever serve-web's version does.
 */
function withTokenCookie(headers: OutgoingHttpHeaders, editorPath: string, token: string): OutgoingHttpHeaders {
  if (!isWorkbench(editorPath)) return headers
  const set = headers['set-cookie']
  const cookies = set === undefined ? [] : Array.isArray(set) ? set : [String(set)]
  if (cookies.some(isTokenCookie)) return headers
  return {
    ...headers,
    'set-cookie': [...cookies, `${TOKEN_COOKIE}=${token}; Path=/; Max-Age=${TOKEN_COOKIE_MAX_AGE_S}; SameSite=Strict`],
  }
}

function upstreamHeaders(request: IncomingMessage, server: HostEditorServer): OutgoingHttpHeaders {
  const headers = endToEnd(request.headers)
  for (const name of CALLER_HEADERS) delete headers[name]
  delete headers['content-length']
  if (request.headers['content-length'] !== undefined) headers['content-length'] = request.headers['content-length']
  else if (request.headers['transfer-encoding'] !== undefined) headers['transfer-encoding'] = 'chunked'
  headers.host = `127.0.0.1:${server.port}`
  headers.cookie = cookieWithToken(request.headers.cookie, server.token)
  // The editor writes this origin into its pages and WebSocket addresses: the computer's, never another one.
  const forwarded = request.headers[FLEET_HOST_EDITOR_FORWARDED_HOST]
  if (isFleetHostEditorForwardedHost(forwarded)) headers[FLEET_HOST_EDITOR_FORWARDED_HOST] = forwarded
  return headers
}

function unavailable(response: ServerResponse): void {
  if (response.headersSent || response.destroyed) return void response.destroy()
  const body = JSON.stringify({ code: 'INSTANCE_UNAVAILABLE', message: 'The editor is not available on this host.' })
  response.writeHead(503, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'X-Content-Type-Options': 'nosniff',
  })
  response.end(body)
}

function rejectSocket(socket: Duplex, status: number, message: string): void {
  if (socket.destroyed) return
  const body = JSON.stringify({ code: 'INSTANCE_UNAVAILABLE', message })
  socket.end(
    `HTTP/1.1 ${status} Error\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
  )
}

function headerLines(statusLine: string, headers: OutgoingHttpHeaders): string {
  const lines = [statusLine]
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue
    for (const item of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${item}`)
  }
  return lines.join('\r\n') + '\r\n\r\n'
}

/**
 * A workspaces host's editor, served to the computers that open it: the control server passes it the requests and
 * WebSocket upgrades under the editor prefix, already authenticated (the gateway's control token), and this passes
 * them to `serve-web` on the host's loopback. The host decides the editor's connection token: it is added to every
 * request as the cookie `serve-web` reads, and any token a caller sends is dropped. The workbench page receives it as
 * its cookie, because the page authenticates its own connection with it; it opens nothing without the control
 * server's credentials, which only the gateway holds.
 */
export class HostEditor {
  private readonly sockets = new Set<Duplex>()
  private lastActivity = 0

  constructor(private readonly deps: HostEditorDeps) {}

  /** Open editor connections. */
  connections(): number {
    return this.sockets.size
  }

  /** An HTTP request for `editorPath` (path and query of the editor). */
  async request(request: IncomingMessage, response: ServerResponse, editorPath: string): Promise<void> {
    let server: HostEditorServer
    try {
      server = await this.deps.ensureServer()
    } catch {
      request.resume()
      return unavailable(response)
    }
    this.activity()
    await new Promise<void>((resolve) => {
      const upstream = http.request({
        host: '127.0.0.1',
        port: server.port,
        method: request.method,
        path: editorPath,
        headers: upstreamHeaders(request, server),
        agent: false,
      })
      upstream.on('response', (incoming) => {
        response.writeHead(
          incoming.statusCode ?? 502,
          withTokenCookie(endToEnd(incoming.headers), editorPath, server.token)
        )
        incoming.on('error', () => response.destroy())
        incoming.on('aborted', () => response.destroy())
        incoming.pipe(response)
      })
      upstream.on('error', () => unavailable(response))
      response.on('close', () => {
        if (!response.writableFinished) upstream.destroy()
        resolve()
      })
      request.on('aborted', () => upstream.destroy())
      request.pipe(upstream)
    })
  }

  /** A WebSocket upgrade for `editorPath`, passed through once `serve-web` accepts it. */
  upgrade(request: IncomingMessage, socket: Duplex, head: Buffer, editorPath: string): void {
    socket.on('error', () => socket.destroy())
    if (request.headers.upgrade?.toLowerCase() !== 'websocket')
      return rejectSocket(socket, 400, 'WebSocket upgrade required.')
    void this.deps.ensureServer().then(
      (server) => this.connect(request, socket, head, editorPath, server),
      () => rejectSocket(socket, 503, 'The editor is not available on this host.')
    )
  }

  /** The host stops serving: every editor connection ends. */
  closeAll(): void {
    for (const socket of [...this.sockets]) socket.destroy()
  }

  private connect(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    editorPath: string,
    server: HostEditorServer
  ) {
    if (socket.destroyed) return
    const headers = upstreamHeaders(request, server)
    headers.connection = 'Upgrade'
    headers.upgrade = 'websocket'
    for (const name of WEBSOCKET_HEADERS) {
      const value = request.headers[name]
      if (typeof value === 'string') headers[name] = value
    }
    const upstream = http.request({
      host: '127.0.0.1',
      port: server.port,
      method: 'GET',
      path: editorPath,
      headers,
      agent: false,
    })
    upstream.on('upgrade', (incoming, tcp, extra) => {
      if (socket.destroyed) return void tcp.destroy()
      const answer: OutgoingHttpHeaders = {}
      for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
        const name = incoming.rawHeaders[index]
        const value = incoming.rawHeaders[index + 1]
        const previous = answer[name]
        answer[name] =
          previous === undefined ? value : [...(Array.isArray(previous) ? previous : [String(previous)]), value]
      }
      socket.write(headerLines(`HTTP/1.1 101 ${incoming.statusMessage || 'Switching Protocols'}`, answer))
      if (extra.length) socket.write(extra)
      if (head.length) tcp.write(head)
      this.sockets.add(socket)
      this.deps.onActivity(this.sockets.size)
      let closed = false
      const close = (): void => {
        tcp.destroy()
        socket.destroy()
        if (closed) return
        closed = true
        this.sockets.delete(socket)
        this.deps.onActivity(this.sockets.size)
      }
      tcp.on('error', close)
      tcp.on('close', close)
      socket.on('close', close)
      socket.pipe(tcp).pipe(socket)
    })
    // `serve-web` answered without upgrading: its answer goes back as it is.
    upstream.on('response', (incoming) => {
      if (socket.destroyed) return void incoming.resume()
      const headers = endToEnd(incoming.headers)
      headers.connection = 'close'
      socket.write(
        headerLines(`HTTP/1.1 ${incoming.statusCode ?? 502} ${incoming.statusMessage ?? ''}`.trim(), headers)
      )
      incoming.pipe(socket)
    })
    upstream.on('error', () => rejectSocket(socket, 503, 'The editor is not available on this host.'))
    upstream.end()
  }

  private activity(): void {
    const now = Date.now()
    if (now - this.lastActivity < ACTIVITY_INTERVAL_MS) return
    this.lastActivity = now
    this.deps.onActivity(this.sockets.size)
  }
}
