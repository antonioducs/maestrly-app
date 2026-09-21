/**
 * HTTP transport of the bot endpoint embedded in this desktop: the OAuth authorization server, the
 * owner consent page and the MCP endpoint, on a plain `node:http` listener with no new dependency.
 *
 * The listener normally binds to loopback and is published through a tunnel, so every absolute URL it
 * emits comes from the configured public URL and never from a request header: `Host`, `Origin` and any
 * `X-Forwarded-*` value are only ever used to reject a request, never to decide who this server is.
 * That keeps the issuer, the audience and the redirect targets stable even behind a hostile proxy.
 *
 * Requests are bounded on every axis that costs something: body size, batch size, and a per-address
 * rate window; failures answer with a short OAuth-shaped error that never echoes internal detail.
 */
import { randomBytes } from 'node:crypto'
import http from 'node:http'
import type { Socket } from 'node:net'
import { BOT_MCP_PATH, BOT_PROTECTED_RESOURCE_PATH } from '@maestrly/protocol'
import {
  BOT_AUTHORIZATION_SERVER_PATH,
  BOT_OAUTH_AUTHORIZE_PATH,
  BOT_OAUTH_REGISTER_PATH,
  BOT_OAUTH_REVOKE_PATH,
  BOT_OAUTH_STATUS_PATH,
  BOT_OAUTH_TOKEN_PATH,
  LocalBotOAuthError,
  isLoopbackHostname,
  normalizeBotPublicUrl,
  type LocalBotOAuth,
} from './oauth'
import { BotMcpForbiddenError, BotMcpUnauthenticatedError, dispatchBotMcpPayload } from './mcp'

export interface BotHttpServerOptions {
  oauth: LocalBotOAuth
  callTool(connectionId: string, name: string, input: Record<string, unknown>, signal: AbortSignal): Promise<unknown>
}

export interface BotHttpServerConfig {
  host: string
  port: number
  /** Public HTTPS URL this endpoint is reachable at; the only source of issuer, audience and metadata. */
  publicUrl: string
}

const MAX_OAUTH_BODY_BYTES = 256 * 1024
const MAX_MCP_BODY_BYTES = 2 * 1024 * 1024
const RATE_WINDOW_MS = 60_000
const OAUTH_RATE_MAX = 120
const MCP_RATE_MAX = 600
const MAX_RATE_KEYS = 2_000
/** A waiting bot may block for the full event wait, so requests are not cut short. */
const HEADERS_TIMEOUT_MS = 30_000

const SAFE_HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
} as const

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&':
        return '&amp;'
      case '<':
        return '&lt;'
      case '>':
        return '&gt;'
      case '"':
        return '&quot;'
      default:
        return '&#39;'
    }
  })

class BodyTooLargeError extends Error {}

function readBody(request: http.IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    // A declared oversize body is refused before a single byte of it is read.
    const declared = Number(request.headers['content-length'] ?? 0)
    if (Number.isFinite(declared) && declared > limit) {
      reject(new BodyTooLargeError('The request body is too large.'))
      return
    }
    let size = 0
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        reject(new BodyTooLargeError('The request body is too large.'))
        request.pause()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}

/** Accept both the form encoding OAuth mandates and the JSON body some bot clients send anyway. */
function asForm(body: string, contentType: string | undefined): URLSearchParams {
  if (contentType?.includes('application/json')) {
    const parsed = JSON.parse(body || '{}')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new LocalBotOAuthError('invalid_request', 'The request body must be an object.')
    const form = new URLSearchParams()
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>))
      if (value !== null && value !== undefined) form.set(key, String(value))
    return form
  }
  return new URLSearchParams(body)
}

export class BotHttpServer {
  private server: http.Server | null = null
  private readonly sockets = new Set<Socket>()
  private readonly hits = new Map<string, { count: number; resetAt: number }>()
  private publicOrigin = ''
  private publicHostname = ''
  private basePath = ''

  constructor(private readonly options: BotHttpServerOptions) {}

  /** Bind the listener and adopt the public URL. Starting again first releases the previous listener. */
  async start(config: BotHttpServerConfig): Promise<void> {
    await this.stop()
    this.options.oauth.configure(config.publicUrl)
    const published = new URL(normalizeBotPublicUrl(config.publicUrl))
    this.publicOrigin = published.origin
    this.publicHostname = published.hostname
    this.basePath = published.pathname.replace(/\/+$/, '')
    const server = http.createServer((request, response) => {
      void this.handle(request, response).catch(() => {
        if (!response.headersSent) this.send(response, 500, { error: 'server_error' })
        else response.destroy()
      })
    })
    server.headersTimeout = HEADERS_TIMEOUT_MS
    // A bot waiting for chat events holds the request open for as long as the tool needs.
    server.requestTimeout = 0
    server.setTimeout(0)
    server.on('connection', (socket) => {
      this.sockets.add(socket)
      socket.once('close', () => this.sockets.delete(socket))
    })
    await new Promise<void>((resolve, reject) => {
      const failed = (error: Error) => reject(error)
      server.once('error', failed)
      server.listen(config.port, config.host, () => {
        server.off('error', failed)
        resolve()
      })
    })
    this.server = server
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = null
    this.hits.clear()
    if (!server) return
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  /** Bound port, for a caller that asked for port 0. */
  port(): number | null {
    const address = this.server?.address()
    return address && typeof address === 'object' ? address.port : null
  }

  private async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const target = new URL(request.url ?? '/', 'http://bot.invalid')
    if (!this.acceptableHost(request) || !this.acceptableOrigin(request)) {
      this.send(response, 403, { error: 'forbidden', error_description: 'This host is not served here.' })
      return
    }
    let path = target.pathname
    if (this.basePath && (path === this.basePath || path.startsWith(`${this.basePath}/`)))
      path = path.slice(this.basePath.length) || '/'
    const method = request.method ?? 'GET'
    const mcp = path === BOT_MCP_PATH
    if (!this.withinRate(request, mcp ? 'mcp' : 'oauth', mcp ? MCP_RATE_MAX : OAUTH_RATE_MAX)) {
      this.send(response, 429, { error: 'too_many_requests' }, { 'retry-after': '60' })
      return
    }
    try {
      if (mcp) return await this.handleMcp(request, response, method)
      return await this.handleOAuth(request, response, method, path, target)
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        this.send(
          response,
          413,
          { error: 'invalid_request', error_description: 'The request body is too large.' },
          { connection: 'close' }
        )
        response.once('finish', () => request.socket?.destroy())
        return
      }
      if (error instanceof LocalBotOAuthError) {
        this.send(response, error.status, { error: error.code, error_description: error.message })
        return
      }
      if (error instanceof SyntaxError) {
        this.send(response, 400, { error: 'invalid_request', error_description: 'The request body is not valid JSON.' })
        return
      }
      // Nothing internal is ever echoed back to a bot.
      this.send(response, 500, { error: 'server_error' })
    }
  }

  private async handleOAuth(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    method: string,
    path: string,
    target: URL
  ): Promise<void> {
    const oauth = this.options.oauth
    if (path === BOT_PROTECTED_RESOURCE_PATH || path === '/.well-known/oauth-protected-resource') {
      if (method !== 'GET') return this.methodNotAllowed(response, 'GET')
      return this.send(response, 200, oauth.protectedResourceMetadata())
    }
    if (path === BOT_AUTHORIZATION_SERVER_PATH || path === `${BOT_AUTHORIZATION_SERVER_PATH}${BOT_MCP_PATH}`) {
      if (method !== 'GET') return this.methodNotAllowed(response, 'GET')
      return this.send(response, 200, oauth.authorizationServerMetadata())
    }
    if (path === BOT_OAUTH_REGISTER_PATH) {
      if (method !== 'POST') return this.methodNotAllowed(response, 'POST')
      const body = await readBody(request, MAX_OAUTH_BODY_BYTES)
      return this.send(response, 201, oauth.registerClient(JSON.parse(body || '{}')))
    }
    if (path === BOT_OAUTH_AUTHORIZE_PATH) {
      if (method !== 'GET') return this.methodNotAllowed(response, 'GET')
      const outcome = oauth.authorize(target.searchParams)
      if (outcome.kind === 'redirect') {
        response.writeHead(302, { ...SAFE_HEADERS, location: outcome.location }).end()
        return
      }
      return this.sendConsentPage(response, outcome.clientName, outcome.pollToken)
    }
    if (path === BOT_OAUTH_STATUS_PATH) {
      if (method !== 'GET') return this.methodNotAllowed(response, 'GET')
      return this.send(response, 200, oauth.authorizationState(target.searchParams.get('poll') ?? ''))
    }
    if (path === BOT_OAUTH_TOKEN_PATH) {
      if (method !== 'POST') return this.methodNotAllowed(response, 'POST')
      const body = await readBody(request, MAX_OAUTH_BODY_BYTES)
      return this.send(response, 200, oauth.token(asForm(body, request.headers['content-type'])))
    }
    if (path === BOT_OAUTH_REVOKE_PATH) {
      if (method !== 'POST') return this.methodNotAllowed(response, 'POST')
      const body = await readBody(request, MAX_OAUTH_BODY_BYTES)
      oauth.revokeToken(asForm(body, request.headers['content-type']))
      return this.send(response, 200, {})
    }
    this.send(response, 404, { error: 'not_found' })
  }

  private async handleMcp(request: http.IncomingMessage, response: http.ServerResponse, method: string): Promise<void> {
    if (method !== 'POST') return this.methodNotAllowed(response, 'POST')
    const oauth = this.options.oauth
    const controller = new AbortController()
    request.once('aborted', () => controller.abort())
    response.once('close', () => {
      if (!response.writableEnded) controller.abort()
    })
    const body = await readBody(request, MAX_MCP_BODY_BYTES)
    let payload: unknown
    try {
      payload = JSON.parse(body)
    } catch {
      return this.send(response, 400, {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Invalid JSON.' },
      })
    }
    const authorization = request.headers.authorization ?? ''
    try {
      const result = await dispatchBotMcpPayload(payload, {
        authenticate: () => {
          try {
            const principal = oauth.authenticate(authorization)
            return { connectionId: principal.connectionId, scopes: principal.scopes }
          } catch (error) {
            throw new BotMcpUnauthenticatedError(
              error instanceof LocalBotOAuthError ? error.message : 'A bot access token is required.'
            )
          }
        },
        callTool: this.options.callTool,
        signal: controller.signal,
      })
      if (result.body === undefined) {
        response.writeHead(result.status, SAFE_HEADERS).end()
        return
      }
      this.send(response, result.status, result.body)
    } catch (error) {
      if (error instanceof BotMcpUnauthenticatedError) {
        this.send(
          response,
          401,
          { error: 'invalid_token', error_description: error.message },
          { 'www-authenticate': oauth.challenge() }
        )
        return
      }
      if (error instanceof BotMcpForbiddenError) {
        this.send(response, 403, { error: 'insufficient_scope', error_description: error.message })
        return
      }
      throw error
    }
  }

  /**
   * The bot is parked here while the person at this computer answers in the application. The page only
   * polls its own request; it can neither approve anything nor learn about any other request.
   */
  private sendConsentPage(response: http.ServerResponse, clientName: string, pollToken: string): void {
    const nonce = randomBytes(16).toString('base64')
    const statusUrl = `${this.basePath}${BOT_OAUTH_STATUS_PATH}?poll=${encodeURIComponent(pollToken)}`
    const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Approve this bot</title>
<style nonce="${nonce}">
body{font:16px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#111;color:#eee}
main{max-width:34rem;padding:2rem}h1{font-size:1.25rem}p{color:#bbb}
</style></head>
<body><main>
<h1>Approve &ldquo;${escapeHtml(clientName)}&rdquo;</h1>
<p>Open Maestrly on this computer, review this request in Bots settings, and choose the bot connection it
may act as. Nothing is granted until you approve it there.</p>
<p id="state">Waiting for your answer&hellip;</p>
<noscript><p>Enable JavaScript, or return to your bot after approving the request here.</p></noscript>
</main>
<script nonce="${nonce}">
(function(){
  var url=${JSON.stringify(statusUrl)},out=document.getElementById('state');
  function tick(){
    fetch(url,{cache:'no-store',credentials:'omit'}).then(function(r){return r.json()}).then(function(v){
      if(v.status==='ready'){out.textContent='Answered. Returning to the bot\\u2026';location.replace(v.redirectTo);return}
      if(v.status!=='pending'){out.textContent='This request is no longer available. Start again from your bot.';return}
      setTimeout(tick,1000)
    }).catch(function(){setTimeout(tick,2000)})
  }
  tick()
})();
</script></body></html>`
    response
      .writeHead(200, {
        ...SAFE_HEADERS,
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      })
      .end(html)
  }

  private methodNotAllowed(response: http.ServerResponse, allow: string): void {
    this.send(response, 405, { error: 'method_not_allowed' }, { allow })
  }

  private send(
    response: http.ServerResponse,
    status: number,
    body: unknown,
    headers: Record<string, string> = {}
  ): void {
    const payload = JSON.stringify(body ?? {})
    response
      .writeHead(status, {
        ...SAFE_HEADERS,
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(payload),
        ...headers,
      })
      .end(payload)
  }

  /** DNS rebinding defense: the request must name the published host or the loopback listener itself. */
  private acceptableHost(request: http.IncomingMessage): boolean {
    const host = request.headers.host
    if (!host || host.length > 255) return false
    let hostname: string
    try {
      hostname = new URL(`http://${host}`).hostname
    } catch {
      return false
    }
    return hostname === this.publicHostname || isLoopbackHostname(hostname)
  }

  /** A browser request from any other site is refused before it reaches consent or token state. */
  private acceptableOrigin(request: http.IncomingMessage): boolean {
    const origin = request.headers.origin
    if (!origin) return true
    if (origin === this.publicOrigin) return true
    try {
      return isLoopbackHostname(new URL(origin).hostname)
    } catch {
      return false
    }
  }

  private withinRate(request: http.IncomingMessage, bucket: string, max: number): boolean {
    const key = `${bucket}:${request.socket.remoteAddress ?? 'unknown'}`
    const now = Date.now()
    if (this.hits.size > MAX_RATE_KEYS)
      for (const [entry, value] of this.hits) if (value.resetAt <= now) this.hits.delete(entry)
    const current = this.hits.get(key)
    if (!current || current.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS })
      return true
    }
    current.count += 1
    return current.count <= max
  }
}
