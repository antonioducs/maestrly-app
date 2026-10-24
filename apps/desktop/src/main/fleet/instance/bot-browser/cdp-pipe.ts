import type { Readable, Writable } from 'node:stream'

/** An event of the DevTools protocol: of the browser itself, or of one attached target's session. */
export interface CdpEvent {
  method: string
  params: Record<string, unknown>
  sessionId?: string
}

/** A command the connection cannot carry any more: Chromium exited or closed its end of the pipe. */
export class CdpPipeClosedError extends Error {
  constructor(reason: string) {
    super(`The bot's Chromium is not running: ${reason}`)
    this.name = 'CdpPipeClosedError'
  }
}

export interface CdpPipeOptions {
  /** How long a command may go unanswered; the page operations have shorter deadlines of their own. */
  commandTimeoutMs?: number
  /** The largest message accepted (a full-page screenshot is a few megabytes); a larger one ends the connection. */
  maxMessageBytes?: number
  setTimeout?: typeof setTimeout
  clearTimeout?: typeof clearTimeout
}

interface Pending {
  method: string
  resolve(value: unknown): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}

export const CDP_COMMAND_TIMEOUT_MS = 60_000
export const CDP_MAX_MESSAGE_BYTES = 64 * 1024 * 1024

/**
 * One connection to a Chromium's DevTools through `--remote-debugging-pipe`: JSON messages, each ended by a NUL byte,
 * written to the browser's fd 3 and read from its fd 4. No port is opened, so nothing else in the container can drive
 * the browser. Every command has a deadline, and every pending command fails at once when the connection ends.
 */
export class CdpPipe {
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private readonly eventListeners = new Set<(event: CdpEvent) => void>()
  private readonly closeListeners = new Set<(error: CdpPipeClosedError) => void>()
  private chunks: Buffer[] = []
  private bufferedBytes = 0
  private closedWith: CdpPipeClosedError | null = null
  private readonly commandTimeoutMs: number
  private readonly maxMessageBytes: number
  private readonly setTimer: typeof setTimeout
  private readonly clearTimer: typeof clearTimeout

  constructor(
    private readonly output: Writable,
    input: Readable,
    options: CdpPipeOptions = {}
  ) {
    this.commandTimeoutMs = options.commandTimeoutMs ?? CDP_COMMAND_TIMEOUT_MS
    this.maxMessageBytes = options.maxMessageBytes ?? CDP_MAX_MESSAGE_BYTES
    this.setTimer = options.setTimeout ?? setTimeout
    this.clearTimer = options.clearTimeout ?? clearTimeout
    input.on('data', (chunk: Buffer | string) => this.receive(typeof chunk === 'string' ? Buffer.from(chunk) : chunk))
    input.once('end', () => this.close('the DevTools pipe ended'))
    input.once('close', () => this.close('the DevTools pipe closed'))
    input.on('error', (error: Error) => this.close(`the DevTools pipe failed (${error.message})`))
    output.on('error', (error: Error) => this.close(`the DevTools pipe failed (${error.message})`))
  }

  get closed(): boolean {
    return this.closedWith !== null
  }

  /** Sends a command to the browser, or to the attached target whose session id is given. */
  send<T = any>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
    timeoutMs?: number
  ): Promise<T> {
    if (this.closedWith) return Promise.reject(this.closedWith)
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = this.setTimer(() => {
        if (!this.pending.delete(id)) return
        reject(
          new Error(`${method} got no answer from the bot's Chromium within ${timeoutMs ?? this.commandTimeoutMs} ms`)
        )
      }, timeoutMs ?? this.commandTimeoutMs)
      ;(timer as { unref?: () => void }).unref?.()
      this.pending.set(id, { method, resolve: resolve as (value: unknown) => void, reject, timer })
      try {
        this.output.write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`)
      } catch (error) {
        this.close(`the DevTools pipe failed (${(error as Error).message})`)
      }
    })
  }

  onEvent(listener: (event: CdpEvent) => void): () => void {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  /** Called once, when the connection ends; at once when it already has. */
  onClose(listener: (error: CdpPipeClosedError) => void): () => void {
    if (this.closedWith) {
      listener(this.closedWith)
      return () => {}
    }
    this.closeListeners.add(listener)
    return () => this.closeListeners.delete(listener)
  }

  /** Ends the connection: pending and later commands fail with the reason. */
  close(reason = 'the connection was closed'): void {
    if (this.closedWith) return
    const error = new CdpPipeClosedError(reason)
    this.closedWith = error
    this.chunks = []
    this.bufferedBytes = 0
    for (const pending of this.pending.values()) {
      this.clearTimer(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
    for (const listener of [...this.closeListeners]) listener(error)
    this.closeListeners.clear()
    this.eventListeners.clear()
  }

  /** Ends the connection like `close`, then writes one last command: nothing the browser sends afterwards is read. */
  closeWith(method: string, reason: string): void {
    if (this.closedWith) return
    this.close(reason)
    try {
      this.output.write(`${JSON.stringify({ id: this.nextId++, method, params: {} })}\0`)
    } catch {
      /* The browser already closed its end. */
    }
  }

  private receive(chunk: Buffer): void {
    if (this.closedWith) return
    let start = 0
    for (let end = chunk.indexOf(0); end !== -1; end = chunk.indexOf(0, start)) {
      const part = chunk.subarray(start, end)
      const message =
        this.chunks.length === 0 ? part : Buffer.concat([...this.chunks, part], this.bufferedBytes + part.length)
      this.chunks = []
      this.bufferedBytes = 0
      start = end + 1
      this.dispatch(message.toString('utf8'))
      if (this.closedWith) return
    }
    if (start < chunk.length) {
      const rest = chunk.subarray(start)
      this.bufferedBytes += rest.length
      if (this.bufferedBytes > this.maxMessageBytes) {
        this.close(`a DevTools message went over ${this.maxMessageBytes} bytes`)
        return
      }
      this.chunks.push(rest)
    }
  }

  private dispatch(text: string): void {
    let message: {
      id?: unknown
      method?: unknown
      params?: unknown
      sessionId?: unknown
      result?: unknown
      error?: unknown
    }
    try {
      message = JSON.parse(text)
    } catch {
      return
    }
    if (typeof message.id === 'number') {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      this.clearTimer(pending.timer)
      if (message.error && typeof message.error === 'object') {
        const { message: text } = message.error as { message?: unknown }
        pending.reject(new Error(typeof text === 'string' && text ? text : `${pending.method} failed`))
      } else pending.resolve(message.result ?? {})
      return
    }
    if (typeof message.method !== 'string') return
    const event: CdpEvent = {
      method: message.method,
      params: message.params && typeof message.params === 'object' ? (message.params as Record<string, unknown>) : {},
      ...(typeof message.sessionId === 'string' ? { sessionId: message.sessionId } : {}),
    }
    for (const listener of [...this.eventListeners]) {
      try {
        listener(event)
      } catch {
        /* One listener's failure never stops the others or the connection. */
      }
    }
  }
}
