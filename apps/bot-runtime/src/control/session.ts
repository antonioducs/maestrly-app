import { accountCredentialResponseSchema, type DelegatedCredential } from '@maestrly/host-protocol'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { Duplex } from 'node:stream'
import { z } from 'zod'
import {
  CONTROL_QUEUE_MAX,
  GUEST_PROTOCOL,
  guestHelloSchema,
  guestResponseSchema,
  hostAckSchema,
  hostToGuestRequestSchema,
  hostWelcomeSchema,
  type HostToGuestRequest,
} from '@maestrly/host-protocol'
import { encodeFrame, FrameDecoder } from './framing.js'
import type { Journal } from './journal.js'
export type HandlerMap = {
  [M in HostToGuestRequest['method']]: (
    params: Extract<HostToGuestRequest, { method: M }>['params']
  ) => unknown | Promise<unknown>
}
export class ControlSession {
  private ready = false
  private closed = false
  private inFlight = new Set<string>()
  private decoder = new FrameDecoder()
  private unsubscribe: () => void = () => {}
  private writes = Promise.resolve()
  private requests = 0
  private accountPromise?: Promise<DelegatedCredential>
  private accountRequests = new Map<string, { resolve: (value: DelegatedCredential) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>()
  readonly nonce = randomBytes(16).toString('hex')
  readonly done: Promise<void>
  private finish!: () => void
  private timer?: NodeJS.Timeout
  constructor(
    private stream: Duplex,
    private journal: Journal,
    private handlers: HandlerMap
  ) {
    this.done = new Promise((resolve) => {
      this.finish = resolve
    })
  }
  async start(options: { version: string; capabilities: string[]; bootId?: string }) {
    const bootId = z
      .string()
      .uuid()
      .parse(
        options.bootId ??
          process.env.MAESTRLY_BOT_BOOT_ID ??
          (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim()
      )
    this.stream.on('error', () => this.close())
    this.stream.on('close', () => this.close())
    this.stream.on('end', () => this.close())
    this.stream.on('data', (chunk: Buffer) => {
      try {
        for (const frame of this.decoder.push(chunk)) this.consume(frame)
      } catch {
        this.close()
      }
    })
    this.timer = setTimeout(() => this.close(), 15_000)
    this.send(
      guestHelloSchema.parse({
        type: 'hello',
        protocol: GUEST_PROTOCOL,
        runtimeVersion: options.version,
        bootId,
        generation: this.journal.nextGeneration(),
        nonce: this.nonce,
        capabilities: options.capabilities,
      })
    )
    this.unsubscribe = this.journal.onEvent(() => this.pump())
  }
  private consume(value: unknown) {
    if (this.closed) return
    const frame = value as Record<string, unknown>
    if (!frame || typeof frame !== 'object') return this.close()
    if (frame.type === 'welcome') {
      if (this.ready) return
      const parsed = hostWelcomeSchema.safeParse(frame)
      if (!parsed.success || parsed.data.nonce !== this.nonce) return this.close()
      this.ready = true
      clearTimeout(this.timer)
      this.pump()
      return
    }
    if (!this.ready) return this.close()
    if (frame.type === 'account.response') {
      const parsed = accountCredentialResponseSchema.safeParse(frame)
      if (!parsed.success) return this.close()
      const pending = this.accountRequests.get(parsed.data.id)
      if (!pending) return
      this.accountRequests.delete(parsed.data.id)
      clearTimeout(pending.timer)
      if (parsed.data.credential && !parsed.data.error) pending.resolve(parsed.data.credential)
      else pending.reject(Object.assign(new Error('Shared account is unavailable'), { code: parsed.data.error?.code ?? 'ACCOUNT_UNAVAILABLE' }))
      return
    }
    if (frame.type === 'ack') {
      const ack = hostAckSchema.safeParse(frame)
      if (!ack.success) return this.close()
      if (this.inFlight.delete(ack.data.runtimeEventId)) this.journal.ack(ack.data.runtimeEventId)
      this.pump()
      return
    }
    if (frame.type !== 'request') return this.close()
    const request = hostToGuestRequestSchema.safeParse(frame)
    if (!request.success) {
      const response = guestResponseSchema.safeParse({
        type: 'response',
        id: frame.id,
        error: { code: 'INVALID_REQUEST', message: 'Invalid request method or parameters' },
      })
      if (response.success) this.send(response.data)
      else this.close()
      return
    }
    if (++this.requests > CONTROL_QUEUE_MAX) return this.close()
    const { id, method, params } = request.data
    // Request execution must remain concurrent: cancellation resolves an outstanding turn operation.
    void Promise.resolve()
      .then(() => {
        if (this.closed) return undefined
        const handler = this.handlers[method] as (params: HostToGuestRequest['params']) => unknown
        return handler(params)
      })
      .then(
        (result) => this.send({ type: 'response', id, result }),
        (error) =>
          this.send({
            type: 'response',
            id,
            error: {
              code: typeof error?.code === 'string' ? error.code.slice(0, 64) : 'RUNTIME_ERROR',
              message: 'Request could not be completed',
            },
          })
      )
      .finally(() => {
        this.requests--
      })
  }
  private pump() {
    if (!this.ready || this.closed) return
    for (const event of this.journal.pendingEvents()) {
      if (this.inFlight.size >= CONTROL_QUEUE_MAX) break
      if (this.inFlight.has(event.runtimeEventId)) continue
      this.inFlight.add(event.runtimeEventId)
      this.send(event)
    }
  }
  private send(frame: unknown) {
    if (this.closed) return
    const bytes = encodeFrame(frame)
    this.writes = this.writes
      .then(
        () =>
          new Promise<void>((resolve, reject) => {
            if (this.closed) return resolve()
            this.stream.write(bytes, (error) => (error ? reject(error) : resolve()))
          })
      )
      .catch(() => this.close())
  }
  requestAccount(forceRefresh: boolean, credentialHash?: string): Promise<DelegatedCredential> {
    if (!this.ready || this.closed) return Promise.reject(new Error('Account channel unavailable'))
    if (this.accountPromise) return this.accountPromise
    const id = randomUUID()
    const pending = new Promise<DelegatedCredential>((resolve, reject) => {
      const timer = setTimeout(() => { this.accountRequests.delete(id); reject(new Error('Account refresh timed out')) }, 9000)
      this.accountRequests.set(id, { resolve, reject, timer })
      this.send({ type: 'account.request', id, forceRefresh, ...(credentialHash ? { credentialHash } : {}) })
    })
    this.accountPromise = pending
    void pending.finally(() => { if (this.accountPromise === pending) this.accountPromise = undefined }).catch(() => {})
    return pending
  }
  close() {
    if (this.closed) return
    this.closed = true
    clearTimeout(this.timer)
    this.unsubscribe()
    for (const pending of this.accountRequests.values()) { clearTimeout(pending.timer); pending.reject(new Error('Account channel closed')) }
    this.accountRequests.clear()
    this.stream.destroy()
    this.finish()
  }
}
