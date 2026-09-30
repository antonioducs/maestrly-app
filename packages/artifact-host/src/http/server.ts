import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { gateFor, resolveAccess } from '../access.js'
import { isHtmlPath, normalizeBundlePath } from '../bundle-paths.js'
import { createCommentService } from '../comments.js'
import { ArtifactHostError } from '../errors.js'
import { BRIDGE_SCRIPT, SHELL_FILES, SHELL_VERSION } from '../generated/shell-assets.js'
import { digest, newSecretToken, randomId } from '../ids.js'
import {
  CAPABILITY_TTL_MS,
  GUEST_SESSION_TTL_MS,
  OWNER_SESSION_TTL_MS,
  PERSON_SESSION_TTL_MS,
  SESSION_TOUCH_INTERVAL_MS,
} from '../limits.js'
import { type ActivityRecorder, createActivityRecorder } from '../sharing-admin.js'
import {
  ARTIFACT_HEADER,
  SESSION_COOKIE,
  VISITOR_COOKIE,
  type ViewerGate,
  type ViewerIdentity,
  type ViewerState,
} from '../shell/contract.js'
import type { ArtifactStore, SessionRecord } from '../store/artifact-store.js'
import type { BlobStore } from '../store/blobs.js'
import { CommentStore } from '../store/comment-store.js'
import { type PrincipalRecord, type SharingFields, SharingStore } from '../store/sharing-store.js'
import { signCapability, verifyCapability } from './capability.js'
import { createCommentRoutes } from './comment-routes.js'
import { deviceInfo } from './device-info.js'
import { contentHeaders, shellHeaders } from './headers.js'
import { injectBridge } from './inject-bridge.js'
import { createRateLimiter } from './rate-limit.js'
import {
  type ApiContext,
  apiForbidden,
  apiNotFound,
  cookie,
  isJsonContent,
  JS_TYPE,
  json,
  LONGEST_COOKIE_SECONDS,
  MAX_COOKIE_TOKEN_CHARS,
  noContent,
  notFound,
  readCookie,
  readJson,
  send,
  text,
} from './respond.js'
import { shellDocument } from './shell-document.js'
import { createVisitorRoutes } from './visitor-routes.js'

export interface PublicServerDeps {
  store: ArtifactStore
  blobs: BlobStore
  capabilityKey: Buffer
  clock: () => number
  port: number
  host?: string
  publicOrigins?: readonly string[]
  /** People, requests and events; opened on the store's database when not given. */
  sharing?: SharingStore
  /** The owner's display name, shown to the people an artifact is shared with. */
  ownerName?: string
  recordActivity?: ActivityRecorder
  onChange?: (artifactId: string) => void
  maxComments?: number
}

export interface PublicServer {
  listen(): Promise<number>
  close(): Promise<void>
}

const SHELL_ASSET = /^\/_maestrly\/shell\/([0-9a-f]{16})\/([a-z0-9-]+\.(?:js|css))$/
const VIEWER = /^\/a\/([A-Za-z0-9_-]{22})$/
const API = /^\/a\/([A-Za-z0-9_-]{22})\/api\/([a-z]+(?:[/-][a-z]+)*)$/
const COMMENT_API = /^\/a\/([A-Za-z0-9_-]{22})\/api\/comments\/([A-Za-z0-9_-]{22})(?:\/(replies|resolve))?$/
const CONTENT = /^\/c\/([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\/(.*)$/
const LOOPBACK_NAMES = ['127.0.0.1', 'localhost', '[::1]']
const BRIDGE_PATH = '_maestrly/bridge.js'

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

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE'

interface Route {
  method: Method
  /** A read that changes something: it must come from the viewer's own script, like a write. */
  viewerOnly?: boolean
  handle: (ctx: ApiContext) => void
}

/** Routes by method and action, such as `POST frame`. */
const routeKey = (method: string, action: string): string => `${method} ${action}`

export function createPublicServer(deps: PublicServerDeps): PublicServer {
  const { store, blobs, clock } = deps
  const publicOrigins = deps.publicOrigins ?? []
  const sharing = deps.sharing ?? new SharingStore(store.db)
  const ownerName = deps.ownerName ?? ''
  const onChange = deps.onChange ?? (() => {})
  const record = deps.recordActivity ?? createActivityRecorder({ sharing, clock, onChange })
  const limiter = createRateLimiter(clock)
  let port = deps.port

  function currentSession(req: http.IncomingMessage, id: string, now: number): SessionRecord | null {
    const token = readCookie(req, SESSION_COOKIE)
    return token ? store.findSessionByToken(digest(token), id, now) : null
  }

  /** When a session ends if unused, and the date it cannot outlive: an invitation's or a link's expiry. */
  function lifetime(principal: PrincipalRecord | null, fields: SharingFields, now: number) {
    if (!principal) return { expiresAt: now + OWNER_SESSION_TTL_MS, cap: null }
    const guest = principal.kind === 'guest'
    const cap = guest ? fields.linkExpiresAt : principal.inviteExpiresAt
    const sliding = now + (guest ? GUEST_SESSION_TTL_MS : PERSON_SESSION_TTL_MS)
    return { expiresAt: cap === null ? sliding : Math.min(sliding, cap), cap }
  }

  function startSession(ctx: ApiContext, principal: PrincipalRecord | null): { cookie: string; device: string } {
    const token = newSecretToken()
    const info = deviceInfo(ctx.req.headers['user-agent'])
    const device = `${info.browser}/${info.os}`
    const { expiresAt, cap } = lifetime(principal, ctx.sharing, ctx.now)
    store.createSession({
      id: randomId(),
      artifactId: ctx.artifactId,
      principalId: principal?.id ?? null,
      tokenHash: digest(token),
      deviceLabel: device,
      createdAt: ctx.now,
      expiresAt,
    })
    const maxAge = !principal
      ? OWNER_SESSION_TTL_MS / 1000
      : cap === null
        ? LONGEST_COOKIE_SECONDS
        : Math.max(1, Math.ceil((cap - ctx.now) / 1000))
    return { cookie: cookie(SESSION_COOKIE, ctx.artifactId, ctx.origin, token, maxAge), device }
  }

  function identityOf(ctx: ApiContext): ViewerIdentity {
    if (ctx.access?.kind !== 'person') return { kind: 'owner' }
    const { principal } = ctx.access
    return principal.kind === 'guest'
      ? { kind: 'guest', name: principal.name || null }
      : { kind: principal.kind, name: principal.name }
  }

  /** How this browser's access request stands, for a visitor who is not in yet. */
  function pendingRequest(ctx: ApiContext): 'pending' | 'denied' | null {
    if (!ctx.visitor) return null
    sharing.expireRequests(ctx.now)
    const request = sharing.findRequestByBrowser(ctx.artifactId, digest(ctx.visitor))
    if (request?.status === 'denied') return 'denied'
    if (request?.status === 'pending') return 'pending'
    if (request?.status !== 'approved' || !request.principalId) return null
    // Approved, but this browser has not collected its session yet: it keeps waiting until it asks for it.
    return sharing.getPrincipal(request.principalId) ? 'pending' : null
  }

  const routes = new Map<string, Route>()
  const route = (method: Method, action: string, handle: Route['handle'], viewerOnly = false): void => {
    routes.set(routeKey(method, action), { method, viewerOnly, handle })
  }

  const core: Record<string, Route> = {
    state: {
      method: 'GET',
      handle(ctx) {
        const artifact = ctx.access ? store.getArtifact(ctx.artifactId) : null
        if (!artifact) {
          const gate = gateFor(ctx.sharing, ctx.now)
          if (!gate) return apiNotFound(ctx.res)
          const closed: ViewerGate = { gate: { ...gate, pending: pendingRequest(ctx) }, ownerName }
          return json(ctx.res, 200, closed)
        }
        const state: ViewerState = {
          artifact: {
            id: artifact.id,
            title: artifact.title,
            currentVersion: artifact.currentVersion,
            versions: store.listVersions(artifact.id).map((version) => ({
              number: version.number,
              createdAt: version.createdAt,
              summary: version.summary,
            })),
          },
          identity: identityOf(ctx),
          ownerName,
          can: { comment: ctx.sharing.commentsEnabled, resolve: ctx.access?.kind === 'owner' },
        }
        json(ctx.res, 200, state)
      },
    },

    frame: {
      method: 'POST',
      handle(ctx) {
        if (!ctx.access) return apiNotFound(ctx.res)
        const version = ctx.body.version
        if (typeof version !== 'number' || !Number.isInteger(version) || version < 1)
          return json(ctx.res, 400, { error: 'invalid_version' })
        const stored = store.getVersion(ctx.artifactId, version)
        if (!stored) return apiNotFound(ctx.res)
        const expiresAt = ctx.now + CAPABILITY_TTL_MS
        // Bind the capability to the stored artifact the session belongs to, never to the request path.
        const capability = signCapability(
          { a: ctx.artifactId, v: stored.number, s: ctx.access.session.id, e: expiresAt },
          deps.capabilityKey
        )
        const entry = stored.entry.split('/').map(encodeURIComponent).join('/')
        json(ctx.res, 200, { url: `/c/${capability}/${entry}`, expiresAt })
      },
    },

    // Leave: ends this device's session, whoever it belongs to.
    session: {
      method: 'DELETE',
      handle(ctx) {
        if (ctx.session) {
          store.revokeSession(ctx.session.id, ctx.now)
          onChange(ctx.artifactId)
        }
        noContent(ctx.res, { 'set-cookie': cookie(SESSION_COOKIE, ctx.artifactId, ctx.origin, '', 0) })
      },
    },

    'session/owner': {
      method: 'POST',
      handle(ctx) {
        const ticket = ctx.body.ticket
        if (typeof ticket !== 'string' || ticket.length === 0 || ticket.length > MAX_COOKIE_TOKEN_CHARS)
          return apiNotFound(ctx.res)
        if (store.consumeOwnerTicket(digest(ticket), ctx.now) !== ctx.artifactId) return apiNotFound(ctx.res)
        noContent(ctx.res, { 'set-cookie': startSession(ctx, null).cookie })
      },
    },
  }

  for (const [action, entry] of Object.entries(core)) route(entry.method, action, entry.handle)

  const visitorRoutes = createVisitorRoutes({ sharing, limiter, ownerName, record, onChange, startSession })
  const visitorMethods: Record<string, Method> = {
    'invite/preview': 'POST',
    'invite/decline': 'POST',
    'session/invite': 'POST',
    'session/code': 'POST',
    'session/name': 'PUT',
    'access-requests': 'POST',
    'access-requests/current': 'GET',
  }
  for (const [action, method] of Object.entries(visitorMethods))
    route(method, action, visitorRoutes[action]!, action === 'access-requests/current')

  const commentRoutes = createCommentRoutes({
    comments: createCommentService({
      store,
      comments: new CommentStore(store.db),
      clock,
      maxComments: deps.maxComments,
      onChange,
      record,
    }),
    ownerName,
  })
  route('GET', 'comments', commentRoutes.list)
  route('POST', 'comments', commentRoutes.create)
  route('POST', 'comments/:id/replies', commentRoutes.reply)
  route('POST', 'comments/:id/resolve', commentRoutes.resolve)
  route('DELETE', 'comments/:id', commentRoutes.remove)

  async function handleApi(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    id: string,
    action: string,
    origin: string,
    params: { commentId: string | null; query: URLSearchParams }
  ): Promise<void> {
    const method = req.method ?? 'GET'
    const found = routes.get(routeKey(method === 'HEAD' ? 'GET' : method, action))
    if (!found || (method === 'HEAD' && found.viewerOnly)) return apiNotFound(res)

    const fromViewer = req.headers[ARTIFACT_HEADER] === '1'
    if (method !== 'GET' && method !== 'HEAD') {
      // The shell's own fetches are the only legitimate writers: exact origin, custom header, and JSON bodies.
      if (req.headers.origin !== origin || !fromViewer) return apiForbidden(res)
      if (method !== 'DELETE' && !isJsonContent(req.headers['content-type'])) return apiForbidden(res)
    } else if (found.viewerOnly && !fromViewer) return apiForbidden(res)
    if (!limiter.allow('host', '')) return json(res, 429, { error: 'rate_limited' })

    let body: Record<string, unknown> = {}
    if (method === 'POST' || method === 'PUT') {
      const parsed = await readJson(req)
      if (!parsed.ok) return json(res, parsed.status, { error: parsed.status === 413 ? 'too_large' : 'invalid_json' })
      if (typeof parsed.value !== 'object' || parsed.value === null) return json(res, 400, { error: 'invalid_json' })
      body = parsed.value as Record<string, unknown>
    }

    const now = clock()
    const artifact = store.getArtifact(id)
    const fields = artifact ? sharing.getSharing(artifact.id) : null
    if (!artifact || !fields) return apiNotFound(res)
    if (!limiter.allow('artifact', artifact.id)) return json(res, 429, { error: 'rate_limited' })

    const session = currentSession(req, artifact.id, now)
    if (session && !limiter.allow('session', session.id)) return json(res, 429, { error: 'rate_limited' })
    const principal = session?.principalId ? sharing.getPrincipal(session.principalId) : null
    const access = resolveAccess(fields, session, principal, now)
    if (access && now - access.session.lastSeenAt > SESSION_TOUCH_INTERVAL_MS)
      store.touchSession(access.session.id, now, lifetime(principal, fields, now).expiresAt)

    found.handle({
      req,
      res,
      artifactId: artifact.id,
      origin,
      now,
      body,
      sharing: fields,
      session,
      access,
      visitor: readCookie(req, VISITOR_COOKIE),
      commentId: params.commentId,
      query: params.query,
    })
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
    // Checked on every file, so revoking a person or making the artifact private cuts the content at once.
    const fields = sharing.getSharing(grant.a)
    const principal = session.principalId ? sharing.getPrincipal(session.principalId) : null
    if (!fields || !resolveAccess(fields, session, principal, now)) return notFound(res)
    if (!store.getVersion(grant.a, grant.v)) return notFound(res)

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

    const search = new URLSearchParams(query >= 0 ? url.slice(query + 1) : '')
    const api = API.exec(pathname)
    if (api) return handleApi(req, res, api[1]!, api[2]!, origin, { commentId: null, query: search })
    const commentApi = COMMENT_API.exec(pathname)
    if (commentApi)
      return handleApi(
        req,
        res,
        commentApi[1]!,
        commentApi[3] ? `comments/:id/${commentApi[3]}` : 'comments/:id',
        origin,
        {
          commentId: commentApi[2]!,
          query: search,
        }
      )

    const content = CONTENT.exec(pathname)
    if (content && reading) return handleContent(res, content[1]!, content[2]!, origin)

    return notFound(res)
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      // Never log request details: URLs, headers and bodies can carry capabilities, tokens and access codes.
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
