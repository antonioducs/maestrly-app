export interface GitHubCopilotDeviceAuthorization {
  deviceCode: string
  userCode: string
  verificationUri: string
  verificationUriComplete: string | null
  expiresAt: number
  intervalSeconds: number
}

export interface GitHubCopilotOAuthToken {
  accessToken: string
  tokenType: string
  scope: string
}

export type GitHubCopilotOAuthErrorCode =
  | 'configuration_missing'
  | 'invalid_response'
  | 'request_failed'
  | 'access_denied'
  | 'expired_token'
  | 'cancelled'
  | 'oauth_error'

export class GitHubCopilotOAuthError extends Error {
  readonly code: GitHubCopilotOAuthErrorCode

  constructor(code: GitHubCopilotOAuthErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'GitHubCopilotOAuthError'
    this.code = code
  }
}

interface OAuthResponse {
  ok: boolean
  status: number
  json(): Promise<unknown>
}

export type GitHubCopilotOAuthFetch = (url: string, init: RequestInit) => Promise<OAuthResponse>

export interface GitHubCopilotOAuthDependencies {
  fetch: GitHubCopilotOAuthFetch
  now: () => number
  sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>
}

export interface GitHubCopilotOAuthClientOptions {
  clientId: string
  /** GitHub host that owns the OAuth App. Defaults to github.com. */
  oauthBaseUrl?: string
  scope?: string
  dependencies?: Partial<GitHubCopilotOAuthDependencies>
}

const DEFAULT_SCOPE = 'read:user'
const MIN_POLL_INTERVAL_SECONDS = 1
const SLOW_DOWN_SECONDS = 5

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

function abortError(): GitHubCopilotOAuthError {
  return new GitHubCopilotOAuthError('cancelled', 'GitHub Copilot login was cancelled')
}

function defaultSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError())
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, milliseconds)
    timer.unref()
    const onAbort = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(abortError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

const DEFAULT_DEPENDENCIES: GitHubCopilotOAuthDependencies = {
  fetch: (url, init) => fetch(url, init),
  now: () => Date.now(),
  sleep: defaultSleep,
}

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '')
  if (!trimmed) return 'https://github.com'
  const url = new URL(trimmed)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && url.hostname === 'localhost')) {
    throw new GitHubCopilotOAuthError('configuration_missing', 'GitHub OAuth host must use HTTPS')
  }
  return url.toString().replace(/\/+$/, '')
}

function oauthMessage(payload: Record<string, unknown>, fallback: string): string {
  return nonEmptyString(payload.error_description) ?? nonEmptyString(payload.error) ?? fallback
}

/**
 * Minimal OAuth Device Flow client for a Maestrly-owned public GitHub OAuth App.
 * Device Flow intentionally has no client secret: shipping one in Electron would not make it confidential.
 */
export class GitHubCopilotOAuthClient {
  private readonly clientId: string
  private readonly scope: string
  private readonly baseUrl: string
  private readonly dependencies: GitHubCopilotOAuthDependencies

  constructor(options: GitHubCopilotOAuthClientOptions) {
    this.clientId = options.clientId.trim()
    this.scope = options.scope?.trim() || DEFAULT_SCOPE
    this.baseUrl = normalizeBaseUrl(options.oauthBaseUrl ?? 'https://github.com')
    this.dependencies = { ...DEFAULT_DEPENDENCIES, ...options.dependencies }
  }

  async startDeviceFlow(signal?: AbortSignal): Promise<GitHubCopilotDeviceAuthorization> {
    if (!this.clientId) {
      throw new GitHubCopilotOAuthError(
        'configuration_missing',
        'GitHub Copilot OAuth Client ID is not configured in this build'
      )
    }
    if (signal?.aborted) throw abortError()

    const payload = await this.post('/login/device/code', { client_id: this.clientId, scope: this.scope }, signal)
    const deviceCode = nonEmptyString(payload.device_code)
    const userCode = nonEmptyString(payload.user_code)
    const verificationUri = nonEmptyString(payload.verification_uri)
    const expiresIn = positiveNumber(payload.expires_in)
    const interval = positiveNumber(payload.interval) ?? 5
    if (!deviceCode || !userCode || !verificationUri || !expiresIn) {
      throw new GitHubCopilotOAuthError('invalid_response', 'GitHub returned an invalid Device Flow response')
    }

    return {
      deviceCode,
      userCode,
      verificationUri,
      verificationUriComplete: nonEmptyString(payload.verification_uri_complete),
      expiresAt: this.dependencies.now() + expiresIn * 1_000,
      intervalSeconds: Math.max(MIN_POLL_INTERVAL_SECONDS, interval),
    }
  }

  async pollForToken(
    authorization: GitHubCopilotDeviceAuthorization,
    signal?: AbortSignal
  ): Promise<GitHubCopilotOAuthToken> {
    let intervalSeconds = Math.max(MIN_POLL_INTERVAL_SECONDS, authorization.intervalSeconds)

    while (this.dependencies.now() < authorization.expiresAt) {
      if (signal?.aborted) throw abortError()
      await this.dependencies.sleep(intervalSeconds * 1_000, signal)
      if (signal?.aborted) throw abortError()
      if (this.dependencies.now() >= authorization.expiresAt) break

      const payload = await this.post(
        '/login/oauth/access_token',
        {
          client_id: this.clientId,
          device_code: authorization.deviceCode,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        },
        signal
      )
      const accessToken = nonEmptyString(payload.access_token)
      if (accessToken) {
        return {
          accessToken,
          tokenType: nonEmptyString(payload.token_type) ?? 'bearer',
          scope: nonEmptyString(payload.scope) ?? this.scope,
        }
      }

      const error = nonEmptyString(payload.error)
      if (error === 'authorization_pending') continue
      if (error === 'slow_down') {
        intervalSeconds += SLOW_DOWN_SECONDS
        continue
      }
      if (error === 'access_denied') {
        throw new GitHubCopilotOAuthError('access_denied', oauthMessage(payload, 'GitHub login was denied'))
      }
      if (error === 'expired_token') {
        throw new GitHubCopilotOAuthError('expired_token', oauthMessage(payload, 'GitHub login code expired'))
      }
      throw new GitHubCopilotOAuthError('oauth_error', oauthMessage(payload, 'GitHub OAuth login failed'))
    }

    throw new GitHubCopilotOAuthError('expired_token', 'GitHub login code expired')
  }

  private async post(
    pathname: string,
    body: Record<string, string>,
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    let response: OAuthResponse
    try {
      response = await this.dependencies.fetch(`${this.baseUrl}${pathname}`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams(body).toString(),
        signal,
      })
    } catch (cause) {
      if (signal?.aborted) throw abortError()
      throw new GitHubCopilotOAuthError('request_failed', 'Could not reach GitHub OAuth', { cause })
    }

    let payload: unknown
    try {
      payload = await response.json()
    } catch (cause) {
      throw new GitHubCopilotOAuthError('invalid_response', 'GitHub OAuth returned invalid JSON', { cause })
    }
    if (!isRecord(payload)) {
      throw new GitHubCopilotOAuthError('invalid_response', 'GitHub OAuth returned an invalid response')
    }
    if (!response.ok) {
      throw new GitHubCopilotOAuthError(
        'request_failed',
        oauthMessage(payload, `GitHub OAuth request failed (${response.status})`)
      )
    }
    return payload
  }
}
