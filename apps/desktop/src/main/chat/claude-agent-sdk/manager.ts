import { createHash } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
  type SDKMessage,
  type SDKUserMessage,
  type SpawnedProcess,
  type SpawnOptions as ClaudeSpawnOptions,
} from '@anthropic-ai/claude-agent-sdk'
import { app } from 'electron'
import { clearClaudeCache, resolveClaude } from './resolve-claude'
import { botClaudeRuntime, type RetainedClaudeExecutable } from './runtime-selection'
import { isBotMode } from '../../fleet/instance/config'
import { spawnCli } from '../../platform'
import {
  CLAUDE_AUTHENTICATION_REQUIRED_MESSAGE,
  ClaudeSubscriptionError,
  claudeRefreshContentionRetryDelay,
  claudeSubscriptionErrorMessage,
  isClaudeAuthenticationRequired,
  isClaudeOAuthRefreshContention,
} from './errors'
import { claudeSubscriptionRuntimeEnvironment } from './runtime-env'
import { allowedConversationProcessEnv, type ConversationProcessEnv } from '../conversation-env'
import {
  claudeModelPickerSnapshot,
  claudeRemoteCatalogSnapshot,
  listClaudeRemoteCatalog,
  onClaudeRemoteCatalogChanged,
} from './model-catalog'
import { broadcast } from '../../window-ipc'
import { CLAUDE_CODE_COMPATIBLE_VERSION, isCompatibleClaudeCodeVersion } from './version'
import { withSubscriptionAccount } from '../../../shared/chat'
import { CLAUDE_SUBSCRIPTION_PROVIDER_ID as CLAUDE_SUBSCRIPTION_BASE_PROVIDER_ID } from '../../../shared/subagent-profiles'
import { getSubscriptionFailoverRouter } from '../subscription-failover/router'

export const CLAUDE_AGENT_SDK_VERSION = '0.3.285'
export { CLAUDE_CODE_COMPATIBLE_VERSION, isCompatibleClaudeCodeVersion }
const CLAUDE_PROFILE_DIRECTORY = 'claude-agent-sdk'
const CLAUDE_SIGNED_OUT_MARKER = '.maestrly-signed-out'
const CLAUDE_USAGE_CACHE_TTL_MS = 60_000
const SUBSCRIPTION_API_KEY_SOURCES = new Set(['none', 'oauth'])
/** `claude auth login` waits for its browser callback with no deadline of its own. */
const CLAUDE_LOGIN_TIMEOUT_MS = 15 * 60_000

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
  errorCode?: 'claude-authentication-required' | 'claude-code-not-installed' | 'claude-code-incompatible'
  /**
   * While Claude Code is missing or too old: the profile still holds the sign-in it cannot use now. It is used again
   * once Claude Code is found, without signing in.
   */
  savedSignIn?: { email: string | null }
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

export interface ClaudeLoginProcess {
  stdout: NodeJS.ReadableStream
  stdin: NodeJS.WritableStream
  exited: Promise<number | null>
  kill(): void
}

export interface ClaudeInteractiveLogin {
  autoUrl: string
  manualUrl: string
  submitCode(code: string): void
  cancel(): void
  done: Promise<ClaudeSubscriptionLoginResult>
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
  /** Forget the executable `resolveExecutable` remembered, so an explicit refresh looks for Claude Code again. */
  forgetExecutable: () => void
  /**
   * The executable one query runs on, held until the query closes; null to use `resolveExecutable`. Bots use it so
   * a Claude Code update never replaces the binary under a running turn.
   */
  retainExecutable: () => RetainedClaudeExecutable | null
  ensureDirectory: (directory: string) => Promise<void>
  removeDirectory: (directory: string) => Promise<void>
  readTextFile: (file: string) => Promise<string>
  writePrivateFile: (file: string, contents: string) => Promise<void>
  runProcess: (
    executable: string,
    args: string[],
    options: { env: Record<string, string>; signal?: AbortSignal }
  ) => Promise<ProcessResult>
  spawnLogin: (executable: string, args: string[], options: { env: Record<string, string> }) => ClaudeLoginProcess
  queryFactory: ClaudeQueryFactory
  deleteSession: (
    sessionId: string,
    options: { dir: string; configDirectory: string; environment: Record<string, string> }
  ) => Promise<void>
  /** Waits between probe attempts. */
  pause: (ms: number) => Promise<void>
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
  resolveExecutable: () => (isBotMode() ? botClaudeRuntime().current().path : resolveClaude()),
  // A bot's selection keeps its own executable and is re-selected when the managed installation changes.
  forgetExecutable: () => {
    if (!isBotMode()) clearClaudeCache()
  },
  retainExecutable: () => (isBotMode() ? botClaudeRuntime().retain() : null),
  ensureDirectory: ensurePrivateDirectory,
  removeDirectory: (directory) => rm(directory, { recursive: true, force: true }),
  readTextFile: (file) => readFile(file, 'utf8'),
  writePrivateFile: (file, contents) => writeFile(file, contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' }),
  runProcess,
  spawnLogin: (executable, args, options) => {
    const child = spawn(executable, args, { env: options.env, stdio: ['pipe', 'pipe', 'pipe'] })
    child.stderr.resume()
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', resolve)
    })
    return {
      stdout: child.stdout,
      stdin: child.stdin,
      exited,
      kill: () => {
        child.kill('SIGKILL')
      },
    }
  },
  queryFactory: query,
  deleteSession: deleteSessionInIsolatedProcess,
  pause: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function parseVersion(raw: string): string | null {
  return raw.match(/\b(\d+\.\d+\.\d+)\b/)?.[1] ?? null
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
  // The plan is display-only: a tier Claude Code does not recognise yet may come back empty, and the backend and
  // login method above already prove a Claude.ai subscription.
  if (apiProvider !== 'firstParty' || authMethod !== 'claude.ai' || (!email && !organizationId)) {
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
  // Only what names the account. A change here aborts the account's turns and drops its native sessions, so the plan
  // and the organization's display name (both renamed upstream or by the user) stay out; the name stands in only
  // when there is no organization id.
  const identity = [
    account.email,
    account.organizationId ?? account.organizationName,
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

/** Only an answering model streams events or a non-error assistant message; quota rejections never do. */
function isClaudeModelOutput(message: SDKMessage): boolean {
  return message.type === 'stream_event' || (message.type === 'assistant' && !message.error)
}

async function* observeClaudeModelOutput(
  messages: AsyncGenerator<SDKMessage, void>,
  onOutput: () => void
): AsyncGenerator<SDKMessage, void> {
  for await (const message of messages) {
    if (isClaudeModelOutput(message)) onOutput()
    yield message
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

  peekStatus(): ClaudeSubscriptionStatus | null {
    return this.cachedStatus
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
    // `none` and `oauth` are the SDK's own names for "no API key"; any other source would bill the API.
    const apiKeySource = nullableString(account.apiKeySource)
    if (account.apiProvider !== 'firstParty' || (apiKeySource && !SUBSCRIPTION_API_KEY_SOURCES.has(apiKeySource))) {
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
    // Only the email proves the account; the backend check above keeps API billing out. The plan and the organization
    // name are labels Anthropic or the user can change, and `auth status` and the runtime pick a new label up at
    // different times (seen live: `max` vs `Claude Ultra`), so neither is compared. The organization, which the
    // runtime reports only by name, stands in solely for accounts without an email.
    const emailMatches = expectedEmail ? runtimeEmail === expectedEmail : true
    const runtimeOrganization = nullableString(account.organization)?.toLowerCase() ?? null
    const expectedOrganizations = new Set(
      [expected?.organizationId, expected?.organizationName]
        .map((value) => value?.toLowerCase() ?? null)
        .filter((value): value is string => Boolean(value))
    )
    const organizationMatches =
      Boolean(expectedEmail) || Boolean(runtimeOrganization && expectedOrganizations.has(runtimeOrganization))
    if (!expected || !emailMatches || !organizationMatches) {
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

  private unavailable(
    error: string,
    cliVersion: string | null = null,
    errorCode?: 'claude-code-not-installed' | 'claude-code-incompatible'
  ): ClaudeSubscriptionStatus {
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
      ...(errorCode ? { errorCode } : {}),
    }
  }

  /** Claude Code is missing or too old: unavailable, keeping word of a sign-in the profile still holds. */
  private async claudeCodeSetupNeeded(
    error: string,
    cliVersion: string | null,
    errorCode: 'claude-code-not-installed' | 'claude-code-incompatible'
  ): Promise<ClaudeSubscriptionStatus> {
    const status = this.unavailable(error, cliVersion, errorCode)
    const savedSignIn = await this.savedSignIn()
    return savedSignIn ? { ...status, savedSignIn } : status
  }

  /**
   * The sign-in Claude Code left in the isolated profile, read without running it: the account it records in
   * `.claude.json` (every system), or the credentials file it keeps outside the macOS Keychain. Never returns secrets.
   */
  private async savedSignIn(): Promise<{ email: string | null } | null> {
    try {
      const parsed = JSON.parse(await this.dependencies.readTextFile(path.join(this.configDirectory, '.claude.json')))
      if (isRecord(parsed) && isRecord(parsed.oauthAccount)) {
        return { email: nullableString(parsed.oauthAccount.emailAddress) }
      }
    } catch {
      // No readable profile file: the credentials file may still be there.
    }
    try {
      const credentials = await this.dependencies.readTextFile(path.join(this.configDirectory, '.credentials.json'))
      return credentials.trim() ? { email: null } : null
    } catch {
      return null
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
    // A refresh ("Check again", the card's refresh) finds Claude Code installed or moved since the last probe.
    // Running queries keep the executable they started with.
    if (options.refresh) this.dependencies.forgetExecutable()
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
        this.cachedStatus = await this.claudeCodeSetupNeeded(
          'Claude Code is not installed or its version could not be read.',
          null,
          'claude-code-not-installed'
        )
        return this.cachedStatus
      }
      if (!isCompatibleClaudeCodeVersion(cliVersion)) {
        this.cachedStatus = await this.claudeCodeSetupNeeded(
          `Claude Code ${cliVersion} is incompatible. Version ${CLAUDE_CODE_COMPATIBLE_VERSION} or newer in the same major release is required.`,
          cliVersion,
          'claude-code-incompatible'
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
      const missing = (error as NodeJS.ErrnoException)?.code === 'ENOENT'
      const message = missing ? 'Claude Code is not installed.' : claudeSubscriptionErrorMessage(error)
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
        : missing
          ? await this.claudeCodeSetupNeeded(message, null, 'claude-code-not-installed')
          : this.unavailable(message)
      return this.cachedStatus
    }
  }

  async status(options: { refresh?: boolean } = {}): Promise<ClaudeSubscriptionStatus> {
    return this.runProfileOperation(() => this.statusUnlocked(options))
  }

  async login(signal?: AbortSignal, options: { totalTimeoutMs?: number } = {}): Promise<ClaudeSubscriptionLoginResult> {
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
      return await this.runProfileOperation(() =>
        this.loginUnlocked(requestController.signal, options.totalTimeoutMs ?? CLAUDE_LOGIN_TIMEOUT_MS)
      )
    } finally {
      signal?.removeEventListener('abort', abortQueued)
      if (this.loginRequestController === requestController) this.loginRequestController = null
      this.endProfileMutation()
    }
  }

  private async loginUnlocked(signal: AbortSignal, totalTimeoutMs: number): Promise<ClaudeSubscriptionLoginResult> {
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
    // An abandoned sign-in must not hold the profile queue, and with it shutdown, forever.
    const expired = AbortSignal.timeout(totalTimeoutMs)
    this.cachedStatus = null
    try {
      const result = await this.dependencies.runProcess(
        this.dependencies.resolveExecutable(),
        ['auth', 'login', '--claudeai'],
        { env: this.runtimeEnvironment(), signal: AbortSignal.any([controller.signal, expired]) }
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
        error: controller.signal.aborted
          ? 'Claude login was cancelled.'
          : expired.aborted
            ? 'Claude login did not complete.'
            : claudeSubscriptionErrorMessage(error),
      }
    } finally {
      signal?.removeEventListener('abort', abort)
      this.loginController = null
    }
  }

  async startInteractiveLogin(
    options: { urlTimeoutMs?: number; totalTimeoutMs?: number } = {}
  ): Promise<ClaudeInteractiveLogin> {
    if (process.platform === 'win32') throw new Error('Interactive Claude login is not supported on Windows.')
    if (this.loginController || this.loginRequestController) throw new Error('Claude login is already in progress.')
    if (this.disposed) throw new Error('Claude provider has been disposed.')
    this.beginProfileMutation()
    const controller = new AbortController()
    this.loginRequestController = controller
    let ready = false
    let resolveReady!: (login: ClaudeInteractiveLogin) => void
    let rejectReady!: (error: unknown) => void
    const started = new Promise<ClaudeInteractiveLogin>((resolve, reject) => {
      resolveReady = resolve
      rejectReady = reject
    })
    const done = this.runProfileOperation(async (): Promise<ClaudeSubscriptionLoginResult> => {
      let directory: string | undefined
      let child: ClaudeLoginProcess | undefined
      let poll: ReturnType<typeof setInterval> | undefined
      let urlTimer: ReturnType<typeof setTimeout> | undefined
      let totalTimer: ReturnType<typeof setTimeout> | undefined
      let startupError: Error | undefined
      let autoUrl = ''
      let manualUrl = ''
      let output = ''
      let finished = false
      const kill = () => child?.kill()
      const onInputError = () => kill()
      const publish = () => {
        if (ready || finished || !autoUrl || !manualUrl || controller.signal.aborted || startupError) return
        ready = true
        clearTimeout(urlTimer)
        clearInterval(poll)
        resolveReady({
          autoUrl,
          manualUrl,
          done,
          submitCode: (code) => {
            if (!finished && !controller.signal.aborted) child?.stdin.write(`${code.trim()}\n`)
          },
          cancel: () => controller.abort(),
        })
      }
      const onData = (chunk: Buffer | string) => {
        output += chunk.toString()
        const lines = output.split(/\r?\n/)
        output = lines.pop()!.slice(-16_384)
        for (const line of lines) {
          const match = /visit:\s*(https:\/\/\S+)/.exec(line)
          if (match) manualUrl = match[1]
        }
        publish()
      }
      try {
        if (controller.signal.aborted) throw new Error('Claude login was cancelled.')
        this.cachedStatus = null
        this.updateIdentity(null)
        this.abortAllQueries()
        await this.dependencies.removeDirectory(this.configDirectory)
        await this.prepare()
        directory = await mkdtemp(path.join(os.tmpdir(), 'maestrly-claude-login-'))
        const script = path.join(directory, 'browser.sh')
        const urlFile = path.join(directory, 'url')
        await writeFile(script, `#!/bin/sh\nprintf '%s\\n' "$1" >> "$MAESTRLY_LOGIN_URL_FILE"\n`, { mode: 0o700 })
        if (controller.signal.aborted) throw new Error('Claude login was cancelled.')
        this.loginController = controller
        child = this.dependencies.spawnLogin(this.dependencies.resolveExecutable(), ['auth', 'login', '--claudeai'], {
          env: { ...this.runtimeEnvironment(), BROWSER: script, MAESTRLY_LOGIN_URL_FILE: urlFile },
        })
        controller.signal.addEventListener('abort', kill, { once: true })
        child.stdin.on('error', onInputError)
        child.stdout.on('data', onData)
        let reading = false
        poll = setInterval(() => {
          if (reading) return
          reading = true
          void readFile(urlFile, 'utf8')
            .then((contents) => {
              for (const line of contents.split(/\r?\n/)) {
                try {
                  const url = new URL(line)
                  const redirect = new URL(url.searchParams.get('redirect_uri') ?? '')
                  if (
                    url.protocol === 'https:' &&
                    redirect.protocol === 'http:' &&
                    ['localhost', '127.0.0.1', '[::1]'].includes(redirect.hostname) &&
                    redirect.port &&
                    !redirect.username &&
                    !redirect.password &&
                    redirect.pathname === '/callback'
                  ) {
                    autoUrl = line
                    publish()
                    break
                  }
                } catch {
                  /* Ignore incomplete or unrelated capture lines. */
                }
              }
            })
            .catch(() => {})
            .finally(() => {
              reading = false
            })
        }, 100)
        urlTimer = setTimeout(() => {
          startupError = new Error('Claude did not start the sign-in (no URL was printed).')
          kill()
        }, options.urlTimeoutMs ?? 20_000)
        totalTimer = setTimeout(kill, options.totalTimeoutMs ?? CLAUDE_LOGIN_TIMEOUT_MS)
        const exitCode = await child.exited
        finished = true
        clearInterval(poll)
        clearTimeout(urlTimer)
        clearTimeout(totalTimer)
        const status = await this.statusUnlocked({ refresh: true, allowAuthenticationRequired: true })
        if (exitCode === 0 && status.authenticated && !controller.signal.aborted) {
          this.authenticationRequired = false
          return { ok: true, status }
        }
        if (this.authenticationRequired) this.cachedStatus = this.authenticationRequiredStatus()
        return {
          ok: false,
          status: this.cachedStatus ?? status,
          error: controller.signal.aborted ? 'Claude login was cancelled.' : 'Claude login did not complete.',
        }
      } catch (error) {
        startupError = error instanceof Error ? error : new Error(String(error))
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
        finished = true
        clearInterval(poll)
        clearTimeout(urlTimer)
        clearTimeout(totalTimer)
        controller.signal.removeEventListener('abort', kill)
        child?.stdout.removeListener('data', onData)
        if (child) {
          child.kill()
          await child.exited.catch(() => {})
          child.stdin.removeListener('error', onInputError)
        }
        try {
          if (directory) await rm(directory, { recursive: true, force: true })
        } finally {
          this.loginController = null
          this.loginRequestController = null
          this.endProfileMutation()
          if (!ready)
            rejectReady(
              startupError ??
                new Error(controller.signal.aborted ? 'Claude login was cancelled.' : 'Claude login did not complete.')
            )
        }
      }
    })
    void done.catch(rejectReady)
    return started
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
    runtimeOptions: { allowUsageTraffic?: boolean; shellEnvironment?: ConversationProcessEnv } = {}
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
    // The manager is shared by every conversation of the account, so a bot's display, session bus and browser, and
    // the conversation's temporary directory, arrive per query. Only those keys pass; they can never replace
    // credentials, the profile or runtime flags.
    Object.assign(environment, allowedConversationProcessEnv(runtimeOptions.shellEnvironment))
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
    const executable = this.dependencies.retainExecutable() ?? {
      path: this.dependencies.resolveExecutable(),
      release: () => {},
    }
    let created: Query
    try {
      created = this.dependencies.queryFactory({
        prompt: params.prompt,
        options: {
          ...params.options,
          ...(settings !== undefined ? { settings } : {}),
          abortController,
          pathToClaudeCodeExecutable: executable.path,
          env: environment,
          ...(process.platform === 'win32' ? { spawnClaudeCodeProcess: spawnClaudeCodeOnWindows } : {}),
        },
      })
    } catch (error) {
      executable.release()
      throw error
    }
    if (typeof created[Symbol.asyncIterator] === 'function') {
      // Every Claude path (root, subagents, helpers, compaction) reads model output through this query, so the
      // failover circuit learns here, once for all of them, that this account answers again.
      const providerId = withSubscriptionAccount(CLAUDE_SUBSCRIPTION_BASE_PROVIDER_ID, this.accountId)
      const iterate = created[Symbol.asyncIterator].bind(created)
      created[Symbol.asyncIterator] = () =>
        observeClaudeModelOutput(iterate(), () => getSubscriptionFailoverRouter().confirmServing(providerId))
    }
    const originalClose = created.close.bind(created)
    let released = false
    created.close = () => {
      this.activeQueries.delete(created)
      if (!released) {
        released = true
        executable.release()
      }
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
      const promise = this.retryRefreshContention(identity, () => this.probeUsage(identity))
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

  /** Runs a probe again while it fails only because another process of the account is refreshing the OAuth token. */
  private async retryRefreshContention<T>(
    identity: ClaudeSubscriptionAccountIdentity,
    probe: () => Promise<T>
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await probe()
      } catch (error) {
        const delay = isClaudeOAuthRefreshContention(error) ? claudeRefreshContentionRetryDelay(attempt) : null
        if (delay === null || this.disposed) throw error
        await this.dependencies.pause(delay)
        this.assertAccountIdentity(identity)
      }
    }
  }

  private async discoverModels(identity: ClaudeSubscriptionAccountIdentity): Promise<ModelInfo[]> {
    const union = new Map<string, ModelInfo>()
    let failure: unknown
    let contended = false
    for (const seed of CLAUDE_MODEL_PROBE_SEEDS) {
      try {
        const models = await this.retryRefreshContention(identity, () => this.probeSupportedModels(seed, identity))
        for (const model of models) if (!union.has(model.value)) union.set(model.value, model)
      } catch (error) {
        failure ??= error
        if (this.requireAuthentication(error)) throw error
        if (isClaudeOAuthRefreshContention(error)) contended = true
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
    // Caching a list a refresh contention cut short would hide those models; the next request probes again.
    if (!contended) this.cachedModels = models.map((model) => ({ ...model }))
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

  /**
   * The Claude Code binary changed: what the previous one reported (its status, models, efforts and observed context
   * windows) no longer holds. Running queries keep their own binary and are not interrupted.
   */
  runtimeChanged(): void {
    this.cachedStatus = null
    this.invalidateModelCache()
    this.invalidateUsageCache()
    this.observedContextWindows.clear()
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

/** After a Claude Code switch, every account rediscovers its models and the renderer reloads them. */
export function notifyClaudeRuntimeChanged(): void {
  for (const manager of instances.values()) manager.runtimeChanged()
  broadcast('models:catalog-changed')
}

export function resetClaudeSubscriptionManagerForTests(): void {
  for (const manager of instances.values()) manager.dispose()
  instances.clear()
}
