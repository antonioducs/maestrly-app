import { randomUUID } from 'node:crypto'
import { Duplex } from 'node:stream'
import { routeFrameSchema, VM_ROUTE_CHUNK, VM_ROUTE_LIMIT, type RouteFrame } from '@maestrly/host-protocol'
import type { JsonWire } from './json-wire.js'

type Identity = { sessionId: string; generation: number; connectionId: string }
type Done = (error?: Error | null) => void
/** One acknowledged packet per route bounds buffers and gives other sessions turns on the wire. */
export class RoutedStream extends Duplex {
  private tx = 0
  private rx = 0
  private waiting?: { sequence: number; resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  private deferredAck?: number
  private opened = false
  private openingTimer?: NodeJS.Timeout
  private remoteClosed = false
  readonly ready: Promise<void>
  private resolveReady!: () => void
  private rejectReady!: (error: Error) => void
  constructor(readonly identity: Identity, private send: (f: RouteFrame) => void, private release: () => void, readonly timeoutMs = 15000) {
    super({ highWaterMark: VM_ROUTE_CHUNK, allowHalfOpen: true })
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject })
    this.ready.catch(() => {})
    this.on('error', () => {})
    this.openingTimer = setTimeout(() => this.destroy(new Error('Session route timed out')), timeoutMs)
  }
  private frame(type: 'route.ready' | 'route.close' | 'route.end'): RouteFrame { return { type, ...this.identity } }
  markReady() {
    if (this.destroyed || this.opened) return
    this.opened = true
    clearTimeout(this.openingTimer)
    this.resolveReady()
  }
  override _read() {
    if (this.deferredAck !== undefined) {
      const sequence = this.deferredAck
      this.deferredAck = undefined
      this.send({ type: 'route.ack', ...this.identity, sequence })
    }
  }
  receive(frame: RouteFrame) {
    if (this.destroyed) return
    if (frame.sessionId !== this.identity.sessionId || frame.generation !== this.identity.generation) return this.destroy(new Error('Session route identity mismatch'))
    if (frame.type === 'route.ready') return this.markReady()
    if (frame.type === 'route.close') { this.remoteClosed = true; this.destroy(); return }
    if (!this.opened) return this.destroy(new Error('Session data before route ready'))
    if (frame.type === 'route.data') {
      const bytes = Buffer.from(frame.data, 'base64')
      if (frame.sequence !== this.rx || this.deferredAck !== undefined || !bytes.length || bytes.length > VM_ROUTE_CHUNK || bytes.toString('base64') !== frame.data)
        return this.destroy(new Error('Invalid session packet'))
      this.rx++
      if (this.push(bytes)) this.send({ type: 'route.ack', ...this.identity, sequence: frame.sequence })
      else this.deferredAck = frame.sequence
    } else if (frame.type === 'route.ack') {
      const waiting = this.waiting
      if (!waiting || waiting.sequence !== frame.sequence) return this.destroy(new Error('Invalid session acknowledgement'))
      this.waiting = undefined
      clearTimeout(waiting.timer)
      waiting.resolve()
    } else if (frame.type === 'route.end') this.push(null)
  }
  override _write(bytes: Buffer, _encoding: BufferEncoding, callback: Done) {
    void this.writePackets(bytes).then(() => callback(), callback)
  }
  private async writePackets(bytes: Buffer) {
    await this.ready
    for (let offset = 0; offset < bytes.length; offset += VM_ROUTE_CHUNK) {
      if (this.destroyed) throw new Error('Session route closed')
      const sequence = this.tx++
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => this.destroy(new Error('Session acknowledgement timed out; do not replay')), this.timeoutMs)
        this.waiting = { sequence, resolve, reject, timer }
        try { this.send({ type: 'route.data', ...this.identity, sequence, data: bytes.subarray(offset, offset + VM_ROUTE_CHUNK).toString('base64') }) }
        catch (error) { this.destroy(error as Error) }
      })
    }
  }
  override _final(callback: Done) {
    try { this.send(this.frame('route.end')); callback() } catch (error) { callback(error as Error) }
  }
  override _destroy(error: Error | null, callback: Done) {
    clearTimeout(this.openingTimer)
    this.rejectReady(error ?? new Error('Session route closed'))
    if (this.waiting) { clearTimeout(this.waiting.timer); this.waiting.reject(error ?? new Error('Session route closed')); this.waiting = undefined }
    this.release()
    if (!this.remoteClosed) try { this.send(this.frame('route.close')) } catch { /* physical channel already closed */ }
    callback(error)
  }
}
export class SessionRouter {
  private routes = new Map<string, RoutedStream>()
  constructor(private wire: JsonWire, private accept?: (identity: Identity) => boolean, private onRoute?: (stream: RoutedStream) => void) {
    wire.on('frame', (raw: unknown) => {
      if (!raw || typeof raw !== 'object' || !('type' in raw) || typeof raw.type !== 'string' || !raw.type.startsWith('route.')) return
      const frame = routeFrameSchema.parse(raw)
      if (frame.type === 'route.open') {
        if (!this.accept?.(frame) || this.routes.size >= VM_ROUTE_LIMIT || [...this.routes.values()].some(s => s.identity.sessionId === frame.sessionId)) {
          wire.send({ type: 'route.close', sessionId: frame.sessionId, generation: frame.generation, connectionId: frame.connectionId }); return
        }
        const stream = this.make(frame)
        stream.markReady()
        wire.send({ type: 'route.ready', ...stream.identity })
        this.onRoute?.(stream)
      } else this.routes.get(frame.connectionId)?.receive(frame)
    })
    wire.on('close', () => this.close())
  }
  private make(identity: Identity) {
    const stream = new RoutedStream({ sessionId: identity.sessionId, generation: identity.generation, connectionId: identity.connectionId }, f => this.wire.send(f), () => this.routes.delete(identity.connectionId))
    this.routes.set(identity.connectionId, stream)
    return stream
  }
  async open(sessionId: string, generation: number): Promise<RoutedStream> {
    if (this.routes.size >= VM_ROUTE_LIMIT || [...this.routes.values()].some(s => s.identity.sessionId === sessionId)) throw new Error('Session route already open or limit reached')
    const stream = this.make({ sessionId, generation, connectionId: randomUUID() })
    this.wire.send({ type: 'route.open', ...stream.identity })
    await stream.ready
    return stream
  }
  closeSession(sessionId: string) { for (const s of this.routes.values()) if (s.identity.sessionId === sessionId) s.destroy() }
  close() { for (const stream of this.routes.values()) stream.destroy() }
}
