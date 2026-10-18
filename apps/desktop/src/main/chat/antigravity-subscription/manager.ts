/**
 * Per-account owner of Google's Antigravity ACP server process.
 *
 * Every account gets an isolated home (`HOME`/`GEMINI_HOME` under userData) with the OAuth token kept in a file, so
 * accounts never share credentials, conversations, or the user's own `~/.gemini`. One shared process serves all
 * chat sessions of an account; sign-in uses a dedicated process because `authenticate` blocks until the browser
 * flow finishes.
 *
 * The server cannot close or delete a session (it implements neither `session/close` nor `session/delete`), and every
 * session keeps a `localharness` process alive until the server exits. The model catalog, the subscription tier,
 * and the `/usage` report therefore share one probe session per server process instead of opening one per request.
 */
import { mkdir, rm, chmod } from 'node:fs/promises'
import path from 'node:path'
import { app } from 'electron'
import type {
  ChatSubscriptionAuthStatus,
  ChatSubscriptionLoginResult,
  ChatSubscriptionUsageWindow,
} from '../../../shared/chat'
import { AcpClient, AcpRpcError } from '../acp/client'
import {
  ACP_AUTH_REQUIRED_CODE,
  type AcpSessionNotification,
  type AcpSessionSetupResult,
  type AcpSessionUpdate,
} from '../acp/protocol'
import {
  ANTIGRAVITY_USAGE_COMMAND,
  type AntigravityTier,
  parseAntigravityTier,
  parseAntigravityUsageReport,
  readAntigravityAccountTier,
  sameAntigravityTier,
  writeAntigravityAccountTier,
} from './account-info'
import {
  AntigravityAccountChangedError,
  AntigravityAuthRequiredError,
  antigravityErrorMessage,
  isAntigravityAuthRequired,
} from './errors'
import type { AntigravityHostToolset } from './host-mcp'
import { type AntigravityModelEntry, antigravityModelEntriesFromSession } from './models'
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
import { captureAntigravityBrowser } from './remote-login'
import { decideAntigravityPermission } from './permissions'
import { type AntigravityRuntimeCommand, resolveAntigravityRuntime } from './runtime'

/** Every ACP session disables all built-in Antigravity tools; Maestrly's tools arrive over MCP. */
export const ANTIGRAVITY_SESSION_META = Object.freeze({ agy: Object.freeze({ enabledTools: Object.freeze([]) }) })

const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DEFAULT_IDLE_CLOSE_MS = 10 * 60_000
/**
 * Catalog lifetime once its server process is gone, and for forced refreshes. While that process runs, a regular
 * request keeps its probe's catalog; each forced refresh costs another session process until the server exits.
 */
const MODEL_CACHE_MS = 10 * 60_000
const USAGE_CACHE_MS = 60_000
const USAGE_TIMEOUT_MS = 30_000
/** The server advertises slash commands right after `session/new` answers. */
const COMMANDS_WAIT_MS = 3_000
/** Sessions whose advertised commands each connection remembers. */
const COMMANDS_MEMORY = 64
const CLIENT_INFO = { name: 'maestrly', version: app.getVersion?.() || '0.0.0' }

export interface AntigravityAccountIdentity {
  fingerprint: string | null
  epoch: number
}

export interface AntigravityConnection {
  readonly client: AcpClient
  readonly generation: number
  subscribe(sessionId: string, listener: (update: AcpSessionUpdate) => void): () => void
  /** Slash commands the server advertised for a session; empty when none arrived within `timeoutMs`. */
  availableCommands(sessionId: string, timeoutMs: number): Promise<readonly string[]>
}

interface AntigravityProbe {
  sessionId: string | null
  generation: number
  epoch: number
  entries: readonly AntigravityModelEntry[]
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
  now?: () => number
}

interface ConnectionState {
  readonly client: AcpClient
  readonly generation: number
  readonly runtime: AntigravityRuntimeCommand
  readonly subscribers: Map<string, Set<(update: AcpSessionUpdate) => void>>
  readonly commands: Map<string, readonly string[]>
  readonly handle: AntigravityConnection
}

function commandNames(update: AcpSessionUpdate): readonly string[] {
  const commands = (update as { availableCommands?: unknown }).availableCommands
  if (!Array.isArray(commands)) return []
  return commands
    .map((command) => (command && typeof command === 'object' ? (command as { name?: unknown }).name : undefined))
    .filter((name): name is string => typeof name === 'string')
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
  private readonly now: () => number
  private readonly authListeners = new Set<() => void>()
  private readonly liveSessions = new Map<string, AntigravityLiveSession>()
  private projectId: string | null | undefined
  /** Undefined until read from the account home. */
  private tier: AntigravityTier | null | undefined
  private authenticationRequired = false
  private epoch = 0
  private generation = 0
  private conn: ConnectionState | null = null
  private connecting: Promise<ConnectionState> | null = null
  private closing: Promise<void> | null = null
  private runtimeUses = 0
  private loginController: AbortController | null = null
  private uses = 0
  private idleTimer: NodeJS.Timeout | null = null
  private models: {
    at: number
    epoch: number
    generation: number
    entries: readonly AntigravityModelEntry[]
  } | null = null
  private probe: AntigravityProbe | null = null
  private probing: { generation: number; promise: Promise<AntigravityProbe> } | null = null
  private usage: { at: number; epoch: number; windows: ChatSubscriptionUsageWindow[] | null } | null = null
  private usageLoading: { epoch: number; promise: Promise<ChatSubscriptionUsageWindow[] | null> } | null = null
  private disposed = false

  constructor(options: AntigravityManagerOptions) {
    this.accountId = options.accountId
    this.userData = options.userDataPath?.() ?? app.getPath('userData')
    this.root = antigravityAccountRoot(options.accountId, this.userData)
    this.resolveRuntime = options.resolveRuntime ?? resolveAntigravityRuntime
    this.processEnv = options.processEnv ?? ((root) => buildAntigravityProcessEnv(root))
    this.idleCloseMs = options.idleCloseMs ?? DEFAULT_IDLE_CLOSE_MS
    this.now = options.now ?? Date.now
  }

  get workDir(): string {
    return antigravityWorkDir(this.root)
  }

  get connectedRuntime(): Pick<AntigravityRuntimeCommand, 'command' | 'version' | 'source'> | null {
    return this.conn?.runtime ?? null
  }

  get runtimeConnecting(): boolean {
    return this.connecting !== null || this.closing !== null
  }

  /** A monotonic admission counter, unlike the number of currently retained requests. */
  get runtimeUseCount(): number {
    return this.runtimeUses
  }

  /** Called only after the environment is idle; a request admitted since that check keeps its process. */
  async recycleRuntime(selectedCommand: string, unusedSince: number | undefined): Promise<boolean> {
    if (this.connecting || this.closing || this.loginController || this.uses > 0) return false
    if (!this.conn || this.conn.runtime.command === selectedCommand) return true
    if (this.runtimeUses !== unusedSince) return false
    this.models = null
    await this.closeConnection()
    return true
  }

  getStatus(): ChatSubscriptionAuthStatus {
    if (this.loginController) return { state: 'signing-in', authenticated: false }
    return this.statusAfterLogin()
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
    this.usage = null
    this.emitAuthChanged()
  }

  /** Blocks until the Google sign-in opened by the ACP server finishes, fails, or is cancelled. */
  async login(signal?: AbortSignal, onBrowserUrl?: (url: string) => void): Promise<ChatSubscriptionLoginResult> {
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
    let browser: Awaited<ReturnType<typeof captureAntigravityBrowser>> | null = null
    try {
      runtime = await this.resolveRuntime()
      await ensurePrivateDirectory(this.root)
      await ensurePrivateDirectory(this.workDir)
      controller.signal.throwIfAborted()
      if (onBrowserUrl) browser = await captureAntigravityBrowser(onBrowserUrl)
      const options = this.startOptions(runtime)
      client = (await AcpClient.start({ ...options, env: { ...options.env, ...browser?.env } }, controller.signal))
        .client
      const authenticated = await client.request<{ _meta?: unknown } | null>(
        'authenticate',
        { methodId: 'oauth-personal' },
        { signal: controller.signal }
      )
      this.projectId = readAntigravityProjectId(this.root)
      if (!this.projectId) throw new Error('Google sign-in finished without an Antigravity account.')
      // Replaces the previous account's tier even when this runtime reports none.
      this.tier = parseAntigravityTier(authenticated?._meta)
      await writeAntigravityAccountTier(this.root, this.tier).catch(() => undefined)
      this.authenticationRequired = false
      this.epoch++
      this.models = null
      this.usage = null
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
      await browser?.close().catch(() => undefined)
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
    this.tier = null
    this.authenticationRequired = false
    this.models = null
    this.usage = null
    this.epoch++
    this.emitAuthChanged()
  }

  /** Shared ACP connection, started on demand and replaced (with a new generation) when the process died. */
  async connection(signal?: AbortSignal): Promise<AntigravityConnection> {
    this.runtimeUses++
    this.clearIdleTimer()
    if (this.closing) await raceAbort(this.closing, signal)
    signal?.throwIfAborted()
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
    this.runtimeUses++
    this.uses++
    let released = false
    return () => {
      if (released) return
      released = true
      this.uses--
      this.scheduleIdleClose()
    }
  }

  /**
   * The account's model catalog. Concurrent callers share one probe, and a server process answers from its probe
   * for as long as it runs; `force` only skips a catalog older than {@link MODEL_CACHE_MS}.
   */
  async listModels(force = false): Promise<readonly AntigravityModelEntry[]> {
    const cached = this.models
    if (
      cached &&
      cached.epoch === this.epoch &&
      this.now() - cached.at < this.catalogMaxAge(cached.generation, force)
    ) {
      return cached.entries
    }
    const release = this.retain()
    try {
      const connection = await this.connection()
      const fresh = this.models
      // Another caller may have probed this process while this one waited for it.
      if (fresh && fresh !== cached && fresh.epoch === this.epoch && fresh.generation === connection.generation) {
        return fresh.entries
      }
      return (await this.openProbe(connection, false)).entries
    } catch (error) {
      throw this.translateError(error)
    } finally {
      release()
    }
  }

  /**
   * Quota windows from the server's `/usage` report, which it answers without a model turn. Null when this runtime
   * does not advertise the command, so an older server never receives it as a prompt.
   */
  async readUsage(force = false): Promise<ChatSubscriptionUsageWindow[] | null> {
    const cached = this.usage
    if (!force && cached && cached.epoch === this.epoch && this.now() - cached.at < USAGE_CACHE_MS) {
      return cached.windows
    }
    const loading = this.usageLoading
    if (loading?.epoch === this.epoch) return loading.promise
    const epoch = this.epoch
    const promise: Promise<ChatSubscriptionUsageWindow[] | null> = this.fetchUsage(epoch).finally(() => {
      if (this.usageLoading?.promise === promise) this.usageLoading = null
    })
    this.usageLoading = { epoch, promise }
    return promise
  }

  private catalogMaxAge(generation: number, force: boolean): number {
    const live = !force && this.conn?.client.alive && this.conn.generation === generation
    return live ? Number.POSITIVE_INFINITY : MODEL_CACHE_MS
  }

  /**
   * The probe session of `connection`: the current one when `reuse` allows, otherwise a new one. Concurrent callers
   * on the same process share a single `session/new`.
   */
  private openProbe(connection: AntigravityConnection, reuse: boolean): Promise<AntigravityProbe> {
    const current = this.probe
    if (reuse && current && current.generation === connection.generation && current.epoch === this.epoch) {
      return Promise.resolve(current)
    }
    const pending = this.probing
    if (pending?.generation === connection.generation) return pending.promise
    const epoch = this.epoch
    const promise: Promise<AntigravityProbe> = (async () => {
      const session = await connection.client.request<AcpSessionSetupResult>('session/new', {
        cwd: this.workDir,
        mcpServers: [],
        _meta: ANTIGRAVITY_SESSION_META,
      })
      const probe: AntigravityProbe = {
        sessionId: session.sessionId ?? null,
        generation: connection.generation,
        epoch,
        entries: antigravityModelEntriesFromSession(session),
      }
      if (epoch !== this.epoch) return probe
      this.models = { at: this.now(), epoch, generation: connection.generation, entries: probe.entries }
      this.recordTier(session._meta)
      if (probe.sessionId) {
        const previous = this.probe
        this.probe = probe
        if (previous?.sessionId && previous.generation === connection.generation) {
          this.removeSessionFilesAfterExit(connection.client, previous.sessionId)
        }
      }
      return probe
    })().finally(() => {
      if (this.probing?.promise === promise) this.probing = null
    })
    this.probing = { generation: connection.generation, promise }
    return promise
  }

  private async fetchUsage(epoch: number): Promise<ChatSubscriptionUsageWindow[] | null> {
    const release = this.retain()
    let unsubscribe: (() => void) | null = null
    const remember = (windows: ChatSubscriptionUsageWindow[] | null) => {
      if (epoch === this.epoch) this.usage = { at: this.now(), epoch, windows }
      return windows
    }
    try {
      const connection = await this.connection()
      const { sessionId } = await this.openProbe(connection, true)
      if (!sessionId) return remember(null)
      const commands = await connection.availableCommands(sessionId, COMMANDS_WAIT_MS)
      if (!commands.includes(ANTIGRAVITY_USAGE_COMMAND)) return remember(null)
      let report = ''
      unsubscribe = connection.subscribe(sessionId, (update) => {
        if (update.sessionUpdate !== 'agent_message_chunk') return
        const content = (update as { content?: { type?: string; text?: unknown } }).content
        if (content?.type === 'text' && typeof content.text === 'string') report += content.text
      })
      await connection.client.request(
        'session/prompt',
        { sessionId, prompt: [{ type: 'text', text: `/${ANTIGRAVITY_USAGE_COMMAND}` }] },
        { timeoutMs: USAGE_TIMEOUT_MS }
      )
      const parsed = parseAntigravityUsageReport(report)
      if (parsed.error) throw new Error(parsed.error)
      return remember(parsed.windows)
    } catch (error) {
      throw this.translateError(error)
    } finally {
      unsubscribe?.()
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
    await this.removeSessionFiles(sessionId)
  }

  private removeSessionFilesAfterExit(client: AcpClient, sessionId: string): void {
    void client.exited.then(() => this.removeSessionFiles(sessionId))
  }

  private async removeSessionFiles(sessionId: string): Promise<void> {
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

  private currentTier(): AntigravityTier | null {
    if (this.tier === undefined) this.tier = readAntigravityAccountTier(this.root)
    return this.tier
  }

  /** Keeps the tier a session setup reported; a runtime that reports none leaves the known one in place. */
  private recordTier(meta: unknown): void {
    const tier = parseAntigravityTier(meta)
    if (!tier || sameAntigravityTier(tier, this.currentTier())) return
    this.tier = tier
    void writeAntigravityAccountTier(this.root, tier).catch(() => undefined)
    this.emitAuthChanged()
  }

  private statusAfterLogin(): ChatSubscriptionAuthStatus {
    if (this.authenticationRequired || !this.currentProjectId()) return { state: 'signed-out', authenticated: false }
    const plan = this.currentTier()?.name
    return { state: 'signed-in', authenticated: true, ...(plan ? { planType: plan } : {}) }
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
    // Recorded here because the advertisement can arrive before the caller that created the session resumes.
    const commands = new Map<string, readonly string[]>()
    client.onNotification((method, params) => {
      if (method !== 'session/update') return
      const notification = params as AcpSessionNotification | null
      if (!notification?.update) return
      if (notification.update.sessionUpdate === 'available_commands_update') {
        commands.delete(notification.sessionId)
        commands.set(notification.sessionId, commandNames(notification.update))
        if (commands.size > COMMANDS_MEMORY) commands.delete(commands.keys().next().value as string)
      }
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
      availableCommands(sessionId, timeoutMs) {
        const known = commands.get(sessionId)
        if (known) return Promise.resolve(known)
        return new Promise((resolve) => {
          let done = false
          const finish = () => {
            if (done) return
            done = true
            clearTimeout(timer)
            unsubscribe()
            resolve(commands.get(sessionId) ?? [])
          }
          const unsubscribe = handle.subscribe(sessionId, (update) => {
            if (update.sessionUpdate === 'available_commands_update') finish()
          })
          const timer = setTimeout(finish, timeoutMs)
          void client.exited.then(finish)
        })
      },
    }
    const state: ConnectionState = { client, generation, runtime, subscribers, commands, handle }
    this.conn = state
    void client.exited.then(() => {
      if (this.conn === state) this.discardConnection(state)
    })
    return state
  }

  /** Detach first so no new request can take a process that is closing. */
  private detachConnection(state: ConnectionState): void {
    if (this.conn === state) this.conn = null
    for (const [conversationId, live] of [...this.liveSessions]) {
      if (live.generation === state.generation) this.dropLiveSession(conversationId)
    }
    // The catalog outlives its process by MODEL_CACHE_MS, so an idle close does not respawn the server for metadata.
    if (this.models?.generation === state.generation) this.models = { ...this.models, at: this.now() }
    const probe = this.probe
    if (probe?.generation === state.generation) {
      this.probe = null
      if (probe.sessionId) this.removeSessionFilesAfterExit(state.client, probe.sessionId)
    }
    state.subscribers.clear()
    state.commands.clear()
  }

  private discardConnection(state: ConnectionState): void {
    this.detachConnection(state)
    // A failed client may have started terminating before its process has actually exited.
    void state.client.exited.then(() => state.runtime.release())
  }

  private async closeConnection(): Promise<void> {
    if (this.closing) return this.closing
    this.clearIdleTimer()
    const pending = this.connecting
    if (pending) await pending.catch(() => undefined)
    if (this.closing) return this.closing
    const state = this.conn
    if (!state) return
    this.detachConnection(state)
    this.closing = state.client
      .close()
      .catch(() => undefined)
      .finally(() => {
        state.runtime.release()
        this.closing = null
      })
    await this.closing
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
