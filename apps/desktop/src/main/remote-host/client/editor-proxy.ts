import { randomBytes, timingSafeEqual } from 'node:crypto'
import http, {
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from 'node:http'
import https from 'node:https'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'
import { FLEET_HOST_EDITOR_FORWARDED_HOST, FLEET_HOST_EDITOR_ORIGIN_HOST } from '@maestrly/bot-fleet-protocol'

/** Where a host's editor is reached from this computer: under the gateway's editor prefix, or a development host's. */
export interface EditorUpstream {
  /** `http(s)://host[:port]` */
  origin: string
  /** The path the editor's own paths follow, without a trailing slash. */
  prefix: string
  /** The credentials and protocol version the upstream requires, read for each request. */
  headers(): Record<string, string>
}

export type EditorUnavailableReason =
  | 'unknown-host'
  | 'offline'
  | 'unauthorized'
  | 'gateway-update-required'
  | 'host-update-required'
  | 'failed'

/** Why the editor of a host cannot be reached now. */
export class EditorUnavailable extends Error {
  constructor(readonly reason: EditorUnavailableReason) {
    super(`The editor is unavailable: ${reason}`)
  }
}

/** The cookie a view must carry for this computer's proxy to pass its requests on. */
export const EDITOR_ACCESS_COOKIE = 'maestrly-editor-access'

export interface EditorProxyDeps {
  /** Where to send the editor's requests; throws EditorUnavailable when the host cannot be reached. */
  upstream(): EditorUpstream
  /** The port it listened on last time, so the editor keeps its origin (and its storage) across restarts. */
  preferredPort: number | null
  /** The port it listens on now, to remember. */
  onPort(port: number): void
}

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
// What the page sends that must not leave this computer, or that the upstream sets itself.
const PAGE_HEADERS = [
  'host',
  'origin',
  'referer',
  'authorization',
  'cookie',
  'forwarded',
  'x-forwarded-for',
  FLEET_HOST_EDITOR_FORWARDED_HOST,
  FLEET_HOST_EDITOR_ORIGIN_HOST,
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

const cookiePairs = (cookie: string | string[] | undefined): string[] =>
  (Array.isArray(cookie) ? cookie.join('; ') : (cookie ?? ''))
    .split(';')
    .map((pair) => pair.trim())
    .filter(Boolean)

const isAccessPair = (pair: string): boolean => pair.toLowerCase().startsWith(EDITOR_ACCESS_COOKIE + '=')

/** The answer's headers, without any cookie that would claim this proxy's access cookie. */
function answerHeaders(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const result = endToEnd(headers)
  const cookies = result['set-cookie']
  if (cookies !== undefined) {
    const kept = (Array.isArray(cookies) ? cookies : [String(cookies)]).filter((cookie) => !isAccessPair(cookie.trim()))
    if (kept.length) result['set-cookie'] = kept
    else delete result['set-cookie']
  }
  return result
}

/** The headers of an accepted upgrade, as they came (the handshake needs its Connection and Upgrade headers). */
function upgradeHeaders(incoming: IncomingMessage): OutgoingHttpHeaders {
  const result: OutgoingHttpHeaders = {}
  for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
    const name = incoming.rawHeaders[index]
    const value = incoming.rawHeaders[index + 1]
    if (name.toLowerCase() === 'set-cookie' && isAccessPair(value.trim())) continue
    const previous = result[name]
    result[name] =
      previous === undefined ? value : [...(Array.isArray(previous) ? previous : [String(previous)]), value]
  }
  return result
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
 * This computer's door to a remote host's editor. The editor runs in a view of the drawer at
 * `http://127.0.0.1:<port>`, an origin of this computer, and this proxy passes every request and WebSocket of that
 * origin to the host (through the gateway, with this device's credentials). Other programs of this computer can reach
 * the port too: a request passes only with the random access cookie the drawer puts in the view's own session, a Host
 * of this origin and, when it has one, an Origin of this origin.
 */
export class EditorProxy {
  /** The value of the access cookie; it changes each time the app starts. */
  readonly access = randomBytes(32).toString('base64url')
  private server: http.Server | null = null
  private listening: Promise<number> | null = null
  private port = 0
  private readonly sockets = new Set<Duplex>()

  constructor(private readonly deps: EditorProxyDeps) {}

  /** Listens on the loopback, on the port of last time when it is free, and returns the port. */
  start(): Promise<number> {
    this.listening ??= this.listen().catch((error) => {
      this.listening = null
      throw error
    })
    return this.listening
  }

  /** The editor's origin on this computer; only valid once started. */
  origin(): string {
    return `http://127.0.0.1:${this.port}`
  }

  close(): void {
    for (const socket of [...this.sockets]) socket.destroy()
    this.server?.closeAllConnections()
    this.server?.close()
    this.server = null
    this.listening = null
  }

  private async listen(): Promise<number> {
    const server = http.createServer((request, response) => this.request(request, response))
    server.on('upgrade', (request, socket, head) => this.upgrade(request, socket, head))
    const attempt = (port: number) =>
      new Promise<number>((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, '127.0.0.1', () => {
          server.off('error', reject)
          resolve((server.address() as AddressInfo).port)
        })
      })
    let port: number
    try {
      port = await attempt(this.deps.preferredPort ?? 0)
    } catch (error) {
      if (!this.deps.preferredPort) throw error
      port = await attempt(0)
    }
    this.server = server
    this.port = port
    if (port !== this.deps.preferredPort) this.deps.onPort(port)
    return port
  }

  /** Whether a request comes from the editor's view: this origin, and the access cookie. */
  private admitted(request: IncomingMessage): boolean {
    const own = `127.0.0.1:${this.port}`
    if (request.headers.host !== own) return false
    const origin = request.headers.origin
    if (origin !== undefined && origin !== `http://${own}`) return false
    const expected = Buffer.from(this.access)
    return cookiePairs(request.headers.cookie).some((pair) => {
      if (!isAccessPair(pair)) return false
      const value = Buffer.from(pair.slice(EDITOR_ACCESS_COOKIE.length + 1))
      return value.length === expected.length && timingSafeEqual(value, expected)
    })
  }

  private upstreamRequest(
    request: IncomingMessage,
    upstream: EditorUpstream,
    method: string,
    extra: OutgoingHttpHeaders
  ) {
    const target = new URL(upstream.origin)
    const headers = endToEnd(request.headers)
    for (const name of PAGE_HEADERS) delete headers[name]
    delete headers['content-length']
    if (request.headers['content-length'] !== undefined) headers['content-length'] = request.headers['content-length']
    else if (request.headers['transfer-encoding'] !== undefined) headers['transfer-encoding'] = 'chunked'
    const cookies = cookiePairs(request.headers.cookie).filter((pair) => !isAccessPair(pair))
    if (cookies.length) headers.cookie = cookies.join('; ')
    // The editor writes this origin into its pages and WebSocket addresses. A proxy before the gateway may replace
    // X-Forwarded-Host; the host reads its own header first, and hosts that predate it still read X-Forwarded-Host.
    headers[FLEET_HOST_EDITOR_ORIGIN_HOST] = `127.0.0.1:${this.port}`
    headers[FLEET_HOST_EDITOR_FORWARDED_HOST] = `127.0.0.1:${this.port}`
    Object.assign(headers, upstream.headers(), extra)
    const options = {
      host: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      method,
      path: upstream.prefix + (request.url ?? '/'),
      headers,
      agent: false as const,
    }
    return target.protocol === 'https:' ? https.request(options) : http.request(options)
  }

  private refuse(response: ServerResponse, status: number, message: string): void {
    if (response.headersSent || response.destroyed) return void response.destroy()
    response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' })
    response.end(message)
  }

  private request(request: IncomingMessage, response: ServerResponse): void {
    if (!this.admitted(request)) {
      request.resume()
      return this.refuse(response, 403, 'Forbidden')
    }
    let upstream: EditorUpstream
    try {
      upstream = this.deps.upstream()
    } catch {
      request.resume()
      return this.refuse(response, 503, 'The editor of this server is unavailable.')
    }
    const outgoing = this.upstreamRequest(request, upstream, request.method ?? 'GET', {})
    outgoing.on('response', (incoming) => {
      response.writeHead(incoming.statusCode ?? 502, answerHeaders(incoming.headers))
      incoming.on('error', () => response.destroy())
      incoming.on('aborted', () => response.destroy())
      incoming.pipe(response)
    })
    outgoing.on('error', () => this.refuse(response, 502, 'The editor of this server did not answer.'))
    response.on('close', () => {
      if (!response.writableFinished) outgoing.destroy()
    })
    request.on('aborted', () => outgoing.destroy())
    request.pipe(outgoing)
  }

  private upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    socket.on('error', () => socket.destroy())
    const fail = (status: number, text: string): void => {
      if (!socket.destroyed) socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
    }
    if (!this.admitted(request)) return fail(403, 'Forbidden')
    if (request.headers.upgrade?.toLowerCase() !== 'websocket') return fail(400, 'Bad Request')
    let upstream: EditorUpstream
    try {
      upstream = this.deps.upstream()
    } catch {
      return fail(503, 'Service Unavailable')
    }
    const extra: OutgoingHttpHeaders = { connection: 'Upgrade', upgrade: 'websocket' }
    for (const name of WEBSOCKET_HEADERS) {
      const value = request.headers[name]
      if (typeof value === 'string') extra[name] = value
    }
    const outgoing = this.upstreamRequest(request, upstream, 'GET', extra)
    outgoing.on('upgrade', (incoming, tcp, rest) => {
      if (socket.destroyed) return void tcp.destroy()
      socket.write(
        headerLines(`HTTP/1.1 101 ${incoming.statusMessage || 'Switching Protocols'}`, upgradeHeaders(incoming))
      )
      if (rest.length) socket.write(rest)
      if (head.length) tcp.write(head)
      this.sockets.add(socket)
      const close = (): void => {
        this.sockets.delete(socket)
        tcp.destroy()
        socket.destroy()
      }
      tcp.on('error', close)
      tcp.on('close', close)
      socket.on('close', close)
      socket.pipe(tcp).pipe(socket)
    })
    outgoing.on('response', (incoming) => {
      if (socket.destroyed) return void incoming.resume()
      const headers = answerHeaders(incoming.headers)
      headers.connection = 'close'
      socket.write(
        headerLines(`HTTP/1.1 ${incoming.statusCode ?? 502} ${incoming.statusMessage ?? ''}`.trim(), headers)
      )
      incoming.pipe(socket)
    })
    outgoing.on('error', () => fail(502, 'Bad Gateway'))
    outgoing.end()
  }
}
