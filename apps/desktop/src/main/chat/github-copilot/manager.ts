import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import {
  CopilotClient,
  RuntimeConnection,
  type CopilotClientOptions,
  type CopilotSession,
  type GetAuthStatusResponse,
  type ModelInfo,
  type ResumeSessionConfig,
  type RuntimeConnection as CopilotRuntimeConnection,
  type SessionConfig,
} from '@github/copilot-sdk'
import { app } from 'electron'
import {
  GitHubCopilotOAuthClient,
  GitHubCopilotOAuthError,
  type GitHubCopilotDeviceAuthorization,
  type GitHubCopilotOAuthClientOptions,
} from './oauth'
import {
  createGitHubCopilotTokenStore,
  defaultGitHubCopilotTokenStore,
  githubCopilotTokenKeyFor,
  type GitHubCopilotTokenStorageMode,
  type GitHubCopilotTokenStore,
} from './token-store'
import { resolveGithubCopilotRuntime } from './runtime-resolver'
import { githubCopilotErrorMessage } from './errors'
import { acquireRuntimeAssetLease, readyRuntimeAsset } from '../../runtime-assets/app-service'
import type { RuntimeAssetLease } from '../../../shared/runtime-assets'

export interface GitHubCopilotPublicError {
  code?: string | number
  message: string
}

export interface GitHubCopilotPublicAccount {
  login: string | null
  host: string | null
  authType: GetAuthStatusResponse['authType'] | null
}

export interface GitHubCopilotAccountIdentity {
  fingerprint: string | null
  epoch: number
}

export interface GitHubCopilotSubscriptionStatus {
  state: 'ready' | 'error' | 'disposed'
  available: boolean
  connected: boolean
  authenticated: boolean
  account: GitHubCopilotPublicAccount | null
  storageMode: GitHubCopilotTokenStorageMode
  accountFingerprint: string | null
  accountEpoch: number
  error: GitHubCopilotPublicError | null
}

export type GitHubCopilotLoginState = 'pending' | 'succeeded' | 'failed' | 'cancelled'

export interface GitHubCopilotLoginCompletion {
  loginId: string
  success: boolean
  error: GitHubCopilotPublicError | null
}

export interface GitHubCopilotLoginAttempt {
  loginId: string
  userCode: string
  verificationUri: string
  verificationUriComplete: string | null
  expiresAt: number
  state: GitHubCopilotLoginState
  completion: GitHubCopilotLoginCompletion | null
}

type LockedSessionConfig = 'gitHubToken' | 'remoteSession' | 'enableManagedSettings'

export type GitHubCopilotCreateSessionConfig = Omit<SessionConfig, LockedSessionConfig | 'availableTools'> &
  Required<Pick<SessionConfig, 'availableTools'>>

export type GitHubCopilotResumeSessionConfig = Omit<ResumeSessionConfig, LockedSessionConfig | 'availableTools'> &
  Required<Pick<ResumeSessionConfig, 'availableTools'>>

export interface GitHubCopilotRuntimeClient {
  start(): Promise<void>
  stop(): Promise<Error[]>
  forceStop(): Promise<void>
  getAuthStatus(): Promise<GetAuthStatusResponse>
  listModels(): Promise<ModelInfo[]>
  createSession(config: SessionConfig): Promise<CopilotSession>
  resumeSession(sessionId: string, config: ResumeSessionConfig): Promise<CopilotSession>
  deleteSession(sessionId: string): Promise<void>
}

export interface GitHubCopilotSubscriptionManagerDependencies {
  /** Additional account slot; absent/null means the default account. Suffixes COPILOT_HOME and the token key. */
  accountId?: string | null
  getOAuthClientId: () => string
  createOAuthClient: (options: GitHubCopilotOAuthClientOptions) => GitHubCopilotOAuthClient
  tokenStore: GitHubCopilotTokenStore
  getUserDataPath: () => string
  ensureDirectory: (directory: string) => Promise<void>
  removeDirectory: (directory: string) => Promise<void>
  getProcessEnvironment: () => NodeJS.ProcessEnv
  resolveConnection: (environment: Record<string, string>, runtimePath?: string) => CopilotRuntimeConnection
  resolveRuntimePath: () => string | Promise<string>
  acquireRuntimeLease: (runtimePath: string) => Promise<RuntimeAssetLease | null>
  createClient: (options: CopilotClientOptions) => GitHubCopilotRuntimeClient
  createLoginId: () => string
}

interface LoginRecord {
  attempt: GitHubCopilotLoginAttempt
  authorization: GitHubCopilotDeviceAuthorization | null
  controller: AbortController
  promise: Promise<GitHubCopilotLoginCompletion>
}

const COPILOT_HOME_DIRECTORY = 'github-copilot-subscription'

/**
 * Ambient values required for normal process/network behavior. Credentials and provider-specific variables are
 * deliberately absent: the SDK layers the selected GitHub token and COPILOT_HOME onto this environment itself.
 */
export const GITHUB_COPILOT_RUNTIME_ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'USER',
  'USERPROFILE',
  'TMPDIR',
  'TMP',
  'TEMP',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'LC_MESSAGES',
  'LC_NUMERIC',
  'LC_TIME',
  'TZ',
  'TERM',
  'COLORTERM',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
] as const

export function githubCopilotRuntimeEnvironment(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const environment: Record<string, string> = {}
  for (const name of GITHUB_COPILOT_RUNTIME_ENV_ALLOWLIST) {
    const value = source[name]
    if (typeof value === 'string') environment[name] = value
  }
  return environment
}

/** Resolve the project-owned public OAuth identifier supplied by the build or local developer. */
export function resolveGitHubCopilotOAuthClientId(options: {
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
  return ''
}

function configuredOAuthClientId(): string {
  const buildEnv = import.meta.env as Record<string, string | undefined>
  return resolveGitHubCopilotOAuthClientId({
    buildClientId: buildEnv.MAIN_VITE_GITHUB_COPILOT_CLIENT_ID,
    developmentClientId: process.env.MAESTRLY_GITHUB_COPILOT_CLIENT_ID,
    packaged: app.isPackaged,
  })
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  if (process.platform === 'win32') return
  try {
    await chmod(directory, 0o700)
  } catch {
    // Creation with 0700 is the primary protection; some mounted filesystems do not support chmod.
  }
}

const DEFAULT_DEPENDENCIES: GitHubCopilotSubscriptionManagerDependencies = {
  accountId: null,
  getOAuthClientId: configuredOAuthClientId,
  createOAuthClient: (options) => new GitHubCopilotOAuthClient(options),
  tokenStore: defaultGitHubCopilotTokenStore,
  getUserDataPath: () => app.getPath('userData'),
  ensureDirectory: ensurePrivateDirectory,
  removeDirectory: (directory) => rm(directory, { recursive: true, force: true }),
  getProcessEnvironment: () => process.env,
  resolveConnection: (environment, runtimePath) =>
    RuntimeConnection.forStdio({ path: runtimePath || resolveGithubCopilotRuntime().executablePath, env: environment }),
  resolveRuntimePath: async () => {
    if (!app.isPackaged) return ''
    const asset = await readyRuntimeAsset('github-copilot-runtime')
    return resolveGithubCopilotRuntime({ managedAssetPath: asset.path }).executablePath
  },
  acquireRuntimeLease: (runtimePath) =>
    app.isPackaged ? acquireRuntimeAssetLease('github-copilot-runtime', runtimePath) : Promise.resolve(null),
  createClient: (options) => new CopilotClient(options),
  createLoginId: () => randomUUID(),
}

function tokenFingerprint(token: string | null): string | null {
  if (!token) return null
  return `sha256:${createHash('sha256').update(token).digest('hex')}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function publicError(error: unknown): GitHubCopilotPublicError {
  const record = isRecord(error) ? error : null
  const rawCode = record?.code
  const code = typeof rawCode === 'string' || typeof rawCode === 'number' ? rawCode : undefined
  return { ...(code !== undefined ? { code } : {}), message: githubCopilotErrorMessage(error) }
}

function cloneAttempt(record: LoginRecord): GitHubCopilotLoginAttempt {
  return {
    ...record.attempt,
    completion: record.attempt.completion ? { ...record.attempt.completion } : null,
  }
}

function cloneModels(models: readonly ModelInfo[]): readonly ModelInfo[] {
  return structuredClone(models)
}

export class GitHubCopilotAccountChangedError extends Error {
  constructor() {
    super('GitHub Copilot account changed while the operation was in progress')
    this.name = 'GitHubCopilotAccountChangedError'
  }
}

export class GitHubCopilotNotAuthenticatedError extends Error {
  constructor() {
    super('GitHub Copilot is not authenticated')
    this.name = 'GitHubCopilotNotAuthenticatedError'
  }
}

export class GitHubCopilotSubscriptionManager {
  private readonly dependencies: GitHubCopilotSubscriptionManagerDependencies
  private readonly loginRecords = new Map<string, LoginRecord>()
  private readonly authUpdatedListeners = new Set<() => void>()
  private readonly activeSessions = new Map<string, CopilotSession>()
  private client: GitHubCopilotRuntimeClient | null = null
  private clientPromise: Promise<GitHubCopilotRuntimeClient> | null = null
  private clientFingerprint: string | null = null
  private runtimeLease: RuntimeAssetLease | null = null
  private statusCache: GitHubCopilotSubscriptionStatus | null = null
  private statusPromise: Promise<GitHubCopilotSubscriptionStatus> | null = null
  private modelsCache: readonly ModelInfo[] | null = null
  private modelsPromise: Promise<readonly ModelInfo[]> | null = null
  private knownFingerprint: string | null
  private accountEpoch = 0
  private lifecycleGeneration = 0
  private loginGeneration = 0
  private resetPromise: Promise<void> | null = null
  private disposed = false

  constructor(dependencies: Partial<GitHubCopilotSubscriptionManagerDependencies> = {}) {
    // Additional account without an explicit tokenStore: use a dedicated store with the suffixed secure-store key.
    const accountId = dependencies.accountId ?? DEFAULT_DEPENDENCIES.accountId
    const accountDefaults =
      accountId && !dependencies.tokenStore
        ? { tokenStore: createGitHubCopilotTokenStore(undefined, githubCopilotTokenKeyFor(accountId)) }
        : {}
    this.dependencies = { ...DEFAULT_DEPENDENCIES, ...accountDefaults, ...dependencies }
    this.knownFingerprint = tokenFingerprint(this.dependencies.tokenStore.get())
  }

  get isDisposed(): boolean {
    return this.disposed
  }

  get accountId(): string | null {
    return this.dependencies.accountId ?? null
  }

  /** App-owned COPILOT_HOME for this ACCOUNT (suffixed for additional slots). */
  private get copilotHome(): string {
    const suffix = this.dependencies.accountId ? `-${this.dependencies.accountId}` : ''
    return path.join(this.dependencies.getUserDataPath(), COPILOT_HOME_DIRECTORY + suffix)
  }

  getAccountIdentity(): GitHubCopilotAccountIdentity {
    return { fingerprint: this.knownFingerprint, epoch: this.accountEpoch }
  }

  assertAccountIdentity(expected: GitHubCopilotAccountIdentity): void {
    const current = this.getAccountIdentity()
    if (current.fingerprint !== expected.fingerprint || current.epoch !== expected.epoch) {
      throw new GitHubCopilotAccountChangedError()
    }
  }

  getStatusSnapshot(): GitHubCopilotSubscriptionStatus | null {
    return this.disposed ? this.disposedStatus() : this.statusCache
  }

  onAuthUpdated(listener: () => void): () => void {
    this.authUpdatedListeners.add(listener)
    return () => this.authUpdatedListeners.delete(listener)
  }

  async getStatus(force = false): Promise<GitHubCopilotSubscriptionStatus> {
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

  async startLogin(): Promise<GitHubCopilotLoginAttempt> {
    while (this.resetPromise) await this.resetPromise
    if (this.disposed) throw new Error('GitHub Copilot subscription manager is disposed')
    const generation = ++this.loginGeneration
    for (const record of this.loginRecords.values()) {
      if (record.attempt.state === 'pending') record.controller.abort()
    }
    const clientId = this.dependencies.getOAuthClientId().trim()
    if (!clientId) {
      throw new GitHubCopilotOAuthError(
        'configuration_missing',
        'GitHub Copilot OAuth Client ID is not configured in this build'
      )
    }

    const oauth = this.dependencies.createOAuthClient({ clientId })
    const controller = new AbortController()
    const authorization = await oauth.startDeviceFlow(controller.signal)
    if (this.disposed || generation !== this.loginGeneration) {
      controller.abort()
      throw new GitHubCopilotOAuthError('cancelled', 'GitHub Copilot login was cancelled')
    }
    const loginId = this.dependencies.createLoginId()
    const attempt: GitHubCopilotLoginAttempt = {
      loginId,
      userCode: authorization.userCode,
      verificationUri: authorization.verificationUri,
      verificationUriComplete: authorization.verificationUriComplete,
      expiresAt: authorization.expiresAt,
      state: 'pending',
      completion: null,
    }
    const record: LoginRecord = {
      attempt,
      authorization,
      controller,
      promise: Promise.resolve({ loginId, success: false, error: null }),
    }
    this.loginRecords.set(loginId, record)
    record.promise = this.completeLogin(record, oauth)
    return cloneAttempt(record)
  }

  getLoginStatus(loginId: string): GitHubCopilotLoginAttempt | null {
    const record = this.loginRecords.get(loginId)
    return record ? cloneAttempt(record) : null
  }

  waitForLogin(loginId: string): Promise<GitHubCopilotLoginCompletion> {
    const record = this.loginRecords.get(loginId)
    if (!record) return Promise.reject(new Error(`Unknown GitHub Copilot login attempt: ${loginId}`))
    return record.promise.then((completion) => ({ ...completion }))
  }

  cancelLogin(loginId: string): boolean {
    const record = this.loginRecords.get(loginId)
    if (record?.attempt.state !== 'pending') return false
    record.controller.abort()
    return true
  }

  async logout(): Promise<void> {
    this.loginGeneration += 1
    for (const record of this.loginRecords.values()) {
      if (record.attempt.state === 'pending') record.controller.abort()
    }
    this.loginRecords.clear()
    this.dependencies.tokenStore.clear()
    await this.changeIdentity(null)
  }

  /**
   * Wipe app-owned state without disposing the manager. This is a synchronous barrier for future runtime/login
   * creation: callers cannot recreate COPILOT_HOME until the previous identity and directory are fully gone.
   */
  resetLocalData(): Promise<void> {
    if (this.disposed) return Promise.resolve()
    if (this.resetPromise) return this.resetPromise

    let resolveReset!: () => void
    let rejectReset!: (error: unknown) => void
    const tracked = new Promise<void>((resolve, reject) => {
      resolveReset = resolve
      rejectReset = reject
    })
    this.resetPromise = tracked
    void this.performResetLocalData().then(
      () => {
        if (this.resetPromise === tracked) this.resetPromise = null
        resolveReset()
      },
      (error: unknown) => {
        if (this.resetPromise === tracked) this.resetPromise = null
        rejectReset(error)
      }
    )
    return tracked
  }

  async listModels(force = false): Promise<readonly ModelInfo[]> {
    if (!force && this.modelsCache) return cloneModels(this.modelsCache)
    if (this.modelsPromise) return cloneModels(await this.modelsPromise)

    const identity = this.getRequiredIdentity()
    const promise = this.getClient()
      .then((client) => client.listModels())
      .then(cloneModels)
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

  async createSession(config: GitHubCopilotCreateSessionConfig): Promise<CopilotSession> {
    this.assertAvailableTools(config.availableTools)
    const identity = this.getRequiredIdentity()
    const token = this.requireToken()
    const client = await this.getClient()
    this.assertAccountIdentity(identity)
    const session = await client.createSession(this.lockSessionConfig(config, token))
    try {
      this.assertAccountIdentity(identity)
    } catch (error) {
      await session.disconnect().catch(() => undefined)
      throw error
    }
    this.activeSessions.set(session.sessionId, session)
    return session
  }

  async resumeSession(sessionId: string, config: GitHubCopilotResumeSessionConfig): Promise<CopilotSession> {
    const normalized = sessionId.trim()
    if (!normalized) throw new Error('GitHub Copilot session id is required')
    this.assertAvailableTools(config.availableTools)
    const identity = this.getRequiredIdentity()
    const token = this.requireToken()
    await this.disconnectSession(normalized)
    const client = await this.getClient()
    this.assertAccountIdentity(identity)
    const session = await client.resumeSession(normalized, this.lockSessionConfig(config, token))
    try {
      this.assertAccountIdentity(identity)
    } catch (error) {
      await session.disconnect().catch(() => undefined)
      throw error
    }
    this.activeSessions.set(session.sessionId, session)
    return session
  }

  async disconnectSession(sessionId: string): Promise<void> {
    const session = this.activeSessions.get(sessionId)
    if (!session) return
    this.activeSessions.delete(sessionId)
    await session.disconnect()
  }

  async deleteSession(sessionId: string): Promise<void> {
    const normalized = sessionId.trim()
    if (!normalized) throw new Error('GitHub Copilot session id is required')
    const identity = this.getRequiredIdentity()
    await this.disconnectSession(normalized).catch(() => undefined)
    const client = await this.getClient()
    this.assertAccountIdentity(identity)
    await client.deleteSession(normalized)
    this.assertAccountIdentity(identity)
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.loginGeneration += 1
    for (const record of this.loginRecords.values()) record.controller.abort()
    const loginPromises = [...this.loginRecords.values()].map((record) => record.promise)
    this.loginRecords.clear()
    await Promise.allSettled(loginPromises)
    await this.resetPromise?.catch(() => undefined)
    await this.stopRuntime()
    this.statusCache = null
    this.modelsCache = null
    this.authUpdatedListeners.clear()
  }

  private async completeLogin(
    record: LoginRecord,
    oauth: GitHubCopilotOAuthClient
  ): Promise<GitHubCopilotLoginCompletion> {
    try {
      if (!record.authorization) throw new Error('GitHub Copilot login authorization is unavailable')
      const result = await oauth.pollForToken(record.authorization, record.controller.signal)
      if (
        this.disposed ||
        record.controller.signal.aborted ||
        this.loginRecords.get(record.attempt.loginId) !== record
      ) {
        throw new GitHubCopilotOAuthError('cancelled', 'GitHub Copilot login was cancelled')
      }
      this.dependencies.tokenStore.set(result.accessToken)
      await this.changeIdentity(tokenFingerprint(result.accessToken))
      return this.finishLogin(record, true, null)
    } catch (error) {
      const cancelled = error instanceof GitHubCopilotOAuthError && error.code === 'cancelled'
      record.attempt.state = cancelled ? 'cancelled' : 'failed'
      return this.finishLogin(record, false, publicError(error))
    } finally {
      // The device code is no longer needed and is deliberately dropped from the long-lived status record.
      record.authorization = null
    }
  }

  private async performResetLocalData(): Promise<void> {
    this.loginGeneration += 1
    for (const record of this.loginRecords.values()) record.controller.abort()
    const loginPromises = [...this.loginRecords.values()].map((record) => record.promise)
    this.loginRecords.clear()
    this.dependencies.tokenStore.clear()
    await Promise.allSettled(loginPromises)
    await this.changeIdentity(null)
    await this.dependencies.removeDirectory(this.copilotHome)
  }

  private finishLogin(
    record: LoginRecord,
    success: boolean,
    error: GitHubCopilotPublicError | null
  ): GitHubCopilotLoginCompletion {
    const completion = { loginId: record.attempt.loginId, success, error }
    record.attempt.state = success ? 'succeeded' : record.attempt.state === 'cancelled' ? 'cancelled' : 'failed'
    record.attempt.completion = completion
    return completion
  }

  private async changeIdentity(nextFingerprint: string | null): Promise<void> {
    if (nextFingerprint !== this.knownFingerprint) {
      this.knownFingerprint = nextFingerprint
      this.accountEpoch += 1
    }
    this.invalidateCaches()
    await this.stopRuntime()
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

  private async getClient(): Promise<GitHubCopilotRuntimeClient> {
    while (this.resetPromise) await this.resetPromise
    if (this.disposed) throw new Error('GitHub Copilot subscription manager is disposed')
    const token = this.requireToken()
    const fingerprint = tokenFingerprint(token)
    if (this.client && this.clientFingerprint === fingerprint) return this.client
    if (this.clientPromise) return this.clientPromise

    if (this.client) await this.stopRuntime()
    const generation = ++this.lifecycleGeneration
    const promise = this.createAndStartClient(token, fingerprint, generation)
    this.clientPromise = promise
    try {
      return await promise
    } finally {
      if (this.clientPromise === promise) this.clientPromise = null
    }
  }

  private async createAndStartClient(
    token: string,
    fingerprint: string | null,
    generation: number
  ): Promise<GitHubCopilotRuntimeClient> {
    const baseDirectory = this.copilotHome
    await this.dependencies.ensureDirectory(baseDirectory)
    const runtimePath = await this.dependencies.resolveRuntimePath()
    let runtimeLease: RuntimeAssetLease | null = await this.dependencies.acquireRuntimeLease(runtimePath)
    try {
      const client = this.dependencies.createClient({
        connection: this.dependencies.resolveConnection(
          githubCopilotRuntimeEnvironment(this.dependencies.getProcessEnvironment()),
          runtimePath
        ),
        mode: 'empty',
        baseDirectory,
        gitHubToken: token,
        useLoggedInUser: false,
        logLevel: 'error',
      })
      try {
        await client.start()
      } catch (error) {
        await this.stopClient(client)
        throw error
      }
      if (this.disposed || generation !== this.lifecycleGeneration || fingerprint !== this.knownFingerprint) {
        await this.stopClient(client)
        throw new GitHubCopilotAccountChangedError()
      }
      this.client = client
      this.clientFingerprint = fingerprint
      this.runtimeLease = runtimeLease
      runtimeLease = null
      return client
    } finally {
      runtimeLease?.release()
    }
  }

  private async stopRuntime(): Promise<void> {
    this.lifecycleGeneration += 1
    const active = this.client
    this.client = null
    this.clientFingerprint = null
    this.activeSessions.clear()
    const connecting = this.clientPromise
    this.clientPromise = null
    if (connecting) {
      const connectingClient = await connecting.catch(() => null)
      if (connectingClient && connectingClient !== active) await this.stopClient(connectingClient)
    }
    try {
      if (active) await this.stopClient(active)
    } finally {
      this.releaseRuntimeLease()
    }
  }

  private async stopClient(client: GitHubCopilotRuntimeClient): Promise<void> {
    try {
      await client.stop()
    } catch {
      await client.forceStop().catch(() => undefined)
    }
  }

  private releaseRuntimeLease(): void {
    const lease = this.runtimeLease
    this.runtimeLease = null
    lease?.release()
  }

  private async loadStatus(identity: GitHubCopilotAccountIdentity): Promise<GitHubCopilotSubscriptionStatus> {
    const clientIdConfigured = Boolean(this.dependencies.getOAuthClientId().trim())
    try {
      // Read-only component probe. In production this verifies the managed ready asset and never installs it.
      await this.dependencies.resolveRuntimePath()
    } catch (error) {
      return {
        state: 'error',
        available: false,
        connected: false,
        authenticated: false,
        account: null,
        storageMode: this.dependencies.tokenStore.mode(),
        accountFingerprint: identity.fingerprint,
        accountEpoch: identity.epoch,
        error: publicError(error),
      }
    }
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
              message: 'GitHub Copilot OAuth Client ID is not configured in this build',
            },
      }
    }

    try {
      const client = await this.getClient()
      this.assertAccountIdentity(identity)
      const auth = await client.getAuthStatus()
      this.assertAccountIdentity(identity)
      return {
        state: 'ready',
        available: true,
        connected: true,
        authenticated: auth.isAuthenticated,
        account: auth.isAuthenticated
          ? {
              login: auth.login?.trim() || null,
              host: auth.host?.trim() || null,
              authType: auth.authType ?? null,
            }
          : null,
        storageMode: this.dependencies.tokenStore.mode(),
        accountFingerprint: identity.fingerprint,
        accountEpoch: identity.epoch,
        error: null,
      }
    } catch (error) {
      return {
        state: 'error',
        available: true,
        connected: false,
        authenticated: false,
        account: null,
        storageMode: this.dependencies.tokenStore.mode(),
        accountFingerprint: identity.fingerprint,
        accountEpoch: identity.epoch,
        error: publicError(error),
      }
    }
  }

  private requireToken(): string {
    const token = this.dependencies.tokenStore.get()?.trim()
    if (!token) throw new GitHubCopilotNotAuthenticatedError()
    return token
  }

  private getRequiredIdentity(): GitHubCopilotAccountIdentity {
    const identity = this.getAccountIdentity()
    if (!identity.fingerprint) throw new GitHubCopilotNotAuthenticatedError()
    return identity
  }

  private assertAvailableTools(availableTools: SessionConfig['availableTools']): void {
    if (availableTools === undefined || availableTools === null) {
      throw new Error('GitHub Copilot empty-mode sessions require an explicit availableTools allowlist')
    }
  }

  private lockSessionConfig<T extends GitHubCopilotCreateSessionConfig | GitHubCopilotResumeSessionConfig>(
    config: T,
    token: string
  ): T & SessionConfig {
    return {
      ...config,
      clientName: config.clientName?.trim() || 'maestrly',
      gitHubToken: token,
      enableManagedSettings: true,
      remoteSession: 'off',
    }
  }

  private disposedStatus(): GitHubCopilotSubscriptionStatus {
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

const instances = new Map<string, GitHubCopilotSubscriptionManager>()

/** Per-account registry: null/absent `accountId` means the default account (legacy behavior). Lazy instances. */
/** accountId becomes the on-disk COPILOT_HOME suffix; any separator/`..` would allow path traversal during wipe. */
const FILESYSTEM_SAFE_ACCOUNT_ID = /^[A-Za-z0-9_-]+$/

export function getGitHubCopilotSubscriptionManager(accountId: string | null = null): GitHubCopilotSubscriptionManager {
  if (accountId && !FILESYSTEM_SAFE_ACCOUNT_ID.test(accountId)) {
    throw new Error(`Invalid GitHub Copilot subscription account id: ${accountId}`)
  }
  const key = accountId ?? ''
  let manager = instances.get(key)
  if (!manager) {
    manager = new GitHubCopilotSubscriptionManager({ accountId })
    instances.set(key, manager)
  }
  return manager
}

/** All instances created in this process (global dispose / wipe). */
export function listGitHubCopilotSubscriptionManagers(): GitHubCopilotSubscriptionManager[] {
  return [...instances.values()]
}

export async function disposeGitHubCopilotSubscriptionManager(): Promise<void> {
  const managers = [...instances.values()]
  instances.clear()
  await Promise.all(managers.map((manager) => manager.dispose()))
}
