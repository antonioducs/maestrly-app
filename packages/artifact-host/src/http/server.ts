import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { isHtmlPath, normalizeBundlePath } from '../bundle-paths.js'
import { ArtifactHostError } from '../errors.js'
import { BRIDGE_SCRIPT, SHELL_FILES, SHELL_VERSION } from '../generated/shell-assets.js'
import { digest, newSecretToken, randomId } from '../ids.js'
import { CAPABILITY_TTL_MS, MAX_API_BODY_BYTES, OWNER_SESSION_TTL_MS, SESSION_TOUCH_INTERVAL_MS } from '../limits.js'
import { ARTIFACT_HEADER, SESSION_COOKIE, type ViewerState } from '../shell/contract.js'
import type { ArtifactStore, SessionRecord } from '../store/artifact-store.js'
import type { BlobStore } from '../store/blobs.js'
import { signCapability, verifyCapability } from './capability.js'
import { deviceInfo } from './device-info.js'
import { API_HEADERS, contentHeaders, shellHeaders } from './headers.js'
import { injectBridge } from './inject-bridge.js'
import { shellDocument } from './shell-document.js'

export interface PublicServerDeps {
  store: ArtifactStore
  blobs: BlobStore
  capabilityKey: Buffer
  clock: () => number
  port: number
  host?: string
  publicOrigins?: readonly string[]
}

export interface PublicServer {
  listen(): Promise<number>
  close(): Promise<void>
}

const SHELL_ASSET = /^\/_maestrly\/shell\/([0-9a-f]{16})\/([a-z0-9-]+\.(?:js|css))$/
const VIEWER = /^\/a\/([A-Za-z0-9_-]{22})$/
const API = /^\/a\/([A-Za-z0-9_-]{22})\/api\/(state|frame|session|session\/owner)$/
const CONTENT = /^\/c\/([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\/(.*)$/
const LOOPBACK_NAMES = ['127.0.0.1', 'localhost', '[::1]']
const MAX_COOKIE_TOKEN_CHARS = 100
const MAX_DRAIN_BYTES = 1024 * 1024
const BRIDGE_PATH = '_maestrly/bridge.js'
const JSON_TYPE = 'application/json; charset=utf-8'
const TEXT_TYPE = 'text/plain; charset=utf-8'
const JS_TYPE = 'text/javascript; charset=utf-8'

/**
 * Maps the request's Host to the origin it is allowed to use: loopback names on the listening port, or a configured
 * public address. Anything else is refused, which blocks DNS rebinding.
 */
export function allowedOrigin(
  hostHeader: string | undefined,
  port: number,
  publicOrigins: readonly string[]
): string | null {
  if (!hostHeader) return null
  const host = hostHeader.toLowerCase()
  for (const name of LOOPBACK_NAMES) if (host === `${name}:${port}`) return `http://${host}`
  for (const candidate of publicOrigins) {
    try {
      const url = new URL(candidate)
      if (url.host.toLowerCase() === host) return url.origin
    } catch {
      // A malformed public address is simply never matched.
    }
  }
  return null
}

type Body = { ok: true; value: unknown } | { ok: false; status: 400 | 413 }

function readJson(req: http.IncomingMessage): Promise<Body> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    let tooLarge = false
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_API_BODY_BYTES) tooLarge = true
      if (size > MAX_DRAIN_BYTES) req.destroy()
      if (!tooLarge) chunks.push(chunk)
    })
    req.on('end', () => {
      if (tooLarge) return resolve({ ok: false, status: 413 })
      try {
        resolve({ ok: true, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
      } catch {
        resolve({ ok: false, status: 400 })
      }
    })
    req.on('error', () => resolve({ ok: false, status: 400 }))
    // A destroyed request emits neither `end` nor `error`; settling twice is a no-op.
    req.on('close', () => resolve({ ok: false, status: tooLarge ? 413 : 400 }))
  })
}

function readCookie(req: http.IncomingMessage, name: string): string | null {
  const header = req.headers.cookie
  if (!header) return null
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0 || part.slice(0, eq).trim() !== name) continue
    const value = part.slice(eq + 1).trim()
    return value.length > 0 && value.length <= MAX_COOKIE_TOKEN_CHARS ? value : null
  }
  return null
}

const isJsonContent = (value: string | undefined): boolean => /^application\/json\s*(?:;|$)/i.test(value ?? '')

function send(res: http.ServerResponse, status: number, headers: Record<string, string>, body?: string | Buffer): void {
  const payload = body === undefined ? undefined : typeof body === 'string' ? Buffer.from(body) : body
  res.writeHead(status, { ...headers, ...(payload ? { 'content-length': String(payload.byteLength) } : {}) })
  // Artifact HTML is intentionally active, but handleContent serves it with a CSP sandbox and opaque origin.
  // codeql[js/reflected-xss]
  res.end(payload)
}

const json = (res: http.ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}) =>
  send(res, status, { ...API_HEADERS, 'content-type': JSON_TYPE, ...extra }, JSON.stringify(body))
const apiNotFound = (res: http.ServerResponse) => json(res, 404, { error: 'not_found' })
const apiForbidden = (res: http.ServerResponse) => json(res, 403, { error: 'forbidden' })
const text = (res: http.ServerResponse, status: number, body: string) =>
  send(res, status, { ...API_HEADERS, 'content-type': TEXT_TYPE }, body)
const notFound = (res: http.ServerResponse) => text(res, 404, 'Not found')

export function createPublicServer(deps: PublicServerDeps): PublicServer {
  const { store, blobs, clock } = deps
  const publicOrigins = deps.publicOrigins ?? []
  let port = deps.port

  const sessionCookie = (id: string, origin: string, token: string, maxAge: number) =>
    `${SESSION_COOKIE}=${token}; Path=/a/${id}/api; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${
      origin.startsWith('https:') ? '; Secure' : ''
    }`

  function currentSession(req: http.IncomingMessage, id: string, now: number): SessionRecord | null {
    const token = readCookie(req, SESSION_COOKIE)
    if (!token) return null
    const session = store.findSessionByToken(digest(token), id, now)
    if (!session) return null
    if (now - session.lastSeenAt > SESSION_TOUCH_INTERVAL_MS)
      store.touchSession(session.id, now, now + OWNER_SESSION_TTL_MS)
    return session
  }

  async function handleApi(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    id: string,
    action: string,
    origin: string
  ): Promise<void> {
    const method = req.method ?? 'GET'
    const expected: Record<string, string> = { state: 'GET', frame: 'POST', session: 'DELETE', 'session/owner': 'POST' }
    if (expected[action] !== method && !(action === 'state' && method === 'HEAD')) return apiNotFound(res)

    if (method === 'POST' || method === 'DELETE') {
      // The shell's own fetches are the only legitimate writers: exact origin, custom header, and JSON bodies.
      if (req.headers.origin !== origin || req.headers[ARTIFACT_HEADER] !== '1') return apiForbidden(res)
      if (method === 'POST' && !isJsonContent(req.headers['content-type'])) return apiForbidden(res)
    }
    let body: Record<string, unknown> = {}
    if (method === 'POST') {
      const parsed = await readJson(req)
      if (!parsed.ok) return json(res, parsed.status, { error: parsed.status === 413 ? 'too_large' : 'invalid_json' })
      if (typeof parsed.value !== 'object' || parsed.value === null) return json(res, 400, { error: 'invalid_json' })
      body = parsed.value as Record<string, unknown>
    }

    const now = clock()
    if (action === 'session/owner') {
      const ticket = body.ticket
      if (typeof ticket !== 'string' || ticket.length === 0 || ticket.length > MAX_COOKIE_TOKEN_CHARS)
        return apiNotFound(res)
      if (store.consumeOwnerTicket(digest(ticket), now) !== id || !store.getArtifact(id)) return apiNotFound(res)
      const token = newSecretToken()
      const device = deviceInfo(req.headers['user-agent'])
      store.createSession({
        id: randomId(),
        artifactId: id,
        principalId: null,
        tokenHash: digest(token),
        deviceLabel: `${device.browser}/${device.os}`,
        createdAt: now,
        expiresAt: now + OWNER_SESSION_TTL_MS,
      })
      return send(res, 204, {
        ...API_HEADERS,
        'set-cookie': sessionCookie(id, origin, token, OWNER_SESSION_TTL_MS / 1000),
      })
    }

    if (action === 'session') {
      const session = currentSession(req, id, now)
      if (session) store.revokeSession(session.id, now)
      return send(res, 204, { ...API_HEADERS, 'set-cookie': sessionCookie(id, origin, '', 0) })
    }

    const session = currentSession(req, id, now)
    const artifact = session ? store.getArtifact(id) : null
    if (!session || !artifact) return apiNotFound(res)

    if (action === 'state') {
      const state: ViewerState = {
        artifact: {
          id: artifact.id,
          title: artifact.title,
          currentVersion: artifact.currentVersion,
          versions: store
            .listVersions(id)
            .map((version) => ({ number: version.number, createdAt: version.createdAt, summary: version.summary })),
        },
        identity: { kind: 'owner' },
      }
      return json(res, 200, state)
    }

    // frame
    const version = body.version
    if (typeof version !== 'number' || !Number.isInteger(version) || version < 1)
      return json(res, 400, { error: 'invalid_version' })
    const record = store.getVersion(id, version)
    if (!record) return apiNotFound(res)
    const expiresAt = now + CAPABILITY_TTL_MS
    const capability = signCapability({ a: id, v: version, s: session.id, e: expiresAt }, deps.capabilityKey)
    const entry = record.entry.split('/').map(encodeURIComponent).join('/')
    return json(res, 200, { url: `/c/${capability}/${entry}`, expiresAt })
  }

  async function handleContent(
    res: http.ServerResponse,
    capability: string,
    rest: string,
    origin: string
  ): Promise<void> {
    const now = clock()
    const grant = verifyCapability(capability, deps.capabilityKey, now)
    if (!grant) return notFound(res)
    const session = store.findSessionById(grant.s, now)
    if (!session || session.artifactId !== grant.a) return notFound(res)
    if (!store.getArtifact(grant.a) || !store.getVersion(grant.a, grant.v)) return notFound(res)

    let filePath: string
    try {
      const segments = rest.split('/').map((segment) => decodeURIComponent(segment))
      if (segments.some((segment) => segment.includes('/') || segment.includes('\\'))) return notFound(res)
      filePath = segments.join('/')
    } catch {
      return notFound(res)
    }
    if (filePath === '' || filePath.endsWith('/')) filePath += 'index.html'

    const capabilityPath = `/c/${capability}`
    const headers = contentHeaders(origin, capabilityPath)
    if (filePath === BRIDGE_PATH) return send(res, 200, { ...headers, 'content-type': JS_TYPE }, BRIDGE_SCRIPT)
    try {
      filePath = normalizeBundlePath(filePath)
    } catch {
      return notFound(res)
    }
    const file = store.getFile(grant.a, grant.v, filePath)
    const bytes = file ? await blobs.read(file.sha256) : null
    if (!file || !bytes) return notFound(res)
    const body = isHtmlPath(filePath)
      ? Buffer.from(injectBridge(new TextDecoder().decode(bytes), `${capabilityPath}/${BRIDGE_PATH}`))
      : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    return send(res, 200, { ...headers, 'content-type': file.contentType }, body)
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const origin = allowedOrigin(req.headers.host, port, publicOrigins)
    if (!origin) return text(res, 403, 'Forbidden')
    const url = req.url ?? '/'
    if (!url.startsWith('/')) return notFound(res)
    const query = url.indexOf('?')
    const pathname = query >= 0 ? url.slice(0, query) : url
    const method = req.method ?? 'GET'
    const reading = method === 'GET' || method === 'HEAD'

    if (pathname === '/robots.txt' && reading) return text(res, 200, 'User-agent: *\nDisallow: /\n')

    const asset = SHELL_ASSET.exec(pathname)
    if (asset && reading) {
      const file = asset[1] === SHELL_VERSION ? SHELL_FILES[asset[2]!] : undefined
      if (!file) return notFound(res)
      return send(
        res,
        200,
        {
          'content-type': file.contentType,
          'cache-control': 'public, max-age=31536000, immutable',
          'x-content-type-options': 'nosniff',
          'x-robots-tag': 'noindex',
        },
        file.body
      )
    }

    if (VIEWER.test(pathname) && reading)
      return send(res, 200, { ...shellHeaders(origin), 'content-type': 'text/html; charset=utf-8' }, shellDocument())

    const api = API.exec(pathname)
    if (api) return handleApi(req, res, api[1]!, api[2]!, origin)

    const content = CONTENT.exec(pathname)
    if (content && reading) return handleContent(res, content[1]!, content[2]!, origin)

    return notFound(res)
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      // Never log request details: URLs and headers can carry capabilities and session tokens.
      console.error('[artifact-host] request failed:', error instanceof Error ? error.message : String(error))
      if (!res.headersSent) text(res, 500, 'Internal error')
      else res.destroy()
    })
  })
  server.requestTimeout = 30_000
  server.headersTimeout = 10_000
  server.keepAliveTimeout = 5_000
  server.maxHeadersCount = 64

  return {
    listen() {
      return new Promise((resolve, reject) => {
        const onError = (error: NodeJS.ErrnoException) => {
          reject(
            error.code === 'EADDRINUSE'
              ? new ArtifactHostError('port_in_use', `Port ${deps.port} is in use`, { port: deps.port })
              : new ArtifactHostError(
                  'internal',
                  `The artifact server could not listen: ${error.code ?? error.message}`
                )
          )
        }
        server.once('error', onError)
        server.listen(deps.port, deps.host ?? '127.0.0.1', () => {
          server.off('error', onError)
          port = (server.address() as AddressInfo).port
          resolve(port)
        })
      })
    },
    close() {
      return new Promise((resolve) => {
        if (!server.listening) return resolve()
        server.close(() => resolve())
        server.closeAllConnections()
      })
    },
  }
}
