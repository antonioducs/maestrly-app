/**
 * Minimal Agent Client Protocol client: JSON-RPC 2.0 over the agent's stdio, one message per line.
 *
 * The agent runs in its own process group (POSIX) so closing the client also reaps helper processes it spawned.
 * stderr is kept only as a bounded tail for diagnostics and is never logged verbatim by this module.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import readline from 'node:readline'
import { killProcessTree } from '../../platform'
import { ACP_PROTOCOL_VERSION, type AcpInitializeResult } from './protocol'

export interface AcpClientOptions {
  command: string
  args: readonly string[]
  cwd: string
  env: NodeJS.ProcessEnv
  clientInfo: { name: string; version: string }
  /** Maximum stderr tail kept in memory; defaults to 64 KiB. */
  stderrLimitBytes?: number
}

export class AcpRpcError extends Error {
  readonly code: number
  readonly data?: unknown

  constructor(message: string, code: number, data?: unknown) {
    super(message)
    this.name = 'AcpRpcError'
    this.code = code
    this.data = data
  }
}

export class AcpProcessExitedError extends Error {
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null

  constructor(exitCode: number | null, signal: NodeJS.Signals | null, reason?: string) {
    super(reason ?? `ACP agent exited (${exitCode ?? signal ?? 'unknown'}).`)
    this.name = 'AcpProcessExitedError'
    this.exitCode = exitCode
    this.signal = signal
  }
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
  cleanup: () => void
}

type NotificationListener = (method: string, params: unknown) => void
type RequestHandler = (params: unknown) => Promise<unknown>

interface JsonRpcMessage {
  jsonrpc?: string
  id?: number | string | null
  method?: string
  params?: unknown
  result?: unknown
  error?: { code?: number; message?: string; data?: unknown }
}

const DEFAULT_STDERR_LIMIT = 65_536
const DEFAULT_CLOSE_GRACE_MS = 3_000

/**
 * Reaps helpers left in an exited agent's POSIX process group. Unlike `killProcessTree`, it never falls back to the
 * bare pid, which may already belong to an unrelated process; a live group id cannot be reused.
 */
function killExitedProcessGroup(pid: number | undefined): void {
  if (!pid || process.platform === 'win32') return
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    // No process left in the group.
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })
}

export class AcpClient {
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
  private readonly child: ChildProcess
  private readonly stderrLimit: number
  private readonly pending = new Map<number, PendingRequest>()
  private readonly listeners = new Set<NotificationListener>()
  private readonly handlers = new Map<string, RequestHandler>()
  private nextId = 1
  private stderr = ''
  private exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null = null
  private spawnError: Error | null = null

  private constructor(child: ChildProcess, stderrLimit: number) {
    this.child = child
    this.stderrLimit = stderrLimit
    this.exited = new Promise((resolve) => {
      const finish = (code: number | null, signal: NodeJS.Signals | null) => {
        if (this.exitInfo) return
        this.exitInfo = { code, signal }
        const error = new AcpProcessExitedError(code, signal, this.spawnError?.message)
        for (const request of this.pending.values()) {
          request.cleanup()
          request.reject(error)
        }
        this.pending.clear()
        // Helper processes may outlive the agent; the process group is reaped with it.
        killExitedProcessGroup(child.pid)
        resolve(this.exitInfo)
      }
      child.once('exit', finish)
      child.once('error', (error) => {
        this.spawnError = error
        finish(null, null)
      })
    })
    child.stdin?.on('error', () => {
      // EPIPE after the agent exits is reported through `exited`.
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-this.stderrLimit)
    })
    if (child.stdout) {
      readline.createInterface({ input: child.stdout }).on('line', (line) => this.receive(line))
    }
  }

  static async start(
    options: AcpClientOptions,
    signal?: AbortSignal
  ): Promise<{ client: AcpClient; initialize: AcpInitializeResult }> {
    if (signal?.aborted) throw abortReason(signal)
    const child = spawn(options.command, [...options.args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    })
    const client = new AcpClient(child, options.stderrLimitBytes ?? DEFAULT_STDERR_LIMIT)
    try {
      const initialize = await client.request<AcpInitializeResult>(
        'initialize',
        {
          protocolVersion: ACP_PROTOCOL_VERSION,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
          clientInfo: options.clientInfo,
        },
        { signal }
      )
      return { client, initialize }
    } catch (error) {
      await client.close(0)
      throw error
    }
  }

  get alive(): boolean {
    return this.exitInfo === null
  }

  get pid(): number | undefined {
    return this.child.pid
  }

  request<T>(method: string, params: unknown, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
    if (!this.alive) {
      return Promise.reject(new AcpProcessExitedError(this.exitInfo?.code ?? null, this.exitInfo?.signal ?? null))
    }
    const { signal, timeoutMs } = options
    if (signal?.aborted) return Promise.reject(abortReason(signal))
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined
      const onAbort = () => {
        this.pending.get(id)?.cleanup()
        this.pending.delete(id)
        reject(abortReason(signal as AbortSignal))
      }
      const cleanup = () => {
        if (timer) clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
      }
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, cleanup })
      signal?.addEventListener('abort', onAbort, { once: true })
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          cleanup()
          this.pending.delete(id)
          reject(new Error(`ACP request ${method} timed out after ${timeoutMs} ms.`))
        }, timeoutMs)
      }
      this.write({ jsonrpc: '2.0', id, method, params })
    })
  }

  notify(method: string, params: unknown): void {
    if (this.alive) this.write({ jsonrpc: '2.0', method, params })
  }

  onNotification(listener: NotificationListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  setRequestHandler(method: string, handler: RequestHandler): void {
    this.handlers.set(method, handler)
  }

  stderrTail(): string {
    return this.stderr
  }

  /** Ends stdin, waits for a graceful exit, then kills the whole process tree. */
  async close(gracePeriodMs = DEFAULT_CLOSE_GRACE_MS): Promise<void> {
    const pid = this.child.pid
    if (this.alive) {
      this.child.stdin?.end()
      let timer: NodeJS.Timeout | undefined
      const graceful = await Promise.race([
        this.exited.then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), gracePeriodMs)
        }),
      ])
      if (timer) clearTimeout(timer)
      if (!graceful && pid && this.alive) await killProcessTree(pid)
    }
    await this.exited
    // Reap helpers left in the agent's process group even after a clean exit.
    killExitedProcessGroup(pid)
  }

  private write(message: JsonRpcMessage): void {
    try {
      this.child.stdin?.write(`${JSON.stringify(message)}\n`)
    } catch {
      // The exit handler rejects pending requests.
    }
  }

  private receive(line: string): void {
    const text = line.trim()
    if (!text) return
    let message: JsonRpcMessage
    try {
      message = JSON.parse(text) as JsonRpcMessage
    } catch {
      return
    }
    if (!message || typeof message !== 'object') return
    if (typeof message.method === 'string') {
      if (message.id === undefined || message.id === null) {
        for (const listener of [...this.listeners]) {
          try {
            listener(message.method, message.params)
          } catch {
            // A faulty listener must not break the transport.
          }
        }
        return
      }
      void this.answer(message.id, message.method, message.params)
      return
    }
    if (typeof message.id !== 'number') return
    const request = this.pending.get(message.id)
    if (!request) return
    this.pending.delete(message.id)
    request.cleanup()
    if (message.error) {
      request.reject(
        new AcpRpcError(
          message.error.message ?? 'ACP request failed.',
          message.error.code ?? -32603,
          message.error.data
        )
      )
    } else {
      request.resolve(message.result)
    }
  }

  private async answer(id: number | string, method: string, params: unknown): Promise<void> {
    const handler = this.handlers.get(method)
    if (!handler) {
      this.write({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } })
      return
    }
    try {
      this.write({ jsonrpc: '2.0', id, result: (await handler(params)) ?? null })
    } catch (error) {
      this.write({
        jsonrpc: '2.0',
        id,
        error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
      })
    }
  }
}
