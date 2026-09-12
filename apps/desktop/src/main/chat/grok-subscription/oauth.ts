/**
 * xAI OAuth client for Maestrly's Grok subscription provider.
 *
 * Conceptual reference: OpenCode / Hermes public Grok-CLI OAuth flows (PKCE loopback + RFC 8628 device).
 * Maestrly owns its client identity: no OpenCode branding, User-Agent, referrer, or production client ID.
 */
import { createHash, randomBytes } from 'node:crypto'
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import type { GrokTokenBundle } from './token-store'
import { grokSubscriptionErrorMessage } from './errors'

export const XAI_API_BASE_URL = 'https://api.x.ai/v1'
export const XAI_OAUTH_ISSUER = 'https://auth.x.ai'
export const XAI_OAUTH_DISCOVERY_URL = `${XAI_OAUTH_ISSUER}/.well-known/openid-configuration`
export const XAI_OAUTH_AUTHORIZE_URL = `${XAI_OAUTH_ISSUER}/oauth2/authorize`
export const XAI_OAUTH_TOKEN_URL = `${XAI_OAUTH_ISSUER}/oauth2/token`
export const XAI_OAUTH_DEVICE_URL = `${XAI_OAUTH_ISSUER}/oauth2/device/code`
export const XAI_OAUTH_USERINFO_URL = `${XAI_OAUTH_ISSUER}/oauth2/userinfo`

/** Scopes required for subscription model access + offline refresh. */
export const XAI_OAUTH_SCOPE = 'openid profile email offline_access grok-cli:access api:access'

export const ACCESS_TOKEN_REFRESH_SKEW_MS = 120_000
export const OAUTH_CALLBACK_TIMEOUT_MS = 180_000
export const OAUTH_REDIRECT_HOST = '127.0.0.1'
export const OAUTH_REDIRECT_PREFERRED_PORT = 56_121
export const OAUTH_REDIRECT_PATH = '/callback'
export const DEVICE_CODE_DEFAULT_INTERVAL_MS = 5_000
export const DEVICE_CODE_MIN_INTERVAL_MS = 1_000
export const DEVICE_CODE_SLOW_DOWN_INCREMENT_MS = 5_000
export const DEVICE_CODE_DEFAULT_EXPIRES_MS = 5 * 60 * 1_000
export const DEFAULT_TOKEN_LIFETIME_SECONDS = 3_600

/** Non-secret sentinel that satisfies AI SDK apiKey requirements; real auth is injected via fetch. */
export const GROK_OAUTH_DUMMY_API_KEY = 'maestrly-grok-oauth'

/**
 * Public Grok-CLI OAuth client ID (same surface OpenCode uses). Desktop builds carry this as the
 * default Maestrly Grok subscription client — Device/PKCE flows intentionally have no client secret.
 */
export const DEFAULT_XAI_OAUTH_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828'

/** @deprecated Use DEFAULT_XAI_OAUTH_CLIENT_ID — kept as alias for older call sites/tests. */
export const XAI_EXTERNAL_SMOKE_CLIENT_ID = DEFAULT_XAI_OAUTH_CLIENT_ID

export type GrokOAuthErrorCode =
  | 'configuration_missing'
  | 'invalid_response'
  | 'request_failed'
  | 'access_denied'
  | 'expired_token'
  | 'invalid_grant'
  | 'cancelled'
  | 'timeout'
  | 'port_in_use'
  | 'state_mismatch'
  | 'oauth_error'

export class GrokOAuthError extends Error {
  readonly code: GrokOAuthErrorCode

  constructor(code: GrokOAuthErrorCode, message: string, options?: ErrorOptions) {
    super(grokSubscriptionErrorMessage(message), options)
    this.name = 'GrokOAuthError'
    this.code = code
  }
}

export interface GrokOAuthDiscovery {
  authorizationEndpoint: string
  tokenEndpoint: string
  deviceAuthorizationEndpoint: string
  userinfoEndpoint: string
}

export interface GrokPkcePair {
  verifier: string
  challenge: string
}

export interface GrokDeviceAuthorization {
  deviceCode: string
  userCode: string
  verificationUri: string
  verificationUriComplete: string | null
  expiresAt: number
  intervalSeconds: number
  /** Discovered token endpoint (validated against x.ai); polling uses this endpoint, not the hardcoded one. */
  tokenEndpoint: string
}

export interface GrokBrowserLoginSession {
  loginId: string
  authUrl: string
  redirectUri: string
  state: string
  method: 'browser'
}

export interface GrokDeviceLoginSession {
  loginId: string
  userCode: string
  verificationUri: string
  verificationUriComplete: string | null
  expiresAt: number
  method: 'device'
}

export type GrokLoginMethod = 'browser' | 'device'

interface OAuthResponse {
  ok: boolean
  status: number
  text(): Promise<string>
  json(): Promise<unknown>
}

export type GrokOAuthFetch = (url: string, init: RequestInit) => Promise<OAuthResponse>

export interface GrokOAuthDependencies {
  fetch: GrokOAuthFetch
  now: () => number
  sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>
  createServer: typeof http.createServer
  randomBytes: (size: number) => Buffer
}

export interface GrokOAuthClientOptions {
  clientId: string
  /** Product referrer sent to xAI. Must be Maestrly's identity, never another product's. */
  referrer?: string
  scope?: string
  userAgent?: string
  dependencies?: Partial<GrokOAuthDependencies>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function positiveNumber(value: unknown): number | null {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function abortError(): GrokOAuthError {
  return new GrokOAuthError('cancelled', 'Grok login was cancelled')
}

function defaultSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError())
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, milliseconds)
    timer.unref?.()
    const onAbort = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(abortError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

const DEFAULT_DEPENDENCIES: GrokOAuthDependencies = {
  fetch: (url, init) => fetch(url, init),
  now: () => Date.now(),
  sleep: defaultSleep,
  createServer: http.createServer,
  randomBytes: (size) => randomBytes(size),
}

function oauthMessage(payload: Record<string, unknown>, fallback: string): string {
  return nonEmptyString(payload.error_description) ?? nonEmptyString(payload.error) ?? fallback
}

export function validateXaiOAuthEndpoint(url: string, field = 'endpoint'): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new GrokOAuthError('invalid_response', `xAI OAuth discovery returned an invalid ${field}`)
  }
  if (parsed.protocol !== 'https:') {
    throw new GrokOAuthError('invalid_response', `xAI OAuth ${field} must use HTTPS`)
  }
  const host = parsed.hostname.toLowerCase()
  if (host !== 'x.ai' && !host.endsWith('.x.ai')) {
    throw new GrokOAuthError('invalid_response', `xAI OAuth ${field} host is not on x.ai`)
  }
  return url
}

function validateHttpsUri(raw: string, label: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new GrokOAuthError('invalid_response', `Untrusted ${label} in xAI OAuth response`)
  }
  if (url.protocol !== 'https:') {
    throw new GrokOAuthError('invalid_response', `Untrusted ${label} in xAI OAuth response`)
  }
  return url.href
}

/** Decode JWT `exp` without verifying the signature — used only as a refresh hint. */
export function readJwtExpiryMs(token: string | undefined): number | null {
  if (!token || typeof token !== 'string') return null
  const parts = token.split('.')
  if (parts.length < 2) return null
  try {
    let payload = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    while (payload.length % 4 !== 0) payload += '='
    const claims = JSON.parse(Buffer.from(payload, 'base64').toString('utf8')) as { exp?: unknown }
    return typeof claims.exp === 'number' && Number.isFinite(claims.exp) ? claims.exp * 1_000 : null
  } catch {
    return null
  }
}

export function calculateTokenExpiry(
  requestTimeMs: number,
  expiresInSeconds: unknown,
  accessToken?: string
): number {
  const fromResponse = positiveNumber(expiresInSeconds)
  if (fromResponse) return requestTimeMs + fromResponse * 1_000
  const jwtExpiry = readJwtExpiryMs(accessToken)
  if (jwtExpiry) return jwtExpiry
  return requestTimeMs + DEFAULT_TOKEN_LIFETIME_SECONDS * 1_000
}

export function accessTokenNeedsRefresh(
  bundle: Pick<GrokTokenBundle, 'accessToken' | 'expiresAt'>,
  nowMs: number,
  skewMs = ACCESS_TOKEN_REFRESH_SKEW_MS
): boolean {
  if (!bundle.accessToken) return true
  if (!Number.isFinite(bundle.expiresAt) || bundle.expiresAt - nowMs <= skewMs) return true
  const jwtExpiry = readJwtExpiryMs(bundle.accessToken)
  if (jwtExpiry != null && jwtExpiry - nowMs <= skewMs) return true
  return false
}

export function generatePkce(random: (size: number) => Buffer = randomBytes): GrokPkcePair {
  const verifier = random(48).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

export function createOAuthState(random: (size: number) => Buffer = randomBytes): string {
  return random(24).toString('hex')
}

export function createOAuthNonce(random: (size: number) => Buffer = randomBytes): string {
  return random(24).toString('hex')
}

export function parseOAuthCallbackInput(
  input: string,
  expectedState: string
): { code: string; state: string } | { error: string; code?: GrokOAuthErrorCode } {
  const raw = input.trim()
  if (!raw) return { error: 'Missing authorization code.', code: 'invalid_response' }

  let code = raw
  let state = expectedState
  try {
    const url = new URL(raw)
    const oauthError = url.searchParams.get('error')
    if (oauthError) {
      return {
        error: url.searchParams.get('error_description') ?? oauthError,
        code: oauthError === 'access_denied' ? 'access_denied' : 'oauth_error',
      }
    }
    code = url.searchParams.get('code') ?? ''
    state = url.searchParams.get('state') ?? ''
  } catch {
    // Plain authorization code — keep expected state from the local session.
  }

  if (!code) return { error: 'Missing authorization code in callback.', code: 'invalid_response' }
  if (state !== expectedState) return { error: 'OAuth state mismatch.', code: 'state_mismatch' }
  return { code, state }
}

export interface GrokOAuthListener {
  redirectUri: string
  port: number
  waitForCallback(timeoutMs: number, signal?: AbortSignal): Promise<URL>
  close(): Promise<void>
}

const ALLOWED_CALLBACK_ORIGINS = new Set(['https://accounts.x.ai', 'https://auth.x.ai'])

function listenWithFallback(
  server: http.Server,
  preferredPort: number,
  host: string
): Promise<number> {
  return new Promise((resolve, reject) => {
    const tryListen = (port: number, allowFallback: boolean) => {
      const onError = (error: NodeJS.ErrnoException) => {
        server.off('listening', onListening)
        if (allowFallback && error.code === 'EADDRINUSE') {
          tryListen(0, false)
          return
        }
        reject(
          new GrokOAuthError(
            error.code === 'EADDRINUSE' ? 'port_in_use' : 'request_failed',
            error.code === 'EADDRINUSE'
              ? 'Grok OAuth callback port is already in use'
              : 'Could not start Grok OAuth callback listener'
          )
        )
      }
      const onListening = () => {
        server.off('error', onError)
        const address = server.address()
        if (!address || typeof address === 'string') {
          reject(new GrokOAuthError('request_failed', 'Could not determine Grok OAuth callback port'))
          return
        }
        resolve(address.port)
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(port, host)
    }
    tryListen(preferredPort, preferredPort !== 0)
  })
}

function handleCallbackRequest(
  req: IncomingMessage,
  res: ServerResponse,
  onCallback: (url: URL) => void,
  consumed: { value: boolean }
): void {
  const origin = req.headers.origin
  const allowOrigin = typeof origin === 'string' && ALLOWED_CALLBACK_ORIGINS.has(origin) ? origin : ''
  if (allowOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowOrigin)
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    res.setHeader('Access-Control-Allow-Private-Network', 'true')
    res.setHeader('Vary', 'Origin')
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }
  const host = req.headers.host ?? `${OAUTH_REDIRECT_HOST}:${OAUTH_REDIRECT_PREFERRED_PORT}`
  const url = new URL(req.url ?? '/', `http://${host}`)
  if (req.method !== 'GET' || url.pathname !== OAUTH_REDIRECT_PATH) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('Not found.')
    return
  }
  if (consumed.value) {
    res.writeHead(409, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end('<html><body><h1>Authorization callback already consumed.</h1></body></html>')
    return
  }
  consumed.value = true
  onCallback(url)
  const failed = url.searchParams.has('error')
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(
    `<html><body><h1>${failed ? 'Grok authorization failed.' : 'Grok authorization received.'}</h1><p>You can close this tab and return to Maestrly.</p></body></html>`
  )
}

export async function startGrokOAuthListener(
  preferredPort = OAUTH_REDIRECT_PREFERRED_PORT,
  createServer: typeof http.createServer = http.createServer
): Promise<GrokOAuthListener> {
  let resolveCallback: ((url: URL) => void) | undefined
  let rejectCallback: ((error: Error) => void) | undefined
  const consumed = { value: false }
  const callbackPromise = new Promise<URL>((resolve, reject) => {
    resolveCallback = resolve
    rejectCallback = reject
  })
  // close() rejects callbackPromise even without waiters (abort before waitForCallback); mark it
  // handled to avoid an unhandled rejection. Waiters use waitForCallback (then/catch).
  callbackPromise.catch(() => undefined)
  const server = createServer((req, res) => {
    handleCallbackRequest(req, res, (url) => resolveCallback?.(url), consumed)
  })
  const port = await listenWithFallback(server, preferredPort, OAUTH_REDIRECT_HOST)
  const redirectUri = `http://${OAUTH_REDIRECT_HOST}:${port}${OAUTH_REDIRECT_PATH}`
  return {
    redirectUri,
    port,
    waitForCallback(timeoutMs, signal) {
      if (signal?.aborted) return Promise.reject(abortError())
      return new Promise<URL>((resolve, reject) => {
        const timer = setTimeout(() => {
          cleanup()
          reject(new GrokOAuthError('timeout', 'Timed out waiting for the Grok OAuth callback'))
        }, timeoutMs)
        timer.unref?.()
        const onAbort = (): void => {
          cleanup()
          reject(abortError())
        }
        const cleanup = (): void => {
          clearTimeout(timer)
          signal?.removeEventListener('abort', onAbort)
        }
        signal?.addEventListener('abort', onAbort, { once: true })
        callbackPromise.then(
          (url) => {
            cleanup()
            resolve(url)
          },
          (error) => {
            cleanup()
            reject(error)
          }
        )
      })
    },
    close() {
      return new Promise<void>((resolve) => {
        rejectCallback?.(abortError())
        rejectCallback = undefined
        resolveCallback = undefined
        server.close(() => resolve())
      })
    },
  }
}

export class GrokOAuthClient {
  private readonly clientId: string
  private readonly scope: string
  private readonly referrer: string
  private readonly userAgent: string
  private readonly dependencies: GrokOAuthDependencies

  constructor(options: GrokOAuthClientOptions) {
    this.clientId = options.clientId.trim()
    this.scope = options.scope?.trim() || XAI_OAUTH_SCOPE
    this.referrer = options.referrer?.trim() || 'maestrly'
    this.userAgent = options.userAgent?.trim() || 'maestrly'
    this.dependencies = { ...DEFAULT_DEPENDENCIES, ...options.dependencies }
  }

  async discover(signal?: AbortSignal): Promise<GrokOAuthDiscovery> {
    if (!this.clientId) {
      throw new GrokOAuthError('configuration_missing', 'Grok OAuth Client ID is not configured in this build')
    }
    if (signal?.aborted) throw abortError()
    let response: OAuthResponse
    try {
      response = await this.dependencies.fetch(XAI_OAUTH_DISCOVERY_URL, {
        headers: { Accept: 'application/json', 'User-Agent': this.userAgent },
        signal,
      })
    } catch (cause) {
      if (signal?.aborted) throw abortError()
      throw new GrokOAuthError('request_failed', 'Could not reach xAI OAuth discovery', { cause })
    }
    let payload: unknown
    try {
      payload = await response.json()
    } catch (cause) {
      throw new GrokOAuthError('invalid_response', 'xAI OAuth discovery returned invalid JSON', { cause })
    }
    if (!response.ok || !isRecord(payload)) {
      throw new GrokOAuthError('invalid_response', 'xAI OAuth discovery failed')
    }
    const authorizationEndpoint = nonEmptyString(payload.authorization_endpoint) ?? XAI_OAUTH_AUTHORIZE_URL
    const tokenEndpoint = nonEmptyString(payload.token_endpoint) ?? XAI_OAUTH_TOKEN_URL
    const deviceAuthorizationEndpoint =
      nonEmptyString(payload.device_authorization_endpoint) ?? XAI_OAUTH_DEVICE_URL
    const userinfoEndpoint = nonEmptyString(payload.userinfo_endpoint) ?? XAI_OAUTH_USERINFO_URL
    return {
      authorizationEndpoint: validateXaiOAuthEndpoint(authorizationEndpoint, 'authorization_endpoint'),
      tokenEndpoint: validateXaiOAuthEndpoint(tokenEndpoint, 'token_endpoint'),
      deviceAuthorizationEndpoint: validateXaiOAuthEndpoint(
        deviceAuthorizationEndpoint,
        'device_authorization_endpoint'
      ),
      userinfoEndpoint: validateXaiOAuthEndpoint(userinfoEndpoint, 'userinfo_endpoint'),
    }
  }

  buildAuthorizeUrl(input: {
    authorizationEndpoint?: string
    redirectUri: string
    codeChallenge: string
    state: string
    nonce: string
  }): string {
    if (!this.clientId) {
      throw new GrokOAuthError('configuration_missing', 'Grok OAuth Client ID is not configured in this build')
    }
    const endpoint = input.authorizationEndpoint ?? XAI_OAUTH_AUTHORIZE_URL
    validateXaiOAuthEndpoint(endpoint, 'authorization_endpoint')
    const url = new URL(endpoint)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('client_id', this.clientId)
    url.searchParams.set('redirect_uri', input.redirectUri)
    url.searchParams.set('scope', this.scope)
    url.searchParams.set('code_challenge', input.codeChallenge)
    url.searchParams.set('code_challenge_method', 'S256')
    url.searchParams.set('state', input.state)
    url.searchParams.set('nonce', input.nonce)
    url.searchParams.set('plan', 'generic')
    url.searchParams.set('referrer', this.referrer)
    return url.toString()
  }

  async startBrowserLogin(signal?: AbortSignal): Promise<{
    authUrl: string
    redirectUri: string
    state: string
    nonce: string
    pkce: GrokPkcePair
    discovery: GrokOAuthDiscovery
    listener: GrokOAuthListener
  }> {
    if (!this.clientId) {
      throw new GrokOAuthError('configuration_missing', 'Grok OAuth Client ID is not configured in this build')
    }
    const discovery = await this.discover(signal)
    const listener = await startGrokOAuthListener(OAUTH_REDIRECT_PREFERRED_PORT, this.dependencies.createServer)
    if (signal?.aborted) {
      await listener.close().catch(() => undefined)
      throw abortError()
    }
    const pkce = generatePkce(this.dependencies.randomBytes)
    const state = createOAuthState(this.dependencies.randomBytes)
    const nonce = createOAuthNonce(this.dependencies.randomBytes)
    const authUrl = this.buildAuthorizeUrl({
      authorizationEndpoint: discovery.authorizationEndpoint,
      redirectUri: listener.redirectUri,
      codeChallenge: pkce.challenge,
      state,
      nonce,
    })
    return { authUrl, redirectUri: listener.redirectUri, state, nonce, pkce, discovery, listener }
  }

  async completeBrowserLogin(
    session: {
      redirectUri: string
      state: string
      pkce: GrokPkcePair
      discovery: GrokOAuthDiscovery
      listener: GrokOAuthListener
    },
    signal?: AbortSignal
  ): Promise<GrokTokenBundle> {
    try {
      const callbackUrl = await session.listener.waitForCallback(OAUTH_CALLBACK_TIMEOUT_MS, signal)
      const params = parseOAuthCallbackInput(callbackUrl.toString(), session.state)
      if ('error' in params) {
        throw new GrokOAuthError(params.code ?? 'oauth_error', params.error)
      }
      return await this.exchangeAuthorizationCode(
        {
          tokenEndpoint: session.discovery.tokenEndpoint,
          code: params.code,
          redirectUri: session.redirectUri,
          codeVerifier: session.pkce.verifier,
          codeChallenge: session.pkce.challenge,
        },
        signal
      )
    } finally {
      await session.listener.close().catch(() => undefined)
    }
  }

  async exchangeAuthorizationCode(
    input: {
      tokenEndpoint: string
      code: string
      redirectUri: string
      codeVerifier: string
      codeChallenge: string
    },
    signal?: AbortSignal
  ): Promise<GrokTokenBundle> {
    if (!input.codeVerifier) throw new GrokOAuthError('invalid_response', 'PKCE code verifier is empty')
    const startedAt = this.dependencies.now()
    const payload = await this.postForm(
      validateXaiOAuthEndpoint(input.tokenEndpoint, 'token_endpoint'),
      {
        grant_type: 'authorization_code',
        code: input.code,
        redirect_uri: input.redirectUri,
        client_id: this.clientId,
        code_verifier: input.codeVerifier,
        code_challenge: input.codeChallenge,
        code_challenge_method: 'S256',
      },
      signal
    )
    return this.parseTokenPayload(payload, startedAt)
  }

  async startDeviceFlow(signal?: AbortSignal): Promise<GrokDeviceAuthorization> {
    if (!this.clientId) {
      throw new GrokOAuthError('configuration_missing', 'Grok OAuth Client ID is not configured in this build')
    }
    const discovery = await this.discover(signal)
    const payload = await this.postForm(
      discovery.deviceAuthorizationEndpoint,
      {
        client_id: this.clientId,
        scope: this.scope,
        referrer: this.referrer,
      },
      signal
    )
    const deviceCode = nonEmptyString(payload.device_code)
    const userCode = nonEmptyString(payload.user_code)
    const verificationUriRaw = nonEmptyString(payload.verification_uri)
    const expiresIn = positiveNumber(payload.expires_in)
    if (!deviceCode || !userCode || !verificationUriRaw || !expiresIn) {
      throw new GrokOAuthError('invalid_response', 'xAI returned an invalid Device Flow response')
    }
    const verificationUri = validateHttpsUri(verificationUriRaw, 'verification_uri')
    const completeRaw = nonEmptyString(payload.verification_uri_complete)
    return {
      deviceCode,
      userCode,
      verificationUri,
      verificationUriComplete: completeRaw ? validateHttpsUri(completeRaw, 'verification_uri_complete') : null,
      expiresAt: this.dependencies.now() + expiresIn * 1_000,
      intervalSeconds: Math.max(1, positiveNumber(payload.interval) ?? 5),
      tokenEndpoint: discovery.tokenEndpoint,
    }
  }

  async pollForDeviceToken(
    authorization: GrokDeviceAuthorization,
    signal?: AbortSignal
  ): Promise<GrokTokenBundle> {
    let intervalMs = Math.max(
      DEVICE_CODE_MIN_INTERVAL_MS,
      authorization.intervalSeconds * 1_000 || DEVICE_CODE_DEFAULT_INTERVAL_MS
    )
    while (this.dependencies.now() < authorization.expiresAt) {
      if (signal?.aborted) throw abortError()
      await this.dependencies.sleep(intervalMs, signal)
      if (signal?.aborted) throw abortError()
      if (this.dependencies.now() >= authorization.expiresAt) break

      const startedAt = this.dependencies.now()
      let response: OAuthResponse
      try {
        response = await this.dependencies.fetch(
          validateXaiOAuthEndpoint(authorization.tokenEndpoint || XAI_OAUTH_TOKEN_URL, 'token_endpoint'),
          {
            method: 'POST',
            headers: this.formHeaders(),
            body: new URLSearchParams({
              grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
              client_id: this.clientId,
              device_code: authorization.deviceCode,
            }).toString(),
            signal,
          }
        )
      } catch (cause) {
        if (signal?.aborted) throw abortError()
        throw new GrokOAuthError('request_failed', 'Could not reach xAI OAuth token endpoint', { cause })
      }

      let payload: unknown
      try {
        payload = await response.json()
      } catch (cause) {
        throw new GrokOAuthError('invalid_response', 'xAI OAuth returned invalid JSON', { cause })
      }
      if (!isRecord(payload)) {
        throw new GrokOAuthError('invalid_response', 'xAI OAuth returned an invalid response')
      }

      if (response.ok && nonEmptyString(payload.access_token)) {
        return this.parseTokenPayload(payload, startedAt)
      }

      const error = nonEmptyString(payload.error)
      if (error === 'authorization_pending') continue
      if (error === 'slow_down') {
        intervalMs += DEVICE_CODE_SLOW_DOWN_INCREMENT_MS
        continue
      }
      if (error === 'access_denied' || error === 'authorization_denied') {
        throw new GrokOAuthError('access_denied', oauthMessage(payload, 'Grok login was denied'))
      }
      if (error === 'expired_token') {
        throw new GrokOAuthError('expired_token', oauthMessage(payload, 'Grok login code expired'))
      }
      throw new GrokOAuthError('oauth_error', oauthMessage(payload, 'Grok OAuth login failed'))
    }
    throw new GrokOAuthError('expired_token', 'Grok login code expired')
  }

  async refresh(refreshToken: string, signal?: AbortSignal): Promise<GrokTokenBundle> {
    const normalized = refreshToken.trim()
    if (!normalized) throw new GrokOAuthError('invalid_grant', 'Grok refresh token is missing')
    if (!this.clientId) {
      throw new GrokOAuthError('configuration_missing', 'Grok OAuth Client ID is not configured in this build')
    }
    const startedAt = this.dependencies.now()
    let response: OAuthResponse
    try {
      response = await this.dependencies.fetch(XAI_OAUTH_TOKEN_URL, {
        method: 'POST',
        headers: this.formHeaders(),
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: normalized,
          client_id: this.clientId,
        }).toString(),
        signal,
      })
    } catch (cause) {
      if (signal?.aborted) throw abortError()
      throw new GrokOAuthError('request_failed', 'Could not refresh Grok access token', { cause })
    }

    let payload: unknown
    try {
      payload = await response.json()
    } catch (cause) {
      throw new GrokOAuthError('invalid_response', 'xAI token refresh returned invalid JSON', { cause })
    }
    if (!isRecord(payload)) {
      throw new GrokOAuthError('invalid_response', 'xAI token refresh returned an invalid response')
    }
    if (!response.ok) {
      const error = nonEmptyString(payload.error)
      if (error === 'invalid_grant') {
        throw new GrokOAuthError('invalid_grant', oauthMessage(payload, 'Grok session expired — sign in again'))
      }
      throw new GrokOAuthError(
        'request_failed',
        oauthMessage(payload, `Grok token refresh failed (${response.status})`)
      )
    }
    return this.parseTokenPayload(payload, startedAt, normalized)
  }

  async fetchUserInfo(
    accessToken: string,
    signal?: AbortSignal
  ): Promise<{ email: string | null; name: string | null; planType: string | null }> {
    const token = accessToken.trim()
    if (!token) return { email: null, name: null, planType: null }
    let response: OAuthResponse
    try {
      response = await this.dependencies.fetch(XAI_OAUTH_USERINFO_URL, {
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
          'User-Agent': this.userAgent,
        },
        signal,
      })
    } catch {
      return { email: null, name: null, planType: null }
    }
    if (!response.ok) return { email: null, name: null, planType: null }
    let payload: unknown
    try {
      payload = await response.json()
    } catch {
      return { email: null, name: null, planType: null }
    }
    if (!isRecord(payload)) return { email: null, name: null, planType: null }
    return {
      email: nonEmptyString(payload.email),
      name: nonEmptyString(payload.name) ?? nonEmptyString(payload.preferred_username),
      planType: nonEmptyString(payload.plan) ?? nonEmptyString(payload.plan_type) ?? null,
    }
  }

  private formHeaders(): Record<string, string> {
    return {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': this.userAgent,
    }
  }

  private async postForm(
    url: string,
    body: Record<string, string>,
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    let response: OAuthResponse
    try {
      response = await this.dependencies.fetch(url, {
        method: 'POST',
        headers: this.formHeaders(),
        body: new URLSearchParams(body).toString(),
        signal,
      })
    } catch (cause) {
      if (signal?.aborted) throw abortError()
      throw new GrokOAuthError('request_failed', 'Could not reach xAI OAuth', { cause })
    }
    let payload: unknown
    try {
      payload = await response.json()
    } catch (cause) {
      throw new GrokOAuthError('invalid_response', 'xAI OAuth returned invalid JSON', { cause })
    }
    if (!isRecord(payload)) {
      throw new GrokOAuthError('invalid_response', 'xAI OAuth returned an invalid response')
    }
    if (!response.ok) {
      throw new GrokOAuthError(
        'request_failed',
        oauthMessage(payload, `xAI OAuth request failed (${response.status})`)
      )
    }
    return payload
  }

  private parseTokenPayload(
    payload: Record<string, unknown>,
    startedAt: number,
    previousRefreshToken?: string
  ): GrokTokenBundle {
    const accessToken = nonEmptyString(payload.access_token)
    const refreshToken = nonEmptyString(payload.refresh_token) ?? previousRefreshToken?.trim() ?? null
    if (!accessToken) {
      throw new GrokOAuthError('invalid_response', 'xAI OAuth response did not include access_token')
    }
    if (!refreshToken) {
      throw new GrokOAuthError('invalid_response', 'xAI OAuth response did not include refresh_token')
    }
    const idToken = nonEmptyString(payload.id_token) ?? undefined
    const scope = nonEmptyString(payload.scope) ?? undefined
    return {
      accessToken,
      refreshToken,
      expiresAt: calculateTokenExpiry(startedAt, payload.expires_in, accessToken),
      ...(idToken ? { idToken } : {}),
      ...(scope ? { scope } : {}),
    }
  }
}
