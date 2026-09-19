import { abortCursorAccountRuns } from './account-runs'
import { CursorStoreOwner } from './store-owner'
import {
  CursorSubscriptionAccountChangedError,
  CursorSubscriptionNotAuthenticatedError,
  cursorIdentityFingerprint,
  validateCursorAccountId,
  publicError,
  CursorLoginController,
} from './auth'
export {
  CursorSubscriptionAccountChangedError,
  CursorSubscriptionNotAuthenticatedError,
  cursorIdentityFingerprint,
  validateCursorAccountId,
} from './auth'

import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import type { AgentOptions, LocalAgentStore, SDKAgent, SDKUser, ToolName } from '@cursor/sdk'
import { app } from 'electron'
import {
  CURSOR_SDK_PLATFORM_INTEGRITY,
  isCursorSdkPlatformSupported,
  resolveCursorSdkPlatformTarget,
} from '../cursor-sdk/platform'
import { cursorSdkErrorMessage } from '../cursor-sdk/errors'
import { normalizeCursorModelList, type CursorModelCatalogEntry } from '../cursor-sdk/models'
import { resolveCursorModelAxes } from '../cursor-sdk/models'
import { cursorCustomToolsOnlyPolicy } from '../cursor-sdk/tool-policy'
import {
  createCursorTokenStore,
  cursorTokenKeyFor,
  defaultCursorTokenStore,
  type CursorTokenStorageMode,
  type CursorTokenStore,
} from './token-store'
import { markCursorAgentCleanupFailed, queueCursorAgentCleanup } from './session-store'

export interface CursorSubscriptionPublicError {
  code?: string
  message: string
}

export interface CursorSubscriptionAccountIdentity {
  fingerprint: string | null
  epoch: number
}

export interface CursorSubscriptionStatus {
  state: 'ready' | 'error' | 'disposed'
  available: boolean
  authenticated: boolean
  connected: boolean
  account: { email: string | null; userId: number | null; apiKeyName: string | null } | null
  storageMode: CursorTokenStorageMode
  accountFingerprint: string | null
  accountEpoch: number
  error: CursorSubscriptionPublicError | null
}

export type CursorLoginState = 'pending' | 'succeeded' | 'failed' | 'cancelled'

export interface CursorLoginCompletion {
  loginId: string
  success: boolean
  error: CursorSubscriptionPublicError | null
}

export interface CursorLoginAttempt {
  loginId: string
  loginUrl: string
  state: CursorLoginState
  completion: CursorLoginCompletion | null
}

export interface CursorSubscriptionModelSelection {
  modelId: string

  params: ReadonlyArray<{ id: string; value: string }>
  note: string
}

export type CursorModelSelectionSnapshot = Pick<CursorSubscriptionModelSelection, 'modelId' | 'params'>

export function cursorModelSelectionsEqual(
  left: CursorModelSelectionSnapshot,
  right: CursorModelSelectionSnapshot
): boolean {
  if (left.modelId !== right.modelId || left.params.length !== right.params.length) return false
  return left.params.every((param, index) => {
    const other = right.params[index]
    return other?.id === param.id && other.value === param.value
  })
}

export interface CursorSubscriptionSdk {
  Agent: {
    create(options: AgentOptions): Promise<SDKAgent>
    resume(agentId: string, options?: Partial<AgentOptions>): Promise<SDKAgent>
  }
  Cursor: {
    me(options?: { apiKey?: string }): Promise<SDKUser>
    models: { list(options?: { apiKey?: string }): Promise<unknown> }
    auth: {
      login(options?: unknown): Promise<{ apiKey: string; email?: string; apiKeyExpiresAtMs: number }>
    }
  }
}

export interface CursorAgentLease {
  agent: SDKAgent
  release(): Promise<void> | void
}

export interface CursorSubscriptionManagerDependencies {
  accountId?: string | null
  tokenStore: CursorTokenStore
  getUserDataPath: () => string
  ensureDirectory: (directory: string) => Promise<void>
  removeDirectory: (directory: string) => Promise<void>
  loadSdk: () => Promise<CursorSubscriptionSdk>
  createLoginId: () => string

  openStore?: (options: { stateRoot: string; workspaceRef: string }) => Promise<LocalAgentStore>
}

const CURSOR_STORE_DIRECTORY = 'cursor-subscription'

const DEFAULT_DEPENDENCIES: Omit<CursorSubscriptionManagerDependencies, 'accountId' | 'tokenStore'> = {
  getUserDataPath: () => app.getPath('userData'),
  ensureDirectory: async (directory) => {
    await mkdir(directory, { recursive: true, mode: 0o700 })
  },
  removeDirectory: (directory) => rm(directory, { recursive: true, force: true }),
  loadSdk: async () => (await import('@cursor/sdk')) as unknown as CursorSubscriptionSdk,
  createLoginId: () => randomUUID(),
}

export class CursorSubscriptionManager {
  private readonly dependencies: CursorSubscriptionManagerDependencies
  private readonly authUpdatedListeners = new Set<() => void>()
  private readonly auth: CursorLoginController

  private readonly storeOwner: CursorStoreOwner
  private readonly agentLifetimes = new Map<string, { count: number; waiters: Array<() => void> }>()
  private readonly retiringAgents = new Map<string, Promise<void>>()
  private statusCache: CursorSubscriptionStatus | null = null
  private statusPromise: Promise<CursorSubscriptionStatus> | null = null
  private modelsCache: readonly CursorModelCatalogEntry[] | null = null
  private modelsPromise: Promise<readonly CursorModelCatalogEntry[]> | null = null
  private knownFingerprint: string | null
  private knownEmail: string | null = null
  private knownUserId: number | null = null
  private knownApiKeyName: string | null = null
  private accountEpoch = 0
  private loginGeneration = 0
  private resetPromise: Promise<void> | null = null
  private disposed = false

  constructor(dependencies: Partial<CursorSubscriptionManagerDependencies> = {}) {
    const accountId = dependencies.accountId ?? null
    validateCursorAccountId(accountId)
    const accountDefaults =
      accountId && !dependencies.tokenStore
        ? { tokenStore: createCursorTokenStore(undefined, cursorTokenKeyFor(accountId)) }
        : {}
    this.dependencies = {
      ...DEFAULT_DEPENDENCIES,
      ...accountDefaults,
      ...dependencies,
      accountId,
      tokenStore: dependencies.tokenStore ?? accountDefaults.tokenStore ?? defaultCursorTokenStore,
    }
    this.auth = new CursorLoginController({
      resetPromise: () => this.resetPromise,
      isDisposed: () => this.disposed,
      nextGeneration: () => ++this.loginGeneration,
      generation: () => this.loginGeneration,
      createLoginId: this.dependencies.createLoginId,
      loadSdk: this.dependencies.loadSdk,
      admitApiKey: (key, options) => this.admitApiKeyInternal(key, options),
    })
    this.storeOwner = new CursorStoreOwner({
      stateRoot: () => this.stateRoot,
      isDisposed: () => this.disposed,
      resetPromise: () => this.resetPromise,
      ensureDirectory: this.dependencies.ensureDirectory,
      openStore: this.dependencies.openStore,
    })
    this.knownFingerprint = null
  }

  get isDisposed(): boolean {
    return this.disposed
  }

  get accountId(): string | null {
    return this.dependencies.accountId ?? null
  }

  private get stateRoot(): string {
    const suffix = this.dependencies.accountId ? `-${this.dependencies.accountId}` : ''
    return path.join(this.dependencies.getUserDataPath(), CURSOR_STORE_DIRECTORY + suffix)
  }

  getAccountIdentity(): CursorSubscriptionAccountIdentity {
    return { fingerprint: this.knownFingerprint, epoch: this.accountEpoch }
  }

  assertAccountIdentity(expected: CursorSubscriptionAccountIdentity): void {
    this.expireCachedIdentity()
    const current = this.getAccountIdentity()
    if (current.fingerprint !== expected.fingerprint || current.epoch !== expected.epoch) {
      throw new CursorSubscriptionAccountChangedError()
    }
  }

  private assertLoginGenerationBarrier(expectedLoginGeneration: number): void {
    if (this.disposed || this.loginGeneration !== expectedLoginGeneration) {
      throw new CursorSubscriptionAccountChangedError()
    }
  }

  private assertReadSnapshot(identity: CursorSubscriptionAccountIdentity, loginGeneration: number): void {
    this.assertAccountIdentity(identity)
    this.assertLoginGenerationBarrier(loginGeneration)
  }

  private assertAgentSnapshot(identity: CursorSubscriptionAccountIdentity, loginGeneration: number): void {
    this.assertAccountIdentity(identity)
    if (this.loginGeneration !== loginGeneration) {
      throw new CursorSubscriptionAccountChangedError()
    }
  }

  getStatusSnapshot(): CursorSubscriptionStatus | null {
    this.expireCachedIdentity()
    return this.disposed ? this.disposedStatus() : this.statusCache
  }

  onAuthUpdated(listener: () => void): () => void {
    this.authUpdatedListeners.add(listener)
    return () => {
      this.authUpdatedListeners.delete(listener)
    }
  }

  async getStatus(force = false): Promise<CursorSubscriptionStatus> {
    this.expireCachedIdentity()
    while (true) {
      if (this.disposed) return this.disposedStatus()
      if (!force && this.statusCache) return this.statusCache
      const identity = this.getAccountIdentity()
      const loginGeneration = this.loginGeneration
      const promise =
        this.statusPromise ??
        this.loadStatus(identity, force, loginGeneration).then((status) => {
          this.assertReadSnapshot(identity, loginGeneration)
          return status
        })
      if (!this.statusPromise) this.statusPromise = promise
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
      } catch (error) {
        if (error instanceof CursorSubscriptionAccountChangedError) {
          force = true
          continue
        }
        throw error
      } finally {
        if (this.statusPromise === promise) this.statusPromise = null
      }
    }
  }

  startLogin(): Promise<CursorLoginAttempt> {
    return this.auth.startLogin()
  }

  getLoginAttempt(loginId: string): CursorLoginAttempt | null {
    return this.auth.getLoginAttempt(loginId)
  }

  waitForLogin(loginId: string): Promise<CursorLoginCompletion> {
    return this.auth.waitForLogin(loginId)
  }

  cancelLogin(loginId: string): boolean {
    return this.auth.cancelLogin(loginId)
  }

  cancelPendingLogins(): void {
    this.auth.cancelPendingLogins()
  }

  async admitApiKey(apiKey: string): Promise<CursorSubscriptionStatus> {
    while (this.resetPromise) await this.resetPromise
    if (this.disposed) throw new Error('Cursor subscription manager is disposed')
    const generation = ++this.loginGeneration
    await this.admitApiKeyInternal(apiKey, { expectedLoginGeneration: generation })
    return this.getStatus(true)
  }

  private assertLoginAdmissionBarrier(options: { expectedLoginGeneration?: number; signal?: AbortSignal }): void {
    if (this.disposed) throw new Error('cancelled')
    if (options.signal?.aborted) throw new Error('cancelled')
    if (options.expectedLoginGeneration !== undefined && options.expectedLoginGeneration !== this.loginGeneration) {
      throw new Error('cancelled')
    }
  }

  private async admitApiKeyInternal(
    apiKey: string,
    options: { expectedLoginGeneration?: number; signal?: AbortSignal; apiKeyExpiresAtMs?: number } = {}
  ): Promise<void> {
    const normalized = apiKey.trim()
    if (!normalized) throw new Error('Cursor User API Key is required')
    const sdk = await this.dependencies.loadSdk()
    const me = await sdk.Cursor.me({ apiKey: normalized })

    this.assertLoginAdmissionBarrier(options)
    if (
      options.apiKeyExpiresAtMs !== undefined &&
      (!Number.isFinite(options.apiKeyExpiresAtMs) || options.apiKeyExpiresAtMs <= Date.now())
    ) {
      throw new Error('Cursor credential has expired')
    }
    this.dependencies.tokenStore.set(normalized, options.apiKeyExpiresAtMs)
    await this.changeIdentity(me)
    this.assertLoginAdmissionBarrier(options)
  }

  async logout(): Promise<void> {
    this.loginGeneration += 1
    this.cancelPendingLogins()
    this.auth.cancelAndClear()
    this.dependencies.tokenStore.clear()
    await this.changeIdentity(null)
  }

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

  async listModels(force = false): Promise<readonly CursorModelCatalogEntry[]> {
    this.requireToken()
    if (!force && this.modelsCache) return this.modelsCache
    if (this.modelsPromise) return this.modelsPromise
    const identity = this.getRequiredIdentity()
    const loginGeneration = this.loginGeneration
    const promise = this.withApiKey(async (apiKey) => {
      const sdk = await this.dependencies.loadSdk()
      const raw = await sdk.Cursor.models.list({ apiKey })
      return normalizeCursorModelList(raw)
    }).then((models) => {
      this.assertReadSnapshot(identity, loginGeneration)
      return models
    })
    this.modelsPromise = promise
    try {
      const models = await promise
      this.modelsCache = models
      return models
    } finally {
      if (this.modelsPromise === promise) this.modelsPromise = null
    }
  }

  async resolveModelSelection(
    modelId: string,
    fastMode?: boolean,
    force = false,
    reasoningEffort?: string | null
  ): Promise<CursorSubscriptionModelSelection> {
    const models = await this.listModels(force)
    const resolved = resolveCursorModelAxes(models, { modelId, fastMode, reasoningEffort })
    if (!resolved.ok) throw new Error(resolved.error)
    return {
      modelId: resolved.resolution.selection.id,
      params: resolved.resolution.canonicalParams,
      note: resolved.resolution.note,
    }
  }

  async createAgent(options: Omit<AgentOptions, 'apiKey' | 'tools' | 'disallowedTools'>): Promise<CursorAgentLease> {
    const identity = this.getRequiredIdentity()

    const loginGeneration = this.loginGeneration
    const lease = await this.storeOwner.acquireStoreLease()
    try {
      this.assertAccountIdentity(identity)
      this.assertLoginGenerationBarrier(loginGeneration)
      const apiKey = this.requireToken()
      const agent = await this.dependencies
        .loadSdk()
        .then((sdk) =>
          sdk.Agent.create(
            this.buildLockedOptions({ ...options, apiKey, local: { ...options.local, store: lease.store } })
          )
        )
      try {
        this.assertAgentSnapshot(identity, loginGeneration)
      } catch (error) {
        try {
          agent.close()
        } catch {}
        try {
          await this.deleteAgentFromStore(lease.store, agent.agentId)
        } catch (secondary) {
          const cwd = typeof options.local?.cwd === 'string' ? options.local.cwd : ''
          queueCursorAgentCleanup(null, agent.agentId, cwd, this.accountId)
          markCursorAgentCleanupFailed(agent.agentId, cursorSdkErrorMessage(secondary))
        }
        throw error
      }

      const releaseAgent = this.retainAgentLifetime(agent.agentId)
      return {
        agent,
        release: () => {
          releaseAgent()
          lease.release()
        },
      }
    } catch (error) {
      lease.release()
      throw error
    }
  }

  async resumeAgent(
    agentId: string,
    options: Omit<Partial<AgentOptions>, 'apiKey' | 'tools' | 'disallowedTools'> = {}
  ): Promise<CursorAgentLease> {
    const normalized = agentId.trim()
    if (!normalized) throw new Error('Cursor agent id is required')
    while (this.retiringAgents.has(normalized)) await this.retiringAgents.get(normalized)
    const identity = this.getRequiredIdentity()

    const loginGeneration = this.loginGeneration
    const releaseAgent = this.retainAgentLifetime(normalized)
    const lease = await this.storeOwner.acquireStoreLease().catch((error: unknown) => {
      releaseAgent()
      throw error
    })
    try {
      this.assertAccountIdentity(identity)
      this.assertLoginGenerationBarrier(loginGeneration)
      const apiKey = this.requireToken()
      const agent = await this.dependencies
        .loadSdk()
        .then((sdk) =>
          sdk.Agent.resume(
            normalized,
            this.buildLockedOptions({ ...options, apiKey, local: { ...options.local, store: lease.store } })
          )
        )
      try {
        this.assertAgentSnapshot(identity, loginGeneration)
      } catch (error) {
        try {
          agent.close()
        } catch {}
        throw error
      }
      return {
        agent,
        release: () => {
          releaseAgent()
          lease.release()
        },
      }
    } catch (error) {
      releaseAgent()
      lease.release()
      throw error
    }
  }

  private async deleteAgentFromStore(store: LocalAgentStore, agentId?: string): Promise<void> {
    try {
      await store.agents.delete({ filter: agentId ? { agentIds: [agentId] } : {} })
    } catch (error) {
      // SDK 1.0.31 throws this exact error for an empty match. Retried tombstones
      // and first-use cleanup must remain idempotent; all storage errors propagate.
      if (!(error instanceof Error) || error.message !== 'No agents matched delete filter') throw error
    }
  }

  /** Track an agent separately so retiring it never blocks unrelated subagent work. */
  private retainAgentLifetime(agentId: string): () => void {
    const lifetime = this.agentLifetimes.get(agentId) ?? { count: 0, waiters: [] }
    this.agentLifetimes.set(agentId, lifetime)
    lifetime.count += 1
    let released = false
    return () => {
      if (released) return
      released = true
      lifetime.count -= 1
      if (lifetime.count === 0) {
        this.agentLifetimes.delete(agentId)
        for (const resolve of lifetime.waiters) resolve()
      }
    }
  }

  async deleteAgent(agentId: string): Promise<void> {
    const pending = this.retiringAgents.get(agentId)
    if (pending) return pending
    // Defer the body until the retirement barrier is registered.
    const retirement = Promise.resolve().then(async () => {
      const lifetime = this.agentLifetimes.get(agentId)
      if (lifetime) await new Promise<void>((resolve) => lifetime.waiters.push(resolve))
      await this.storeOwner.withStoreLease((store) => this.deleteAgentFromStore(store, agentId))
    })
    this.retiringAgents.set(agentId, retirement)
    try {
      await retirement
    } finally {
      if (this.retiringAgents.get(agentId) === retirement) this.retiringAgents.delete(agentId)
    }
  }

  async deleteAllManagedAgents(): Promise<void> {
    await this.storeOwner.withExclusiveStoreLease(async (store) => {
      await this.deleteAgentFromStore(store)
      await store.runs.delete({ filter: {} })
    })
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    abortCursorAccountRuns(this)
    const loginPromises = this.auth.cancelAndClear()
    await Promise.allSettled(loginPromises)
    await this.resetPromise?.catch(() => undefined)
    await this.storeOwner.disposeStore()
    this.statusCache = null
    this.modelsCache = null
    this.authUpdatedListeners.clear()
  }

  private buildLockedOptions<T extends AgentOptions>(options: T): T {
    const policy = cursorCustomToolsOnlyPolicy()
    return {
      ...options,
      tools: (policy.tools as ToolName[]) ?? ['mcp'],
      local: { ...options.local, settingSources: [] },
    }
  }

  private async changeIdentity(me: SDKUser | null): Promise<void> {
    abortCursorAccountRuns(this)
    const nextFingerprint = me ? cursorIdentityFingerprint(me) : null
    this.knownEmail = me?.userEmail?.trim() ?? null
    this.knownUserId = typeof me?.userId === 'number' ? me.userId : null
    this.knownApiKeyName = me?.apiKeyName?.trim() ?? null
    if (nextFingerprint !== this.knownFingerprint) {
      this.knownFingerprint = nextFingerprint
      this.accountEpoch += 1
    }
    this.invalidateCaches()
    await this.storeOwner.disposeStore()
    this.notifyAuthUpdated()
  }

  private invalidateCaches(): void {
    this.statusCache = null
    this.statusPromise = null
    this.modelsCache = null
    this.modelsPromise = null
  }

  private notifyAuthUpdated(): void {
    for (const listener of this.authUpdatedListeners) {
      try {
        listener()
      } catch {}
    }
  }

  private async performResetLocalData(): Promise<void> {
    this.loginGeneration += 1
    const loginPromises = this.auth.cancelAndClear()
    this.dependencies.tokenStore.clear()
    await Promise.allSettled(loginPromises)
    await this.changeIdentity(null)
    await this.dependencies.removeDirectory(this.stateRoot)
  }

  private async loadStatus(
    identity: CursorSubscriptionAccountIdentity,
    force: boolean,
    loginGeneration: number
  ): Promise<CursorSubscriptionStatus> {
    const token = this.dependencies.tokenStore.get()?.trim()
    if (!token) {
      this.assertReadSnapshot(identity, loginGeneration)
      return {
        state: 'ready',
        available: isCursorSdkPlatformSupported(),
        authenticated: false,
        connected: false,
        account: null,
        storageMode: this.dependencies.tokenStore.mode(),
        accountFingerprint: null,
        accountEpoch: identity.epoch,
        error: null,
      }
    }
    try {
      if (!this.knownFingerprint || force) {
        const sdk = await this.dependencies.loadSdk()
        const me = await sdk.Cursor.me({ apiKey: token })
        this.assertReadSnapshot(identity, loginGeneration)
        if (cursorIdentityFingerprint(me) !== identity.fingerprint) {
          this.knownFingerprint = cursorIdentityFingerprint(me)
          this.knownEmail = me.userEmail?.trim() ?? null
          this.knownUserId = typeof me.userId === 'number' ? me.userId : null
          this.knownApiKeyName = me.apiKeyName?.trim() ?? null
        }
      }
      this.assertReadSnapshot(identity, loginGeneration)
      return {
        state: 'ready',
        available: true,
        authenticated: true,
        connected: true,
        account: {
          email: this.knownEmail,
          userId: this.knownUserId,
          apiKeyName: this.knownApiKeyName,
        },
        storageMode: this.dependencies.tokenStore.mode(),
        accountFingerprint: this.knownFingerprint,
        accountEpoch: identity.epoch,
        error: null,
      }
    } catch (error) {
      this.assertReadSnapshot(identity, loginGeneration)
      return {
        state: 'error',
        available: true,
        authenticated: false,
        connected: false,
        account: null,
        storageMode: this.dependencies.tokenStore.mode(),
        accountFingerprint: identity.fingerprint,
        accountEpoch: identity.epoch,
        error: publicError(error),
      }
    }
  }

  /** Expiry invalidates cached authentication and in-flight identity snapshots. */
  private expireCachedIdentity(): void {
    if (!this.knownFingerprint || this.dependencies.tokenStore.get()) return
    abortCursorAccountRuns(this)
    this.loginGeneration += 1
    this.accountEpoch += 1
    this.knownFingerprint = null
    this.knownEmail = null
    this.knownUserId = null
    this.knownApiKeyName = null
    this.invalidateCaches()
    // Existing turns retain their store until release; new calls cannot use the key.
    void this.storeOwner.disposeStore().catch(() => undefined)
    this.notifyAuthUpdated()
  }

  private requireToken(): string {
    this.expireCachedIdentity()
    const token = this.dependencies.tokenStore.get()?.trim()
    if (!token) throw new CursorSubscriptionNotAuthenticatedError()
    return token
  }

  private getRequiredIdentity(): CursorSubscriptionAccountIdentity {
    this.requireToken()
    const identity = this.getAccountIdentity()
    if (!identity.fingerprint) throw new CursorSubscriptionNotAuthenticatedError()
    return identity
  }

  private async withApiKey<T>(fn: (apiKey: string) => Promise<T>): Promise<T> {
    const apiKey = this.requireToken()
    return fn(apiKey)
  }

  private disposedStatus(): CursorSubscriptionStatus {
    return {
      state: 'disposed',
      available: false,
      authenticated: false,
      connected: false,
      account: null,
      storageMode: this.dependencies.tokenStore.mode(),
      accountFingerprint: null,
      accountEpoch: this.accountEpoch,
      error: null,
    }
  }
}

const instances = new Map<string, CursorSubscriptionManager>()

export function getCursorSubscriptionManager(accountId: string | null = null): CursorSubscriptionManager {
  validateCursorAccountId(accountId)
  const key = accountId ?? ''
  let manager = instances.get(key)
  if (!manager) {
    manager = new CursorSubscriptionManager({ accountId })
    instances.set(key, manager)
  }
  return manager
}

export function listCursorSubscriptionManagers(): CursorSubscriptionManager[] {
  return [...instances.values()]
}

export async function disposeCursorSubscriptionManagers(): Promise<void> {
  const managers = [...instances.values()]
  instances.clear()
  await Promise.all(managers.map((manager) => manager.dispose()))
}

export const CURSOR_SUBSCRIPTION_PLATFORM = {
  version: Object.keys(CURSOR_SDK_PLATFORM_INTEGRITY).length > 0 ? '1.0.31' : 'unknown',
  target: resolveCursorSdkPlatformTarget(),
  supported: isCursorSdkPlatformSupported(),
}
