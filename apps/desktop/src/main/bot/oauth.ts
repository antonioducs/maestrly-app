/**
 * Local OAuth 2.1 authorization server for the bot MCP endpoint embedded in this desktop.
 *
 * This computer is its own issuer: there is no bridge account behind it and no remote approval path. A
 * bot registers dynamically, is sent here to authorize, and then waits while the person sitting at this
 * computer approves the request inside the application and chooses which bot connection it may act as.
 * Consent only ever happens through `decide`, which the main process calls from its own IPC handler, so
 * nothing reachable over the network can approve anything or pick a connection.
 *
 * Secrets are only ever stored hashed, authorization codes are single use and short lived, refresh
 * tokens rotate, and every token is bound to the public URL configured for the endpoint. Changing that
 * URL, or revoking a connection, therefore leaves nothing replayable behind.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { BOT_MCP_PATH, BOT_PROTECTED_RESOURCE_PATH } from '@maestrly/protocol'
import { getDb } from '../store'

export const BOT_OAUTH_SCOPES = ['api:read', 'api:write'] as const
export type BotOAuthScope = (typeof BOT_OAUTH_SCOPES)[number]

export const BOT_OAUTH_REGISTER_PATH = '/oauth/register'
export const BOT_OAUTH_AUTHORIZE_PATH = '/oauth/authorize'
export const BOT_OAUTH_STATUS_PATH = '/oauth/authorize/status'
export const BOT_OAUTH_TOKEN_PATH = '/oauth/token'
export const BOT_OAUTH_REVOKE_PATH = '/oauth/revoke'
export const BOT_AUTHORIZATION_SERVER_PATH = '/.well-known/oauth-authorization-server'

/** How long the person has to notice and answer a waiting request. */
const AUTHORIZATION_TTL_MS = 10 * 60_000
/** An approved code is redeemed by the bot within seconds; anything longer is a replay. */
const CODE_TTL_MS = 60_000
const ACCESS_TTL_MS = 60 * 60_000
const REFRESH_TTL_MS = 30 * 24 * 60 * 60_000
/** Replayed codes must still be recognizable for a while after they expire, to revoke their grant. */
const REPLAY_WINDOW_MS = 30 * 60_000
const MAX_CLIENTS = 200
const MAX_PENDING_REQUESTS = 20
const MAX_REDIRECT_URIS = 5
const PKCE_VALUE = /^[A-Za-z0-9\-._~]{43,128}$/

export class LocalBotOAuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400
  ) {
    super(message)
    this.name = 'LocalBotOAuthError'
  }
}

export interface LocalBotPendingAuthorization {
  id: string
  clientName: string
  redirectUri: string
}

export interface LocalBotPrincipal {
  clientId: string
  connectionId: string
  scopes: string[]
}

export interface LocalBotTokenGrant {
  access_token: string
  token_type: 'Bearer'
  expires_in: number
  refresh_token: string
  scope: string
}

export type LocalBotAuthorizeOutcome =
  | { kind: 'consent'; requestId: string; pollToken: string; clientName: string }
  | { kind: 'redirect'; location: string }

export type LocalBotAuthorizationState =
  | { status: 'pending' }
  | { status: 'ready'; redirectTo: string }
  | { status: 'unknown' }

interface ClientRow {
  clientId: string
  clientName: string
  redirectUris: string
}
interface RequestRow {
  id: string
  clientId: string
  redirectUri: string
  state: string | null
  scope: string
  codeChallenge: string
  status: 'pending' | 'approved' | 'denied'
  connectionId: string | null
  codeUsed: number
  expiresAt: number
}
interface TokenRow {
  kind: 'access' | 'refresh'
  requestId: string
  clientId: string
  connectionId: string
  scope: string
  resource: string
  revoked: number
  expiresAt: number
}

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')
const newSecret = (): string => randomBytes(32).toString('base64url')

function equalSecret(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8')
  const b = Buffer.from(right, 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
}

/** Loopback covers the whole 127/8 range plus IPv6 and the reserved `.localhost` names. */
export function isLoopbackHostname(hostname: string): boolean {
  const name = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  return name === 'localhost' || name.endsWith('.localhost') || name === '::1' || /^127(\.\d{1,3}){3}$/.test(name)
}

/**
 * The published URL is the only identity this server has. It is taken from configuration, never from a
 * request header, so a forwarded `Host` or `X-Forwarded-Proto` can never move the issuer or audience.
 */
export function normalizeBotPublicUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new LocalBotOAuthError('invalid_request', 'The public bot URL is not a valid absolute URL.')
  }
  if (url.search || url.hash)
    throw new LocalBotOAuthError('invalid_request', 'The public bot URL must not carry a query or fragment.')
  if (url.username || url.password)
    throw new LocalBotOAuthError('invalid_request', 'The public bot URL must not contain credentials.')
  if (url.pathname !== '/')
    throw new LocalBotOAuthError('invalid_request', 'Use the public HTTPS origin without a path.')
  if (url.protocol !== 'https:') throw new LocalBotOAuthError('invalid_request', 'The public bot URL must use HTTPS.')
  if (isLoopbackHostname(url.hostname) || ['0.0.0.0', '[::]'].includes(url.hostname))
    throw new LocalBotOAuthError('invalid_request', 'The public bot URL must be reachable outside this computer.')
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
}

function normalizeRedirectUri(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 2048)
    throw new LocalBotOAuthError('invalid_redirect_uri', 'A redirect URI is missing or malformed.')
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new LocalBotOAuthError('invalid_redirect_uri', 'A redirect URI is missing or malformed.')
  }
  if (url.hash) throw new LocalBotOAuthError('invalid_redirect_uri', 'A redirect URI must not carry a fragment.')
  if (url.protocol === 'https:') return url.toString()
  if (url.protocol === 'http:') {
    // Only a loopback callback may be plaintext; anything else would expose the code on the network.
    if (!isLoopbackHostname(url.hostname))
      throw new LocalBotOAuthError('invalid_redirect_uri', 'A plaintext redirect URI must be loopback.')
    return url.toString()
  }
  // Native bots call back through their own scheme; script-bearing schemes are never acceptable.
  if (
    !/^[a-z][a-z0-9+.-]*:$/.test(url.protocol) ||
    ['javascript:', 'data:', 'file:', 'blob:', 'vbscript:'].includes(url.protocol)
  )
    throw new LocalBotOAuthError('invalid_redirect_uri', 'This redirect URI scheme is not accepted.')
  return url.toString()
}

function redirectWith(redirectUri: string, params: Record<string, string | null>): string {
  const url = new URL(redirectUri)
  for (const [key, value] of Object.entries(params)) if (value !== null) url.searchParams.set(key, value)
  return url.toString()
}

/** Create the tables this module owns. Safe to call repeatedly and independent of other schema. */
export function initializeBotOAuthSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS bot_oauth_config (
      id INTEGER PRIMARY KEY CHECK(id = 1), issuer TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS bot_oauth_clients (
      client_id TEXT PRIMARY KEY, client_name TEXT NOT NULL,
      redirect_uris TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS bot_oauth_requests (
      id TEXT PRIMARY KEY, client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL, state TEXT,
      scope TEXT NOT NULL, code_challenge TEXT NOT NULL, poll_hash TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK(status IN ('pending','approved','denied')),
      connection_id TEXT, code_hash TEXT UNIQUE, code_used INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS bot_oauth_requests_pending ON bot_oauth_requests(status,expires_at);
    CREATE TABLE IF NOT EXISTS bot_oauth_tokens (
      token_hash TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('access','refresh')),
      request_id TEXT NOT NULL, client_id TEXT NOT NULL, connection_id TEXT NOT NULL,
      scope TEXT NOT NULL, resource TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS bot_oauth_tokens_grant ON bot_oauth_tokens(request_id);
    CREATE INDEX IF NOT EXISTS bot_oauth_tokens_connection ON bot_oauth_tokens(connection_id);
  `)
}

export class LocalBotOAuth {
  private schemaDb: DatabaseSync | null = null

  constructor() {
    try {
      this.db()
    } catch {
      // The store may open after this object exists; the schema is then created on first real use.
    }
  }

  /**
   * Adopt the published URL. A different URL is a different issuer and audience, so everything issued
   * under the previous one is dropped rather than left pointing at an address this bot no longer uses.
   */
  configure(publicUrl: string): string {
    const issuer = normalizeBotPublicUrl(publicUrl)
    if (this.currentIssuer() !== issuer) {
      this.invalidate()
      this.db()
        .prepare(
          'INSERT INTO bot_oauth_config(id,issuer) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET issuer=excluded.issuer'
        )
        .run(issuer)
    }
    return issuer
  }

  issuer(): string {
    const issuer = this.currentIssuer()
    if (!issuer) throw new LocalBotOAuthError('server_error', 'The bot endpoint is not configured yet.', 503)
    return issuer
  }

  resource(): string {
    return this.issuer() + BOT_MCP_PATH
  }

  protectedResourceMetadataUrl(): string {
    return this.issuer() + BOT_PROTECTED_RESOURCE_PATH
  }

  challenge(): string {
    return `Bearer resource_metadata="${this.protectedResourceMetadataUrl()}"`
  }

  protectedResourceMetadata(): Record<string, unknown> {
    return {
      resource: this.resource(),
      authorization_servers: [this.issuer()],
      scopes_supported: [...BOT_OAUTH_SCOPES],
      bearer_methods_supported: ['header'],
      resource_name: 'Maestrly personal chats',
    }
  }

  authorizationServerMetadata(): Record<string, unknown> {
    const issuer = this.issuer()
    return {
      issuer,
      authorization_endpoint: issuer + BOT_OAUTH_AUTHORIZE_PATH,
      token_endpoint: issuer + BOT_OAUTH_TOKEN_PATH,
      registration_endpoint: issuer + BOT_OAUTH_REGISTER_PATH,
      revocation_endpoint: issuer + BOT_OAUTH_REVOKE_PATH,
      scopes_supported: [...BOT_OAUTH_SCOPES],
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none'],
      revocation_endpoint_auth_methods_supported: ['none'],
      code_challenge_methods_supported: ['S256'],
      resource_indicators_supported: true,
    }
  }

  /** Register a public client. Registration authorizes nothing: no connection exists until consent. */
  registerClient(input: unknown): Record<string, unknown> {
    this.purge()
    const value = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
    const requested = Array.isArray(value.redirect_uris) ? value.redirect_uris : []
    if (!requested.length || requested.length > MAX_REDIRECT_URIS)
      throw new LocalBotOAuthError('invalid_redirect_uri', 'Between one and five redirect URIs are required.')
    const redirectUris = requested.map(normalizeRedirectUri)
    if (value.token_endpoint_auth_method !== undefined && value.token_endpoint_auth_method !== 'none')
      throw new LocalBotOAuthError('invalid_client_metadata', 'Only public clients using PKCE are supported.')
    for (const grant of Array.isArray(value.grant_types) ? value.grant_types : [])
      if (grant !== 'authorization_code' && grant !== 'refresh_token')
        throw new LocalBotOAuthError(
          'invalid_client_metadata',
          'Only authorization_code and refresh_token are supported.'
        )
    for (const response of Array.isArray(value.response_types) ? value.response_types : [])
      if (response !== 'code')
        throw new LocalBotOAuthError('invalid_client_metadata', 'Only the code response type is supported.')
    const clientName =
      typeof value.client_name === 'string' && value.client_name.trim()
        ? value.client_name.trim().slice(0, 120)
        : 'Unnamed bot'
    const clientId = randomUUID()
    const db = this.db()
    db.prepare('INSERT INTO bot_oauth_clients(client_id,client_name,redirect_uris,created_at) VALUES(?,?,?,?)').run(
      clientId,
      clientName,
      JSON.stringify(redirectUris),
      Date.now()
    )
    db.prepare(
      `DELETE FROM bot_oauth_clients WHERE client_id IN
        (SELECT client_id FROM bot_oauth_clients ORDER BY created_at DESC LIMIT -1 OFFSET ?)`
    ).run(MAX_CLIENTS)
    return {
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: clientName,
      redirect_uris: redirectUris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: BOT_OAUTH_SCOPES.join(' '),
    }
  }

  /**
   * Start an authorization. Nothing is granted here: the request only becomes a code once the owner
   * approves it in the application and names the connection the bot may act as.
   */
  authorize(params: URLSearchParams): LocalBotAuthorizeOutcome {
    this.purge()
    const client = this.client(params.get('client_id') ?? '')
    if (!client) throw new LocalBotOAuthError('invalid_client', 'This client is not registered here.', 400)
    const registered: string[] = JSON.parse(client.redirectUris)
    const requestedRedirect = params.get('redirect_uri')
    let redirectUri: string
    try {
      redirectUri = requestedRedirect ? normalizeRedirectUri(requestedRedirect) : registered[0]
    } catch {
      throw new LocalBotOAuthError('invalid_request', 'The redirect URI does not match this registration.', 400)
    }
    if (!registered.includes(redirectUri))
      throw new LocalBotOAuthError('invalid_request', 'The redirect URI does not match this registration.', 400)

    const state = params.get('state')
    const fail = (code: string, description: string): LocalBotAuthorizeOutcome => ({
      kind: 'redirect',
      location: redirectWith(redirectUri, { error: code, error_description: description, state }),
    })
    if (params.get('response_type') !== 'code')
      return fail('unsupported_response_type', 'Only the code flow is supported.')
    if (params.get('code_challenge_method') !== 'S256') return fail('invalid_request', 'PKCE with S256 is required.')
    const codeChallenge = params.get('code_challenge') ?? ''
    if (!PKCE_VALUE.test(codeChallenge)) return fail('invalid_request', 'The PKCE code challenge is malformed.')
    if (state !== null && state.length > 512) return fail('invalid_request', 'The state value is too long.')
    const target = params.get('resource')
    if (target !== null && !this.matchesResource(target))
      return fail('invalid_target', 'This resource is not served here.')
    let scope: string
    try {
      scope = grantedScope(params.get('scope'))
    } catch {
      return fail('invalid_scope', 'The requested scope is not supported here.')
    }
    const db = this.db()
    const waiting = db
      .prepare("SELECT COUNT(*) AS total FROM bot_oauth_requests WHERE status='pending' AND expires_at>?")
      .get(Date.now()) as unknown as { total: number }
    if (waiting.total >= MAX_PENDING_REQUESTS)
      return fail('temporarily_unavailable', 'Too many authorization requests are waiting for approval.')

    const requestId = randomUUID()
    const pollToken = newSecret()
    db.prepare(
      `INSERT INTO bot_oauth_requests
        (id,client_id,redirect_uri,state,scope,code_challenge,poll_hash,status,created_at,expires_at)
        VALUES(?,?,?,?,?,?,?,'pending',?,?)`
    ).run(
      requestId,
      client.clientId,
      redirectUri,
      state,
      scope,
      codeChallenge,
      sha256(pollToken),
      Date.now(),
      Date.now() + AUTHORIZATION_TTL_MS
    )
    return { kind: 'consent', requestId, pollToken, clientName: client.clientName }
  }

  /** The waiting browser polls with its own secret; knowing a request id is never enough to read a code. */
  authorizationState(pollToken: string): LocalBotAuthorizationState {
    this.purge()
    if (!pollToken) return { status: 'unknown' }
    const row = this.db()
      .prepare(
        `SELECT id,client_id AS clientId,redirect_uri AS redirectUri,state,status,connection_id AS connectionId,
          code_used AS codeUsed,expires_at AS expiresAt,scope,code_challenge AS codeChallenge
         FROM bot_oauth_requests WHERE poll_hash=?`
      )
      .get(sha256(pollToken)) as unknown as (RequestRow & { code?: string }) | undefined
    if (!row) return { status: 'unknown' }
    if (row.status === 'denied')
      return {
        status: 'ready',
        redirectTo: redirectWith(row.redirectUri, {
          error: 'access_denied',
          error_description: 'The owner of this computer denied the request.',
          state: row.state,
        }),
      }
    if (row.status === 'approved') {
      const code = this.issuedCodes.get(row.id)
      if (!code || row.expiresAt <= Date.now()) return { status: 'unknown' }
      this.issuedCodes.delete(row.id)
      return { status: 'ready', redirectTo: redirectWith(row.redirectUri, { code, state: row.state }) }
    }
    if (row.expiresAt <= Date.now()) return { status: 'unknown' }
    return { status: 'pending' }
  }

  /** Requests waiting for the person at this computer, for the application to show and answer. */
  pending(): Array<{ id: string; clientName: string; redirectUri: string }> {
    this.purge()
    const rows = this.db()
      .prepare(
        `SELECT r.id AS id, c.client_name AS clientName, r.redirect_uri AS redirectUri
         FROM bot_oauth_requests r LEFT JOIN bot_oauth_clients c ON c.client_id=r.client_id
         WHERE r.status='pending' AND r.expires_at>? ORDER BY r.created_at`
      )
      .all(Date.now()) as unknown as Array<{ id: string; clientName: string | null; redirectUri: string }>
    return rows.map((row) => ({
      id: row.id,
      clientName: row.clientName ?? 'Unnamed bot',
      redirectUri: row.redirectUri,
    }))
  }

  /**
   * The only way an authorization is ever granted. It is called by the main process for the person at
   * this computer, who also names the bot connection the token will act as; a dynamically registered
   * client is never bound to a connection on its own.
   */
  decide(id: string, approved: boolean, connectionId: string): void {
    this.purge()
    const db = this.db()
    const row = db
      .prepare('SELECT id,status,expires_at AS expiresAt FROM bot_oauth_requests WHERE id=?')
      .get(id) as unknown as { id: string; status: string; expiresAt: number } | undefined
    if (row?.status !== 'pending' || row.expiresAt <= Date.now())
      throw new Error('This authorization request is no longer waiting for an answer.')
    if (!approved) {
      db.prepare("UPDATE bot_oauth_requests SET status='denied',expires_at=? WHERE id=?").run(
        Date.now() + CODE_TTL_MS,
        id
      )
      return
    }
    if (typeof connectionId !== 'string' || !connectionId.trim() || connectionId.length > 191)
      throw new Error('Choose the bot connection this authorization acts as.')
    const code = newSecret()
    db.prepare(
      "UPDATE bot_oauth_requests SET status='approved',connection_id=?,code_hash=?,code_used=0,expires_at=? WHERE id=?"
    ).run(connectionId.trim(), sha256(code), Date.now() + CODE_TTL_MS, id)
    this.issuedCodes.set(id, code)
  }

  /** Redeem an authorization code or rotate a refresh token. Public clients, so PKCE is the proof. */
  token(form: URLSearchParams): LocalBotTokenGrant {
    this.purge()
    const grantType = form.get('grant_type')
    if (grantType === 'authorization_code') return this.exchangeCode(form)
    if (grantType === 'refresh_token') return this.rotateRefresh(form)
    throw new LocalBotOAuthError('unsupported_grant_type', 'This grant type is not supported.')
  }

  /** RFC 7009. A revoked refresh token takes its whole grant with it. */
  revokeToken(form: URLSearchParams): void {
    this.purge()
    const token = form.get('token')
    if (!token) return
    const row = this.db()
      .prepare('SELECT kind,request_id AS requestId FROM bot_oauth_tokens WHERE token_hash=?')
      .get(sha256(token)) as unknown as { kind: string; requestId: string } | undefined
    if (!row) return
    if (row.kind === 'refresh') this.dropGrant(row.requestId)
    else this.db().prepare('UPDATE bot_oauth_tokens SET revoked=1 WHERE token_hash=?').run(sha256(token))
  }

  /** Resolve a bearer token. The audience must still be the resource this endpoint publishes today. */
  authenticate(bearer: string): LocalBotPrincipal {
    this.purge()
    const value = bearer.startsWith('Bearer ') ? bearer.slice(7).trim() : ''
    if (!value) throw new LocalBotOAuthError('invalid_token', 'A bot access token is required.', 401)
    const row = this.db()
      .prepare(
        `SELECT kind,request_id AS requestId,client_id AS clientId,connection_id AS connectionId,scope,resource,
          revoked,expires_at AS expiresAt FROM bot_oauth_tokens WHERE token_hash=?`
      )
      .get(sha256(value)) as unknown as TokenRow | undefined
    if (row?.kind !== 'access' || row.revoked || row.expiresAt <= Date.now())
      throw new LocalBotOAuthError('invalid_token', 'The bot access token is invalid or expired.', 401)
    if (row.resource !== this.resource())
      throw new LocalBotOAuthError('invalid_token', 'The bot access token was issued for another resource.', 401)
    return { clientId: row.clientId, connectionId: row.connectionId, scopes: row.scope.split(' ').filter(Boolean) }
  }

  /** Drop every code and token. Used when the published URL, and therefore the audience, changes. */
  invalidate(): void {
    const db = this.db()
    db.prepare('DELETE FROM bot_oauth_tokens').run()
    db.prepare('DELETE FROM bot_oauth_requests').run()
    this.issuedCodes.clear()
  }

  /** Forget everything a single bot connection could still act with. */
  revoke(connectionId: string): void {
    const db = this.db()
    db.prepare('DELETE FROM bot_oauth_tokens WHERE connection_id=?').run(connectionId)
    for (const row of db
      .prepare('SELECT id FROM bot_oauth_requests WHERE connection_id=?')
      .all(connectionId) as unknown as Array<{ id: string }>)
      this.issuedCodes.delete(row.id)
    db.prepare('DELETE FROM bot_oauth_requests WHERE connection_id=?').run(connectionId)
  }

  /**
   * Codes live in memory only: they exist for the seconds between the owner's approval and the waiting
   * browser's next poll, and a restart in that window simply asks the bot to authorize again.
   */
  private readonly issuedCodes = new Map<string, string>()

  private exchangeCode(form: URLSearchParams): LocalBotTokenGrant {
    const db = this.db()
    const code = form.get('code') ?? ''
    const invalid = new LocalBotOAuthError('invalid_grant', 'The authorization code is invalid, used or expired.')
    if (!code) throw invalid
    const row = db
      .prepare(
        `SELECT id,client_id AS clientId,redirect_uri AS redirectUri,scope,code_challenge AS codeChallenge,
          status,connection_id AS connectionId,code_used AS codeUsed,expires_at AS expiresAt
         FROM bot_oauth_requests WHERE code_hash=?`
      )
      .get(sha256(code)) as unknown as RequestRow | undefined
    if (row?.status !== 'approved' || !row.connectionId) throw invalid
    if (row.codeUsed) {
      // A replayed code means the first redemption may have been stolen: the grant cannot be trusted.
      this.dropGrant(row.id)
      throw invalid
    }
    if (row.expiresAt <= Date.now()) throw invalid
    if (form.get('client_id') !== row.clientId)
      throw new LocalBotOAuthError('invalid_client', 'This client did not request that code.', 400)
    const redirectUri = form.get('redirect_uri')
    if (redirectUri !== null && redirectUri !== row.redirectUri)
      throw new LocalBotOAuthError('invalid_grant', 'The redirect URI does not match the authorization.')
    const verifier = form.get('code_verifier') ?? ''
    if (
      !PKCE_VALUE.test(verifier) ||
      !equalSecret(createHash('sha256').update(verifier).digest('base64url'), row.codeChallenge)
    )
      throw new LocalBotOAuthError('invalid_grant', 'The PKCE code verifier does not match.')
    const target = form.get('resource')
    if (target !== null && !this.matchesResource(target))
      throw new LocalBotOAuthError('invalid_target', 'This resource is not served here.')
    db.prepare('UPDATE bot_oauth_requests SET code_used=1 WHERE id=?').run(row.id)
    this.issuedCodes.delete(row.id)
    return this.issue(row.id, row.clientId, row.connectionId, row.scope)
  }

  private rotateRefresh(form: URLSearchParams): LocalBotTokenGrant {
    const db = this.db()
    const presented = form.get('refresh_token') ?? ''
    const invalid = new LocalBotOAuthError('invalid_grant', 'The refresh token is invalid, used or expired.')
    if (!presented) throw invalid
    const hash = sha256(presented)
    const row = db
      .prepare(
        `SELECT kind,request_id AS requestId,client_id AS clientId,connection_id AS connectionId,scope,resource,
          revoked,expires_at AS expiresAt FROM bot_oauth_tokens WHERE token_hash=?`
      )
      .get(hash) as unknown as TokenRow | undefined
    if (row?.kind !== 'refresh') throw invalid
    if (row.revoked) {
      // A rotated token being presented again is a replay; the whole grant goes.
      this.dropGrant(row.requestId)
      throw invalid
    }
    if (row.expiresAt <= Date.now() || row.resource !== this.resource()) throw invalid
    const target = form.get('resource')
    if (target !== null && !this.matchesResource(target))
      throw new LocalBotOAuthError('invalid_target', 'This resource is not served here.')
    const clientId = form.get('client_id')
    if (clientId !== null && clientId !== row.clientId)
      throw new LocalBotOAuthError('invalid_client', 'This client did not receive that refresh token.', 400)
    const scope = form.get('scope')
    if (
      scope !== null &&
      !scope
        .split(' ')
        .filter(Boolean)
        .every((entry) => row.scope.split(' ').includes(entry))
    )
      throw new LocalBotOAuthError('invalid_scope', 'A refresh cannot widen the granted scope.')
    db.prepare('UPDATE bot_oauth_tokens SET revoked=1 WHERE token_hash=?').run(hash)
    return this.issue(row.requestId, row.clientId, row.connectionId, scope ? scope : row.scope)
  }

  private issue(requestId: string, clientId: string, connectionId: string, scope: string): LocalBotTokenGrant {
    const accessToken = newSecret()
    const refreshToken = newSecret()
    const resource = this.resource()
    const db = this.db()
    const insert = db.prepare(
      `INSERT INTO bot_oauth_tokens
        (token_hash,kind,request_id,client_id,connection_id,scope,resource,created_at,expires_at)
        VALUES(?,?,?,?,?,?,?,?,?)`
    )
    insert.run(
      sha256(accessToken),
      'access',
      requestId,
      clientId,
      connectionId,
      scope,
      resource,
      Date.now(),
      Date.now() + ACCESS_TTL_MS
    )
    insert.run(
      sha256(refreshToken),
      'refresh',
      requestId,
      clientId,
      connectionId,
      scope,
      resource,
      Date.now(),
      Date.now() + REFRESH_TTL_MS
    )
    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: Math.floor(ACCESS_TTL_MS / 1000),
      refresh_token: refreshToken,
      scope,
    }
  }

  private dropGrant(requestId: string): void {
    const db = this.db()
    db.prepare('DELETE FROM bot_oauth_tokens WHERE request_id=?').run(requestId)
    db.prepare('DELETE FROM bot_oauth_requests WHERE id=?').run(requestId)
    this.issuedCodes.delete(requestId)
  }

  private matchesResource(value: string): boolean {
    const resource = this.resource()
    return value === resource || value === `${resource}/`
  }

  private client(clientId: string): ClientRow | undefined {
    if (!clientId || clientId.length > 191) return undefined
    return this.db()
      .prepare(
        'SELECT client_id AS clientId,client_name AS clientName,redirect_uris AS redirectUris FROM bot_oauth_clients WHERE client_id=?'
      )
      .get(clientId) as unknown as ClientRow | undefined
  }

  private currentIssuer(): string | null {
    const row = this.db().prepare('SELECT issuer FROM bot_oauth_config WHERE id=1').get() as unknown as
      | { issuer: string }
      | undefined
    return row?.issuer ?? null
  }

  private purge(): void {
    const db = this.db()
    db.prepare('DELETE FROM bot_oauth_tokens WHERE expires_at<?').run(Date.now())
    for (const row of db
      .prepare('SELECT id FROM bot_oauth_requests WHERE expires_at<?')
      .all(Date.now() - REPLAY_WINDOW_MS) as unknown as Array<{ id: string }>)
      this.issuedCodes.delete(row.id)
    db.prepare('DELETE FROM bot_oauth_requests WHERE expires_at<?').run(Date.now() - REPLAY_WINDOW_MS)
  }

  private db(): DatabaseSync {
    const db = getDb()
    if (!db) throw new LocalBotOAuthError('server_error', 'The local database is not open.', 503)
    if (this.schemaDb !== db) {
      initializeBotOAuthSchema(db)
      this.schemaDb = db
    }
    return db
  }
}

function grantedScope(requested: string | null): string {
  if (requested === null || !requested.trim()) return BOT_OAUTH_SCOPES.join(' ')
  const scopes = requested.split(' ').filter(Boolean)
  if (!scopes.length || scopes.some((scope) => !(BOT_OAUTH_SCOPES as readonly string[]).includes(scope)))
    throw new LocalBotOAuthError('invalid_scope', 'The requested scope is not supported here.')
  return [...new Set(scopes)].join(' ')
}
