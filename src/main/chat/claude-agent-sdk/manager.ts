import { createHash } from 'node:crypto'
import type { ChildProcess } from 'node:child_process'
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import {
  query,
  type AccountInfo,
  type ModelInfo,
  type Options as ClaudeQueryOptions,
  type Query,
  type SDKControlGetUsageResponse,
  type SDKUserMessage,
  type SpawnedProcess,
  type SpawnOptions as ClaudeSpawnOptions,
} from '@anthropic-ai/claude-agent-sdk'
import { app } from 'electron'
import { resolveClaude } from './resolve-claude'
import { spawnCli } from '../../platform'
import {
  CLAUDE_AUTHENTICATION_REQUIRED_MESSAGE,
  ClaudeSubscriptionError,
  claudeSubscriptionErrorMessage,
  isClaudeAuthenticationRequired,
} from './errors'
import { claudeSubscriptionRuntimeEnvironment } from './runtime-env'
import {
  claudeModelPickerSnapshot,
  claudeRemoteCatalogSnapshot,
  listClaudeRemoteCatalog,
  onClaudeRemoteCatalogChanged,
} from './model-catalog'
import { broadcast } from '../../window-ipc'

export const CLAUDE_AGENT_SDK_VERSION = '0.3.263'
export const CLAUDE_CODE_COMPATIBLE_VERSION = '2.1.263'
const CLAUDE_PROFILE_DIRECTORY = 'claude-agent-sdk'
const CLAUDE_SIGNED_OUT_MARKER = '.maestrly-signed-out'
const CLAUDE_USAGE_CACHE_TTL_MS = 60_000

/**
 * Alias probes complement the account-aware picker — see `listModels`. Concrete/versioned models come from
 * modelPicker + the remote catalog, so launches no longer require adding seeds or publishing a desktop build.
 */
const CLAUDE_MODEL_PROBE_SEEDS: readonly (string | undefined)[] = [undefined, 'fable', 'opus']

export interface ClaudeSubscriptionAccount {
  email: string | null
  organizationId: string | null
  organizationName: string | null
  subscriptionType: string | null
  authMethod: string | null
  apiProvider: string | null
}

export interface ClaudeSubscriptionStatus {
  state: 'ready' | 'unavailable' | 'signed-out' | 'signing-in' | 'error' | 'disposed'
  available: boolean
  authenticated: boolean
  account: ClaudeSubscriptionAccount | null
  accountFingerprint: string | null
  accountEpoch: number
  cliVersion: string | null
  sdkVersion: string
  error: string | null
  errorCode?: 'claude-authentication-required'
}

export interface ClaudeSubscriptionAccountIdentity {
  fingerprint: string | null
  epoch: number
}

export interface ClaudeSubscriptionLoginResult {
  ok: boolean
  status: ClaudeSubscriptionStatus
  error?: string
}

export type ClaudeQueryFactory = (params: {
  prompt: string | AsyncIterable<SDKUserMessage>
  options?: ClaudeQueryOptions
}) => Query

interface ProcessResult {
  exitCode: number | null
  stdout: string
  stderr: string
}

export interface ClaudeSubscriptionManagerDependencies {
  /** Additional account slot; absent/null means the default account. Suffixes the isolated CLAUDE_CONFIG_DIR. */
  accountId?: string | null
  getUserDataPath: () => string
  getHomeDirectory: () => string
  getProcessEnvironment: () => NodeJS.ProcessEnv
  resolveExecutable: () => string
  ensureDirectory: (directory: string) => Promise<void>
  removeDirectory: (directory: string) => Promise<void>
  readTextFile: (file: string) => Promise<string>
  writePrivateFile: (file: string, contents: string) => Promise<void>
  runProcess: (
    executable: string,
    args: string[],
    options: { env: Record<string, string>; signal?: AbortSignal }
  ) => Promise<ProcessResult>
  queryFactory: ClaudeQueryFactory
  deleteSession: (
    sessionId: string,
    options: { dir: string; configDirectory: string; environment: Record<string, string> }
  ) => Promise<void>
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  if (process.platform === 'win32') return
  try {
    await chmod(directory, 0o700)
  } catch {
    // Some mounted filesystems do not support chmod. Creation mode is the primary protection.
  }
}

function runProcess(
  executable: string,
  args: string[],
  options: { env: Record<string, string>; signal?: AbortSignal }
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess
    try {
      child = spawnCli(executable, args, {
        env: options.env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        signal: options.signal,
      })
    } catch (error) {
      reject(error)
      return
    }
    let stdout = ''
    let stderr = ''
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.once('error', reject)
    child.once('close', (exitCode) => resolve({ exitCode, stdout, stderr }))
  })
}

function spawnClaudeCodeOnWindows(options: ClaudeSpawnOptions): SpawnedProcess {
  return spawnCli(options.command, options.args, {
    cwd: options.cwd,
    env: options.env,
    signal: options.signal,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as unknown as SpawnedProcess
}

const CLAUDE_SDK_ENTRY = createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk')
const DELETE_SESSION_SCRIPT =
  "const { pathToFileURL } = require('node:url');" +
  '(async()=>{const sdk=await import(pathToFileURL(process.argv[1]).href);' +
  'await sdk.deleteSession(process.argv[2],{dir:process.argv[3]});})()' +
  '.catch((error)=>{console.error(error instanceof Error?error.message:String(error));process.exitCode=1})'

async function deleteSessionInIsolatedProcess(
  sessionId: string,
  options: { dir: string; configDirectory: string; environment: Record<string, string> }
): Promise<void> {
  const result = await runProcess(
    process.execPath,
    ['-e', DELETE_SESSION_SCRIPT, CLAUDE_SDK_ENTRY, sessionId, options.dir],
    {
      env: {
        ...options.environment,
        CLAUDE_CONFIG_DIR: options.configDirectory,
        ELECTRON_RUN_AS_NODE: '1',
      },
      signal: AbortSignal.timeout(30_000),
    }
  )
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || 'Claude session cleanup failed.')
  }
}

const DEFAULT_DEPENDENCIES: ClaudeSubscriptionManagerDependencies = {
  accountId: null,
  getUserDataPath: () => app.getPath('userData'),
  getHomeDirectory: () => os.homedir(),
  getProcessEnvironment: () => process.env,
  resolveExecutable: resolveClaude,
  ensureDirectory: ensurePrivateDirectory,
  removeDirectory: (directory) => rm(directory, { recursive: true, force: true }),
  readTextFile: (file) => readFile(file, 'utf8'),
  writePrivateFile: (file, contents) => writeFile(file, contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' }),
  runProcess,
  queryFactory: query,
  deleteSession: deleteSessionInIsolatedProcess,
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function normalizedSubscriptionType(value: unknown): string | null {
  const normalized = nullableString(value)
    ?.toLowerCase()
    .replace(/^claude[\s_-]+/, '')
    .trim()
  return normalized || null
}

function parseVersion(raw: string): string | null {
  return raw.match(/\b(\d+\.\d+\.\d+)\b/)?.[1] ?? null
}

function versionParts(version: string): [number, number, number] {
  const [major = 0, minor = 0, patch = 0] = version.split('.').map((part) => Number.parseInt(part, 10) || 0)
  return [major, minor, patch]
}

export function isCompatibleClaudeCodeVersion(version: string): boolean {
  const current = versionParts(version)
  const minimum = versionParts(CLAUDE_CODE_COMPATIBLE_VERSION)
  if (current[0] !== minimum[0]) return false
  if (current[1] !== minimum[1]) return current[1] > minimum[1]
  return current[2] >= minimum[2]
}

export function parseClaudeAuthStatus(raw: string): {
  authenticated: boolean
  account: ClaudeSubscriptionAccount | null
} {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new ClaudeSubscriptionError('claude-auth-failed', 'Claude Code returned an invalid auth status.', {
      cause: error,
    })
  }
  if (!isRecord(parsed)) {
    throw new ClaudeSubscriptionError('claude-auth-failed', 'Claude Code returned an invalid auth status.')
  }
  const authenticated = parsed.loggedIn === true
  if (!authenticated) return { authenticated: false, account: null }
  const apiProvider = nullableString(parsed.apiProvider)
  const authMethod = nullableString(parsed.authMethod)
  const subscriptionType = nullableString(parsed.subscriptionType)
  const email = nullableString(parsed.email)
  const organizationId = nullableString(parsed.orgId)
  if (apiProvider !== 'firstParty' || authMethod !== 'claude.ai' || !subscriptionType || (!email && !organizationId)) {
    throw new ClaudeSubscriptionError(
      'claude-auth-failed',
      'Claude Code is authenticated with a backend that is not a verifiable Claude.ai subscription.'
    )
  }
  return {
    authenticated: true,
    account: {
      email,
      organizationId,
      organizationName: nullableString(parsed.orgName),
      subscriptionType,
      authMethod,
      apiProvider,
    },
  }
}

function accountFingerprint(account: ClaudeSubscriptionAccount | null): string | null {
  if (!account) return null
  const identity = [
    account.email,
    account.organizationId,
    account.organizationName,
    account.subscriptionType,
    account.authMethod,
    account.apiProvider,
  ].join('\0')
  return `sha256:${createHash('sha256').update(identity).digest('hex')}`
}

async function* emptyPrompt(): AsyncIterable<SDKUserMessage> {
  // Initialization-only query used for model capability probes. It never starts a model turn.
}

/**
 * Control requests need stdin to remain open after initialization. An already-completed async iterable makes the
 * SDK call `endInput()` and the Claude process may exit before replying to `get_usage`.
 */
function heldOpenPrompt(): { prompt: AsyncIterable<SDKUserMessage>; release: () => void } {
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const prompt: AsyncIterable<SDKUserMessage> = {
    [Symbol.asyncIterator]() {
      let consumed = false
      return {
        async next(): Promise<IteratorResult<SDKUserMessage>> {
          if (!consumed) {
            consumed = true
            await held
          }
          return { done: true, value: undefined }
        },
      }
    },
  }
  return {
    prompt,
    release,
  }
}

export class ClaudeSubscriptionManager {
  private readonly dependencies: ClaudeSubscriptionManagerDependencies
  private disposed = false
  private loginController: AbortController | null = null
  private cachedStatus: ClaudeSubscriptionStatus | null = null
  private fingerprint: string | null = null
  private epoch = 0
  private readonly observedContextWindows = new Map<string, number>()
  private cachedModels: ModelInfo[] | null = null
  private modelDiscovery: { identityKey: string; promise: Promise<ModelInfo[]> } | null = null
  private cachedUsage: { identityKey: string; fetchedAt: number; value: SDKControlGetUsageResponse } | null = null
  private usageDiscovery: { identityKey: string; promise: Promise<SDKControlGetUsageResponse> } | null = null
  private readonly activeQueries = new Map<Query, AbortController>()
  private profileOperations: Promise<void> = Promise.resolve()
  private loginRequestController: AbortController | null = null
  private profileMutationRequests = 0
  private authenticationRequired = false
  private readonly authenticationRequiredListeners = new Set<(status: ClaudeSubscriptionStatus) => void>()

  constructor(dependencies: Partial<ClaudeSubscriptionManagerDependencies> = {}) {
    this.dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencies }
  }

  get accountId(): string | null {
    return this.dependencies.accountId ?? null
  }

  get configDirectory(): string {
    const suffix = this.dependencies.accountId ? `-${this.dependencies.accountId}` : ''
    return path.join(this.dependencies.getUserDataPath(), CLAUDE_PROFILE_DIRECTORY + suffix)
  }

  get isDisposed(): boolean {
    return this.disposed
  }

  getStatusSnapshot(): ClaudeSubscriptionStatus | null {
    if (!this.cachedStatus) return null
    return {
      ...this.cachedStatus,
      account: this.cachedStatus.account ? { ...this.cachedStatus.account } : null,
    }
  }

  getUsageSnapshot(): SDKControlGetUsageResponse | null {
    return this.disposed ? null : (this.cachedUsage?.value ?? null)
  }

  onAuthenticationRequired(listener: (status: ClaudeSubscriptionStatus) => void): () => void {
    this.authenticationRequiredListeners.add(listener)
    return () => this.authenticationRequiredListeners.delete(listener)
  }

  /**
   * Revokes the admitted subscription identity after a terminal OAuth failure.
   * The latch is released only after a successful explicit login.
   */
  requireAuthentication(error: unknown): boolean {
    if (!isClaudeAuthenticationRequired(error)) return false
    if (this.authenticationRequired) return true
    this.authenticationRequired = true
    this.invalidateModelCache()
    this.invalidateUsageCache()
    this.observedContextWindows.clear()
    this.updateIdentity(null)
    this.abortAllQueries()
    this.cachedStatus = this.authenticationRequiredStatus()
    const status = this.getStatusSnapshot()!
    for (const listener of this.authenticationRequiredListeners) listener(status)
    return true
  }

  observeModelContextWindow(modelId: string, contextWindow: number): void {
    if (modelId && Number.isFinite(contextWindow) && contextWindow > 0) {
      this.observedContextWindows.set(modelId, Math.floor(contextWindow))
    }
  }

  getObservedModelContextWindow(modelId: string): number | undefined {
    return this.observedContextWindows.get(modelId)
  }

  getResolvedModelId(modelId: string): string {
    const match = this.cachedModels?.find((model) => model.value === modelId || model.resolvedModel === modelId)
    return match?.resolvedModel ?? match?.value ?? modelId
  }

  /** Resolve an alias against the current model catalog. `force` bypasses only the completed cache. */
  async resolveModelId(modelId: string, signal?: AbortSignal, force = false): Promise<string | null> {
    const models = await this.listModels(signal, force)
    const match = models.find((model) => model.value === modelId || model.resolvedModel === modelId)
    return match?.resolvedModel ?? match?.value ?? null
  }

  runtimeEnvironment(): Record<string, string> {
    return claudeSubscriptionRuntimeEnvironment(this.configDirectory, this.dependencies.getProcessEnvironment())
  }

  private runProfileOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.profileOperations.then(operation, operation)
    this.profileOperations = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  abortAllQueries(): void {
    for (const [activeQuery, controller] of this.activeQueries) {
      controller.abort(new Error('Claude account or profile changed.'))
      try {
        activeQuery.close()
      } catch {
        // Query cleanup is best effort; the abort controller remains authoritative.
      }
    }
    this.activeQueries.clear()
  }

  assertSubscriptionRuntimeAccount(account: AccountInfo, expectedIdentity?: ClaudeSubscriptionAccountIdentity): void {
    if (account.apiProvider !== 'firstParty' || account.apiKeySource) {
      throw new ClaudeSubscriptionError(
        'claude-auth-failed',
        'Claude runtime selected a non-subscription backend. Sign in with Claude.ai and remove API/cloud credentials.'
      )
    }
    if (!expectedIdentity) return
    this.assertAccountIdentity(expectedIdentity)
    const expected =
      this.cachedStatus?.authenticated &&
      this.cachedStatus.accountFingerprint === expectedIdentity.fingerprint &&
      this.cachedStatus.accountEpoch === expectedIdentity.epoch
        ? this.cachedStatus.account
        : null
    const runtimeEmail = nullableString(account.email)?.toLowerCase() ?? null
    const expectedEmail = expected?.email?.toLowerCase() ?? null
    const runtimeSubscription = normalizedSubscriptionType(account.subscriptionType)
    const expectedSubscription = normalizedSubscriptionType(expected?.subscriptionType)
    const runtimeOrganization = nullableString(account.organization)?.toLowerCase() ?? null
    const expectedOrganizations = new Set(
      [expected?.organizationId, expected?.organizationName]
        .map((value) => value?.toLowerCase() ?? null)
        .filter((value): value is string => Boolean(value))
    )
    const emailMatches = expectedEmail ? runtimeEmail === expectedEmail : true
    const organizationMatches = expectedEmail
      ? !runtimeOrganization || expectedOrganizations.size === 0 || expectedOrganizations.has(runtimeOrganization)
      : Boolean(runtimeOrganization && expectedOrganizations.has(runtimeOrganization))
    if (
      !expected ||
      !expectedSubscription ||
      runtimeSubscription !== expectedSubscription ||
      !emailMatches ||
      !organizationMatches
    ) {
      throw new ClaudeSubscriptionError(
        'claude-auth-failed',
        'Claude runtime account does not match the subscription identity admitted by Maestrly.'
      )
    }
  }

  private beginProfileMutation(): void {
    this.profileMutationRequests += 1
    this.cachedStatus = null
    this.invalidateModelCache()
    this.invalidateUsageCache()
    this.updateIdentity(null)
    this.abortAllQueries()
  }

  private endProfileMutation(): void {
    this.profileMutationRequests = Math.max(0, this.profileMutationRequests - 1)
  }

  private unavailable(error: string, cliVersion: string | null = null): ClaudeSubscriptionStatus {
    this.updateIdentity(null)
    return {
      state: 'unavailable',
      available: false,
      authenticated: false,
      account: null,
      accountFingerprint: null,
      accountEpoch: this.epoch,
      cliVersion,
      sdkVersion: CLAUDE_AGENT_SDK_VERSION,
      error,
    }
  }

  private authenticationRequiredStatus(): ClaudeSubscriptionStatus {
    return {
      state: 'error',
      available: this.cachedStatus?.available ?? true,
      authenticated: false,
      account: null,
      accountFingerprint: null,
      accountEpoch: this.epoch,
      cliVersion: this.cachedStatus?.cliVersion ?? null,
      sdkVersion: CLAUDE_AGENT_SDK_VERSION,
      error: CLAUDE_AUTHENTICATION_REQUIRED_MESSAGE,
      errorCode: 'claude-authentication-required',
    }
  }

  private updateIdentity(nextFingerprint: string | null): void {
    if (this.fingerprint !== nextFingerprint) {
      if (this.fingerprint !== null) this.abortAllQueries()
      this.invalidateModelCache()
      this.invalidateUsageCache()
      this.fingerprint = nextFingerprint
      this.epoch += 1
    }
  }

  private invalidateModelCache(): void {
    this.cachedModels = null
    this.modelDiscovery = null
  }

  private invalidateUsageCache(): void {
    this.cachedUsage = null
    this.usageDiscovery = null
  }

  private async bootstrapKeychainSelector(): Promise<void> {
    try {
      await this.dependencies.readTextFile(path.join(this.configDirectory, CLAUDE_SIGNED_OUT_MARKER))
      return
    } catch {
      // No explicit local logout marker: the non-secret selector may be bootstrapped.
    }
    const target = path.join(this.configDirectory, '.claude.json')
    try {
      await this.dependencies.readTextFile(target)
      return
    } catch {
      // An absent isolated profile may be bootstrapped with the non-secret user selector.
    }
    const home = this.dependencies.getHomeDirectory()
    const sources = [path.join(home, '.claude', '.claude.json'), path.join(home, '.claude.json')]
    for (const source of sources) {
      try {
        const parsed = JSON.parse(await this.dependencies.readTextFile(source)) as unknown
        if (!isRecord(parsed)) continue
        const userID = nullableString(parsed.userID)
        if (!userID) continue
        await this.dependencies.writePrivateFile(target, `${JSON.stringify({ userID }, null, 2)}\n`)
        return
      } catch (error) {
        const code = isRecord(error) ? error.code : undefined
        if (code === 'EEXIST') return
        if (code !== 'ENOENT') {
          // Bootstrap is best effort. Dedicated login remains available.
        }
      }
    }
  }

  private async prepare(): Promise<void> {
    if (this.disposed) {
      throw new ClaudeSubscriptionError('claude-runtime-failed', 'Claude provider has been disposed.')
    }
    await this.dependencies.ensureDirectory(this.configDirectory)
    await this.bootstrapKeychainSelector()
  }

  private async statusUnlocked(
    options: { refresh?: boolean; allowAuthenticationRequired?: boolean } = {}
  ): Promise<ClaudeSubscriptionStatus> {
    if (this.disposed) {
      return {
        state: 'disposed',
        available: false,
        authenticated: false,
        account: null,
        accountFingerprint: null,
        accountEpoch: this.epoch,
        cliVersion: null,
        sdkVersion: CLAUDE_AGENT_SDK_VERSION,
        error: 'Claude provider has been disposed.',
      }
    }
    if (this.authenticationRequired && !options.allowAuthenticationRequired) {
      this.cachedStatus = this.authenticationRequiredStatus()
      return this.cachedStatus
    }
    if (!options.refresh && this.cachedStatus) return this.cachedStatus
    let verifiedCliVersion: string | null = null
    try {
      await this.prepare()
      const executable = this.dependencies.resolveExecutable()
      const environment = this.runtimeEnvironment()
      const probeSignal = AbortSignal.timeout(15_000)
      const versionResult = await this.dependencies.runProcess(executable, ['--version'], {
        env: environment,
        signal: probeSignal,
      })
      const cliVersion = parseVersion(versionResult.stdout || versionResult.stderr)
      if (!cliVersion) {
        this.cachedStatus = this.unavailable('Claude Code is not installed or its version could not be read.')
        return this.cachedStatus
      }
      if (!isCompatibleClaudeCodeVersion(cliVersion)) {
        this.cachedStatus = this.unavailable(
          `Claude Code ${cliVersion} is incompatible. Version ${CLAUDE_CODE_COMPATIBLE_VERSION} or newer in the same major release is required.`,
          cliVersion
        )
        return this.cachedStatus
      }
      verifiedCliVersion = cliVersion
      const authResult = await this.dependencies.runProcess(executable, ['auth', 'status', '--json'], {
        env: environment,
        signal: probeSignal,
      })
      if (authResult.exitCode !== 0 && !authResult.stdout.trim()) {
        throw new ClaudeSubscriptionError(
          'claude-auth-failed',
          authResult.stderr.trim() || 'Claude Code could not read the authentication status.'
        )
      }
      const auth = parseClaudeAuthStatus(authResult.stdout)
      if (this.authenticationRequired && !options.allowAuthenticationRequired) {
        this.cachedStatus = this.authenticationRequiredStatus()
        return this.cachedStatus
      }
      const nextFingerprint = accountFingerprint(auth.account)
      this.updateIdentity(nextFingerprint)
      this.cachedStatus = {
        state: auth.authenticated ? 'ready' : this.loginController ? 'signing-in' : 'signed-out',
        available: true,
        authenticated: auth.authenticated,
        account: auth.account,
        accountFingerprint: nextFingerprint,
        accountEpoch: this.epoch,
        cliVersion,
        sdkVersion: CLAUDE_AGENT_SDK_VERSION,
        error: null,
      }
      return this.cachedStatus
    } catch (error) {
      this.updateIdentity(null)
      const message =
        (error as NodeJS.ErrnoException)?.code === 'ENOENT'
          ? 'Claude Code is not installed.'
          : claudeSubscriptionErrorMessage(error)
      this.cachedStatus = verifiedCliVersion
        ? {
            state: 'error',
            available: true,
            authenticated: false,
            account: null,
            accountFingerprint: null,
            accountEpoch: this.epoch,
            cliVersion: verifiedCliVersion,
            sdkVersion: CLAUDE_AGENT_SDK_VERSION,
            error: message,
          }
        : this.unavailable(message)
      return this.cachedStatus
    }
  }

  async status(options: { refresh?: boolean } = {}): Promise<ClaudeSubscriptionStatus> {
    return this.runProfileOperation(() => this.statusUnlocked(options))
  }

  async login(signal?: AbortSignal): Promise<ClaudeSubscriptionLoginResult> {
    if (this.loginController || this.loginRequestController) {
      const status = this.cachedStatus ?? {
        state: 'signing-in' as const,
        available: true,
        authenticated: false,
        account: null,
        accountFingerprint: null,
        accountEpoch: this.epoch,
        cliVersion: null,
        sdkVersion: CLAUDE_AGENT_SDK_VERSION,
        error: null,
      }
      return { ok: false, status, error: 'Claude login is already in progress.' }
    }
    this.beginProfileMutation()
    const requestController = new AbortController()
    this.loginRequestController = requestController
    const abortQueued = () => requestController.abort(signal?.reason)
    signal?.addEventListener('abort', abortQueued, { once: true })
    if (signal?.aborted) abortQueued()
    try {
      return await this.runProfileOperation(() => this.loginUnlocked(requestController.signal))
    } finally {
      signal?.removeEventListener('abort', abortQueued)
      if (this.loginRequestController === requestController) this.loginRequestController = null
      this.endProfileMutation()
    }
  }

  private async loginUnlocked(signal?: AbortSignal): Promise<ClaudeSubscriptionLoginResult> {
    if (signal?.aborted) {
      return {
        ok: false,
        status: this.cachedStatus ?? this.unavailable('Claude login was cancelled.'),
        error: 'Claude login was cancelled.',
      }
    }
    // A status probe queued before login may have restored the old identity after
    // login() invalidated it. Revoke it again at the exact profile mutation boundary.
    this.cachedStatus = null
    this.updateIdentity(null)
    this.abortAllQueries()
    // Explicit login clears the Maestrly-only signed-out marker and rebuilds the isolated profile.
    await this.dependencies.removeDirectory(this.configDirectory)
    await this.prepare()
    const controller = new AbortController()
    this.loginController = controller
    const abort = () => controller.abort()
    signal?.addEventListener('abort', abort, { once: true })
    this.cachedStatus = null
    try {
      const result = await this.dependencies.runProcess(
        this.dependencies.resolveExecutable(),
        ['auth', 'login', '--claudeai'],
        { env: this.runtimeEnvironment(), signal: controller.signal }
      )
      this.cachedStatus = null
      const status = await this.statusUnlocked({ refresh: true, allowAuthenticationRequired: true })
      if (result.exitCode !== 0 || !status.authenticated) {
        if (this.authenticationRequired) this.cachedStatus = this.authenticationRequiredStatus()
        return {
          ok: false,
          status: this.cachedStatus ?? status,
          error: controller.signal.aborted ? 'Claude login was cancelled.' : 'Claude login did not complete.',
        }
      }
      this.authenticationRequired = false
      return { ok: true, status }
    } catch (error) {
      this.cachedStatus = null
      const status = await this.statusUnlocked({
        refresh: true,
        allowAuthenticationRequired: !this.authenticationRequired,
      })
      return {
        ok: false,
        status,
        error: controller.signal.aborted ? 'Claude login was cancelled.' : claudeSubscriptionErrorMessage(error),
      }
    } finally {
      signal?.removeEventListener('abort', abort)
      this.loginController = null
    }
  }

  cancelLogin(): void {
    this.loginRequestController?.abort(new Error('Claude login was cancelled.'))
    this.loginController?.abort()
  }

  async logout(): Promise<ClaudeSubscriptionLoginResult> {
    this.cancelLogin()
    this.beginProfileMutation()
    try {
      return await this.runProfileOperation(() => this.logoutUnlocked())
    } finally {
      this.endProfileMutation()
    }
  }

  private async logoutUnlocked(): Promise<ClaudeSubscriptionLoginResult> {
    try {
      // Never invoke `claude auth logout`: OAuth/Keychain state may be shared with the user's default CLI
      // profile. Local logout removes only Maestrly's selector/profile and leaves an explicit no-bootstrap marker.
      await this.dependencies.removeDirectory(this.configDirectory)
      await this.dependencies.ensureDirectory(this.configDirectory)
      await this.dependencies.writePrivateFile(
        path.join(this.configDirectory, CLAUDE_SIGNED_OUT_MARKER),
        `${Date.now()}\n`
      )
      this.cachedStatus = null
      this.updateIdentity(null)
      return { ok: true, status: await this.statusUnlocked({ refresh: true }) }
    } catch (error) {
      const status = await this.statusUnlocked({ refresh: true })
      return { ok: false, status, error: claudeSubscriptionErrorMessage(error) }
    }
  }

  createQuery(
    params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: ClaudeQueryOptions },
    runtimeOptions: { allowUsageTraffic?: boolean } = {}
  ): Query {
    if (this.disposed) {
      throw new ClaudeSubscriptionError('claude-runtime-failed', 'Claude provider has been disposed.')
    }
    if (this.profileMutationRequests > 0) {
      throw new ClaudeSubscriptionError(
        'claude-not-authenticated',
        'Claude authentication is changing. Wait for login, logout, or wipe to finish.'
      )
    }
    if (this.authenticationRequired) {
      throw new ClaudeSubscriptionError('claude-not-authenticated', CLAUDE_AUTHENTICATION_REQUIRED_MESSAGE)
    }
    const abortController = params.options?.abortController ?? new AbortController()
    const environment = this.runtimeEnvironment()
    // The user explicitly requested this read by opening/refreshing the card. Claude classifies the official
    // `/usage` endpoint as nonessential traffic; allowing only this probe keeps all normal turns
    // under the runtime's restrictive policy.
    if (runtimeOptions.allowUsageTraffic) delete environment.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC
    const modelPicker = claudeModelPickerSnapshot()
    const incomingSettings = params.options?.settings
    // All internal paths use inline settings. External paths stay intact because merging JSON would require
    // owning the file; listModels still merges the catalog in that case.
    const settings =
      typeof incomingSettings === 'string'
        ? incomingSettings
        : modelPicker
          ? { ...(incomingSettings ?? {}), modelPicker }
          : incomingSettings
    const created = this.dependencies.queryFactory({
      prompt: params.prompt,
      options: {
        ...params.options,
        ...(settings !== undefined ? { settings } : {}),
        abortController,
        pathToClaudeCodeExecutable: this.dependencies.resolveExecutable(),
        env: environment,
        ...(process.platform === 'win32' ? { spawnClaudeCodeProcess: spawnClaudeCodeOnWindows } : {}),
      },
    })
    const originalClose = created.close.bind(created)
    created.close = () => {
      this.activeQueries.delete(created)
      originalClose()
    }
    this.activeQueries.set(created, abortController)
    return created
  }

  /**
   * Lists the models this account can select.
   *
   * One probe is not enough. `supportedModels()` answers with the harness default list plus the session's
   * own model when that model is not already in it, so a probe with no `model` hides every variant the
   * harness does not advertise. Measured against the live runtime: no seed answers
   * `default, opus[1m], sonnet, haiku`, seeding `fable` adds Fable and seeding `opus` adds Opus without the
   * 1M window. `setModel()` and `reinitialize()` do not change the answer — the list is fixed when the
   * session spawns — so a session per seed is the only way to reveal them.
   *
   * Seeds run sequentially to prevent concurrent OAuth refresh attempts. Failures are tolerated individually:
   * a seed the account cannot reach (or one
   * Anthropic retires) costs that entry, not the whole list.
   */
  async listModels(signal?: AbortSignal, force = false): Promise<ModelInfo[]> {
    signal?.throwIfAborted()
    const status = await this.status()
    signal?.throwIfAborted()
    if (!status.authenticated) {
      throw new ClaudeSubscriptionError('claude-not-authenticated', 'Sign in to Claude Code first.')
    }
    await listClaudeRemoteCatalog(force)
    signal?.throwIfAborted()
    // The exec catalog uses `force` after TTL expiry or refresh clicks. It bypasses only completed results;
    // LIVE discovery for the same identity remains deduplicated below.
    if (!force && this.cachedModels) return this.cachedModels.map((model) => ({ ...model }))
    const identity = { fingerprint: status.accountFingerprint, epoch: status.accountEpoch }
    const identityKey = `${identity.fingerprint ?? ''}:${identity.epoch}`
    let discovery = this.modelDiscovery
    if (!discovery || discovery.identityKey !== identityKey) {
      const promise = this.discoverModels(identity).finally(() => {
        if (this.modelDiscovery?.promise === promise) this.modelDiscovery = null
      })
      discovery = { identityKey, promise }
      this.modelDiscovery = discovery
    }
    const models = await discovery.promise
    signal?.throwIfAborted()
    return models.map((model) => ({ ...model }))
  }

  /**
   * Read the official `/usage` snapshot without starting a turn. The SDK method is experimental, so the shared
   * adapter treats the response as untrusted data and normalizes only known fields.
   */
  async getUsage(force = false): Promise<SDKControlGetUsageResponse> {
    const status = await this.status()
    if (!status.authenticated || !status.accountFingerprint) {
      throw new ClaudeSubscriptionError('claude-not-authenticated', 'Sign in to Claude Code first.')
    }
    const identity = { fingerprint: status.accountFingerprint, epoch: status.accountEpoch }
    const identityKey = `${identity.fingerprint}:${identity.epoch}`
    const cached = this.cachedUsage
    if (!force && cached?.identityKey === identityKey && Date.now() - cached.fetchedAt < CLAUDE_USAGE_CACHE_TTL_MS) {
      return cached.value
    }

    let discovery = this.usageDiscovery
    if (!discovery || discovery.identityKey !== identityKey) {
      const promise = this.probeUsage(identity)
        .then((value) => {
          this.assertAccountIdentity(identity)
          this.cachedUsage = { identityKey, fetchedAt: Date.now(), value }
          return value
        })
        .catch((error) => {
          this.requireAuthentication(error)
          throw error
        })
        .finally(() => {
          if (this.usageDiscovery?.promise === promise) this.usageDiscovery = null
        })
      discovery = { identityKey, promise }
      this.usageDiscovery = discovery
    }
    return discovery.promise
  }

  private async discoverModels(identity: ClaudeSubscriptionAccountIdentity): Promise<ModelInfo[]> {
    const union = new Map<string, ModelInfo>()
    let failure: unknown
    for (const seed of CLAUDE_MODEL_PROBE_SEEDS) {
      try {
        const models = await this.probeSupportedModels(seed, identity)
        for (const model of models) if (!union.has(model.value)) union.set(model.value, model)
      } catch (error) {
        failure ??= error
        if (this.requireAuthentication(error)) throw error
      }
    }
    // Compatibility with runtimes that do not yet materialize modelPicker during initialize: the feed still
    // appears in the picker. On collision, the account-aware runtime row inserted above always wins.
    for (const model of claudeRemoteCatalogSnapshot()) {
      if (union.has(model.id)) continue
      const efforts = model.capabilities
        .filter((capability) => capability.startsWith('effort:'))
        .map((capability) => capability.slice('effort:'.length))
        .filter(
          (effort): effort is 'low' | 'medium' | 'high' | 'xhigh' | 'max' =>
            effort === 'low' || effort === 'medium' || effort === 'high' || effort === 'xhigh' || effort === 'max'
        )
      union.set(model.id, {
        value: model.id,
        resolvedModel: model.id,
        displayName: model.label,
        description: model.description,
        ...(model.capabilities.includes('effort')
          ? {
              supportsEffort: true,
              ...(efforts.length ? { supportedEffortLevels: efforts } : {}),
            }
          : {}),
        ...(model.capabilities.includes('thinking') || model.capabilities.includes('adaptive_thinking')
          ? { supportsAdaptiveThinking: model.capabilities.includes('adaptive_thinking') }
          : {}),
      })
    }
    if (!union.size) {
      throw failure instanceof Error
        ? failure
        : new ClaudeSubscriptionError('claude-auth-failed', 'Claude Code did not report any available model.')
    }
    const models = [...union.values()]
    this.assertAccountIdentity(identity)
    this.cachedModels = models.map((model) => ({ ...model }))
    return models
  }

  private async probeUsage(identity: ClaudeSubscriptionAccountIdentity): Promise<SDKControlGetUsageResponse> {
    const abortController = new AbortController()
    const input = heldOpenPrompt()
    const session = this.createQuery(
      {
        prompt: input.prompt,
        options: {
          abortController,
          settingSources: [],
          strictMcpConfig: true,
          tools: [],
          allowedTools: [],
          disallowedTools: ['Agent', 'Task', 'Skill', 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList'],
          skills: [],
          plugins: [],
          mcpServers: {},
          permissionMode: 'dontAsk',
          persistSession: false,
          systemPrompt: 'Maestrly subscription usage probe.',
        },
      },
      { allowUsageTraffic: true }
    )
    try {
      const initialized = await session.initializationResult()
      this.assertSubscriptionRuntimeAccount(initialized.account, identity)
      const usage = await session.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()
      this.assertAccountIdentity(identity)
      return usage
    } finally {
      input.release()
      session.close()
    }
  }

  /** One capability probe. `seed` becomes the session model, which is what widens the answer. */
  private async probeSupportedModels(
    seed: string | undefined,
    identity: ClaudeSubscriptionAccountIdentity,
    signal?: AbortSignal
  ): Promise<ModelInfo[]> {
    signal?.throwIfAborted()
    const abortController = new AbortController()
    const abort = () => abortController.abort(signal?.reason)
    signal?.addEventListener('abort', abort, { once: true })
    const session = this.createQuery({
      prompt: emptyPrompt(),
      options: {
        abortController,
        ...(seed ? { model: seed } : {}),
        settingSources: [],
        strictMcpConfig: true,
        tools: [],
        allowedTools: [],
        disallowedTools: ['Agent', 'Task', 'Skill', 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList'],
        skills: [],
        plugins: [],
        mcpServers: {},
        permissionMode: 'dontAsk',
        persistSession: false,
        systemPrompt: 'Maestrly model capability probe.',
      },
    })
    try {
      const initialized = await session.initializationResult()
      signal?.throwIfAborted()
      this.assertSubscriptionRuntimeAccount(initialized.account, identity)
      return await session.supportedModels()
    } finally {
      signal?.removeEventListener('abort', abort)
      session.close()
    }
  }

  async accountIdentity(refresh = false): Promise<ClaudeSubscriptionAccountIdentity> {
    const status = await this.status({ refresh })
    return { fingerprint: status.accountFingerprint, epoch: status.accountEpoch }
  }

  assertAccountIdentity(expected: ClaudeSubscriptionAccountIdentity): void {
    if (this.fingerprint !== expected.fingerprint || this.epoch !== expected.epoch) {
      throw new ClaudeSubscriptionError(
        'claude-not-authenticated',
        'The Claude account changed while this operation was running.'
      )
    }
  }

  async wipe(): Promise<void> {
    this.cancelLogin()
    this.beginProfileMutation()
    try {
      await this.runProfileOperation(async () => {
        await this.dependencies.removeDirectory(this.configDirectory)
        await this.dependencies.ensureDirectory(this.configDirectory)
        await this.dependencies.writePrivateFile(
          path.join(this.configDirectory, CLAUDE_SIGNED_OUT_MARKER),
          `${Date.now()}\n`
        )
        this.cachedStatus = null
        this.observedContextWindows.clear()
        this.invalidateModelCache()
        this.invalidateUsageCache()
        this.updateIdentity(null)
      })
    } finally {
      this.endProfileMutation()
    }
  }

  async deleteManagedSession(sessionId: string, cwd: string): Promise<void> {
    await this.dependencies.deleteSession(sessionId, {
      dir: cwd,
      configDirectory: this.configDirectory,
      environment: this.runtimeEnvironment(),
    })
  }

  dispose(): void {
    this.cancelLogin()
    this.abortAllQueries()
    this.disposed = true
    this.cachedStatus = null
    this.observedContextWindows.clear()
    this.invalidateModelCache()
    this.invalidateUsageCache()
    this.updateIdentity(null)
    this.authenticationRequiredListeners.clear()
  }

  invalidateModels(): void {
    this.invalidateModelCache()
  }
}

const instances = new Map<string, ClaudeSubscriptionManager>()

/** Per-account registry: null/absent `accountId` means the default account (legacy behavior). Lazy instances. */
/** accountId becomes the on-disk CLAUDE_CONFIG_DIR suffix; separators/`..` would allow path traversal during wipe. */
const FILESYSTEM_SAFE_ACCOUNT_ID = /^[A-Za-z0-9_-]+$/

export function getClaudeSubscriptionManager(accountId: string | null = null): ClaudeSubscriptionManager {
  if (accountId && !FILESYSTEM_SAFE_ACCOUNT_ID.test(accountId)) {
    throw new Error(`Invalid Claude subscription account id: ${accountId}`)
  }
  const key = accountId ?? ''
  let manager = instances.get(key)
  if (!manager) {
    manager = new ClaudeSubscriptionManager({ accountId })
    instances.set(key, manager)
  }
  return manager
}

/** All instances created in this process (global dispose / wipe). */
export function listClaudeSubscriptionManagers(): ClaudeSubscriptionManager[] {
  return [...instances.values()]
}

onClaudeRemoteCatalogChanged(() => {
  for (const manager of instances.values()) manager.invalidateModels()
  broadcast('models:catalog-changed')
})

export function resetClaudeSubscriptionManagerForTests(): void {
  for (const manager of instances.values()) manager.dispose()
  instances.clear()
}
