import { randomUUID } from 'node:crypto'
import { connect, type Socket } from 'node:net'

/** Private bounded JSON line transport. Unsolicited events never satisfy requests. */
export class JsonChannel {
  private synchronizing = false
  private syncToken?: number
  private syncBytes = 0
  private socket?: Socket
  private buffer = Buffer.alloc(0)
  private pending = new Map<
    string,
    {
      resolve: (value: any) => void
      reject: (error: Error) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  private events = new Map<string, Set<() => void>>()
  private eventFailures = new Set<(error: Error) => void>()
  private greeting?: () => void
  private failGreeting?: (error: Error) => void
  private failure?: Error
  private constructor(
    private readonly timeoutMs: number,
    private readonly maxFrameBytes: number
  ) {}
  static async open(
    path: string,
    qmp = true,
    timeoutMs = 5000,
    maxFrameBytes = 1024 * 1024
  ): Promise<JsonChannel> {
    const channel = new JsonChannel(timeoutMs, maxFrameBytes)
    channel.synchronizing = !qmp
    await new Promise<void>((resolve, reject) => {
      const socket = connect({ path })
      channel.socket = socket
      const timer = setTimeout(() => {
        const error = new Error('Monitor connection timed out')
        channel.fail(error)
        reject(error)
      }, timeoutMs)
      channel.greeting = () => {
        clearTimeout(timer)
        resolve()
      }
      channel.failGreeting = (error) => {
        clearTimeout(timer)
        reject(error)
      }
      socket.on('error', (error) => channel.fail(error))
      socket.on('close', () => channel.fail(new Error('Monitor connection closed')))
      socket.on('data', (data) => channel.consume(data))
      socket.on('connect', () => {
        if (!qmp) channel.greeting?.()
      })
    })
    try {
      if (qmp) await channel.command('qmp_capabilities')
      else {
        channel.syncToken = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER)
        channel.socket!.write(Buffer.from([0xff]))
        const token = await channel.command('guest-sync-delimited', {
          id: channel.syncToken,
        })
        if (token !== channel.syncToken) throw new Error('Guest synchronization token mismatch')
      }
      return channel
    } catch (error) {
      channel.close()
      throw error
    }
  }
  private fail(error: Error) {
    if (this.failure) return
    this.failure = error
    this.failGreeting?.(error)
    for (const item of this.pending.values()) {
      clearTimeout(item.timer)
      item.reject(error)
    }
    this.pending.clear()
    for (const reject of this.eventFailures) reject(error)
    this.eventFailures.clear()
    this.events.clear()
    this.socket?.destroy()
  }
  private consume(data: Buffer) {
    if (this.synchronizing) {
      this.syncBytes += data.length
      if (this.syncBytes > this.maxFrameBytes) {
        this.fail(new Error('Guest synchronization frame exceeds limit'))
        return
      }
      const sentinel = data.indexOf(0xff)
      if (sentinel < 0) return
      data = data.subarray(sentinel + 1)
      this.buffer = Buffer.alloc(0)
      this.synchronizing = false
    }
    // Bound each incoming chunk plus residual before parsing; never buffer indefinitely.
    if (this.buffer.length + data.length > this.maxFrameBytes) {
      this.fail(new Error('Monitor frame exceeds limit'))
      return
    }
    this.buffer = Buffer.concat([this.buffer, data])
    let newline: number
    while ((newline = this.buffer.indexOf(10)) >= 0) {
      const frame = this.buffer.subarray(0, newline)
      this.buffer = this.buffer.subarray(newline + 1)
      let message: any
      try {
        message = JSON.parse(frame.toString('utf8'))
      } catch {
        this.fail(new Error('Invalid monitor JSON'))
        return
      }
      if (!message || typeof message !== 'object' || Array.isArray(message)) {
        this.fail(new Error('Invalid monitor message'))
        return
      }
      if (typeof message.event === 'string')
        for (const listener of this.events.get(message.event) ?? []) listener()
      if (message.QMP) {
        this.greeting?.()
        continue
      }
      if (typeof message.id !== 'string') continue
      const item = this.pending.get(message.id)
      if (!item) continue
      this.pending.delete(message.id)
      clearTimeout(item.timer)
      if (message.error)
        item.reject(new Error(`Monitor rejected command: ${String(message.error.desc ?? 'unknown error')}`))
      else if (Object.hasOwn(message, 'return')) item.resolve(message.return)
      else item.reject(new Error('Invalid monitor reply'))
    }
  }
  async command(execute: string, args?: Record<string, unknown>): Promise<any> {
    if (this.failure) throw this.failure
    if (this.pending.size >= 32) throw new Error('Monitor request limit reached')
    const id = randomUUID()
    const body = JSON.stringify({ execute, ...(args ? { arguments: args } : {}), id }) + '\r\n'
    if (Buffer.byteLength(body) > this.maxFrameBytes) throw new Error('Monitor command exceeds limit')
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(new Error('Monitor command timed out'))
      }, this.timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.socket!.write(body, (error) => {
        if (error) this.fail(error)
      })
    })
  }
  async notify(execute: string, args?: Record<string, unknown>): Promise<void> {
    if (this.failure) throw this.failure
    const body = JSON.stringify({ execute, ...(args ? { arguments: args } : {}) }) + '\r\n'
    if (Buffer.byteLength(body) > this.maxFrameBytes) throw new Error('Monitor command exceeds limit')
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new Error('Monitor write timed out')
        this.fail(error)
        reject(error)
      }, this.timeoutMs)
      this.socket!.write(body, (error) => {
        clearTimeout(timer)
        error ? reject(error) : resolve()
      })
    })
  }
  waitEvent(name: string, timeoutMs = this.timeoutMs): Promise<void> {
    if (this.failure) return Promise.reject(this.failure)
    if (this.eventFailures.size >= 32) return Promise.reject(new Error('Monitor event limit reached'))
    return new Promise((resolve, reject) => {
      const listeners = this.events.get(name) ?? new Set<() => void>()
      this.events.set(name, listeners)
      const listener = () => {
        clearTimeout(timer)
        listeners.delete(listener)
        this.eventFailures.delete(fail)
        resolve()
      }
      const fail = (error: Error) => {
        clearTimeout(timer)
        listeners.delete(listener)
        this.eventFailures.delete(fail)
        reject(error)
      }
      const timer = setTimeout(() => fail(new Error(`Monitor event ${name} timed out`)), timeoutMs)
      this.eventFailures.add(fail)
      listeners.add(listener)
    })
  }
  close() {
    this.fail(new Error('Monitor channel closed'))
  }
}
