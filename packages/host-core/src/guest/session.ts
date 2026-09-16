import { TEAM_LIMITS, delegatedCredentialSchema, type CollaborationRequest, type DelegatedCredential, type VmRequest, type VmSessionInfo } from '@maestrly/host-protocol'
import { connect } from 'node:net'
import { randomUUID } from 'node:crypto'
import { lstat } from 'node:fs/promises'
import type { Duplex } from 'node:stream'
import {
  CONTROL_FRAME_MAX,
  CONTROL_QUEUE_MAX,
  GUEST_PROTOCOL,
  guestFrameSchema,
  type GuestEvent,
  type HostToGuestRequest,
  type BotSession,
  type SessionCapacity,
} from '@maestrly/host-protocol'
import { HostError } from '../errors.js'

export type GuestRequestParams<M extends HostToGuestRequest['method']> = Extract<HostToGuestRequest, { method: M }>['params']
export interface GuestSession {
  readonly vmId: string
  readonly sessionId: string
  readonly bootId: string
  readonly generation: number
  readonly runtimeVersion: string
  readonly capabilities: readonly string[]
  request<M extends HostToGuestRequest['method']>(method: M, params: GuestRequestParams<M>, timeoutMs?: number): Promise<unknown>
  /** Events are delivered in order; the listener calls ack only after durable persistence. */
  onEvent(listener: (event: GuestEvent, ack: () => void) => void): () => void
  onClose(listener: (error: Error) => void): () => void
  setAccountHandler?(handler: (forceRefresh: boolean, credentialHash?: string) => Promise<DelegatedCredential>): void
  /**
   * Handles a collaboration request from the working guest. The Host derives who is acting
   * from this authenticated session; the frame never names a bot, a team or a role.
   */
  setCollaborationHandler?(handler: (request: CollaborationRequest) => Promise<Record<string, unknown>>): void
  readonly alive: boolean
  close(): void
}
export interface GuestConnector {
  connect(input: { vmId: string; sessionId: string; hostGeneration: number; transport: 'legacy' | 'managed' }): Promise<GuestSession>
  inspectVm?(vmId: string): Promise<{ capacity?: SessionCapacity; capabilities?: string[]; runtimeVersion?: string }>
  createSession?(session: BotSession, idempotencyKey: string): Promise<{ id: string; botId: string; generation: number }>
  stopSession?(session: BotSession, idempotencyKey: string): Promise<void>
  renewSessionLease?(session: BotSession, turnId: string, leaseMs: number): Promise<void>
  releaseSessionLease?(session: BotSession, turnId: string): Promise<void>
  /** Live supervisor view of a managed session (generation and state). */
  inspectSession?(session: BotSession): Promise<VmSessionInfo>
  /** Fixed desktop requests to the guest supervisor; there is no generic passthrough. */
  desktop?(session: BotSession, method: DesktopVmMethod, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown>
  /** Opens one RFB stream on the private media lane for a grant created by desktop.viewer.open. */
  openDesktopMedia?(session: BotSession, generation: number, grantId: string): Promise<Duplex>
  dropDesktop?(vmId: string): void
}
export type DesktopVmMethod = Extract<VmRequest['method'], `desktop.${string}`>
type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }

/** Host side of the private virtio-serial control channel. Rejects stale or foreign frames. */
export class SocketGuestSession implements GuestSession {
  sessionId = randomUUID()
  bootId = ''
  generation = 0
  runtimeVersion = ''
  capabilities: string[] = []
  alive = true
  private accountHandler?: (forceRefresh: boolean, credentialHash?: string) => Promise<DelegatedCredential>
  private accountPending = false
  setAccountHandler(handler: (forceRefresh: boolean, credentialHash?: string) => Promise<DelegatedCredential>) { this.accountHandler = handler }
  private collaborationHandler?: (request: CollaborationRequest) => Promise<Record<string, unknown>>
  private collaborationPending = 0
  setCollaborationHandler(handler: (request: CollaborationRequest) => Promise<Record<string, unknown>>) { this.collaborationHandler = handler }
  private buffer = Buffer.alloc(0)
  private pending = new Map<string, Pending>()
  private eventListeners = new Set<(event: GuestEvent, ack: () => void) => void>()
  private closeListeners = new Set<(error: Error) => void>()
  private queue: GuestEvent[] = []
  private handshake?: { resolve: () => void; reject: (error: Error) => void }
  private constructor(
    readonly vmId: string,
    private readonly socket: Duplex,
    private readonly hostGeneration: number,
    private readonly timeoutMs: number
  ) {}
  static async open(vmId: string, path: string, hostGeneration: number, timeoutMs = 15_000): Promise<SocketGuestSession> {
    const stat = await lstat(path)
    if (!stat.isSocket() || stat.uid !== process.getuid?.()) throw new HostError('RUNTIME_UNREACHABLE', 'Guest control socket ownership mismatch')
    const socket = connect({ path })
    return SocketGuestSession.fromStream(vmId, socket, hostGeneration, timeoutMs)
  }
  static async fromStream(vmId: string, socket: Duplex, hostGeneration: number, timeoutMs = 15_000): Promise<SocketGuestSession> {
    const session = new SocketGuestSession(vmId, socket, hostGeneration, timeoutMs)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        session.fail(new HostError('RUNTIME_UNREACHABLE', 'Guest runtime did not answer the handshake'))
      }, timeoutMs)
      session.handshake = {
        resolve: () => {
          clearTimeout(timer)
          resolve()
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      }
      socket.on('error', (error) => session.fail(error))
      socket.on('close', () => session.fail(new HostError('RUNTIME_UNREACHABLE', 'Guest control channel closed')))
      socket.on('data', (data) => session.consume(data))
      socket.on('connect', () => {
        // The guest speaks first with hello; a stale runtime from a previous boot cannot reuse our nonce.
      })
    })
    return session
  }
  private consume(data: Buffer) {
    if (this.buffer.length + data.length > CONTROL_FRAME_MAX) {
      this.fail(new HostError('RUNTIME_PROTOCOL', 'Guest control frame exceeds limit'))
      return
    }
    this.buffer = Buffer.concat([this.buffer, data])
    let newline: number
    while ((newline = this.buffer.indexOf(10)) >= 0) {
      const line = this.buffer.subarray(0, newline)
      this.buffer = this.buffer.subarray(newline + 1)
      let frame: ReturnType<typeof guestFrameSchema.parse>
      try {
        frame = guestFrameSchema.parse(JSON.parse(line.toString('utf8')))
      } catch {
        this.fail(new HostError('RUNTIME_PROTOCOL', 'Invalid guest control frame'))
        return
      }
      if (frame.type === 'hello') {
        if (this.handshake === undefined) {
          this.fail(new HostError('RUNTIME_RESTARTED', 'Guest runtime restarted; reconnect and reconcile pending work'))
          return
        }
        if (frame.protocol !== GUEST_PROTOCOL) {
          this.fail(new HostError('RUNTIME_INCOMPATIBLE', 'Guest runtime protocol mismatch'))
          return
        }
        this.bootId = frame.bootId
        this.generation = frame.generation
        this.runtimeVersion = frame.runtimeVersion
        this.capabilities = frame.capabilities
        // The welcome echoes the guest nonce so a stale runtime cannot pair with an old host reply.
        this.write({ type: 'welcome', protocol: GUEST_PROTOCOL, sessionId: this.sessionId, nonce: frame.nonce, hostGeneration: this.hostGeneration })
        const handshake = this.handshake
        this.handshake = undefined
        handshake.resolve()
        continue
      }
      if (this.handshake !== undefined) {
        this.fail(new HostError('RUNTIME_PROTOCOL', 'Guest sent frames before hello'))
        return
      }
      if (frame.type === 'account.request') {
        const id = frame.id
        if (this.accountPending || !this.accountHandler) {
          this.write({ type: 'account.response', id, error: { code: 'ACCOUNT_UNAVAILABLE' } })
          continue
        }
        this.accountPending = true
        void this.accountHandler(frame.forceRefresh, frame.credentialHash).then(credential => {
          if (this.alive) this.write({ type: 'account.response', id, credential: delegatedCredentialSchema.parse(credential) })
        }).catch(error => {
          if (this.alive) this.write({ type: 'account.response', id, error: { code: error instanceof HostError && ['ACCOUNT_REQUIRED', 'ACCOUNT_REVOKED'].includes(error.code) ? error.code : 'ACCOUNT_UNAVAILABLE' } })
        }).finally(() => { this.accountPending = false })
        continue
      }
      if (frame.type === 'collaboration.request') {
        const id = frame.id
        // Bounded concurrency: collaboration must never starve account renewal, leases,
        // cancellation or the live screen on the same channel.
        if (!this.collaborationHandler || this.collaborationPending >= TEAM_LIMITS.requestsInFlightMax) {
          this.write({ type: 'collaboration.response', id, error: { code: 'TEAM_BUSY', message: 'Colaboração indisponível nesta execução' } })
          continue
        }
        this.collaborationPending++
        void this.collaborationHandler(frame)
          .then((result) => {
            if (this.alive) this.write({ type: 'collaboration.response', id, result })
          })
          .catch((error) => {
            if (this.alive)
              this.write({
                type: 'collaboration.response',
                id,
                error: { code: error instanceof HostError ? error.code : 'TEAM_STAGE_INVALID', message: String(error?.message ?? 'Ação indisponível').slice(0, 400) },
              })
          })
          .finally(() => {
            this.collaborationPending--
          })
        continue
      }
      if (frame.type === 'response') {
        const item = this.pending.get(frame.id)
        if (!item) continue
        this.pending.delete(frame.id)
        clearTimeout(item.timer)
        if (frame.error) item.reject(new HostError(frame.error.code, frame.error.message))
        else item.resolve(frame.result)
        continue
      }
      if (this.queue.length >= CONTROL_QUEUE_MAX) {
        this.fail(new HostError('RUNTIME_PROTOCOL', 'Guest event queue overflow'))
        return
      }
      this.queue.push(frame)
      if (this.queue.length === 1) this.deliver()
    }
  }
  private deliver() {
    const event = this.queue[0]
    if (!event) return
    let acked = false
    const ack = () => {
      if (acked) return
      acked = true
      this.write({ type: 'ack', runtimeEventId: event.runtimeEventId })
      this.queue.shift()
      this.deliver()
    }
    if (!this.eventListeners.size) {
      // Without a listener the event stays queued and unacked; the runtime will redeliver after reconnect.
      return
    }
    for (const listener of this.eventListeners) listener(event, ack)
  }
  onEvent(listener: (event: GuestEvent, ack: () => void) => void) {
    this.eventListeners.add(listener)
    if (this.queue.length) this.deliver()
    return () => this.eventListeners.delete(listener)
  }
  onClose(listener: (error: Error) => void) {
    this.closeListeners.add(listener)
    return () => this.closeListeners.delete(listener)
  }
  private write(frame: unknown) {
    const body = JSON.stringify(frame) + '\n'
    if (Buffer.byteLength(body) > CONTROL_FRAME_MAX) throw new HostError('RUNTIME_PROTOCOL', 'Host control frame exceeds limit')
    this.socket.write(body, (error) => {
      if (error) this.fail(error)
    })
  }
  request<M extends HostToGuestRequest['method']>(method: M, params: GuestRequestParams<M>, timeoutMs = this.timeoutMs): Promise<unknown> {
    if (!this.alive) return Promise.reject(new HostError('RUNTIME_UNREACHABLE', 'Guest control channel is closed'))
    if (this.pending.size >= CONTROL_QUEUE_MAX) return Promise.reject(new HostError('RUNTIME_BUSY', 'Guest request limit reached'))
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(new HostError('RUNTIME_TIMEOUT', `Guest request ${method} timed out; outcome unknown`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.write({ type: 'request', id, method, params })
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error as Error)
      }
    })
  }
  private fail(error: Error) {
    if (!this.alive) return
    this.alive = false
    this.handshake?.reject(error)
    this.handshake = undefined
    for (const item of this.pending.values()) {
      clearTimeout(item.timer)
      item.reject(error)
    }
    this.pending.clear()
    this.queue = []
    this.socket.destroy()
    for (const listener of this.closeListeners) listener(error)
    this.closeListeners.clear()
  }
  close() {
    this.fail(new HostError('RUNTIME_UNREACHABLE', 'Guest control channel closed by host'))
  }
}
