import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { Socket } from 'node:net'
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { Duplex } from 'node:stream'

export const VIEW_PROTOCOL = 'maestrly.desktop.v1'
export const VIEW_PATH = '/desktop'
export const VIEW_HEADER = 'x-maestrly-view'
const TICKET_PREFIX = 'mdt.'
const MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const MESSAGE_MAX = 1024 * 1024
const FRAME_MAX = 64 * 1024
const TICKET_MS = 30_000
type Ticket = { webContentsId: number; expiresAt: number; onConnect: (channel: WebSocketChannel) => void }
const digest = (value: string) => createHash('sha256').update(value).digest('hex')

/**
 * Server half of one WebSocket connection (RFC 6455): binary messages only, masked
 * client frames, bounded messages, and backpressure in both directions.
 */
export class WebSocketChannel extends Duplex {
  private buffer: Buffer = Buffer.alloc(0)
  private fragments: Buffer[] = []
  private fragmentBytes = 0
  private closing = false
  constructor(private readonly socket: Socket, head: Buffer) {
    super({ allowHalfOpen: false })
    this.on('error', () => {})
    socket.setNoDelay(true)
    socket.on('data', (chunk: Buffer) => this.consume(chunk))
    socket.on('error', () => this.destroy())
    socket.once('close', () => this.destroy())
    if (head.length) queueMicrotask(() => this.consume(head))
  }
  private consume(chunk: Buffer) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk
    try {
      for (;;) {
        if (this.buffer.length < 2) return
        const fin = (this.buffer[0] & 0x80) !== 0
        const rsv = this.buffer[0] & 0x70
        const opcode = this.buffer[0] & 0x0f
        const masked = (this.buffer[1] & 0x80) !== 0
        let length = this.buffer[1] & 0x7f
        let offset = 2
        if (rsv || !masked) return this.fail(1002)
        if (length === 126) {
          if (this.buffer.length < 4) return
          length = this.buffer.readUInt16BE(2)
          offset = 4
        } else if (length === 127) {
          if (this.buffer.length < 10) return
          const high = this.buffer.readUInt32BE(2)
          length = this.buffer.readUInt32BE(6)
          if (high !== 0) return this.fail(1009)
          offset = 10
        }
        if (length > MESSAGE_MAX) return this.fail(1009)
        if (this.buffer.length < offset + 4 + length) return
        const mask = this.buffer.subarray(offset, offset + 4)
        const payload = Buffer.from(this.buffer.subarray(offset + 4, offset + 4 + length))
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3]
        this.buffer = this.buffer.subarray(offset + 4 + length)
        if (opcode >= 8) {
          if (!fin || length > 125) return this.fail(1002)
          if (opcode === 8) return this.fail(1000)
          if (opcode === 9) this.frame(10, payload)
          continue
        }
        if (opcode === 1) return this.fail(1003)
        if (opcode === 2 && this.fragments.length) return this.fail(1002)
        if (opcode === 0 && !this.fragments.length) return this.fail(1002)
        if (opcode !== 0 && opcode !== 2) return this.fail(1002)
        this.fragmentBytes += payload.length
        if (this.fragmentBytes > MESSAGE_MAX) return this.fail(1009)
        this.fragments.push(payload)
        if (!fin) continue
        const message = this.fragments.length === 1 ? this.fragments[0] : Buffer.concat(this.fragments)
        this.fragments = []
        this.fragmentBytes = 0
        if (message.length && !this.push(message)) this.socket.pause()
      }
    } catch {
      this.fail(1011)
    }
  }
  private frame(opcode: number, payload: Buffer) {
    const header = payload.length < 126 ? Buffer.alloc(2) : payload.length < 65536 ? Buffer.alloc(4) : Buffer.alloc(10)
    header[0] = 0x80 | opcode
    if (payload.length < 126) header[1] = payload.length
    else if (payload.length < 65536) {
      header[1] = 126
      header.writeUInt16BE(payload.length, 2)
    } else {
      header[1] = 127
      header.writeUInt32BE(0, 2)
      header.writeUInt32BE(payload.length, 6)
    }
    return this.socket.write(Buffer.concat([header, payload]))
  }
  private fail(code: number) {
    if (this.closing) return
    this.closing = true
    const payload = Buffer.alloc(2)
    payload.writeUInt16BE(code, 0)
    if (!this.socket.destroyed) this.frame(8, payload)
    this.socket.end()
    this.destroy()
  }
  override _read() {
    this.socket.resume()
  }
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    if (this.closing || this.socket.destroyed) return callback(new Error('Desktop view closed'))
    let drained = true
    for (let offset = 0; offset < chunk.length; offset += FRAME_MAX) drained = this.frame(2, chunk.subarray(offset, offset + FRAME_MAX))
    if (drained) callback()
    else this.socket.once('drain', () => callback())
  }
  override _destroy(error: Error | null, callback: (error?: Error | null) => void) {
    this.socket.destroy()
    callback(error)
  }
  close() {
    this.fail(1000)
  }
}

/**
 * Loopback-only WebSocket endpoint feeding noVNC. Upgrades require the exact Host header
 * and path, an allowed renderer Origin, a single-use ticket carried in the subprotocol
 * (never the URL) and a header the main process injects only into its own renderer.
 */
export class DesktopViewServer {
  private server?: Server
  private tickets = new Map<string, Ticket>()
  private channels = new Map<number, Set<WebSocketChannel>>()
  private readonly headerKey = randomBytes(32)
  port = 0
  constructor(
    private readonly options: {
      origins: () => string[]
      alive: (webContentsId: number) => boolean
      clock?: () => number
    }
  ) {}
  private now() {
    return (this.options.clock ?? Date.now)()
  }
  async start() {
    if (this.server) return
    const server = createServer((_request, response) => {
      response.writeHead(404, { Connection: 'close' })
      response.end()
    })
    server.on('upgrade', (request, socket: Socket, head: Buffer) => this.upgrade(request, socket, head))
    server.on('clientError', (_error, socket) => socket.destroy())
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      // The OS assigns the port; nothing scans for a free one and nothing binds 0.0.0.0.
      server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => resolve())
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Desktop view server has no address')
    this.port = address.port
    this.server = server
  }
  /** Value the main process adds to its own renderer's WebSocket request. */
  binding(webContentsId: number) {
    return `${webContentsId}.${createHmac('sha256', this.headerKey).update(String(webContentsId)).digest('hex')}`
  }
  private verifyBinding(value: string | string[] | undefined, webContentsId: number) {
    if (typeof value !== 'string') return false
    const expected = Buffer.from(this.binding(webContentsId))
    const actual = Buffer.from(value)
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  }
  issue(webContentsId: number, onConnect: (channel: WebSocketChannel) => void) {
    if (!this.server) throw new Error('Desktop view server not started')
    for (const [key, ticket] of this.tickets) if (ticket.expiresAt <= this.now()) this.tickets.delete(key)
    const ticket = randomBytes(32).toString('hex')
    this.tickets.set(digest(ticket), { webContentsId, onConnect, expiresAt: this.now() + TICKET_MS })
    return { url: `ws://127.0.0.1:${this.port}${VIEW_PATH}`, protocols: [VIEW_PROTOCOL, `${TICKET_PREFIX}${ticket}`] }
  }
  private refuse(socket: Socket) {
    if (!socket.destroyed) socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
    socket.destroy()
  }
  private upgrade(request: IncomingMessage, socket: Socket, head: Buffer) {
    socket.on('error', () => socket.destroy())
    const protocols = String(request.headers['sec-websocket-protocol'] ?? '').split(',').map((value) => value.trim())
    const offered = protocols.find((value) => value.startsWith(TICKET_PREFIX))
    const key = request.headers['sec-websocket-key']
    const token = offered?.slice(TICKET_PREFIX.length) ?? ''
    // Consume the ticket first: a failed attempt burns it.
    const ticket = /^[a-f0-9]{64}$/.test(token) ? this.tickets.get(digest(token)) : undefined
    if (ticket) this.tickets.delete(digest(token))
    const valid =
      !!ticket &&
      ticket.expiresAt > this.now() &&
      request.url === VIEW_PATH &&
      request.headers.host === `127.0.0.1:${this.port}` &&
      String(request.headers.upgrade).toLowerCase() === 'websocket' &&
      request.headers['sec-websocket-version'] === '13' &&
      typeof key === 'string' &&
      Buffer.from(key, 'base64').length === 16 &&
      protocols.includes(VIEW_PROTOCOL) &&
      this.options.origins().includes(String(request.headers.origin ?? '')) &&
      this.verifyBinding(request.headers[VIEW_HEADER], ticket.webContentsId) &&
      this.options.alive(ticket.webContentsId)
    if (!valid || !ticket || typeof key !== 'string') return this.refuse(socket)
    const accept = createHash('sha1').update(key + MAGIC).digest('base64')
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: ${VIEW_PROTOCOL}\r\n\r\n`)
    const channel = new WebSocketChannel(socket, head)
    const owned = this.channels.get(ticket.webContentsId) ?? new Set()
    owned.add(channel)
    this.channels.set(ticket.webContentsId, owned)
    channel.once('close', () => owned.delete(channel))
    ticket.onConnect(channel)
  }
  /** A renderer went away: its pending tickets and open sockets end with it. */
  revoke(webContentsId: number) {
    for (const [key, ticket] of this.tickets) if (ticket.webContentsId === webContentsId) this.tickets.delete(key)
    for (const channel of this.channels.get(webContentsId) ?? []) channel.destroy()
    this.channels.delete(webContentsId)
  }
  async close() {
    this.tickets.clear()
    for (const owned of this.channels.values()) for (const channel of owned) channel.destroy()
    this.channels.clear()
    const server = this.server
    this.server = undefined
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}
