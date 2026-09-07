import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import readline from 'node:readline'
import { CodexProcessTree } from './process-tree'
import type {
  CodexAccountLoginStartParams,
  CodexAccountLoginStartResponse,
  CodexAccountReadParams,
  CodexAccountReadResponse,
  CodexClientInfo,
  CodexEmptyResponse,
  CodexInitializeCapabilities,
  CodexInitializeResponse,
  CodexNotification,
  CodexRequestId,
  CodexRpcErrorBody,
  CodexServerRequest,
  CodexThreadResumeParams,
  CodexThreadResumeResponse,
  CodexThreadDeleteParams,
  CodexThreadDeleteResponse,
  CodexThreadStartParams,
  CodexThreadStartResponse,
  CodexTurnInterruptParams,
  CodexTurnSteerParams,
  CodexTurnSteerResponse,
  CodexTurnSettingsUpdateParams,
  CodexTurnSettingsUpdateResponse,
  CodexTurnStartParams,
  CodexTurnStartResponse,
} from './protocol'

export type CodexAppServerState = 'starting' | 'initializing' | 'ready' | 'closing' | 'closed' | 'failed'

export interface CodexAppServerConnectOptions {
  binaryPath: string
  /** Defaults to `["app-server"]`. An override is useful for a platform-specific launcher. */
  binaryArgs?: readonly string[]
  clientInfo: CodexClientInfo
  capabilities?: CodexInitializeCapabilities | null
  cwd?: string
  env?: Readonly<NodeJS.ProcessEnv>
  /** Variables removed from the inherited environment, compared case-insensitively for Windows. */
  unsetEnv?: readonly string[]
  /** Prefixes removed from the inherited environment. Explicit `env` is applied afterward and always wins. */
  unsetEnvPrefixes?: readonly string[]
  signal?: AbortSignal
  defaultRequestTimeoutMs?: number
  stderrBufferLimit?: number
  serverRequestHandler?: CodexServerRequestHandler
}

export interface CodexRequestOptions {
  signal?: AbortSignal
  timeoutMs?: number
}

export interface CodexCloseOptions {
  gracePeriodMs?: number
}

export interface CodexProcessExit {
  code: number | null
  signal: NodeJS.Signals | null
}

export type CodexServerRequestHandler = (request: CodexServerRequest, signal: AbortSignal) => unknown | Promise<unknown>

type NotificationListener = (notification: CodexNotification) => void
type StderrListener = (chunk: string) => void
type ProtocolErrorListener = (error: CodexAppServerProtocolError) => void

interface PendingRequest {
  method: string
  resolve: (result: unknown) => void
  reject: (error: Error) => void
  cleanup: () => void
}

interface RpcResponse {
  id: CodexRequestId
  result?: unknown
  error?: CodexRpcErrorBody
}

interface RpcRequest {
  id: CodexRequestId
  method: string
  params?: unknown
}

interface RpcNotification {
  method: string
  params?: unknown
}

const hasOwn = (value: object, key: PropertyKey): boolean => Object.hasOwn(value, key)

function asError(value: unknown, fallback: string): Error {
  if (value instanceof Error) return value
  if (typeof value === 'string' && value) return new Error(value)
  return new Error(fallback)
}

export class CodexAppServerRpcError extends Error {
  readonly name = 'CodexAppServerRpcError'

  constructor(
    message: string,
    readonly code: number,
    readonly method: string,
    readonly requestId: CodexRequestId,
    readonly data?: unknown
  ) {
    super(message)
  }
}

export class CodexAppServerProcessError extends Error {
  readonly name = 'CodexAppServerProcessError'

  constructor(
    message: string,
    readonly exit: CodexProcessExit | null,
    readonly stderr: string,
    options?: ErrorOptions
  ) {
    super(message, options)
  }
}

export class CodexAppServerProtocolError extends Error {
  readonly name = 'CodexAppServerProtocolError'

  constructor(
    message: string,
    readonly line?: string,
    options?: ErrorOptions
  ) {
    super(message, options)
  }
}

export class CodexAppServerTimeoutError extends Error {
  readonly name = 'CodexAppServerTimeoutError'

  constructor(
    readonly method: string,
    readonly timeoutMs: number
  ) {
    super(`Codex app-server request "${method}" timed out after ${timeoutMs}ms`)
  }
}

export class CodexAppServerAbortError extends Error {
  readonly name = 'AbortError'

  constructor(message = 'Codex app-server operation was aborted', options?: ErrorOptions) {
    super(message, options)
  }
}

export class CodexAppServerClosedError extends Error {
  readonly name = 'CodexAppServerClosedError'

  constructor(message = 'Codex app-server client is closed') {
    super(message)
  }
}

export class CodexAppServerClient {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly processTree: CodexProcessTree
  private closePromise: Promise<void> | undefined
  private readonly lines: readline.Interface
  private readonly pending = new Map<CodexRequestId, PendingRequest>()
  private readonly notificationListeners = new Set<NotificationListener>()
  private readonly stderrListeners = new Set<StderrListener>()
  private readonly protocolErrorListeners = new Set<ProtocolErrorListener>()
  private readonly serverRequestAbort = new AbortController()
  private readonly defaultRequestTimeoutMs: number
  private readonly stderrBufferLimit: number
  private readonly spawned: Promise<void>
  private readonly exited: Promise<CodexProcessExit>
  private resolveExited!: (exit: CodexProcessExit) => void
  private outerAbortCleanup: (() => void) | undefined
  private requestId = 0
  private stderrTail = ''
  private didExit = false
  private terminalError: Error | null = null
  private _initializeResult: CodexInitializeResponse | null = null
  private serverRequestHandler: CodexServerRequestHandler | undefined
  private _state: CodexAppServerState = 'starting'

  private constructor(options: CodexAppServerConnectOptions) {
    this.defaultRequestTimeoutMs = options.defaultRequestTimeoutMs ?? 30_000
    this.stderrBufferLimit = options.stderrBufferLimit ?? 16_384
    this.serverRequestHandler = options.serverRequestHandler
    const childEnv = { ...process.env }
    const unset = new Set((options.unsetEnv ?? []).map((name) => name.toUpperCase()))
    const unsetPrefixes = (options.unsetEnvPrefixes ?? []).map((prefix) => prefix.toUpperCase())
    for (const name of Object.keys(childEnv)) {
      const normalized = name.toUpperCase()
      if (unset.has(normalized) || unsetPrefixes.some((prefix) => normalized.startsWith(prefix))) {
        delete childEnv[name]
      }
    }
    Object.assign(childEnv, options.env)
    this.child = spawn(options.binaryPath, [...(options.binaryArgs ?? ['app-server'])], {
      cwd: options.cwd,
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    })

    this.processTree = new CodexProcessTree(this.child)

    this.exited = new Promise((resolve) => {
      this.resolveExited = resolve
    })

    let spawnSettled = false
    this.spawned = new Promise((resolve, reject) => {
      this.child.once('spawn', () => {
        spawnSettled = true
        resolve()
      })
      this.child.once('error', (cause) => {
        const error = new CodexAppServerProcessError(
          `Failed to start Codex app-server: ${cause.message}`,
          null,
          this.stderrTail,
          { cause }
        )
        if (!spawnSettled) {
          spawnSettled = true
          reject(error)
        }
        this.fail(error)
      })
    })

    this.lines = readline.createInterface({ input: this.child.stdout, crlfDelay: Number.POSITIVE_INFINITY })
    this.lines.on('line', (line) => this.handleLine(line))
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', (chunk: string) => this.handleStderr(chunk))
    this.child.stdin.on('error', (cause) => {
      if (this._state === 'closing' || this._state === 'closed') return
      this.fail(
        new CodexAppServerProcessError(
          `Lost the Codex app-server stdin stream: ${cause.message}`,
          null,
          this.stderrTail,
          { cause }
        )
      )
    })
    this.child.once('close', (code, signal) => this.handleProcessClose({ code, signal }))

    if (options.signal) {
      const onAbort = (): void => this.abort(options.signal?.reason)
      options.signal.addEventListener('abort', onAbort, { once: true })
      this.outerAbortCleanup = () => options.signal?.removeEventListener('abort', onAbort)
    }
  }

  static async connect(options: CodexAppServerConnectOptions): Promise<CodexAppServerClient> {
    if (options.signal?.aborted) throw CodexAppServerClient.abortError(options.signal.reason)

    const client = new CodexAppServerClient(options)
    try {
      await client.spawned
      client._state = 'initializing'
      const params = {
        clientInfo: options.clientInfo,
        ...(options.capabilities !== undefined ? { capabilities: options.capabilities } : {}),
      }
      const result = await client.sendRequest<CodexInitializeResponse>('initialize', params, {
        signal: options.signal,
      })
      client._initializeResult = result
      await client.writeMessage({ method: 'initialized', params: {} })
      client._state = 'ready'
      return client
    } catch (error) {
      client.abort(error)
      await client.close({ gracePeriodMs: 100 })
      throw error
    }
  }

  get state(): CodexAppServerState {
    return this._state
  }

  get initializeResult(): CodexInitializeResponse {
    if (!this._initializeResult) throw new CodexAppServerClosedError('Codex app-server did not finish initialization')
    return this._initializeResult
  }

  get stderr(): string {
    return this.stderrTail
  }

  get failure(): Error | null {
    return this.terminalError
  }

  onNotification(listener: NotificationListener): () => void {
    this.notificationListeners.add(listener)
    return () => this.notificationListeners.delete(listener)
  }

  onStderr(listener: StderrListener): () => void {
    this.stderrListeners.add(listener)
    return () => this.stderrListeners.delete(listener)
  }

  onProtocolError(listener: ProtocolErrorListener): () => void {
    this.protocolErrorListeners.add(listener)
    return () => this.protocolErrorListeners.delete(listener)
  }

  setServerRequestHandler(handler: CodexServerRequestHandler | undefined): void {
    this.serverRequestHandler = handler
  }

  request<TResult>(method: string, params?: unknown, options: CodexRequestOptions = {}): Promise<TResult> {
    if (this._state !== 'ready') {
      return Promise.reject(this.terminalError ?? new CodexAppServerClosedError(`Client is not ready (${this._state})`))
    }
    return this.sendRequest<TResult>(method, params, options)
  }

  readAccount(params: CodexAccountReadParams = {}, options?: CodexRequestOptions): Promise<CodexAccountReadResponse> {
    return this.request('account/read', params, options)
  }

  startAccountLogin(
    params: CodexAccountLoginStartParams,
    options?: CodexRequestOptions
  ): Promise<CodexAccountLoginStartResponse> {
    return this.request('account/login/start', params, options)
  }

  logoutAccount(options?: CodexRequestOptions): Promise<CodexEmptyResponse> {
    return this.request('account/logout', undefined, options)
  }

  startThread(params: CodexThreadStartParams = {}, options?: CodexRequestOptions): Promise<CodexThreadStartResponse> {
    return this.request('thread/start', params, options)
  }

  resumeThread(params: CodexThreadResumeParams, options?: CodexRequestOptions): Promise<CodexThreadResumeResponse> {
    return this.request('thread/resume', params, options)
  }

  deleteThread(params: CodexThreadDeleteParams, options?: CodexRequestOptions): Promise<CodexThreadDeleteResponse> {
    return this.request('thread/delete', params, options)
  }

  startTurn(params: CodexTurnStartParams, options?: CodexRequestOptions): Promise<CodexTurnStartResponse> {
    return this.request('turn/start', params, options)
  }

  interruptTurn(params: CodexTurnInterruptParams, options?: CodexRequestOptions): Promise<CodexEmptyResponse> {
    return this.request('turn/interrupt', params, options)
  }

  steerTurn(params: CodexTurnSteerParams, options?: CodexRequestOptions): Promise<CodexTurnSteerResponse> {
    return this.request('turn/steer', params, options)
  }

  updateTurnSettings(
    params: CodexTurnSettingsUpdateParams,
    options?: CodexRequestOptions
  ): Promise<CodexTurnSettingsUpdateResponse> {
    return this.request('turn/settings/update', params, options)
  }

  waitForExit(): Promise<CodexProcessExit> {
    return this.exited
  }

  abort(reason?: unknown): void {
    if (this._state === 'closed' || this._state === 'closing') return
    const error = CodexAppServerClient.abortError(reason)
    this.beginShutdown(error)
    void this.close({ gracePeriodMs: 0 }).catch((cause: unknown) => {
      this.fail(asError(cause, 'Failed to stop Codex process tree'))
    })
  }

  close(options: CodexCloseOptions = {}): Promise<void> {
    this.closePromise ??= this.closeProcessTree(options)
    return this.closePromise
  }

  private async closeProcessTree(options: CodexCloseOptions): Promise<void> {
    if (this._state !== 'closing') this.beginShutdown(new CodexAppServerClosedError())
    const requestedGrace = options.gracePeriodMs ?? 1_000
    const gracePeriodMs = Number.isFinite(requestedGrace) ? Math.max(0, requestedGrace) : 1_000
    await this.processTree.stop(gracePeriodMs)
    await this.waitForExitWithin(Math.max(100, gracePeriodMs))
    this._state = 'closed'
  }

  private static abortError(reason: unknown): CodexAppServerAbortError {
    if (reason instanceof CodexAppServerAbortError) return reason
    const cause = reason instanceof Error ? reason : undefined
    return new CodexAppServerAbortError(cause?.message ?? 'Codex app-server operation was aborted', { cause })
  }

  private sendRequest<TResult>(method: string, params: unknown, options: CodexRequestOptions): Promise<TResult> {
    if (options.signal?.aborted) return Promise.reject(CodexAppServerClient.abortError(options.signal.reason))
    if (this._state === 'closing' || this._state === 'closed' || this._state === 'failed') {
      return Promise.reject(this.terminalError ?? new CodexAppServerClosedError())
    }

    const id = this.requestId++
    const message = {
      method,
      id,
      ...(params !== undefined ? { params } : {}),
    }
    let serialized: string
    try {
      serialized = `${JSON.stringify(message)}\n`
    } catch (cause) {
      return Promise.reject(asError(cause, `Could not serialize Codex app-server request "${method}"`))
    }

    return new Promise<TResult>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined
      const onAbort = (): void => {
        const pending = this.pending.get(id)
        if (!pending) return
        this.pending.delete(id)
        pending.cleanup()
        reject(CodexAppServerClient.abortError(options.signal?.reason))
      }
      const timeoutMs = options.timeoutMs ?? this.defaultRequestTimeoutMs
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          const pending = this.pending.get(id)
          if (!pending) return
          this.pending.delete(id)
          pending.cleanup()
          reject(new CodexAppServerTimeoutError(method, timeoutMs))
        }, timeoutMs)
        timer.unref()
      }
      options.signal?.addEventListener('abort', onAbort, { once: true })

      const cleanup = (): void => {
        if (timer) clearTimeout(timer)
        options.signal?.removeEventListener('abort', onAbort)
      }
      this.pending.set(id, {
        method,
        resolve: (result) => resolve(result as TResult),
        reject,
        cleanup,
      })

      const onWrite = (cause?: Error | null): void => {
        if (!cause) return
        const error = new CodexAppServerProcessError(
          `Failed to write Codex app-server request "${method}": ${cause.message}`,
          null,
          this.stderrTail,
          { cause }
        )
        this.fail(error)
      }
      try {
        this.child.stdin.write(serialized, onWrite)
      } catch (cause) {
        onWrite(asError(cause, `Failed to write Codex app-server request "${method}"`))
      }
    })
  }

  private writeMessage(message: unknown): Promise<void> {
    if (this._state === 'closing' || this._state === 'closed' || this._state === 'failed') {
      return Promise.reject(this.terminalError ?? new CodexAppServerClosedError())
    }

    let serialized: string
    try {
      serialized = `${JSON.stringify(message)}\n`
    } catch (cause) {
      return Promise.reject(asError(cause, 'Could not serialize Codex app-server message'))
    }

    return new Promise((resolve, reject) => {
      const onWrite = (cause?: Error | null): void => {
        if (!cause) {
          resolve()
          return
        }
        const error = new CodexAppServerProcessError(
          `Failed to write to Codex app-server: ${cause.message}`,
          null,
          this.stderrTail,
          { cause }
        )
        reject(error)
        this.fail(error)
      }
      try {
        this.child.stdin.write(serialized, onWrite)
      } catch (cause) {
        onWrite(asError(cause, 'Failed to write to Codex app-server'))
      }
    })
  }

  private handleLine(line: string): void {
    if (!line.trim()) return

    let value: unknown
    try {
      value = JSON.parse(line)
    } catch (cause) {
      this.reportProtocolError(
        new CodexAppServerProtocolError('Codex app-server emitted invalid JSON', line, { cause })
      )
      return
    }

    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      this.reportProtocolError(new CodexAppServerProtocolError('Codex app-server emitted a non-object message', line))
      return
    }

    const message = value as Record<string, unknown>
    const hasId = hasOwn(message, 'id') && (typeof message.id === 'string' || typeof message.id === 'number')
    const hasMethod = typeof message.method === 'string'

    if (hasMethod && hasId) {
      void this.handleServerRequest(message as unknown as RpcRequest)
      return
    }
    if (hasMethod) {
      this.handleNotification(message as unknown as RpcNotification)
      return
    }
    if (hasId) {
      this.handleResponse(message as unknown as RpcResponse, line)
      return
    }

    this.reportProtocolError(new CodexAppServerProtocolError('Codex app-server emitted an unknown message shape', line))
  }

  private handleResponse(message: RpcResponse, line: string): void {
    const pending = this.pending.get(message.id)
    if (!pending) {
      this.reportProtocolError(
        new CodexAppServerProtocolError(`Codex app-server responded with unknown id ${String(message.id)}`, line)
      )
      return
    }

    this.pending.delete(message.id)
    pending.cleanup()
    if (hasOwn(message, 'error')) {
      if (
        !message.error ||
        typeof message.error !== 'object' ||
        typeof message.error.code !== 'number' ||
        typeof message.error.message !== 'string'
      ) {
        pending.reject(new CodexAppServerProtocolError('Codex app-server response has an invalid error body', line))
        return
      }
      pending.reject(
        new CodexAppServerRpcError(
          message.error.message,
          message.error.code,
          pending.method,
          message.id,
          message.error.data
        )
      )
      return
    }
    if (!hasOwn(message, 'result')) {
      pending.reject(new CodexAppServerProtocolError('Codex app-server response has neither result nor error', line))
      return
    }
    pending.resolve(message.result)
  }

  private handleNotification(message: RpcNotification): void {
    const notification: CodexNotification = {
      method: message.method,
      params: message.params,
    }
    for (const listener of this.notificationListeners) {
      try {
        listener(notification)
      } catch (cause) {
        this.reportProtocolError(
          new CodexAppServerProtocolError(`Notification listener failed for "${message.method}"`, undefined, {
            cause,
          })
        )
      }
    }
  }

  private async handleServerRequest(message: RpcRequest): Promise<void> {
    const request: CodexServerRequest = {
      id: message.id,
      method: message.method,
      params: message.params,
    }
    const handler = this.serverRequestHandler
    if (!handler) {
      await this.replyToServerRequest(message.id, {
        error: { code: -32601, message: `No handler registered for ${message.method}` },
      })
      return
    }

    try {
      const result = await handler(request, this.serverRequestAbort.signal)
      await this.replyToServerRequest(message.id, { result: result === undefined ? null : result })
    } catch (cause) {
      const error = asError(cause, `Server request handler failed for ${message.method}`)
      await this.replyToServerRequest(message.id, {
        error: { code: -32603, message: error.message },
      })
    }
  }

  private async replyToServerRequest(
    id: CodexRequestId,
    response: { result: unknown } | { error: CodexRpcErrorBody }
  ): Promise<void> {
    if (this._state === 'closing' || this._state === 'closed' || this._state === 'failed') return
    try {
      await this.writeMessage({ id, ...response })
    } catch {
      // writeMessage already promotes transport failures to the client lifecycle.
    }
  }

  private handleStderr(chunk: string): void {
    this.stderrTail = `${this.stderrTail}${chunk}`.slice(-this.stderrBufferLimit)
    for (const listener of this.stderrListeners) {
      try {
        listener(chunk)
      } catch {
        // Diagnostic listeners must not affect the transport.
      }
    }
  }

  private handleProcessClose(exit: CodexProcessExit): void {
    if (this.didExit) return
    this.didExit = true
    this.lines.close()
    this.outerAbortCleanup?.()
    this.outerAbortCleanup = undefined

    if (this._state !== 'closing' && this._state !== 'failed') {
      this.fail(
        new CodexAppServerProcessError(
          `Codex app-server exited unexpectedly (code=${String(exit.code)}, signal=${String(exit.signal)})`,
          exit,
          this.stderrTail
        )
      )
    }
    if (this._state === 'closing') this._state = 'closed'
    this.resolveExited(exit)
  }

  private reportProtocolError(error: CodexAppServerProtocolError): void {
    for (const listener of this.protocolErrorListeners) {
      try {
        listener(error)
      } catch {
        // Protocol diagnostics are observational only.
      }
    }
  }

  private fail(error: Error): void {
    if (this._state === 'closed' || this._state === 'failed') return
    this.terminalError = error
    this._state = 'failed'
    this.serverRequestAbort.abort(error)
    this.rejectPending(error)
    this.outerAbortCleanup?.()
    this.outerAbortCleanup = undefined
  }

  private beginShutdown(error: Error): void {
    this.terminalError ??= error
    this._state = 'closing'
    this.serverRequestAbort.abort(error)
    this.rejectPending(error)
    this.outerAbortCleanup?.()
    this.outerAbortCleanup = undefined
  }

  private rejectPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id)
      pending.cleanup()
      pending.reject(error)
    }
  }

  private async waitForExitWithin(timeoutMs: number): Promise<boolean> {
    if (this.didExit) return true
    if (timeoutMs === 0) return false

    let timer: NodeJS.Timeout | undefined
    const timedOut = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs)
      timer.unref()
    })
    const exited = this.exited.then(() => true as const)
    const result = await Promise.race([exited, timedOut])
    if (timer) clearTimeout(timer)
    return result
  }
}
