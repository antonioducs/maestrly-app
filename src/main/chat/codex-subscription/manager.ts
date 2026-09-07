import { chmod, mkdir, readFile, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { app } from 'electron'
import {
  CodexAppServerAbortError,
  CodexAppServerClient,
  CodexAppServerClosedError,
  CodexAppServerProcessError,
  CodexAppServerProtocolError,
  type CodexAppServerConnectOptions,
  type CodexRequestOptions,
} from './client'
import {
  codexLongContextWindowOverride,
  discardNativeSubagentCatalogOverride,
  ensureNativeSubagentCatalogOverride,
  MODEL_CATALOG_REFRESH_MAX_AGE_MS,
  modelCatalogClientVersion,
  modelCatalogOverrideArgs,
  modelCatalogSnapshot,
  modelCatalogSnapshotAgeMs,
  resetNativeSubagentCatalogOverrideCache,
  waitForModelCatalogSnapshotChange,
  type ModelCatalogSnapshot,
} from './model-catalog-override'
import {
  estimateCodexEffectiveContextWindow,
  normalizeCodexContextWindowPercent,
  normalizeCodexContextWindowTokens,
  type CodexContextWindowObservation,
} from './context-window'
import type {
  CodexAccount,
  CodexAccountLoginCompletedNotification,
  CodexAccountRateLimits,
  CodexAccountRateLimitsReadResponse,
  CodexNotification,
} from './protocol'
import { isMethodNotFoundError, mergeRateLimits, parseCodexRateLimits } from './rate-limits'
import { resolveCodexRuntime, type CodexRuntimeResolution, type CodexRuntimeSource } from './runtime-resolver'
import { acquireRuntimeAssetLease, readyRuntimeAsset } from '../../runtime-assets/app-service'
import type { RuntimeAssetLease } from '../../../shared/runtime-assets'

export interface CodexSubscriptionPublicError {
  code?: string | number
  message: string
}

export type CodexSubscriptionPublicAccount =
  | { type: 'apiKey' }
  | { type: 'chatgpt'; email: string | null; planType: string }
  | { type: 'amazonBedrock'; credentialSource: string | null }
  | { type: 'unknown' }

export interface CodexSubscriptionRuntimeStatus {
  source: CodexRuntimeSource
  platform: NodeJS.Platform
  arch: NodeJS.Architecture
}

export interface CodexSubscriptionStatus {
  state: 'ready' | 'error' | 'disposed'
  available: boolean
  connected: boolean
  authenticated: boolean
  account: CodexSubscriptionPublicAccount | null
  requiresOpenaiAuth: boolean | null
  runtime: CodexSubscriptionRuntimeStatus | null
  error: CodexSubscriptionPublicError | null
}

export interface CodexSubscriptionReasoningEffort {
  reasoningEffort: string
  description: string
}

export interface CodexSubscriptionServiceTier {
  id: string
  name: string
  description: string
}

export interface CodexSubscriptionModel {
  id: string
  model: string
  displayName: string
  description: string
  hidden: boolean
  supportedReasoningEfforts: readonly CodexSubscriptionReasoningEffort[]
  defaultReasoningEffort: string
  inputModalities: readonly string[]
  supportsPersonality: boolean
  serviceTiers: readonly CodexSubscriptionServiceTier[]
  defaultServiceTier: string | null
  legacySpeedTiers: readonly string[]
  /** Effective runtime window (already applies `effective_context_window_percent`), when known. */
  contextWindow: number | null
  /** Active nominal runtime setting, before applying `effectiveContextWindowPercent`. */
  nominalContextWindow: number | null
  /** Largest nominal setting published by the runtime; not itself the active window. */
  maxContextWindow: number | null
  /** Published percentage for converting the nominal setting to the effective window. */
  effectiveContextWindowPercent: number | null
  /** Tri-state runtime capability: null means this catalog version did not publish the field. */
  supportsExperimentalContext: boolean | null
  preferWebsockets: boolean | null
  supportsParallelToolCalls: boolean | null
  toolMode: string | null
  multiAgentVersion: number | null
  useResponsesLite: boolean | null
  supportedVerbosity: readonly string[]
  defaultVerbosity: string | null
  minimumClientVersion: string | null
  isDefault: boolean
}

/** Public `thread/tokenUsage/updated` observation tied to the request's nominal setting. */
export interface CodexSubscriptionContextWindowObservation extends CodexContextWindowObservation {
  maxContextWindow: number | null
  effectiveContextWindowPercent: number | null
}

export type CodexSubscriptionLoginState = 'pending' | 'succeeded' | 'failed'

export interface CodexSubscriptionLoginCompletion {
  loginId: string
  success: boolean
  error: string | null
}

export interface CodexSubscriptionLoginAttempt {
  loginId: string
  authUrl: string | null
  state: CodexSubscriptionLoginState
  completion: CodexSubscriptionLoginCompletion | null
}

export interface CodexSubscriptionLoginWaitOptions {
  signal?: AbortSignal
  timeoutMs?: number
}

export interface CodexSubscriptionManagerDependencies {
  /** Additional account slot; absent/null means the default account. Suffixes app-owned CODEX_HOME. */
  accountId?: string | null
  resolveRuntime: () => CodexRuntimeResolution | Promise<CodexRuntimeResolution>
  acquireRuntimeLease: (runtimePath: string) => Promise<RuntimeAssetLease | null>
  connectClient: (options: CodexAppServerConnectOptions) => Promise<CodexAppServerClient>
  getUserDataPath: () => string
  getAppVersion: () => string
  ensureDirectory: (directory: string) => Promise<void>
  removeDirectory: (directory: string) => Promise<void>
}

interface LoginWaiter {
  resolve: (completion: CodexSubscriptionLoginCompletion) => void
  reject: (error: Error) => void
  cleanup: () => void
}

interface LoginRecord {
  loginId: string
  authUrl: string | null
  completion: CodexSubscriptionLoginCompletion | null
  waiters: Set<LoginWaiter>
}

interface RawModelPage {
  data: unknown
  nextCursor: unknown
}

interface CachedModelContextWindow {
  contextWindow: number | null
  nominalContextWindow: number | null
  maxContextWindow: number | null
  effectiveContextWindowPercent: number | null
}

const DEFAULT_LOGIN_TIMEOUT_MS = 10 * 60_000
const MODEL_PAGE_LIMIT = 100
const MAX_MODEL_PAGES = 100
/**
 * Feature gates resolved at process start. Cover ONLY LEGACY multi-agent (v1): for 5.6 models, remote catalog
 * `multi_agent_version` registers `spawn_agent`/`wait_agent` regardless of these flags or per-thread
 * `features.multi_agent*: false`. Do NOT rely on these as a gate; actual suppression comes from
 * `model_catalog_json` in process argv (see model-catalog-override.ts).
 */
const CODEX_SUBSCRIPTION_APP_SERVER_ARGS = [
  'app-server',
  '--disable',
  'multi_agent',
  '--disable',
  'multi_agent_v2',
] as const
/** This provider is exclusively first-party ChatGPT; host-injected credentials/endpoints are not accepted. */
const CODEX_SUBSCRIPTION_UNSET_ENV = [
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'AZURE_OPENAI_API_KEY',
  'CODEX_API_KEY',
  'CODEX_ACCESS_TOKEN',
  'CODEX_AUTHAPI_BASE_URL',
  'CODEX_REFRESH_TOKEN_URL_OVERRIDE',
  'CODEX_REVOKE_TOKEN_URL_OVERRIDE',
  'CODEX_APP_SERVER_LOGIN_CLIENT_ID',
  'CODEX_APP_SERVER_LOGIN_ISSUER',
  // The provider database must live alongside isolated CODEX_HOME so logout/wipe are complete.
  'CODEX_SQLITE_HOME',
] as const

async function defaultEnsureDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  if (process.platform === 'win32') return
  try {
    await chmod(directory, 0o700)
  } catch {
    // Some mounted filesystems ignore chmod; creation with 0700 remains the primary protection.
  }
}

const DEFAULT_DEPENDENCIES: CodexSubscriptionManagerDependencies = {
  accountId: null,
  resolveRuntime: async () => {
    if (!app.isPackaged) return resolveCodexRuntime()
    const asset = await readyRuntimeAsset('codex-runtime')
    return resolveCodexRuntime({ managedAssetPath: asset.path })
  },
  acquireRuntimeLease: (runtimePath) =>
    app.isPackaged ? acquireRuntimeAssetLease('codex-runtime', runtimePath) : Promise.resolve(null),
  connectClient: (options) => CodexAppServerClient.connect(options),
  getUserDataPath: () => app.getPath('userData'),
  getAppVersion: () => app.getVersion(),
  ensureDirectory: defaultEnsureDirectory,
  removeDirectory: (directory) => rm(directory, { recursive: true, force: true }),
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function redactSecrets(message: string): string {
  return message
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED]')
    .replace(/([?&](?:access_token|refresh_token|id_token|token|code)=)[^&\s]+/gi, '$1[REDACTED]')
}

/**
 * `code=1, signal=null` tells the user nothing. When rejecting configuration, the runtime explains why on stderr
 * and exits before `initialize`; append the last line to expose that reason. The client already bounds the buffer;
 * here we only trim an oversized line.
 */
function processFailureDetail(error: unknown): string {
  if (!(error instanceof CodexAppServerProcessError)) return ''
  const line = error.stderr
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .pop()
  if (!line) return ''
  return `: ${line.length > 400 ? `${line.slice(0, 400)}…` : line}`
}

function publicError(error: unknown): CodexSubscriptionPublicError {
  const record = isRecord(error) ? error : null
  const rawCode = record?.code
  const code = typeof rawCode === 'string' || typeof rawCode === 'number' ? rawCode : undefined
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : 'Codex runtime error'
  return { ...(code !== undefined ? { code } : {}), message: redactSecrets(`${message}${processFailureDetail(error)}`) }
}

function sanitizeAccount(account: CodexAccount | null): CodexSubscriptionPublicAccount | null {
  if (!account) return null
  if (account.type === 'apiKey') return { type: 'apiKey' }
  if (account.type === 'chatgpt') {
    return {
      type: 'chatgpt',
      email: typeof account.email === 'string' ? account.email : null,
      planType: typeof account.planType === 'string' ? account.planType : 'unknown',
    }
  }
  if (account.type === 'amazonBedrock') {
    return {
      type: 'amazonBedrock',
      credentialSource: typeof account.credentialSource === 'string' ? account.credentialSource : null,
    }
  }
  return { type: 'unknown' }
}

function runtimeStatus(runtime: CodexRuntimeResolution | null): CodexSubscriptionRuntimeStatus | null {
  if (!runtime) return null
  return {
    source: runtime.source,
    platform: runtime.target.platform,
    arch: runtime.target.arch,
  }
}

function stringOr(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function stringArray(value: unknown, fallback: readonly string[] = []): readonly string[] {
  if (!Array.isArray(value)) return [...fallback]
  return value.filter((entry): entry is string => typeof entry === 'string')
}

function positiveInteger(value: unknown): number | null {
  return normalizeCodexContextWindowTokens(value)
}

async function regularFileExists(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile()
  } catch {
    return false
  }
}

function maximumPositiveInteger(...values: unknown[]): number | null {
  const normalized = values.map(positiveInteger).filter((value): value is number => value !== null)
  return normalized.length ? Math.max(...normalized) : null
}

function parseReasoningEfforts(value: unknown): readonly CodexSubscriptionReasoningEffort[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.reasoningEffort !== 'string') return []
    return [
      {
        reasoningEffort: entry.reasoningEffort,
        description: stringOr(entry.description),
      },
    ]
  })
}

function parseServiceTiers(value: unknown): readonly CodexSubscriptionServiceTier[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.id !== 'string') return []
    return [
      {
        id: entry.id,
        name: stringOr(entry.name, entry.id),
        description: stringOr(entry.description),
      },
    ]
  })
}

function publishedBoolean(...values: unknown[]): boolean | null {
  const present = values.filter((value) => value !== undefined)
  if (present.length === 0) return null
  if (present.some((value) => typeof value !== 'boolean')) return null
  // Conflicting aliases are malformed metadata and must never enable a capability.
  return present.every((value) => value === true)
}

function publishedString(...values: unknown[]): string | null {
  for (const value of values) {
    if (value === undefined) continue
    return typeof value === 'string' && value.trim() ? value.trim() : null
  }
  return null
}

function parseModel(value: unknown): CodexSubscriptionModel {
  if (!isRecord(value)) throw new CodexAppServerProtocolError('model/list returned a non-object model entry')
  const id = stringOr(value.id, stringOr(value.model))
  if (!id) throw new CodexAppServerProtocolError('model/list returned a model without id/model')

  // `model/list` v2 does not publish these fields yet, but future versions may return the same shape as
  // `models_cache.json`. The legacy camelCase field, if present, already represents the effective runtime window.
  const nominalContextWindow = positiveInteger(value.context_window) ?? positiveInteger(value.nominalContextWindow)
  const maxContextWindow = maximumPositiveInteger(
    value.max_context_window,
    value.maxContextWindow,
    codexLongContextWindowOverride(id)
  )
  const effectiveContextWindowPercent =
    normalizeCodexContextWindowPercent(value.effective_context_window_percent) ??
    normalizeCodexContextWindowPercent(value.effectiveContextWindowPercent)

  return {
    id,
    model: stringOr(value.model, id),
    displayName: stringOr(value.displayName, id),
    description: stringOr(value.description),
    hidden: value.hidden === true,
    supportedReasoningEfforts: parseReasoningEfforts(value.supportedReasoningEfforts),
    defaultReasoningEffort: stringOr(value.defaultReasoningEffort),
    inputModalities: stringArray(value.inputModalities, ['text', 'image']),
    supportsPersonality: value.supportsPersonality === true,
    serviceTiers: parseServiceTiers(value.serviceTiers),
    defaultServiceTier: typeof value.defaultServiceTier === 'string' ? value.defaultServiceTier : null,
    legacySpeedTiers: stringArray(value.additionalSpeedTiers),
    contextWindow:
      positiveInteger(value.contextWindow) ??
      estimateCodexEffectiveContextWindow(nominalContextWindow, effectiveContextWindowPercent),
    nominalContextWindow,
    maxContextWindow,
    effectiveContextWindowPercent,
    supportsExperimentalContext: publishedBoolean(
      value.supportsExperimentalContext,
      value.supports_experimental_context
    ),
    preferWebsockets: publishedBoolean(value.preferWebsockets, value.prefer_websockets),
    supportsParallelToolCalls: publishedBoolean(
      value.supportsParallelToolCalls,
      value.supports_parallel_tool_calls
    ),
    toolMode: publishedString(value.toolMode, value.tool_mode),
    multiAgentVersion:
      positiveInteger(value.multiAgentVersion) ?? positiveInteger(value.multi_agent_version),
    useResponsesLite: publishedBoolean(value.useResponsesLite, value.use_responses_lite),
    supportedVerbosity: stringArray(value.supportedVerbosity ?? value.supported_verbosity),
    defaultVerbosity: publishedString(value.defaultVerbosity, value.default_verbosity),
    minimumClientVersion: publishedString(value.minimumClientVersion, value.minimum_client_version),
    isDefault: value.isDefault === true,
  }
}

function loginSnapshot(record: LoginRecord): CodexSubscriptionLoginAttempt {
  return {
    loginId: record.loginId,
    authUrl: record.authUrl,
    state: record.completion ? (record.completion.success ? 'succeeded' : 'failed') : 'pending',
    completion: record.completion ? { ...record.completion } : null,
  }
}

export class CodexSubscriptionManager {
  private readonly dependencies: CodexSubscriptionManagerDependencies
  private readonly loginRecords = new Map<string, LoginRecord>()
  private readonly accountUpdatedListeners = new Set<() => void>()
  private readonly rateLimitsUpdatedListeners = new Set<(limits: CodexAccountRateLimits) => void>()
  private client: CodexAppServerClient | null = null
  private clientPromise: Promise<CodexAppServerClient> | null = null
  private connectAbort: AbortController | null = null
  private runtime: CodexRuntimeResolution | null = null
  private runtimeLease: RuntimeAssetLease | null = null
  private unsubscribeNotification: (() => void) | null = null
  private statusCache: CodexSubscriptionStatus | null = null
  private statusPromise: Promise<CodexSubscriptionStatus> | null = null
  private modelsCache: readonly CodexSubscriptionModel[] | null = null
  private modelsPromise: Promise<readonly CodexSubscriptionModel[]> | null = null
  private rateLimitsCache: CodexAccountRateLimits | null = null
  private rateLimitsPromise: Promise<CodexAccountRateLimits | null> | null = null
  /** null = unknown for this client generation; false = Method not found (fail-open). */
  private rateLimitsSupported: boolean | null = null
  /** Per model and nominal setting: a 1M turn must never narrow a default turn (or vice versa). */
  private readonly observedModelContextWindows = new Map<
    string,
    Map<number | null, CodexSubscriptionContextWindowObservation>
  >()
  private resetPromise: Promise<void> | null = null
  /** `models_cache.json` snapshot whose override the runtime rejected; keeps retries off the hot path. */
  private rejectedCatalogSnapshot: ModelCatalogSnapshot | null = null
  private lastError: Error | null = null
  private cacheGeneration = 0
  private connectionGeneration = 0
  private disposed = false

  constructor(dependencies: Partial<CodexSubscriptionManagerDependencies> = {}) {
    this.dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencies }
  }

  get isDisposed(): boolean {
    return this.disposed
  }

  get accountId(): string | null {
    return this.dependencies.accountId ?? null
  }

  /** App-owned CODEX_HOME for this ACCOUNT (suffixed for additional slots). */
  get codexHome(): string {
    const suffix = this.dependencies.accountId ? `-${this.dependencies.accountId}` : ''
    return path.join(this.dependencies.getUserDataPath(), 'codex-subscription' + suffix)
  }

  /**
   * Last confirmed status without resolving/spawning the runtime. Startup consumers may use `null` provisionally
   * and call `getStatus()` in the background without blocking other providers.
   */
  getStatusSnapshot(): CodexSubscriptionStatus | null {
    return this.disposed ? this.disposedStatus() : this.statusCache
  }

  /** Report runtime-emitted authentication changes, including those made through another Codex surface. */
  onAccountUpdated(listener: () => void): () => void {
    this.accountUpdatedListeners.add(listener)
    return () => this.accountUpdatedListeners.delete(listener)
  }

  getRateLimitsSnapshot(): CodexAccountRateLimits | null {
    return this.disposed ? null : this.rateLimitsCache
  }

  onRateLimitsUpdated(listener: (limits: CodexAccountRateLimits) => void): () => void {
    this.rateLimitsUpdatedListeners.add(listener)
    return () => this.rateLimitsUpdatedListeners.delete(listener)
  }

  /** Capability may flip to unsupported during an in-flight read (Method not found). */
  private isRateLimitsUnsupported(): boolean {
    return this.rateLimitsSupported === false
  }

  async getRateLimits(force = false): Promise<CodexAccountRateLimits | null> {
    while (true) {
      if (this.disposed) return null
      if (this.isRateLimitsUnsupported()) return null
      if (!force && this.rateLimitsCache) return this.rateLimitsCache

      const generation = this.cacheGeneration
      const promise = this.rateLimitsPromise ?? this.loadRateLimits()
      this.rateLimitsPromise = promise
      try {
        const limits = await promise
        // Re-check via method: TS narrows `this.rateLimitsSupported` across await incorrectly.
        if (this.disposed || this.isRateLimitsUnsupported()) return null
        if (generation !== this.cacheGeneration) continue
        if (limits) this.rateLimitsCache = limits
        return limits
      } finally {
        if (this.rateLimitsPromise === promise) this.rateLimitsPromise = null
      }
    }
  }

  async getClient(): Promise<CodexAppServerClient> {
    // CODEX_HOME removal is a barrier: no caller may observe, retain, or recreate an app-server
    // while the directory still represents pre-wipe state.
    while (this.resetPromise) await this.resetPromise
    if (this.disposed) throw new CodexAppServerClosedError('Codex subscription manager is disposed')
    if (this.client?.state === 'ready') return this.client
    if (this.client) {
      const staleClient = this.client
      this.lastError = staleClient.failure
      this.detachClient(staleClient)
      this.runtime = null
      this.invalidateCaches()
      this.clearLoginRecords(staleClient.failure ?? new CodexAppServerClosedError('Codex app-server disconnected'))
      await staleClient.close().catch(() => undefined)
      this.releaseRuntimeLease()
    }
    if (this.clientPromise) return this.clientPromise

    const generation = ++this.connectionGeneration
    const abort = new AbortController()
    this.connectAbort = abort
    const promise = this.createClient(generation, abort.signal)
    this.clientPromise = promise

    try {
      return await promise
    } finally {
      if (this.clientPromise === promise) this.clientPromise = null
      if (this.connectAbort === abort) this.connectAbort = null
    }
  }

  request<TResult>(method: string, params?: unknown, options?: CodexRequestOptions): Promise<TResult> {
    return this.getClient().then((client) => client.request<TResult>(method, params, options))
  }

  async getStatus(force = false): Promise<CodexSubscriptionStatus> {
    while (true) {
      if (this.disposed) return this.disposedStatus()
      if (!force && this.statusCache) return this.statusCache

      const generation = this.cacheGeneration
      const promise = this.statusPromise ?? this.loadStatus(force)
      this.statusPromise = promise
      try {
        const status = await promise
        if (this.disposed) return this.disposedStatus()
        // `account/updated`, logout, reset and disconnect all invalidate the generation. A response that
        // started before that boundary may describe the previous account/client, so retry against the current one.
        if (generation !== this.cacheGeneration) continue
        this.statusCache = status
        return status
      } finally {
        if (this.statusPromise === promise) this.statusPromise = null
      }
    }
  }

  async startLogin(): Promise<CodexSubscriptionLoginAttempt> {
    const client = await this.getClient()
    const response = await client.startAccountLogin({
      type: 'chatgpt',
      useHostedLoginSuccessPage: true,
      appBrand: 'chatgpt',
    })
    if (response.type !== 'chatgpt') {
      throw new CodexAppServerProtocolError(`Expected ChatGPT login response, received ${response.type}`)
    }

    const record = this.loginRecords.get(response.loginId) ?? {
      loginId: response.loginId,
      authUrl: null,
      completion: null,
      waiters: new Set<LoginWaiter>(),
    }
    record.authUrl = response.authUrl
    this.loginRecords.set(response.loginId, record)
    return loginSnapshot(record)
  }

  getLoginStatus(loginId: string): CodexSubscriptionLoginAttempt | null {
    const record = this.loginRecords.get(loginId)
    return record ? loginSnapshot(record) : null
  }

  waitForLogin(
    loginId: string,
    options: CodexSubscriptionLoginWaitOptions = {}
  ): Promise<CodexSubscriptionLoginCompletion> {
    const record = this.loginRecords.get(loginId)
    if (!record) return Promise.reject(new Error(`Unknown Codex login attempt: ${loginId}`))
    if (record.completion) return Promise.resolve({ ...record.completion })
    if (this.disposed) return Promise.reject(new CodexAppServerClosedError('Codex subscription manager is disposed'))
    if (options.signal?.aborted) {
      return Promise.reject(new CodexAppServerAbortError('Waiting for Codex login was aborted'))
    }

    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined
      const timeoutMs = options.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS
      const waiter: LoginWaiter = {
        resolve,
        reject,
        cleanup: () => {
          if (timer) clearTimeout(timer)
          options.signal?.removeEventListener('abort', onAbort)
          record.waiters.delete(waiter)
        },
      }
      const onAbort = (): void => {
        waiter.cleanup()
        reject(new CodexAppServerAbortError('Waiting for Codex login was aborted'))
      }
      options.signal?.addEventListener('abort', onAbort, { once: true })
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          waiter.cleanup()
          reject(new Error(`Timed out waiting for Codex login ${loginId}`))
        }, timeoutMs)
        timer.unref()
      }
      record.waiters.add(waiter)
    })
  }

  async logout(): Promise<void> {
    const client = await this.getClient()
    await client.logoutAccount()
    this.clearLoginRecords(new CodexAppServerClosedError('Codex account logged out'))
    this.invalidateCaches()
  }

  /** Provider-native hard-delete. The caller decides when to discard the local binding. */
  async deleteThread(threadId: string, options?: CodexRequestOptions): Promise<void> {
    const normalized = threadId.trim()
    if (!normalized) throw new Error('Codex thread id is required')
    const client = await this.getClient()
    await client.deleteThread({ threadId: normalized }, options)
  }

  async listModels(force = false): Promise<readonly CodexSubscriptionModel[]> {
    if (!force && this.modelsCache) return this.modelsCache
    if (this.modelsPromise) return this.modelsPromise

    const generation = this.cacheGeneration
    const promise = this.loadModels()
    this.modelsPromise = promise
    try {
      const models = await promise
      if (!this.disposed && generation === this.cacheGeneration) this.modelsCache = models
      return models
    } finally {
      if (this.modelsPromise === promise) this.modelsPromise = null
    }
  }

  async preferredServiceTier(modelId: string, force = false): Promise<string | null> {
    const model = (await this.listModels(force)).find((entry) => entry.id === modelId || entry.model === modelId)
    if (!model) return null

    const priority = model.serviceTiers.find((tier) => tier.id.toLowerCase() === 'priority')
    if (priority) return priority.id
    const fast = model.serviceTiers.find(
      (tier) => tier.id.toLowerCase() === 'fast' || tier.name.toLowerCase() === 'fast'
    )
    if (fast) return fast.id
    if (model.defaultServiceTier && /^(priority|fast)$/i.test(model.defaultServiceTier)) {
      return model.defaultServiceTier
    }
    const legacyFast = model.legacySpeedTiers.find((tier) => /^(priority|fast)$/i.test(tier))
    return legacyFast ?? null
  }

  /**
   * Learn the effective window through the public `thread/tokenUsage/updated` contract. The notification is
   * authoritative over the internal catalog cache. Nominal configuration is optional for legacy callers; when
   * supplied, the observation is usable only for the same request setting.
   */
  observeModelContextWindow(modelId: string, value: number, requestedNominal?: number | null): void {
    const contextWindow = positiveInteger(value)
    const normalizedModelId = modelId.trim()
    if (!contextWindow || !normalizedModelId) return

    const matched = this.findCachedModel(normalizedModelId)
    const configuredNominal = positiveInteger(matched?.nominalContextWindow)
    let observedRequestedNominal: number | null
    if (requestedNominal === undefined) {
      // The two-argument contract represents the known active setting, not a generic observation
      // that could leak from one long request into another.
      observedRequestedNominal = configuredNominal
    } else if (requestedNominal === null) {
      observedRequestedNominal = null
    } else {
      observedRequestedNominal = positiveInteger(requestedNominal)
      if (!observedRequestedNominal) return
    }

    const keys = [...new Set([normalizedModelId, matched?.id, matched?.model].filter(Boolean))]
    const previous = this.findObservedModelContextWindow(keys, observedRequestedNominal)
    const observation: CodexSubscriptionContextWindowObservation = {
      contextWindow,
      requestedNominal: observedRequestedNominal,
      maxContextWindow: matched?.maxContextWindow ?? previous?.maxContextWindow ?? null,
      effectiveContextWindowPercent:
        matched?.effectiveContextWindowPercent ?? previous?.effectiveContextWindowPercent ?? null,
    }
    this.rememberObservedModelContextWindow(keys, observation)

    // Catalog `contextWindow` remains the ACTIVE setting. A 1M observation is available through the getter below
    // but must not replace the default 272k snapshot and narrow future requests.
    const appliesToActiveConfiguration =
      observedRequestedNominal === null || observedRequestedNominal === configuredNominal
    if (matched && this.modelsCache) {
      this.modelsCache = this.modelsCache.map((model) =>
        model === matched
          ? {
              ...model,
              maxContextWindow: model.maxContextWindow ?? observation.maxContextWindow,
              effectiveContextWindowPercent:
                model.effectiveContextWindowPercent ?? observation.effectiveContextWindowPercent,
              ...(appliesToActiveConfiguration ? { contextWindow } : {}),
            }
          : model
      )
    }
  }

  /**
   * Return a copy of the observation matching the same nominal setting. Without the second argument, query only
   * the catalog's active setting (or the legacy call without a setting), never an arbitrary value from another
   * request.
   */
  getObservedModelContextWindowObservation(
    modelId: string,
    requestedNominal?: number | null
  ): CodexSubscriptionContextWindowObservation | undefined {
    const normalizedModelId = modelId.trim()
    if (!normalizedModelId) return undefined

    const matched = this.findCachedModel(normalizedModelId)
    let normalizedRequestedNominal: number | null
    if (requestedNominal === undefined) {
      normalizedRequestedNominal = positiveInteger(matched?.nominalContextWindow)
    } else if (requestedNominal === null) {
      normalizedRequestedNominal = null
    } else {
      normalizedRequestedNominal = positiveInteger(requestedNominal)
      if (!normalizedRequestedNominal) return undefined
    }

    const observation =
      this.findObservedModelContextWindow(
        [normalizedModelId, matched?.id, matched?.model],
        normalizedRequestedNominal
      ) ??
      // A legacy two-argument call made before the catalog existed still represents the active setting;
      // query it only when the caller also omitted an explicit setting.
      (requestedNominal === undefined && normalizedRequestedNominal !== null
        ? this.findObservedModelContextWindow([normalizedModelId, matched?.id, matched?.model], null)
        : undefined)
    return observation ? { ...observation } : undefined
  }

  /** Numeric shortcut for existing consumers; use `getObservedModelContextWindowObservation` for metadata. */
  getObservedModelContextWindow(modelId: string, requestedNominal?: number | null): number | undefined {
    return this.getObservedModelContextWindowObservation(modelId, requestedNominal)?.contextWindow
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.connectionGeneration += 1
    this.connectAbort?.abort(new CodexAppServerClosedError('Codex subscription manager is disposed'))
    this.connectAbort = null
    this.invalidateCaches()
    this.clearLoginRecords(new CodexAppServerClosedError('Codex subscription manager is disposed'))

    const active = this.client
    this.detachClient(active)
    const connecting = this.clientPromise
    this.clientPromise = null
    if (connecting) await connecting.catch(() => undefined)
    try {
      await active?.close()
    } finally {
      this.releaseRuntimeLease()
    }
    this.runtime = null
    this.lastError = null
    this.accountUpdatedListeners.clear()
    this.rateLimitsUpdatedListeners.clear()
    this.rateLimitsSupported = null
  }

  /**
   * Stop the process and remove app-owned CODEX_HOME, keeping the manager reusable. Used only for explicit local
   * wipe; a future login starts another app-server and recreates the tree with 0700 permissions.
   */
  resetLocalData(): Promise<void> {
    if (this.disposed) return Promise.resolve()
    if (this.resetPromise) return this.resetPromise

    // Publish the barrier synchronously before starting reset. Besides blocking new clients,
    // this lets us invalidate the caches below before the operation's first await.
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

  private async performResetLocalData(): Promise<void> {
    this.connectionGeneration += 1
    const resetError = new CodexAppServerClosedError('Codex local data is being reset')
    this.connectAbort?.abort(resetError)
    this.connectAbort = null
    this.invalidateCaches()
    this.clearLoginRecords(resetError)

    const active = this.client
    this.detachClient(active)
    const connecting = this.clientPromise
    this.clientPromise = null
    if (connecting) await connecting.catch(() => undefined)
    try {
      await active?.close()
    } finally {
      this.releaseRuntimeLease()
    }
    this.runtime = null
    this.lastError = null
    this.rejectedCatalogSnapshot = null
    const codexHome = this.codexHome
    resetNativeSubagentCatalogOverrideCache(codexHome)
    await this.dependencies.removeDirectory(codexHome)
  }

  /**
   * Start an ephemeral app-server WITHOUT the override so boot refetches the remote catalog and rewrites
   * `models_cache.json`. The override prevents that refresh; without this window, the catalog and user-visible
   * model list would freeze at the current snapshot. Best effort: any failure retains the previous snapshot.
   */
  private async refreshModelCatalogSnapshot(
    runtime: CodexRuntimeResolution,
    codexHome: string,
    signal: AbortSignal
  ): Promise<void> {
    let client: CodexAppServerClient | null = null
    try {
      const previousSnapshot = await modelCatalogSnapshot(codexHome)
      client = await this.dependencies.connectClient({
        binaryPath: runtime.executablePath,
        binaryArgs: CODEX_SUBSCRIPTION_APP_SERVER_ARGS,
        clientInfo: { name: 'maestrly', title: 'Maestrly', version: this.dependencies.getAppVersion() },
        capabilities: { experimentalApi: true },
        env: { CODEX_HOME: codexHome },
        unsetEnv: CODEX_SUBSCRIPTION_UNSET_ENV,
        unsetEnvPrefixes: ['CODEX_', 'OPENAI_', 'AZURE_OPENAI_'],
        signal,
      })
      // Boot itself triggers refresh; `model/list` only ensures the runtime served a request
      // before we close the window.
      await client.request<RawModelPage>('model/list', { limit: MODEL_PAGE_LIMIT }, { signal })
      await waitForModelCatalogSnapshotChange(codexHome, previousSnapshot, { signal })
    } catch {
      // Offline/expired token/busy binary: continue with the existing snapshot.
    } finally {
      await client?.close({ gracePeriodMs: 1_000 }).catch(() => undefined)
    }
  }

  /**
   * Restore the neutralized catalog to argv only when `models_cache.json` changes: retrying THIS rejected snapshot
   * would waste a failed spawn on every reconnection. A new cache (remote refresh, wipe, app update) warrants
   * another attempt.
   */
  private async catalogOverrideIsBlocked(codexHome: string): Promise<boolean> {
    const rejected = this.rejectedCatalogSnapshot
    if (!rejected) return false
    const current = await modelCatalogSnapshot(codexHome)
    if (current && current.mtimeMs === rejected.mtimeMs && current.size === rejected.size) return true
    this.rejectedCatalogSnapshot = null
    return false
  }

  /**
   * `model_catalog_json` is an OPTIONAL enhancement (suppresses native multi-agent) but is PROCESS configuration:
   * if the runtime cannot parse the file, it exits with code 1 before `initialize`, taking the subscription
   * entirely offline. Preserving the provider is more important than suppression: retry rejection without the
   * argument and remove the override from disk.
   */
  private async connectAppServer(
    runtime: CodexRuntimeResolution,
    codexHome: string,
    overridePath: string | null,
    signal: AbortSignal
  ): Promise<CodexAppServerClient> {
    const connect = (catalogArgs: readonly string[]): Promise<CodexAppServerClient> =>
      this.dependencies.connectClient({
        binaryPath: runtime.executablePath,
        binaryArgs: [...CODEX_SUBSCRIPTION_APP_SERVER_ARGS, ...catalogArgs],
        clientInfo: {
          name: 'maestrly',
          title: 'Maestrly',
          version: this.dependencies.getAppVersion(),
        },
        capabilities: { experimentalApi: true },
        env: { CODEX_HOME: codexHome },
        unsetEnv: CODEX_SUBSCRIPTION_UNSET_ENV,
        // First-party provider: no inherited key, base URL, or development config may redirect the runtime.
        // The client applies app-owned CODEX_HOME above only after this cleanup.
        unsetEnvPrefixes: ['CODEX_', 'OPENAI_', 'AZURE_OPENAI_'],
        signal,
      })

    if (!overridePath) return connect([])

    try {
      return await connect(modelCatalogOverrideArgs(overridePath))
    } catch (error) {
      // Abort/supersede does not judge catalog validity: a second spawn would be stopped too.
      if (signal.aborted || error instanceof CodexAppServerAbortError || this.disposed) throw error
      this.rejectedCatalogSnapshot = await modelCatalogSnapshot(codexHome)
      await discardNativeSubagentCatalogOverride(codexHome)
      console.warn(
        '[codex-subscription] app-server rejected the neutralized catalog ' +
          `(${error instanceof Error ? error.message : String(error)}); ` +
          'reconnecting without it — native Codex multi-agent becomes available again in this session.'
      )
      return connect([])
    }
  }

  private async createClient(generation: number, signal: AbortSignal): Promise<CodexAppServerClient> {
    let runtimeLease: RuntimeAssetLease | null = null
    let client: CodexAppServerClient | null = null
    try {
      const runtime = await this.dependencies.resolveRuntime()
      runtimeLease = await this.dependencies.acquireRuntimeLease(runtime.executablePath)
      this.runtime = runtime
      const codexHome = this.codexHome
      await this.dependencies.ensureDirectory(codexHome)
      // CODEX_HOME is app-owned: auth.json must survive, but config.toml need not. Remove it on every spawn
      // to clear native trust/MCP/config left by older versions without disconnecting the ChatGPT subscription.
      await rm(path.join(codexHome, 'config.toml'), { force: true })
      // Fetch a snapshot BEFORE enabling the override if expired, written by another runtime, or missing for an
      // authenticated account. An authenticated cold start without the catalog would limit the thread to the
      // remote ceiling; reusing the old cache's first response after an upgrade would hide models released only
      // to the new client. A short connection downloads the snapshot; the final connection starts with overrides.
      // Unauthenticated installations proceed directly to allow login. Never runs in parallel.
      const snapshotAge = await modelCatalogSnapshotAgeMs(codexHome)
      const snapshotClientVersion = snapshotAge === null ? null : await modelCatalogClientVersion(codexHome)
      const shouldPrimeAuthenticatedColdStart =
        snapshotAge === null && (await regularFileExists(path.join(codexHome, 'auth.json')))
      const shouldRefreshAfterRuntimeUpgrade =
        snapshotAge !== null &&
        runtime.version !== null &&
        snapshotClientVersion !== null &&
        snapshotClientVersion !== runtime.version
      if (
        shouldPrimeAuthenticatedColdStart ||
        shouldRefreshAfterRuntimeUpgrade ||
        (snapshotAge !== null && snapshotAge > MODEL_CATALOG_REFRESH_MAX_AGE_MS)
      ) {
        await this.refreshModelCatalogSnapshot(runtime, codexHome, signal)
        resetNativeSubagentCatalogOverrideCache(codexHome)
      }
      const overridePath = (await this.catalogOverrideIsBlocked(codexHome))
        ? null
        : await ensureNativeSubagentCatalogOverride(codexHome, {}, { runtimeVersion: runtime.version })
      client = await this.connectAppServer(runtime, codexHome, overridePath, signal)

      if (this.disposed || generation !== this.connectionGeneration) {
        await client.close()
        throw new CodexAppServerClosedError('Codex subscription connection was superseded')
      }

      const unsubscribeNotification = client.onNotification((notification) => this.handleNotification(notification))
      const exited = client.waitForExit()
      this.client = client
      this.runtimeLease = runtimeLease
      runtimeLease = null
      this.lastError = null
      this.rateLimitsSupported = null
      this.unsubscribeNotification = unsubscribeNotification
      void exited.then((exit) => this.handleClientExit(client!, exit))
      return client
    } catch (error) {
      if (client && this.client !== client) await client.close().catch(() => undefined)
      runtimeLease?.release()
      this.lastError = error instanceof Error ? error : new Error(String(error))
      throw error
    }
  }

  private async loadRateLimits(): Promise<CodexAccountRateLimits | null> {
    try {
      const client = await this.getClient()
      const response = await client.request<CodexAccountRateLimitsReadResponse>('account/rateLimits/read', {})
      const parsed = parseCodexRateLimits(response)
      if (parsed) this.rateLimitsSupported = true
      return parsed
    } catch (error) {
      if (isMethodNotFoundError(error)) {
        this.rateLimitsSupported = false
        return null
      }
      // Fail-open: transient RPC/transport errors must not block chat; callers can retry later.
      return null
    }
  }

  private async loadStatus(refreshToken: boolean): Promise<CodexSubscriptionStatus> {
    try {
      const client = await this.getClient()
      const response = await client.readAccount({ refreshToken })
      this.lastError = null
      return {
        state: 'ready',
        available: true,
        connected: true,
        // This provider represents ONLY the ChatGPT subscription. CODEX_HOME contaminated by
        // OPENAI_API_KEY/Bedrock remains visible in `account` but never opens the subscription gate.
        authenticated: response.account?.type === 'chatgpt',
        account: sanitizeAccount(response.account),
        requiresOpenaiAuth: response.requiresOpenaiAuth,
        runtime: runtimeStatus(this.runtime),
        error: null,
      }
    } catch (error) {
      this.lastError = error instanceof Error ? error : new Error(String(error))
      return {
        state: 'error',
        available: this.runtime !== null,
        connected: this.client?.state === 'ready',
        authenticated: false,
        account: null,
        requiresOpenaiAuth: null,
        runtime: runtimeStatus(this.runtime),
        error: publicError(this.lastError),
      }
    }
  }

  private async loadModels(): Promise<readonly CodexSubscriptionModel[]> {
    const client = await this.getClient()
    const models: CodexSubscriptionModel[] = []
    const seenCursors = new Set<string>()
    let cursor: string | null = null

    for (let pageIndex = 0; pageIndex < MAX_MODEL_PAGES; pageIndex += 1) {
      const page: RawModelPage = await client.request<RawModelPage>('model/list', {
        cursor,
        limit: MODEL_PAGE_LIMIT,
        includeHidden: false,
      })
      if (!Array.isArray(page.data)) throw new CodexAppServerProtocolError('model/list returned invalid data')
      models.push(...page.data.map(parseModel))

      if (page.nextCursor === null || page.nextCursor === undefined) return this.enrichModelContextWindows(models)
      if (typeof page.nextCursor !== 'string' || !page.nextCursor) {
        throw new CodexAppServerProtocolError('model/list returned an invalid nextCursor')
      }
      if (seenCursors.has(page.nextCursor)) {
        throw new CodexAppServerProtocolError(`model/list repeated cursor ${page.nextCursor}`)
      }
      seenCursors.add(page.nextCursor)
      cursor = page.nextCursor
    }

    throw new CodexAppServerProtocolError(`model/list exceeded ${MAX_MODEL_PAGES} pages`)
  }

  private findCachedModel(modelId: string): CodexSubscriptionModel | undefined {
    return this.modelsCache?.find((model) => model.id === modelId || model.model === modelId)
  }

  private findObservedModelContextWindow(
    modelIds: readonly (string | null | undefined)[],
    requestedNominal: number | null
  ): CodexSubscriptionContextWindowObservation | undefined {
    for (const modelId of modelIds) {
      const normalizedModelId = modelId?.trim()
      if (!normalizedModelId) continue
      const observation = this.observedModelContextWindows.get(normalizedModelId)?.get(requestedNominal)
      if (observation) return observation
    }
    return undefined
  }

  private rememberObservedModelContextWindow(
    modelIds: readonly (string | null | undefined)[],
    observation: CodexSubscriptionContextWindowObservation
  ): void {
    for (const modelId of modelIds) {
      const normalizedModelId = modelId?.trim()
      if (!normalizedModelId) continue
      const byRequest = this.observedModelContextWindows.get(normalizedModelId) ?? new Map()
      byRequest.set(observation.requestedNominal, { ...observation })
      this.observedModelContextWindows.set(normalizedModelId, byRequest)
    }
  }

  /**
   * `model/list` may still omit limits. The runtime stores the remote catalog in app-owned CODEX_HOME with
   * `context_window`, `max_context_window`, and `effective_context_window_percent`; read all three by slug,
   * failing open. Public observations replace only the corresponding nominal setting.
   */
  private async enrichModelContextWindows(
    models: readonly CodexSubscriptionModel[]
  ): Promise<readonly CodexSubscriptionModel[]> {
    const cached = new Map<string, CachedModelContextWindow>()
    try {
      const file = path.join(this.codexHome, 'models_cache.json')
      const parsed: unknown = JSON.parse(await readFile(file, 'utf8'))
      const entries = isRecord(parsed) && Array.isArray(parsed.models) ? parsed.models : []
      for (const entry of entries) {
        if (!isRecord(entry) || typeof entry.slug !== 'string' || !entry.slug) continue
        const nominalContextWindow = positiveInteger(entry.context_window)
        const maxContextWindow = positiveInteger(entry.max_context_window)
        const effectiveContextWindowPercent = normalizeCodexContextWindowPercent(entry.effective_context_window_percent)
        if (!nominalContextWindow && !maxContextWindow && effectiveContextWindowPercent === null) continue
        cached.set(entry.slug, {
          contextWindow: estimateCodexEffectiveContextWindow(nominalContextWindow, effectiveContextWindowPercent),
          nominalContextWindow,
          maxContextWindow,
          effectiveContextWindowPercent,
        })
      }
    } catch {
      // Missing/old/corrupt cache does not block login or model/list; learn the value during the turn.
    }

    return models.map((model) => {
      const cachedWindow = cached.get(model.id) ?? cached.get(model.model)
      const nominalContextWindow = cachedWindow?.nominalContextWindow ?? model.nominalContextWindow
      const observation =
        this.findObservedModelContextWindow([model.id, model.model], nominalContextWindow) ??
        this.findObservedModelContextWindow([model.id, model.model], null)
      return {
        ...model,
        nominalContextWindow,
        maxContextWindow: maximumPositiveInteger(
          cachedWindow?.maxContextWindow,
          model.maxContextWindow,
          observation?.maxContextWindow,
          codexLongContextWindowOverride(model.id),
          codexLongContextWindowOverride(model.model)
        ),
        effectiveContextWindowPercent:
          cachedWindow?.effectiveContextWindowPercent ??
          model.effectiveContextWindowPercent ??
          observation?.effectiveContextWindowPercent ??
          null,
        contextWindow: observation?.contextWindow ?? cachedWindow?.contextWindow ?? model.contextWindow,
      }
    })
  }

  private handleNotification(notification: CodexNotification): void {
    if (notification.method === 'account/login/completed') {
      this.handleLoginCompleted(notification.params)
      return
    }
    if (notification.method === 'account/rateLimits/updated') {
      const parsed = parseCodexRateLimits(notification.params)
      if (!parsed) return
      const merged = this.rateLimitsCache ? mergeRateLimits(this.rateLimitsCache, parsed) : parsed
      this.rateLimitsCache = merged
      this.rateLimitsSupported = true
      for (const listener of this.rateLimitsUpdatedListeners) {
        try {
          listener(merged)
        } catch {
          // Observers must not break app-server transport.
        }
      }
      return
    }
    if (notification.method === 'account/updated') {
      this.invalidateCaches()
      for (const listener of this.accountUpdatedListeners) {
        try {
          listener()
        } catch {
          // Observers must not break app-server transport.
        }
      }
    }
  }

  private handleLoginCompleted(value: unknown): void {
    if (!isRecord(value)) return
    const params = value as unknown as CodexAccountLoginCompletedNotification
    if (typeof params.loginId !== 'string' || typeof params.success !== 'boolean') return
    const record = this.loginRecords.get(params.loginId) ?? {
      loginId: params.loginId,
      authUrl: null,
      completion: null,
      waiters: new Set<LoginWaiter>(),
    }
    const completion: CodexSubscriptionLoginCompletion = {
      loginId: params.loginId,
      success: params.success,
      error: typeof params.error === 'string' ? redactSecrets(params.error) : null,
    }
    record.completion = completion
    this.loginRecords.set(params.loginId, record)
    for (const waiter of [...record.waiters]) {
      waiter.cleanup()
      waiter.resolve({ ...completion })
    }
    this.invalidateCaches()
  }

  private handleClientExit(
    client: CodexAppServerClient,
    exit: { code: number | null; signal: NodeJS.Signals | null }
  ): void {
    if (this.client !== client) return
    let disconnectError: Error = new CodexAppServerClosedError('Codex app-server disconnected')
    if (!this.disposed) {
      disconnectError =
        client.failure ??
        new CodexAppServerProcessError(
          `Codex app-server exited unexpectedly (code=${String(exit.code)}, signal=${String(exit.signal)})`,
          exit,
          client.stderr
        )
      this.lastError = disconnectError
    }
    this.detachClient(client)
    this.releaseRuntimeLease()
    this.runtime = null
    this.invalidateCaches()
    this.clearLoginRecords(disconnectError)
  }

  private detachClient(client: CodexAppServerClient | null): void {
    if (!client || this.client !== client) return
    this.unsubscribeNotification?.()
    this.unsubscribeNotification = null
    this.client = null
    // Capability is per client generation; unknown again until the next connection proves support.
    this.rateLimitsSupported = null
  }

  private releaseRuntimeLease(): void {
    const lease = this.runtimeLease
    this.runtimeLease = null
    lease?.release()
  }

  private invalidateCaches(): void {
    this.cacheGeneration += 1
    this.statusCache = null
    this.statusPromise = null
    this.modelsCache = null
    this.modelsPromise = null
    this.rateLimitsCache = null
    this.rateLimitsPromise = null
    this.observedModelContextWindows.clear()
  }

  private clearLoginRecords(error: Error): void {
    for (const record of this.loginRecords.values()) {
      for (const waiter of [...record.waiters]) {
        waiter.cleanup()
        waiter.reject(error)
      }
    }
    this.loginRecords.clear()
  }

  private disposedStatus(): CodexSubscriptionStatus {
    return {
      state: 'disposed',
      available: false,
      connected: false,
      authenticated: false,
      account: null,
      requiresOpenaiAuth: null,
      runtime: null,
      error: null,
    }
  }
}

const instances = new Map<string, CodexSubscriptionManager>()

/** accountId becomes the on-disk CODEX_HOME suffix; any separator/`..` would allow path traversal during wipe. */
const FILESYSTEM_SAFE_ACCOUNT_ID = /^[A-Za-z0-9_-]+$/

/** Per-account registry: null/absent `accountId` means the default account (legacy behavior). Lazy instances. */
export function getCodexSubscriptionManager(accountId: string | null = null): CodexSubscriptionManager {
  if (accountId && !FILESYSTEM_SAFE_ACCOUNT_ID.test(accountId)) {
    throw new Error(`Invalid Codex subscription account id: ${accountId}`)
  }
  const key = accountId ?? ''
  let manager = instances.get(key)
  if (!manager) {
    manager = new CodexSubscriptionManager({ accountId })
    instances.set(key, manager)
  }
  return manager
}

/** All instances created in this process (global dispose / wipe). */
export function listCodexSubscriptionManagers(): CodexSubscriptionManager[] {
  return [...instances.values()]
}
