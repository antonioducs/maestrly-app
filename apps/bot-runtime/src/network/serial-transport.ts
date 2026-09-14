import { Duplex } from 'node:stream'
import { EGRESS_LIMITS } from '@maestrly/host-protocol'
import { z } from 'zod'
import { FrameDecoder } from '../control/framing.js'
import { openControlTransport } from '../control/transport.js'
import { runtimeError } from '../turns/service.js'

export const STREAM_WINDOW = 512 * 1024
export const EGRESS_FRAME_MAX = 80 * 1024
const id = z
  .number()
  .int()
  .nonnegative()
  .max(2 ** 31)
const hostFrame = z.discriminatedUnion('t', [
  z.strictObject({ t: z.literal('opened'), s: id }),
  z.strictObject({ t: z.literal('refused'), s: id, code: z.string().max(40), message: z.string().max(400) }),
  z.strictObject({ t: z.literal('data'), s: id, d: z.string().max(65540) }),
  z.strictObject({ t: z.literal('end'), s: id }),
  z.strictObject({ t: z.literal('close'), s: id }),
  z.strictObject({ t: z.literal('ack'), s: id, n: z.number().int().positive().max(STREAM_WINDOW) }),
  z.strictObject({
    t: z.literal('policy'),
    revision: z.number().int().nonnegative(),
    mode: z.enum(['offline', 'allowlist', 'blocklist']),
  }),
])
type Callback = (error?: Error | null) => void
export class EgressStream extends Duplex {
  outstanding = 0
  private pending?: { bytes: Buffer; offset: number; callback: Callback }
  private unacked = 0
  constructor(
    readonly id: number,
    private transport: EgressTransport
  ) {
    super({ allowHalfOpen: true, highWaterMark: EGRESS_LIMITS.dataFrameBytes })
    this.on('error', () => {})
  }
  override _read() {}
  override emit(event: string | symbol, ...args: unknown[]): boolean {
    const emitted = super.emit(event, ...args)
    // Readable emits data only when bytes leave its queue, including explicit read().
    if (event === 'data' && (Buffer.isBuffer(args[0]) || typeof args[0] === 'string')) {
      const n = Math.min(this.unacked, Buffer.byteLength(args[0]))
      if (n) {
        this.unacked -= n
        this.transport.received -= n
        this.transport.send({ t: 'ack', s: this.id, n })
      }
    }
    return emitted
  }
  receive(bytes: Buffer) {
    this.emit('activity')
    this.unacked += bytes.length
    this.transport.received += bytes.length
    if (this.transport.received > EGRESS_LIMITS.pendingBytesPerVm) {
      this.destroy(runtimeError('LIMIT', 'Receive buffer exceeded'))
      return
    }
    this.push(bytes)
  }
  override _write(bytes: Buffer, _encoding: BufferEncoding, callback: Callback) {
    this.pending = { bytes, offset: 0, callback }
    this.flush()
  }
  flush() {
    const pending = this.pending
    if (!pending || this.destroyed) return
    while (pending.offset < pending.bytes.length) {
      const length = Math.min(
        EGRESS_LIMITS.dataFrameBytes,
        STREAM_WINDOW - this.outstanding,
        EGRESS_LIMITS.pendingBytesPerVm - this.transport.outstanding,
        pending.bytes.length - pending.offset
      )
      if (length <= 0) return
      const bytes = pending.bytes.subarray(pending.offset, pending.offset + length)
      this.outstanding += length
      this.transport.outstanding += length
      pending.offset += length
      this.transport.send({ t: 'data', s: this.id, d: bytes.toString('base64') })
      this.emit('activity')
    }
    this.pending = undefined
    pending.callback()
  }
  acknowledge(n: number) {
    if (n > this.outstanding) {
      this.destroy(runtimeError('PROTOCOL', 'Invalid acknowledgement'))
      return
    }
    this.outstanding -= n
    this.transport.outstanding -= n
    this.transport.flush()
  }
  override _final(callback: Callback) {
    this.transport.send({ t: 'end', s: this.id })
    callback()
  }
  override _destroy(error: Error | null, callback: Callback) {
    this.transport.outstanding -= this.outstanding
    this.transport.received -= this.unacked
    this.outstanding = this.unacked = 0
    this.transport.release(this.id, error ?? runtimeError('CLOSED', 'Egress stream closed'))
    this.transport.send({ t: 'close', s: this.id })
    const pending = this.pending
    this.pending = undefined
    pending?.callback(error ?? runtimeError('CLOSED', 'Egress stream closed'))
    callback(error)
    this.transport.flush()
  }
}
interface Opening {
  resolve: (stream: EgressStream) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}
export class EgressTransport {
  hostPolicyRevision = 0
  outstanding = 0
  received = 0
  private channel?: Duplex
  private streams = new Map<number, EgressStream>()
  private openings = new Map<number, Opening>()
  private nextId = 0
  private stopped = true
  private retry?: NodeJS.Timeout
  private backoff = 100
  constructor(readonly path = process.env.MAESTRLY_BOT_EGRESS_PATH ?? '/dev/virtio-ports/org.maestrly.bot.egress.0') {}
  get connected() {
    return !!this.channel && !this.channel.destroyed
  }
  async start() {
    this.stopped = false
    await this.connect()
  }
  private async connect() {
    try {
      const channel = await openControlTransport(this.path)
      if (this.stopped) {
        channel.destroy()
        return
      }
      this.channel = channel
      this.backoff = 100
      const decoder = new FrameDecoder(EGRESS_FRAME_MAX)
      channel.on('data', (chunk: Buffer) => {
        try {
          for (const raw of decoder.push(chunk)) {
            const frame = hostFrame.parse(raw)
            if (frame.t === 'policy') {
              this.hostPolicyRevision = frame.revision
              continue
            }
            const stream = this.streams.get(frame.s)
            if (!stream) continue
            const opening = this.openings.get(frame.s)
            if (frame.t === 'opened' && opening) {
              clearTimeout(opening.timer)
              this.openings.delete(frame.s)
              opening.resolve(stream)
            } else if (frame.t === 'refused') {
              this.release(frame.s, runtimeError(frame.code, frame.message))
              stream.destroy()
            } else if (frame.t === 'data') {
              const bytes = Buffer.from(frame.d, 'base64')
              if (bytes.length > EGRESS_LIMITS.dataFrameBytes || bytes.toString('base64') !== frame.d)
                throw new Error('Invalid data frame')
              stream.receive(bytes)
            } else if (frame.t === 'ack') stream.acknowledge(frame.n)
            else if (frame.t === 'end') stream.push(null)
            else if (frame.t === 'close') stream.destroy()
          }
        } catch {
          channel.destroy()
        }
      })
      channel.on('error', () => channel.destroy())
      channel.once('close', () => {
        if (this.channel !== channel) return
        this.channel = undefined
        for (const stream of [...this.streams.values()])
          stream.destroy(runtimeError('EGRESS_UNAVAILABLE', 'Egress channel disconnected'))
        this.schedule()
      })
    } catch {
      this.schedule()
    }
  }
  private schedule() {
    if (this.stopped || this.retry) return
    this.retry = setTimeout(() => {
      this.retry = undefined
      void this.connect()
    }, this.backoff)
    this.retry.unref()
    this.backoff = Math.min(this.backoff * 2, 10_000)
  }
  open(host: string, port: number): Promise<EgressStream> {
    if (!this.connected) return Promise.reject(runtimeError('EGRESS_UNAVAILABLE', 'Egress channel is not connected'))
    if (this.streams.size >= EGRESS_LIMITS.streamsPerVm)
      return Promise.reject(runtimeError('LIMIT', 'Too many tunnels'))
    if (this.nextId > 2 ** 31) return Promise.reject(runtimeError('LIMIT', 'Stream ids exhausted; restart required'))
    const stream = new EgressStream(this.nextId++, this)
    this.streams.set(stream.id, stream)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => stream.destroy(runtimeError('CONNECT_TIMEOUT', 'Egress connect timed out')),
        EGRESS_LIMITS.connectTimeoutMs
      )
      this.openings.set(stream.id, { resolve, reject, timer })
      this.send({ t: 'open', s: stream.id, host, port })
    })
  }
  release(id: number, error: Error = runtimeError('CLOSED', 'Egress stream closed')) {
    const opening = this.openings.get(id)
    if (opening) {
      clearTimeout(opening.timer)
      opening.reject(error)
      this.openings.delete(id)
    }
    this.streams.delete(id)
  }
  send(frame: unknown) {
    if (!this.connected) return
    if ((this.channel?.writableLength ?? 0) > EGRESS_LIMITS.pendingBytesPerVm * 2) {
      this.channel?.destroy()
      return
    }
    this.channel?.write(JSON.stringify(frame) + '\n')
  }
  flush() {
    for (const stream of this.streams.values()) stream.flush()
  }
  close() {
    this.stopped = true
    clearTimeout(this.retry)
    this.retry = undefined
    this.channel?.destroy()
    for (const stream of [...this.streams.values()]) stream.destroy()
  }
}
