/**
 * Per-account owner of Google's Antigravity ACP server process.
 *
 * Every account gets an isolated home (`HOME`/`GEMINI_HOME` under userData) with the OAuth token kept in a file, so
 * accounts never share credentials, conversations, or the user's own `~/.gemini`. One shared process serves all
 * chat sessions of an account; sign-in uses a dedicated process because `authenticate` blocks until the browser
 * flow finishes.
 */
import { mkdir, rm, chmod } from 'node:fs/promises'
import path from 'node:path'
import { app } from 'electron'
import type { ChatSubscriptionAuthStatus, ChatSubscriptionLoginResult } from '../../../shared/chat'
import { AcpClient, AcpRpcError } from '../acp/client'
import {
  ACP_AUTH_REQUIRED_CODE,
  type AcpSessionNotification,
  type AcpSessionSetupResult,
  type AcpSessionUpdate,
} from '../acp/protocol'
import {
  AntigravityAccountChangedError,
  AntigravityAuthRequiredError,
  antigravityErrorMessage,
  isAntigravityAuthRequired,
} from './errors'
import type { AntigravityHostToolset } from './host-mcp'
import { type AntigravityModelEntry, parseAntigravityModelOptions } from './models'
import {
  antigravityAccountRoot,
  antigravityAccountsRoot,
  antigravityAcpHome,
  antigravityFingerprint,
  antigravityWorkDir,
  buildAntigravityProcessEnv,
  isStrictlyInside,
  readAntigravityProjectId,
} from './paths'
import { decideAntigravityPermission } from './permissions'
import { type AntigravityRuntimeCommand, resolveAntigravityRuntime } from './runtime'

/** Every ACP session disables all built-in Antigravity tools; Maestrly's tools arrive over MCP. */
export const ANTIGRAVITY_SESSION_META = Object.freeze({ agy: Object.freeze({ enabledTools: Object.freeze([]) }) })

const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DEFAULT_IDLE_CLOSE_MS = 10 * 60_000
const MODEL_CACHE_MS = 10 * 60_000
const CLIENT_INFO = { name: 'maestrly', version: app.getVersion?.() || '0.0.0' }

export interface AntigravityAccountIdentity {
  fingerprint: string | null
  epoch: number
}

export interface AntigravityConnection {
  readonly client: AcpClient
  readonly generation: number
  subscribe(sessionId: string, listener: (update: AcpSessionUpdate) => void): () => void
}

export interface AntigravityLiveSession {
  sessionId: string
  generation: number
  toolset: AntigravityHostToolset
  toolSignature: string
  instructionHash: string
  modelValue: string | null
}

export interface AntigravityManagerOptions {
  accountId: string | null
  userDataPath?: () => string
  resolveRuntime?: () => Promise<AntigravityRuntimeCommand>
  processEnv?: (root: string) => NodeJS.ProcessEnv
  idleCloseMs?: number
}

interface ConnectionState {
  readonly client: AcpClient
  readonly generation: number
  readonly runtime: AntigravityRuntimeCommand
  readonly subscribers: Map<string, Set<(update: AcpSessionUpdate) => void>>
  readonly handle: AntigravityConnection
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

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })
}

function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(abortError(signal))
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError(signal))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      }
    )
  })
}

export class AntigravitySubscriptionManager {
  readonly accountId: string | null
  readonly root: string
  private readonly userData: string
  private readonly resolveRuntime: () => Promise<AntigravityRuntimeCommand>
  private readonly processEnv: (root: string) => NodeJS.ProcessEnv
  private readonly idleCloseMs: number
  private readonly authListeners = new Set<() => void>()
  private readonly liveSessions = new Map<string, AntigravityLiveSession>()
  private projectId: string | null | undefined
  private authenticationRequired = false
  private epoch = 0
  private generation = 0
  private conn: ConnectionState | null = null
  private connecting: Promise<ConnectionState> | null = null
  private loginController: AbortController | null = null
  private uses = 0
  private idleTimer: NodeJS.Timeout | null = null
  private models: { at: number; epoch: number; entries: readonly AntigravityModelEntry[] } | null = null
  private disposed = false

  constructor(options: AntigravityManagerOptions) {
    this.accountId = options.accountId
    this.userData = options.userDataPath?.() ?? app.getPath('userData')
    this.root = antigravityAccountRoot(options.accountId, this.userData)
    this.resolveRuntime = options.resolveRuntime ?? resolveAntigravityRuntime
    this.processEnv = options.processEnv ?? ((root) => buildAntigravityProcessEnv(root))
    this.idleCloseMs = options.idleCloseMs ?? DEFAULT_IDLE_CLOSE_MS
  }

  get workDir(): string {
    return antigravityWorkDir(this.root)
  }

  getStatus(): ChatSubscriptionAuthStatus {
    if (this.loginController) return { state: 'signing-in', authenticated: false }
    if (!this.authenticationRequired && this.currentProjectId()) return { state: 'signed-in', authenticated: true }
    return { state: 'signed-out', authenticated: false }
  }

  getAccountIdentity(): AntigravityAccountIdentity {
    const projectId = this.authenticationRequired ? null : this.currentProjectId()
    return { fingerprint: projectId ? antigravityFingerprint(projectId) : null, epoch: this.epoch }
  }

  assertAccountIdentity(expected: AntigravityAccountIdentity): void {
    const current = this.getAccountIdentity()
    if (!current.fingerprint) throw new AntigravityAuthRequiredError()
    if (current.fingerprint !== expected.fingerprint || current.epoch !== expected.epoch) {
      throw new AntigravityAccountChangedError()
    }
  }

  onAuthChanged(listener: () => void): () => void {
    this.authListeners.add(listener)
    return () => this.authListeners.delete(listener)
  }

  /** Marks the stored sign-in as unusable (the server answered "Authentication required"). */
  markAuthenticationRequired(): void {
    if (this.authenticationRequired) return
    this.authenticationRequired = true
    this.models = null
    this.emitAuthChanged()
  }

  /** Blocks until the Google sign-in opened by the ACP server finishes, fails, or is cancelled. */
  async login(signal?: AbortSignal): Promise<ChatSubscriptionLoginResult> {
    if (this.disposed) return { ok: false, error: 'Google AI is shutting down.', status: this.getStatus() }
    if (this.loginController) {
      return { ok: false, error: 'A Google sign-in is already in progress.', status: this.getStatus() }
    }
    const controller = new AbortController()
    const forward = () => controller.abort(signal?.reason)
    if (signal?.aborted) controller.abort(signal.reason)
    signal?.addEventListener('abort', forward, { once: true })
    this.loginController = controller
    this.emitAuthChanged()
    let runtime: AntigravityRuntimeCommand | null = null
    let client: AcpClient | null = null
    try {
      runtime = await this.resolveRuntime()
      await ensurePrivateDirectory(this.root)
      await ensurePrivateDirectory(this.workDir)
      client = (await AcpClient.start(this.startOptions(runtime), controller.signal)).client
      await client.request('authenticate', { methodId: 'oauth-personal' }, { signal: controller.signal })
      this.projectId = readAntigravityProjectId(this.root)
      if (!this.projectId) throw new Error('Google sign-in finished without an Antigravity account.')
      this.authenticationRequired = false
      this.epoch++
      this.models = null
      // The shared process authenticated with the previous state; the next request starts a fresh one.
      await this.closeConnection()
      return { ok: true, status: this.statusAfterLogin() }
    } catch (error) {
      this.projectId = undefined
      const message = controller.signal.aborted
        ? 'Google sign-in was cancelled.'
        : antigravityErrorMessage(error).message
      return { ok: false, error: message, status: this.statusAfterLogin() }
    } finally {
      signal?.removeEventListener('abort', forward)
      await client?.close(0).catch(() => undefined)
      runtime?.release()
      this.loginController = null
      this.emitAuthChanged()
    }
  }

  cancelLogin(): void {
    this.loginController?.abort(new Error('Google sign-in was cancelled.'))
  }

  /** Signs out by deleting the whole account home: token, settings, and ACP conversations. */
  async logout(): Promise<void> {
    this.cancelLogin()
    this.dropAllLiveSessions()
    await this.closeConnection()
    if (isStrictlyInside(antigravityAccountsRoot(this.userData), this.root)) {
      await rm(this.root, { recursive: true, force: true })
    }
    this.projectId = null
    this.authenticationRequired = false
    this.models = null
    this.epoch++
    this.emitAuthChanged()
  }

  /** Shared ACP connection, started on demand and replaced (with a new generation) when the process died. */
  async connection(signal?: AbortSignal): Promise<AntigravityConnection> {
    this.clearIdleTimer()
    if (this.disposed) throw new Error('Google AI is shutting down.')
    if (!this.currentProjectId() || this.authenticationRequired) throw new AntigravityAuthRequiredError()
    if (this.conn?.client.alive) return this.conn.handle
    this.connecting ??= this.openConnection().finally(() => {
      this.connecting = null
    })
    return (await raceAbort(this.connecting, signal)).handle
  }

  /** Keeps the shared process alive while a request that is not yet a live session is running. */
  retain(): () => void {
    this.clearIdleTimer()
    this.uses++
    let released = false
    return () => {
      if (released) return
      released = true
      this.uses--
      this.scheduleIdleClose()
    }
  }

  async listModels(force = false): Promise<readonly AntigravityModelEntry[]> {
    const cached = this.models
    if (!force && cached && cached.epoch === this.epoch && Date.now() - cached.at < MODEL_CACHE_MS) {
      return cached.entries
    }
    const epoch = this.epoch
    const release = this.retain()
    try {
      const { client } = await this.connection()
      const session = await client.request<AcpSessionSetupResult>('session/new', {
        cwd: this.workDir,
        mcpServers: [],
        _meta: ANTIGRAVITY_SESSION_META,
      })
      if (session.sessionId) {
        void client.request('session/delete', { sessionId: session.sessionId }).catch(() => undefined)
      }
      const option = session.configOptions?.find((candidate) => candidate.id === 'model')
      const entries = parseAntigravityModelOptions(option?.options ?? [])
      if (epoch === this.epoch) this.models = { at: Date.now(), epoch, entries }
      return entries
    } catch (error) {
      throw this.translateError(error)
    } finally {
      release()
    }
  }

  /** Converts "Authentication required" answers into the typed error and updates the account status. */
  translateError(error: unknown): unknown {
    if (error instanceof AcpRpcError && error.code === ACP_AUTH_REQUIRED_CODE) {
      this.markAuthenticationRequired()
      return new AntigravityAuthRequiredError()
    }
    if (isAntigravityAuthRequired(error)) this.markAuthenticationRequired()
    return error
  }

  getLiveSession(conversationId: string): AntigravityLiveSession | undefined {
    const live = this.liveSessions.get(conversationId)
    if (live && live.generation !== this.conn?.generation) {
      this.dropLiveSession(conversationId)
      return undefined
    }
    return live
  }

  setLiveSession(conversationId: string, live: AntigravityLiveSession): void {
    const previous = this.liveSessions.get(conversationId)
    if (previous && previous.toolset !== live.toolset) previous.toolset.dispose()
    this.liveSessions.set(conversationId, live)
    this.clearIdleTimer()
  }

  dropLiveSession(conversationId: string): AntigravityLiveSession | undefined {
    const live = this.liveSessions.get(conversationId)
    if (!live) return undefined
    this.liveSessions.delete(conversationId)
    live.toolset.dispose()
    this.scheduleIdleClose()
    return live
  }

  liveSessionCount(): number {
    return this.liveSessions.size
  }

  /**
   * Deletes one ACP session: through the running server when possible, then its files in this account's
   * GEMINI_HOME (the server keeps them even for sessions it no longer has in memory).
   */
  async deleteSession(sessionId: string): Promise<void> {
    if (this.conn?.client.alive) {
      await this.conn.client.request('session/delete', { sessionId }, { timeoutMs: 10_000 }).catch(() => undefined)
    }
    if (!SESSION_ID_PATTERN.test(sessionId)) return
    const acpHome = antigravityAcpHome(this.root)
    const conversations = path.join(acpHome, 'conversations')
    const targets = [
      ...['.db', '.db-wal', '.db-shm', '.meta'].map((suffix) => path.join(conversations, `${sessionId}${suffix}`)),
      path.join(acpHome, 'brain', sessionId),
    ]
    for (const target of targets) {
      if (isStrictlyInside(acpHome, target)) await rm(target, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  /** Forgets every live session and stops the shared process; sign-in state is kept. */
  async closeSessions(): Promise<void> {
    this.dropAllLiveSessions()
    await this.closeConnection()
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.cancelLogin()
    this.dropAllLiveSessions()
    this.clearIdleTimer()
    await this.closeConnection()
    this.authListeners.clear()
  }

  private currentProjectId(): string | null {
    if (this.projectId === undefined) this.projectId = readAntigravityProjectId(this.root)
    return this.projectId
  }

  private statusAfterLogin(): ChatSubscriptionAuthStatus {
    return !this.authenticationRequired && this.currentProjectId()
      ? { state: 'signed-in', authenticated: true }
      : { state: 'signed-out', authenticated: false }
  }

  private startOptions(runtime: AntigravityRuntimeCommand) {
    return {
      command: runtime.command,
      args: runtime.args,
      cwd: this.workDir,
      env: this.processEnv(this.root),
      clientInfo: CLIENT_INFO,
    }
  }

  private async openConnection(): Promise<ConnectionState> {
    if (this.conn) this.discardConnection(this.conn)
    const runtime = await this.resolveRuntime()
    let client: AcpClient
    try {
      await ensurePrivateDirectory(this.workDir)
      client = (await AcpClient.start(this.startOptions(runtime))).client
    } catch (error) {
      runtime.release()
      throw error
    }
    const subscribers = new Map<string, Set<(update: AcpSessionUpdate) => void>>()
    client.onNotification((method, params) => {
      if (method !== 'session/update') return
      const notification = params as AcpSessionNotification | null
      if (!notification?.update) return
      for (const listener of subscribers.get(notification.sessionId) ?? []) listener(notification.update)
    })
    client.setRequestHandler('session/request_permission', async (params) => decideAntigravityPermission(params))
    const generation = ++this.generation
    const handle: AntigravityConnection = {
      client,
      generation,
      subscribe(sessionId, listener) {
        let listeners = subscribers.get(sessionId)
        if (!listeners) {
          listeners = new Set()
          subscribers.set(sessionId, listeners)
        }
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
          if (listeners.size === 0 && subscribers.get(sessionId) === listeners) subscribers.delete(sessionId)
        }
      },
    }
    const state: ConnectionState = { client, generation, runtime, subscribers, handle }
    this.conn = state
    void client.exited.then(() => {
      if (this.conn === state) this.discardConnection(state)
    })
    return state
  }

  /** Forgets a connection: its sessions cannot be reused, and its runtime lease is returned. */
  private discardConnection(state: ConnectionState): void {
    if (this.conn === state) this.conn = null
    for (const [conversationId, live] of [...this.liveSessions]) {
      if (live.generation === state.generation) this.dropLiveSession(conversationId)
    }
    state.subscribers.clear()
    state.runtime.release()
  }

  private async closeConnection(): Promise<void> {
    this.clearIdleTimer()
    const pending = this.connecting
    if (pending) await pending.catch(() => undefined)
    const state = this.conn
    if (!state) return
    this.discardConnection(state)
    await state.client.close().catch(() => undefined)
  }

  private dropAllLiveSessions(): void {
    for (const conversationId of [...this.liveSessions.keys()]) this.dropLiveSession(conversationId)
  }

  private scheduleIdleClose(): void {
    if (this.idleTimer || !this.conn || this.uses > 0 || this.liveSessions.size > 0) return
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      if (this.uses === 0 && this.liveSessions.size === 0) void this.closeConnection()
    }, this.idleCloseMs)
    this.idleTimer.unref?.()
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
  }

  private emitAuthChanged(): void {
    for (const listener of [...this.authListeners]) {
      try {
        listener()
      } catch {
        // Listener failures must not break account transitions.
      }
    }
  }
}

const instances = new Map<string, AntigravitySubscriptionManager>()

/** Per-account registry: null/absent `accountId` means the default account. Lazy instances. */
export function getAntigravitySubscriptionManager(accountId: string | null = null): AntigravitySubscriptionManager {
  const key = accountId ?? ''
  let manager = instances.get(key)
  if (!manager) {
    manager = new AntigravitySubscriptionManager({ accountId })
    instances.set(key, manager)
  }
  return manager
}

export function listAntigravitySubscriptionManagers(): AntigravitySubscriptionManager[] {
  return [...instances.values()]
}

export async function disposeAntigravitySubscriptionManager(accountId: string | null): Promise<void> {
  const key = accountId ?? ''
  const manager = instances.get(key)
  instances.delete(key)
  await manager?.dispose()
}

export async function disposeAllAntigravitySubscriptionManagers(): Promise<void> {
  const managers = [...instances.values()]
  instances.clear()
  await Promise.all(managers.map((manager) => manager.dispose()))
}
