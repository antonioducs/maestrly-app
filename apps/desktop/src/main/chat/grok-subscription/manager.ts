import { createHash, randomUUID } from 'node:crypto'
import { net, app } from 'electron'
import {
  GrokOAuthClient,
  GrokOAuthError,
  GROK_OAUTH_DUMMY_API_KEY,
  XAI_API_BASE_URL,
  DEFAULT_XAI_OAUTH_CLIENT_ID,
  accessTokenNeedsRefresh,
  type GrokDeviceAuthorization,
  type GrokLoginMethod,
  type GrokOAuthClientOptions,
  type GrokOAuthListener,
  type GrokPkcePair,
  type GrokOAuthDiscovery,
} from './oauth'
import {
  createGrokTokenStore,
  defaultGrokTokenStore,
  grokTokenKeyFor,
  type GrokTokenBundle,
  type GrokTokenStorageMode,
  type GrokTokenStore,
} from './token-store'
import { grokSubscriptionErrorMessage } from './errors'

export interface GrokPublicError {
  code?: string | number
  message: string
}

export interface GrokPublicAccount {
  email: string | null
  name: string | null
  planType: string | null
}

export interface GrokAccountIdentity {
  fingerprint: string | null
  epoch: number
}

export interface GrokSubscriptionStatus {
  state: 'ready' | 'error' | 'disposed'
  available: boolean
  connected: boolean
  authenticated: boolean
  account: GrokPublicAccount | null
  storageMode: GrokTokenStorageMode
  accountFingerprint: string | null
  accountEpoch: number
  error: GrokPublicError | null
}

export type GrokLoginState = 'pending' | 'succeeded' | 'failed' | 'cancelled'

export interface GrokLoginCompletion {
  loginId: string
  success: boolean
  error: GrokPublicError | null
}

export interface GrokLoginAttempt {
  loginId: string
  method: GrokLoginMethod
  authUrl: string | null
  userCode: string | null
  verificationUri: string | null
  verificationUriComplete: string | null
  expiresAt: number | null
  state: GrokLoginState
  completion: GrokLoginCompletion | null
}

export interface GrokSubscriptionModel {
  id: string
  ownedBy?: string
  contextWindow?: number
}

const GROK_MODELS_TIMEOUT_MS = 10_000

export interface GrokSubscriptionManagerDependencies {
  accountId?: string | null
  getOAuthClientId: () => string
  createOAuthClient: (options: GrokOAuthClientOptions) => GrokOAuthClient
  tokenStore: GrokTokenStore
  createLoginId: () => string
  now: () => number
  fetch: typeof fetch
  getUserAgent: () => string
}

interface BrowserLoginContext {
  redirectUri: string
  state: string
  pkce: GrokPkcePair
  discovery: GrokOAuthDiscovery
  listener: GrokOAuthListener
}

interface LoginRecord {
  attempt: GrokLoginAttempt
  method: GrokLoginMethod
  authorization: GrokDeviceAuthorization | null
  browser: BrowserLoginContext | null
  controller: AbortController
  promise: Promise<GrokLoginCompletion>
}

/**
 * Resolve the xAI OAuth client ID for this build.
 * Build/dev env vars override the default public Grok-CLI client ID.
 */
export function resolveGrokOAuthClientId(options: {
  buildClientId?: string
  developmentClientId?: string
  packaged: boolean
}): string {
  const fromBuild = options.buildClientId?.trim()
  if (fromBuild) return fromBuild
  if (!options.packaged) {
    const fromDevelopment = options.developmentClientId?.trim()
    if (fromDevelopment) return fromDevelopment
  }
  return DEFAULT_XAI_OAUTH_CLIENT_ID
}

function configuredOAuthClientId(): string {
  const buildEnv = import.meta.env as Record<string, string | undefined>
  return resolveGrokOAuthClientId({
    buildClientId: buildEnv.MAIN_VITE_XAI_OAUTH_CLIENT_ID,
    developmentClientId: process.env.MAESTRLY_XAI_OAUTH_CLIENT_ID,
    packaged: app.isPackaged,
  })
}

function configuredUserAgent(): string {
  try {
    return `maestrly/${app.getVersion()}`
  } catch {
    return 'maestrly'
  }
}

const DEFAULT_DEPENDENCIES: GrokSubscriptionManagerDependencies = {
  accountId: null,
  getOAuthClientId: configuredOAuthClientId,
  // Main does NOT open the browser: other providers' contract returns authUrl via IPC and lets only the
  // renderer call openExternalUrl (opening twice causes duplicate tabs/lost callbacks).
  createOAuthClient: (options) =>
    new GrokOAuthClient({
      ...options,
      dependencies: {
        fetch: (url, init) => fetch(url, init),
      },
    }),
  tokenStore: defaultGrokTokenStore,
  createLoginId: () => randomUUID(),
  now: () => Date.now(),
  // Lazy: avoid touching `electron.net` on import (tests partially mock electron).
  fetch: ((input, init) => (net.fetch as unknown as typeof fetch)(input, init)) as typeof fetch,
  getUserAgent: configuredUserAgent,
}

/** Decode the id_token `sub` claim without verifying the signature: identity only, never used for auth. */
function extractIdTokenSubject(idToken: string | undefined): string | null {
  if (!idToken) return null
  const parts = idToken.split('.')
  if (parts.length < 2) return null
  try {
    let payload = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    while (payload.length % 4 !== 0) payload += '='
    const claims = JSON.parse(Buffer.from(payload, 'base64').toString('utf8')) as { sub?: unknown }
    return typeof claims.sub === 'string' && claims.sub.trim() ? claims.sub.trim() : null
  } catch {
    return null
  }
}

/**
 * Account identity uses STABLE material (id_token subject; fallback: opaque sessionId created at login and
 * preserved across refreshes). Access/refresh tokens NEVER enter the fingerprint: token rotation must not look
 * like an account change. Legacy bundles without subject or sessionId are treated as unauthenticated; stable
 * identity cannot be derived without using tokens.
 */
function identityFingerprint(bundle: GrokTokenBundle | null): string | null {
  if (!bundle) return null
  const subject = extractIdTokenSubject(bundle.idToken)
  if (subject) return `sha256:sub:${createHash('sha256').update(subject).digest('hex')}`
  if (bundle.sessionId) return `sha256:session:${createHash('sha256').update(bundle.sessionId).digest('hex')}`
  return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function publicError(error: unknown): GrokPublicError {
  const record = isRecord(error) ? error : null
  const rawCode = record?.code ?? (error instanceof GrokOAuthError ? error.code : undefined)
  const code = typeof rawCode === 'string' || typeof rawCode === 'number' ? rawCode : undefined
  return { ...(code !== undefined ? { code } : {}), message: grokSubscriptionErrorMessage(error) }
}

function cloneAttempt(record: LoginRecord): GrokLoginAttempt {
  return cloneAttemptSnapshot(record.attempt)
}

function cloneAttemptSnapshot(attempt: GrokLoginAttempt): GrokLoginAttempt {
  return {
    ...attempt,
    completion: attempt.completion ? { ...attempt.completion } : null,
  }
}

function cloneModels(models: readonly GrokSubscriptionModel[]): readonly GrokSubscriptionModel[] {
  return structuredClone(models)
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function positiveNumber(value: unknown): number | null {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

export class GrokAccountChangedError extends Error {
  constructor() {
    super('Grok account changed while the operation was in progress')
    this.name = 'GrokAccountChangedError'
  }
}

export class GrokNotAuthenticatedError extends Error {
  constructor() {
    super('Grok is not authenticated')
    this.name = 'GrokNotAuthenticatedError'
  }
}

export class GrokSubscriptionManager {
  private static readonly MAX_RECENT_LOGINS = 16
  private readonly dependencies: GrokSubscriptionManagerDependencies
  private readonly loginRecords = new Map<string, LoginRecord>()
  /** Recently completed logins (loginId -> final attempt) for getLoginStatus/waitForLogin after pruning. */
  private readonly recentLogins = new Map<string, GrokLoginAttempt>()
  private readonly authUpdatedListeners = new Set<() => void>()
  private statusCache: GrokSubscriptionStatus | null = null
  private statusPromise: Promise<GrokSubscriptionStatus> | null = null
  private modelsCache: readonly GrokSubscriptionModel[] | null = null
  private modelsPromise: Promise<readonly GrokSubscriptionModel[]> | null = null
  private refreshPromise: Promise<GrokTokenBundle> | null = null
  private knownFingerprint: string | null
  private accountEpoch = 0
  private loginGeneration = 0
  /** Credential generation: logout/dispose invalidate in-flight refreshes so they cannot persist tokens again. */
  private credentialGeneration = 0
  private disposed = false

  constructor(dependencies: Partial<GrokSubscriptionManagerDependencies> = {}) {
    const accountId = dependencies.accountId ?? DEFAULT_DEPENDENCIES.accountId
    const accountDefaults =
      accountId && !dependencies.tokenStore
        ? { tokenStore: createGrokTokenStore(undefined, grokTokenKeyFor(accountId)) }
        : {}
    this.dependencies = { ...DEFAULT_DEPENDENCIES, ...accountDefaults, ...dependencies }
    this.knownFingerprint = identityFingerprint(this.dependencies.tokenStore.get())
  }

  get isDisposed(): boolean {
    return this.disposed
  }

  get accountId(): string | null {
    return this.dependencies.accountId ?? null
  }

  getAccountIdentity(): GrokAccountIdentity {
    return { fingerprint: this.knownFingerprint, epoch: this.accountEpoch }
  }

  assertAccountIdentity(expected: GrokAccountIdentity): void {
    const current = this.getAccountIdentity()
    if (current.fingerprint !== expected.fingerprint || current.epoch !== expected.epoch) {
      throw new GrokAccountChangedError()
    }
  }

  getStatusSnapshot(): GrokSubscriptionStatus | null {
    return this.disposed ? this.disposedStatus() : this.statusCache
  }

  onAuthUpdated(listener: () => void): () => void {
    this.authUpdatedListeners.add(listener)
    return () => this.authUpdatedListeners.delete(listener)
  }

  async getStatus(force = false): Promise<GrokSubscriptionStatus> {
    while (true) {
      if (this.disposed) return this.disposedStatus()
      if (!force && this.statusCache) return this.statusCache

      const identity = this.getAccountIdentity()
      const promise = this.statusPromise ?? this.loadStatus(identity)
      this.statusPromise = promise
      try {
        const status = await promise
        if (this.disposed) return this.disposedStatus()
        const current = this.getAccountIdentity()
        if (status.accountFingerprint !== current.fingerprint || status.accountEpoch !== current.epoch) {
          force = true
          continue
        }
        this.statusCache = status
        return status
      } finally {
        if (this.statusPromise === promise) this.statusPromise = null
      }
    }
  }

  async startLogin(method: GrokLoginMethod = 'browser'): Promise<GrokLoginAttempt> {
    if (this.disposed) throw new Error('Grok subscription manager is disposed')
    const generation = ++this.loginGeneration
    for (const record of this.loginRecords.values()) {
      if (record.attempt.state === 'pending') record.controller.abort()
    }
    const clientId = this.dependencies.getOAuthClientId().trim()
    if (!clientId) {
      throw new GrokOAuthError(
        'configuration_missing',
        'Grok OAuth Client ID is not configured in this build'
      )
    }

    const oauth = this.createClient(clientId)
    const controller = new AbortController()
    const loginId = this.dependencies.createLoginId()

    if (method === 'device') {
      const authorization = await oauth.startDeviceFlow(controller.signal)
      if (this.disposed || generation !== this.loginGeneration) {
        controller.abort()
        throw new GrokOAuthError('cancelled', 'Grok login was cancelled')
      }
      const attempt: GrokLoginAttempt = {
        loginId,
        method: 'device',
        authUrl: null,
        userCode: authorization.userCode,
        verificationUri: authorization.verificationUri,
        verificationUriComplete: authorization.verificationUriComplete,
        expiresAt: authorization.expiresAt,
        state: 'pending',
        completion: null,
      }
      const record: LoginRecord = {
        attempt,
        method: 'device',
        authorization,
        browser: null,
        controller,
        promise: Promise.resolve({ loginId, success: false, error: null }),
      }
      this.loginRecords.set(loginId, record)
      record.promise = this.completeDeviceLogin(record, oauth)
      return cloneAttempt(record)
    }

    const browser = await oauth.startBrowserLogin(controller.signal)
    if (this.disposed || generation !== this.loginGeneration) {
      controller.abort()
      await browser.listener.close().catch(() => undefined)
      throw new GrokOAuthError('cancelled', 'Grok login was cancelled')
    }
    const attempt: GrokLoginAttempt = {
      loginId,
      method: 'browser',
      authUrl: browser.authUrl,
      userCode: null,
      verificationUri: null,
      verificationUriComplete: null,
      expiresAt: this.dependencies.now() + 180_000,
      state: 'pending',
      completion: null,
    }
    const record: LoginRecord = {
      attempt,
      method: 'browser',
      authorization: null,
      browser: {
        redirectUri: browser.redirectUri,
        state: browser.state,
        pkce: browser.pkce,
        discovery: browser.discovery,
        listener: browser.listener,
      },
      controller,
      promise: Promise.resolve({ loginId, success: false, error: null }),
    }
    this.loginRecords.set(loginId, record)
    record.promise = this.completeBrowserLogin(record, oauth)
    return cloneAttempt(record)
  }

  getLoginStatus(loginId: string): GrokLoginAttempt | null {
    const record = this.loginRecords.get(loginId)
    if (record) return cloneAttempt(record)
    const recent = this.recentLogins.get(loginId)
    return recent ? cloneAttemptSnapshot(recent) : null
  }

  waitForLogin(loginId: string): Promise<GrokLoginCompletion> {
    const record = this.loginRecords.get(loginId)
    if (record) return record.promise.then((completion) => ({ ...completion }))
    const completion = this.recentLogins.get(loginId)?.completion
    if (completion) return Promise.resolve({ ...completion })
    return Promise.reject(new Error(`Unknown Grok login attempt: ${loginId}`))
  }

  cancelLogin(loginId: string): boolean {
    const record = this.loginRecords.get(loginId)
    if (record?.attempt.state !== 'pending') return false
    record.controller.abort()
    return true
  }

  async logout(): Promise<void> {
    this.loginGeneration += 1
    this.credentialGeneration += 1
    const pendingPromises = [...this.loginRecords.values()].map((record) => record.promise)
    for (const record of this.loginRecords.values()) {
      if (record.attempt.state === 'pending') record.controller.abort()
    }
    this.loginRecords.clear()
    this.refreshPromise = null
    this.dependencies.tokenStore.clear()
    // Wait for pending listeners/callbacks to close before declaring logout complete; only then clear
    // the recent cache (otherwise a late finishLogin could repopulate the map).
    await Promise.allSettled(pendingPromises)
    this.recentLogins.clear()
    await this.changeIdentity(null)
  }

  resetLocalData(): Promise<void> {
    if (this.disposed) return Promise.resolve()
    return this.logout()
  }

  async getAccessToken(): Promise<string> {
    const bundle = await this.ensureFreshBundle()
    return bundle.accessToken
  }

  /**
   * Authenticated fetch for api.x.ai. Clones headers, overwrites Authorization, refreshes early,
   * respects abort, and never retries infinitely on auth failure.
   */
  authenticatedFetch: typeof fetch = async (input, init) => {
    const identity = this.getRequiredIdentity()
    const bundle = await this.ensureFreshBundle()
    this.assertAccountIdentity(identity)

    const headers = new Headers(input instanceof Request ? input.headers : undefined)
    if (init?.headers) {
      if (init.headers instanceof Headers) {
        init.headers.forEach((value, key) => {
          headers.set(key, value)
        })
      } else if (Array.isArray(init.headers)) {
        for (const [key, value] of init.headers) headers.set(key, value)
      } else {
        for (const [key, value] of Object.entries(init.headers as Record<string, string | undefined>)) {
          if (value !== undefined) headers.set(key, String(value))
        }
      }
    }
    headers.set('Authorization', `Bearer ${bundle.accessToken}`)
    headers.set('User-Agent', this.dependencies.getUserAgent())
    headers.delete('x-api-key')

    const url = typeof input === 'string' || input instanceof URL ? String(input) : input.url
    this.assertSafeApiUrl(url)

    let response = await this.dependencies.fetch(url, { ...init, headers })
    if (response.status !== 401) return response

    // One refresh + retry on 401. Terminal invalid_grant clears the session.
    try {
      const refreshed = await this.refreshBundle(true)
      this.assertAccountIdentity(identity)
      headers.set('Authorization', `Bearer ${refreshed.accessToken}`)
      response = await this.dependencies.fetch(url, { ...init, headers })
      return response
    } catch (error) {
      if (error instanceof GrokOAuthError && error.code === 'invalid_grant') {
        throw new GrokNotAuthenticatedError()
      }
      throw error
    }
  }

  async listModels(force = false): Promise<readonly GrokSubscriptionModel[]> {
    if (!force && this.modelsCache) return cloneModels(this.modelsCache)
    if (this.modelsPromise) return cloneModels(await this.modelsPromise)

    const identity = this.getRequiredIdentity()
    const promise = this.fetchModels()
    this.modelsPromise = promise
    try {
      const models = await promise
      this.assertAccountIdentity(identity)
      this.modelsCache = models
      return cloneModels(models)
    } finally {
      if (this.modelsPromise === promise) this.modelsPromise = null
    }
  }

  /** Sentinel credential + authenticated transport for the generic AI SDK runner. */
  resolveRuntimeCredential(): { apiKey: string; fetch: typeof fetch; fingerprint: string } {
    const identity = this.getRequiredIdentity()
    if (!identity.fingerprint) throw new GrokNotAuthenticatedError()
    return {
      apiKey: GROK_OAUTH_DUMMY_API_KEY,
      fetch: this.authenticatedFetch,
      fingerprint: createHash('sha256')
        .update(
          JSON.stringify({
            version: 1,
            provider: 'grok-subscription',
            accountId: this.accountId,
            fingerprint: identity.fingerprint,
            epoch: identity.epoch,
            baseURL: XAI_API_BASE_URL,
          })
        )
        .digest('hex'),
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.loginGeneration += 1
    this.credentialGeneration += 1
    for (const record of this.loginRecords.values()) record.controller.abort()
    const loginPromises = [...this.loginRecords.values()].map((record) => record.promise)
    const refresh = this.refreshPromise
    this.loginRecords.clear()
    // Await the in-flight refresh (invalidated by generation) to avoid finishing with persistence pending.
    await Promise.allSettled([...loginPromises, refresh])
    this.recentLogins.clear()
    this.refreshPromise = null
    this.statusCache = null
    this.modelsCache = null
    this.authUpdatedListeners.clear()
  }

  private createClient(clientId: string): GrokOAuthClient {
    return this.dependencies.createOAuthClient({
      clientId,
      userAgent: this.dependencies.getUserAgent(),
      referrer: 'maestrly',
    })
  }

  private async completeBrowserLogin(
    record: LoginRecord,
    oauth: GrokOAuthClient
  ): Promise<GrokLoginCompletion> {
    try {
      if (!record.browser) throw new Error('Grok browser login context is unavailable')
      const bundle = await oauth.completeBrowserLogin(record.browser, record.controller.signal)
      if (
        this.disposed ||
        record.controller.signal.aborted ||
        this.loginRecords.get(record.attempt.loginId) !== record
      ) {
        throw new GrokOAuthError('cancelled', 'Grok login was cancelled')
      }
      const stored = this.persistLoginBundle(bundle)
      await this.changeIdentity(identityFingerprint(stored))
      return this.finishLogin(record, true, null)
    } catch (error) {
      const cancelled = error instanceof GrokOAuthError && error.code === 'cancelled'
      record.attempt.state = cancelled ? 'cancelled' : 'failed'
      return this.finishLogin(record, false, publicError(error))
    } finally {
      record.browser = null
    }
  }

  private async completeDeviceLogin(
    record: LoginRecord,
    oauth: GrokOAuthClient
  ): Promise<GrokLoginCompletion> {
    try {
      if (!record.authorization) throw new Error('Grok device authorization is unavailable')
      const bundle = await oauth.pollForDeviceToken(record.authorization, record.controller.signal)
      if (
        this.disposed ||
        record.controller.signal.aborted ||
        this.loginRecords.get(record.attempt.loginId) !== record
      ) {
        throw new GrokOAuthError('cancelled', 'Grok login was cancelled')
      }
      const stored = this.persistLoginBundle(bundle)
      await this.changeIdentity(identityFingerprint(stored))
      return this.finishLogin(record, true, null)
    } catch (error) {
      const cancelled = error instanceof GrokOAuthError && error.code === 'cancelled'
      record.attempt.state = cancelled ? 'cancelled' : 'failed'
      return this.finishLogin(record, false, publicError(error))
    } finally {
      record.authorization = null
    }
  }

  /**
   * Persist the LOGIN bundle with its own opaque sessionId (stable identity when id_token lacks `sub`). sessionId
   * survives refreshes; rotated tokens never change it.
   */
  private persistLoginBundle(bundle: GrokTokenBundle): GrokTokenBundle {
    const stored: GrokTokenBundle = {
      ...bundle,
      ...(bundle.sessionId ? {} : { sessionId: this.dependencies.createLoginId() }),
    }
    this.dependencies.tokenStore.set(stored)
    return stored
  }

  private finishLogin(
    record: LoginRecord,
    success: boolean,
    error: GrokPublicError | null
  ): GrokLoginCompletion {
    const completion = { loginId: record.attempt.loginId, success, error }
    record.attempt.state = success ? 'succeeded' : record.attempt.state === 'cancelled' ? 'cancelled' : 'failed'
    record.attempt.completion = completion
    // Prune the completed record (the pending map must not grow unbounded); retain the final state
    // in a small cache for late getLoginStatus/waitForLogin calls.
    this.loginRecords.delete(record.attempt.loginId)
    this.recentLogins.set(record.attempt.loginId, cloneAttempt(record))
    while (this.recentLogins.size > GrokSubscriptionManager.MAX_RECENT_LOGINS) {
      const oldest = this.recentLogins.keys().next().value
      if (oldest === undefined) break
      this.recentLogins.delete(oldest)
    }
    return completion
  }

  private async changeIdentity(nextFingerprint: string | null): Promise<void> {
    if (nextFingerprint !== this.knownFingerprint) {
      this.knownFingerprint = nextFingerprint
      this.accountEpoch += 1
    }
    this.invalidateCaches()
    this.notifyAuthUpdated()
  }

  private invalidateCaches(): void {
    this.statusCache = null
    this.modelsCache = null
    this.modelsPromise = null
  }

  private notifyAuthUpdated(): void {
    for (const listener of this.authUpdatedListeners) {
      try {
        listener()
      } catch {
        // One observer must not prevent the service from notifying the others.
      }
    }
  }

  private async ensureFreshBundle(): Promise<GrokTokenBundle> {
    const current = this.requireBundle()
    if (!accessTokenNeedsRefresh(current, this.dependencies.now())) return current
    return this.refreshBundle(false)
  }

  private async refreshBundle(force: boolean): Promise<GrokTokenBundle> {
    const current = this.requireBundle()
    if (!force && !accessTokenNeedsRefresh(current, this.dependencies.now())) return current
    if (this.refreshPromise) return this.refreshPromise

    const identity = this.getRequiredIdentity()
    const generation = this.credentialGeneration
    const clientId = this.dependencies.getOAuthClientId().trim()
    if (!clientId) {
      throw new GrokOAuthError(
        'configuration_missing',
        'Grok OAuth Client ID is not configured in this build'
      )
    }
    const oauth = this.createClient(clientId)
    const promise = oauth
      .refresh(current.refreshToken)
      .then(async (next) => {
        // Logout/dispose during refresh: the old generation loses permission to persist tokens again.
        if (this.disposed || generation !== this.credentialGeneration) {
          throw new GrokOAuthError('cancelled', 'Grok session was closed during token refresh')
        }
        this.assertAccountIdentity(identity)
        // Rotating refresh tokens: persist atomically; keep previous refresh if xAI omits a new one.
        // sessionId and subject are preserved; refresh is NEVER treated as an account change.
        const merged: GrokTokenBundle = {
          accessToken: next.accessToken,
          refreshToken: next.refreshToken || current.refreshToken,
          expiresAt: next.expiresAt,
          ...(next.idToken ? { idToken: next.idToken } : current.idToken ? { idToken: current.idToken } : {}),
          ...(next.scope ? { scope: next.scope } : current.scope ? { scope: current.scope } : {}),
          ...(current.sessionId ? { sessionId: current.sessionId } : {}),
        }
        this.dependencies.tokenStore.set(merged)
        const nextFingerprint = identityFingerprint(merged)
        if (nextFingerprint !== this.knownFingerprint) {
          // Confirmed different subject (e.g. new id_token with another sub): identity boundary.
          await this.changeIdentity(nextFingerprint)
        } else {
          // Normal refresh: new tokens, stable identity. Only caches under the old credential are cleared;
          // no epoch increment or onAuthUpdated (the current turn must not be aborted).
          this.modelsCache = null
        }
        return merged
      })
      .catch(async (error) => {
        // invalid_grant is a boundary only if the session is still current (it must not revive after logout).
        if (
          !this.disposed &&
          generation === this.credentialGeneration &&
          error instanceof GrokOAuthError &&
          error.code === 'invalid_grant'
        ) {
          this.dependencies.tokenStore.clear()
          await this.changeIdentity(null)
        }
        throw error
      })
      .finally(() => {
        if (this.refreshPromise === promise) this.refreshPromise = null
      })
    this.refreshPromise = promise
    return promise
  }

  private async fetchModels(): Promise<readonly GrokSubscriptionModel[]> {
    const response = await this.authenticatedFetch(`${XAI_API_BASE_URL}/models`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(GROK_MODELS_TIMEOUT_MS),
    })
    if (!response.ok) {
      throw new Error(`Could not list Grok models (${response.status})`)
    }
    let payload: unknown
    try {
      payload = await response.json()
    } catch (cause) {
      throw new Error('Grok models response was not valid JSON', { cause })
    }
    const rows = isRecord(payload) && Array.isArray(payload.data) ? payload.data : Array.isArray(payload) ? payload : []
    const models: GrokSubscriptionModel[] = []
    for (const row of rows) {
      if (!isRecord(row)) continue
      const id = nonEmptyString(row.id)
      if (!id) continue
      const ownedBy = nonEmptyString(row.owned_by) ?? undefined
      const contextWindow =
        positiveNumber(row.context_window) ??
        positiveNumber(row.context_length) ??
        positiveNumber(isRecord(row.limits) ? row.limits.max_prompt_tokens : null) ??
        undefined
      models.push({
        id,
        ...(ownedBy ? { ownedBy } : {}),
        ...(contextWindow ? { contextWindow } : {}),
      })
    }
    return models
  }

  private async loadStatus(identity: GrokAccountIdentity): Promise<GrokSubscriptionStatus> {
    const clientIdConfigured = Boolean(this.dependencies.getOAuthClientId().trim())
    if (!identity.fingerprint) {
      return {
        state: 'ready',
        available: clientIdConfigured,
        connected: false,
        authenticated: false,
        account: null,
        storageMode: this.dependencies.tokenStore.mode(),
        accountFingerprint: null,
        accountEpoch: identity.epoch,
        error: clientIdConfigured
          ? null
          : {
              code: 'configuration_missing',
              message: 'Grok OAuth Client ID is not configured in this build',
            },
      }
    }

    try {
      const bundle = await this.ensureFreshBundle()
      this.assertAccountIdentity(identity)
      const clientId = this.dependencies.getOAuthClientId().trim()
      const oauth = this.createClient(clientId || 'missing')
      const userInfo = clientId
        ? await oauth.fetchUserInfo(bundle.accessToken).catch(() => ({
            email: null,
            name: null,
            planType: null,
          }))
        : { email: null, name: null, planType: null }
      this.assertAccountIdentity(identity)
      return {
        state: 'ready',
        available: true,
        connected: true,
        authenticated: true,
        account: {
          email: userInfo.email,
          name: userInfo.name,
          planType: userInfo.planType,
        },
        storageMode: this.dependencies.tokenStore.mode(),
        accountFingerprint: identity.fingerprint,
        accountEpoch: identity.epoch,
        error: null,
      }
    } catch (error) {
      const authLost = error instanceof GrokNotAuthenticatedError ||
        (error instanceof GrokOAuthError && error.code === 'invalid_grant')
      return {
        state: authLost ? 'ready' : 'error',
        available: clientIdConfigured,
        connected: false,
        authenticated: false,
        account: null,
        storageMode: this.dependencies.tokenStore.mode(),
        accountFingerprint: authLost ? null : identity.fingerprint,
        accountEpoch: identity.epoch,
        error: authLost ? null : publicError(error),
      }
    }
  }

  private requireBundle(): GrokTokenBundle {
    const bundle = this.dependencies.tokenStore.get()
    if (!bundle?.accessToken || !bundle.refreshToken) throw new GrokNotAuthenticatedError()
    return bundle
  }

  private getRequiredIdentity(): GrokAccountIdentity {
    const identity = this.getAccountIdentity()
    if (!identity.fingerprint) throw new GrokNotAuthenticatedError()
    return identity
  }

  private assertSafeApiUrl(url: string): void {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      throw new Error('Refusing to send Grok OAuth token to an invalid URL')
    }
    if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'api.x.ai') {
      throw new Error(`Refusing to send Grok OAuth token to non-xAI URL: ${parsed.origin}`)
    }
  }

  private disposedStatus(): GrokSubscriptionStatus {
    return {
      state: 'disposed',
      available: false,
      connected: false,
      authenticated: false,
      account: null,
      storageMode: this.dependencies.tokenStore.mode(),
      accountFingerprint: null,
      accountEpoch: this.accountEpoch,
      error: null,
    }
  }
}

const instances = new Map<string, GrokSubscriptionManager>()
const FILESYSTEM_SAFE_ACCOUNT_ID = /^[A-Za-z0-9_-]+$/

export function getGrokSubscriptionManager(accountId: string | null = null): GrokSubscriptionManager {
  if (accountId && !FILESYSTEM_SAFE_ACCOUNT_ID.test(accountId)) {
    throw new Error(`Invalid Grok subscription account id: ${accountId}`)
  }
  const key = accountId ?? ''
  let manager = instances.get(key)
  if (!manager) {
    manager = new GrokSubscriptionManager({ accountId })
    instances.set(key, manager)
  }
  return manager
}

export function listGrokSubscriptionManagers(): GrokSubscriptionManager[] {
  return [...instances.values()]
}

export async function disposeGrokSubscriptionManager(): Promise<void> {
  const managers = [...instances.values()]
  instances.clear()
  await Promise.all(managers.map((manager) => manager.dispose()))
}
