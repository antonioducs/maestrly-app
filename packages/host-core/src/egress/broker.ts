import { lstat } from 'node:fs/promises'
import { connect, type Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import { EGRESS_LIMITS, permitsDomain, type NetworkPolicy } from '@maestrly/host-protocol'
import { decide } from './policy.js'
import { pinnedConnect, systemDialer, systemLookup, type Dialer, type Lookup } from './resolver.js'
import { guestEgressFrameSchema, LineDecoder, STREAM_WINDOW, type HostEgressFrame } from './streams.js'

interface Stream {
  id: number
  host: string
  socket?: Socket
  outstandingToGuest: number
  outstandingToRemote: number
  idle?: ReturnType<typeof setTimeout>
  closed: boolean
}
interface Attachment {
  vmId: string
  channel: Duplex
  key: string
  sessionId?: string
  policy: NetworkPolicy
  streams: Map<number, Stream>
  decoder: LineDecoder
  pendingBytes: number
}
export interface EgressBrokerOptions {
  lookup?: Lookup
  dialer?: Dialer
  hostAddresses?: readonly string[]
  /** Injection seam: open the guest channel from a path (tests use socket pairs). */
  openChannel?: (path: string) => Promise<Socket>
}
/**
 * The only path from a guest to the internet. No command, file, QMP or listener surface:
 * a guest can request TCP streams to policy-approved exact hostnames on 80/443, nothing else.
 */
export class EgressBroker {
  private attachments = new Map<string, Attachment>()
  private readonly lookup: Lookup
  private readonly dialer: Dialer
  private readonly hostAddresses?: readonly string[]
  private readonly openChannel: (path: string) => Promise<Socket>
  constructor(options: EgressBrokerOptions = {}) {
    this.lookup = options.lookup ?? systemLookup
    this.dialer = options.dialer ?? systemDialer
    this.hostAddresses = options.hostAddresses
    this.openChannel =
      options.openChannel ??
      (async (path) => {
        const stat = await lstat(path)
        if (!stat.isSocket() || stat.uid !== process.getuid?.()) throw new Error('Egress socket ownership mismatch')
        return new Promise((resolve, reject) => {
          const socket = connect({ path })
          socket.once('error', reject)
          socket.once('connect', () => {
            socket.off('error', reject)
            resolve(socket)
          })
        })
      })
  }
  activeStreams(vmId: string, sessionId?: string) {
    return [...this.attachments.values()].filter(a => a.vmId === vmId && (sessionId === undefined || a.sessionId === sessionId)).reduce((n, a) => n + a.streams.size, 0)
  }
  private pendingForVm(vmId: string) { return [...this.attachments.values()].filter(a => a.vmId === vmId).reduce((n, a) => n + a.pendingBytes, 0) }
  private resumeVm(vmId: string) {
    if (this.pendingForVm(vmId) > EGRESS_LIMITS.pendingBytesPerVm / 2) return
    for (const a of this.attachments.values()) if (a.vmId === vmId)
      for (const s of a.streams.values()) if (s.socket && s.outstandingToGuest <= STREAM_WINDOW / 2) s.socket.resume()
  }
  hasSession(vmId: string, sessionId: string) { return this.attachments.has(`${vmId}:${sessionId}`) }
  bindSession(vmId: string, sessionId: string, channel: Duplex, policy: NetworkPolicy) { this.bindChannel(vmId, `${vmId}:${sessionId}`, channel, policy, sessionId) }
  detachSession(vmId: string, sessionId: string) { this.detachKey(`${vmId}:${sessionId}`) }
  attach(vmId: string, path: string, policy: NetworkPolicy) {
    if (this.attachments.has(vmId)) return
    void this.openChannel(path)
      .then((channel) => this.bind(vmId, channel, policy))
      .catch(() => {
        // Guest without a runtime never opens the port; fail closed and retry on the next attach.
      })
  }
  /** Tests and in-process runtimes bind an already-open socket. */
  bind(vmId: string, channel: Socket, policy: NetworkPolicy) { this.bindChannel(vmId, vmId, channel, policy) }
  private bindChannel(vmId: string, key: string, channel: Duplex, policy: NetworkPolicy, sessionId?: string) {
    if (this.attachments.has(key)) {
      channel.destroy()
      return
    }
    const attachment: Attachment = { vmId, key, sessionId, channel, policy, streams: new Map(), decoder: new LineDecoder(), pendingBytes: 0 }
    this.attachments.set(key, attachment)
    channel.on('data', (chunk: Buffer) => {
      try {
        for (const line of attachment.decoder.push(chunk)) this.handle(attachment, guestEgressFrameSchema.parse(JSON.parse(line)))
      } catch {
        this.detachKey(key)
      }
    })
    channel.on('error', () => this.detachKey(key))
    channel.on('close', () => this.detachKey(key))
    this.send(attachment, { t: 'policy', revision: policy.revision, mode: policy.mode })
  }
  detach(vmId: string) {
    for (const a of this.attachments.values()) if (a.vmId === vmId) this.detachKey(a.key)
  }
  private detachKey(key: string) {
    const attachment = this.attachments.get(key)
    if (!attachment) return
    this.attachments.delete(key)
    for (const stream of attachment.streams.values()) this.closeStream(attachment, stream, false)
    attachment.channel.destroy()
  }
  /** Revocation ends existing streams to removed destinations and denies new ones. */
  updatePolicy(vmId: string, policy: NetworkPolicy, sessionId?: string) {
    const attachment = this.attachments.get(sessionId ? `${vmId}:${sessionId}` : vmId)
    if (!attachment) return
    attachment.policy = policy
    for (const stream of attachment.streams.values())
      if (!permitsDomain(policy, stream.host)) this.closeStream(attachment, stream, true)
    this.send(attachment, { t: 'policy', revision: policy.revision, mode: policy.mode })
  }
  close() {
    for (const key of [...this.attachments.keys()]) this.detachKey(key)
  }
  private send(attachment: Attachment, frame: HostEgressFrame) {
    if (attachment.channel.destroyed) return
    attachment.channel.write(JSON.stringify(frame) + '\n')
  }
  private touch(attachment: Attachment, stream: Stream) {
    if (stream.idle) clearTimeout(stream.idle)
    stream.idle = setTimeout(() => this.closeStream(attachment, stream, true), EGRESS_LIMITS.idleTimeoutMs)
    stream.idle.unref?.()
  }
  private handle(attachment: Attachment, frame: ReturnType<typeof guestEgressFrameSchema.parse>) {
    const stream = attachment.streams.get(frame.s)
    switch (frame.t) {
      case 'open': {
        if (stream) return this.send(attachment, { t: 'refused', s: frame.s, code: 'DUPLICATE', message: 'Stream id in use' })
        if (attachment.streams.size >= (attachment.sessionId ? 8 : EGRESS_LIMITS.streamsPerVm) || this.activeStreams(attachment.vmId) >= EGRESS_LIMITS.streamsPerVm) return this.send(attachment, { t: 'refused', s: frame.s, code: 'LIMIT', message: 'Too many streams' })
        const decision = decide(attachment.policy, frame.host, frame.port)
        if ('code' in decision) return this.send(attachment, { t: 'refused', s: frame.s, code: decision.code, message: decision.message })
        const created: Stream = { id: frame.s, host: decision.host, outstandingToGuest: 0, outstandingToRemote: 0, closed: false }
        attachment.streams.set(frame.s, created)
        this.touch(attachment, created)
        void pinnedConnect(decision.host, decision.port, this.lookup, this.dialer, this.hostAddresses)
          .then((socket) => {
            if (created.closed || attachment.streams.get(frame.s) !== created) {
              socket.destroy()
              return
            }
            // Re-check policy after the connect delay: a revocation in between must win.
            if ('code' in decide(attachment.policy, created.host, decision.port)) {
              socket.destroy()
              this.closeStream(attachment, created, true)
              return
            }
            created.socket = socket
            socket.on('data', (chunk: Buffer) => {
              this.touch(attachment, created)
              for (let offset = 0; offset < chunk.length; offset += EGRESS_LIMITS.dataFrameBytes) {
                const slice = chunk.subarray(offset, offset + EGRESS_LIMITS.dataFrameBytes)
                created.outstandingToGuest += slice.length
                attachment.pendingBytes += slice.length
                this.send(attachment, { t: 'data', s: created.id, d: slice.toString('base64') })
              }
              if (created.outstandingToGuest > STREAM_WINDOW || this.pendingForVm(attachment.vmId) > EGRESS_LIMITS.pendingBytesPerVm) socket.pause()
            })
            socket.on('end', () => this.send(attachment, { t: 'end', s: created.id }))
            socket.on('error', () => this.closeStream(attachment, created, true))
            socket.on('close', () => this.closeStream(attachment, created, true))
            this.send(attachment, { t: 'opened', s: created.id })
          })
          .catch((error: Error) => {
            attachment.streams.delete(frame.s)
            if (created.idle) clearTimeout(created.idle)
            const code = /^[A-Z_]+:/.exec(error.message)?.[0].slice(0, -1) ?? 'CONNECT_FAILED'
            this.send(attachment, { t: 'refused', s: frame.s, code, message: error.message.slice(0, 400) })
          })
        return
      }
      case 'data': {
        if (!stream?.socket || stream.closed) return
        const bytes = Buffer.from(frame.d, 'base64')
        stream.outstandingToRemote += bytes.length
        if (stream.outstandingToRemote > STREAM_WINDOW * 2) return this.closeStream(attachment, stream, true)
        this.touch(attachment, stream)
        stream.socket.write(bytes, () => {
          stream.outstandingToRemote -= bytes.length
          this.send(attachment, { t: 'ack', s: stream.id, n: bytes.length })
        })
        return
      }
      case 'ack': {
        if (!stream) return
        if (frame.n > stream.outstandingToGuest) return this.closeStream(attachment, stream, true)
        stream.outstandingToGuest = Math.max(0, stream.outstandingToGuest - frame.n)
        attachment.pendingBytes = Math.max(0, attachment.pendingBytes - frame.n)
        this.resumeVm(attachment.vmId)
        return
      }
      case 'end':
        if (stream?.socket && !stream.closed) stream.socket.end()
        return
      case 'close':
        if (stream) this.closeStream(attachment, stream, false)
        return
    }
  }
  private closeStream(attachment: Attachment, stream: Stream, notify: boolean) {
    if (stream.closed) return
    stream.closed = true
    if (stream.idle) clearTimeout(stream.idle)
    attachment.pendingBytes = Math.max(0, attachment.pendingBytes - stream.outstandingToGuest)
    attachment.streams.delete(stream.id)
    this.resumeVm(attachment.vmId)
    stream.socket?.destroy()
    if (notify) this.send(attachment, { t: 'close', s: stream.id })
  }
}
