import http, {
  type ClientRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from 'node:http'

/**
 * The artifact viewer's paths: the shell and its assets, the viewer's API under `/a/`, and page content under `/c/`.
 * Everything else on the public port is the fleet API.
 */
const VIEWER_PREFIXES = ['/a/', '/c/', '/_maestrly/shell/']
const ROBOTS = '/robots.txt'
/** The viewer's API takes small JSON bodies; the host refuses more than 64 KiB and drops a connection past 1 MiB. */
export const MAX_VIEWER_BODY_BYTES = 1024 * 1024
const DEFAULT_TIMEOUT_MS = 30_000
/** Headers that describe one connection, never forwarded across the proxy (RFC 9110, section 7.6.1). */
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

/** Whether a request target is one of the viewer's paths. Only origin-form targets match. */
export function isArtifactViewerRequest(target: string): boolean {
  if (!target.startsWith('/')) return false
  const query = target.indexOf('?')
  const pathname = query >= 0 ? target.slice(0, query) : target
  return pathname === ROBOTS || VIEWER_PREFIXES.some((prefix) => pathname.startsWith(prefix))
}

/** The end-to-end headers of a message. Host is always kept: the artifact host validates it. */
function endToEnd(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const listed = new Set(
    String(headers.connection ?? '')
      .split(',')
      .map((token) => token.trim().toLowerCase())
      .filter((token) => token && token !== 'host')
  )
  const result: OutgoingHttpHeaders = {}
  for (const [name, value] of Object.entries(headers))
    if (value !== undefined && !HOP_BY_HOP.has(name) && !listed.has(name)) result[name] = value
  return result
}

/**
 * The headers sent to the host. Body framing comes from the request itself, never from its Connection list: a length
 * when it declared one, otherwise explicit chunks, which Node would not add by default for DELETE.
 */
function upstreamHeaders(req: IncomingMessage): OutgoingHttpHeaders {
  const headers = endToEnd(req.headers)
  delete headers['content-length']
  if (req.headers['content-length'] !== undefined) headers['content-length'] = req.headers['content-length']
  else if (req.headers['transfer-encoding'] !== undefined) headers['transfer-encoding'] = 'chunked'
  return headers
}

function plain(res: ServerResponse, status: number, body: string, close = false): void {
  if (res.headersSent || res.destroyed) return void res.destroy()
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-robots-tag': 'noindex',
    ...(close ? { connection: 'close' } : {}),
  })
  res.end(body)
}

/** The answer while artifact hosting is off, failed, or restarting. */
export function viewerUnavailable(res: ServerResponse, close = false): void {
  plain(res, 503, 'Artifact hosting is unavailable', close)
}

/**
 * Forwards viewer requests from the gateway's public port to one running artifact host, on this machine's loopback.
 * The target is fixed by the caller, never taken from the request. The host enforces Host, Origin, sessions and
 * capabilities itself; the gateway has already applied its network rule to the original client.
 *
 * Never logs: URLs, headers and bodies can carry capabilities, tickets and access codes.
 */
export class ArtifactViewerProxy {
  /** Each request in progress, with the way to cut it short. */
  private readonly active = new Map<ClientRequest, () => void>()
  private closed = false
  private readonly timeoutMs: number
  constructor(options: { timeoutMs?: number } = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  /** Requests still being forwarded. */
  activeCount(): number {
    return this.active.size
  }

  /** Resolves once the response is complete or abandoned; never rejects. */
  forward(req: IncomingMessage, res: ServerResponse, port: number): Promise<void> {
    return new Promise((resolve) => {
      res.once('close', () => resolve())
      if (this.closed) return viewerUnavailable(res)
      const declared = Number(req.headers['content-length'] ?? 0)
      if (declared > MAX_VIEWER_BODY_BYTES) {
        // Answered at once, without reading or forwarding the body.
        req.resume()
        return plain(res, 413, 'Request body too large', true)
      }

      const upstream = http.request({
        host: '127.0.0.1',
        port,
        method: req.method,
        path: req.url,
        headers: upstreamHeaders(req),
        setHost: false,
        // One connection per request: nothing is reused across a host restart.
        agent: false,
      })
      // Settles once: the first failure decides what the client sees. The connection closes afterwards, since the
      // rest of the request body may never be read.
      let failed = false
      const fail = (status: 413 | 503) => {
        if (failed) return
        failed = true
        req.unpipe(upstream)
        upstream.destroy()
        this.active.delete(upstream)
        if (status === 413) {
          req.resume()
          plain(res, 413, 'Request body too large', true)
        } else viewerUnavailable(res, true)
      }
      this.active.set(upstream, () => fail(503))
      upstream.once('close', () => this.active.delete(upstream))
      upstream.setTimeout(this.timeoutMs, () => fail(503))
      upstream.on('error', () => fail(503))
      upstream.on('response', (incoming) => {
        if (failed || res.destroyed) return void incoming.destroy()
        res.writeHead(incoming.statusCode ?? 502, endToEnd(incoming.headers))
        incoming.on('error', () => res.destroy())
        incoming.on('close', () => {
          if (!incoming.complete) res.destroy()
        })
        incoming.pipe(res)
      })

      let received = 0
      req.on('data', (chunk: Buffer) => {
        received += chunk.length
        if (received > MAX_VIEWER_BODY_BYTES) fail(413)
      })
      req.on('error', () => upstream.destroy())
      res.on('error', () => upstream.destroy())
      res.once('close', () => {
        // The client left before the whole answer reached it.
        if (!res.writableFinished) upstream.destroy()
      })
      req.pipe(upstream)
    })
  }

  /** Stops forwarding: requests in progress are cut, later ones are answered as unavailable. */
  close(): void {
    this.closed = true
    for (const cut of [...this.active.values()]) cut()
    this.active.clear()
  }
}
