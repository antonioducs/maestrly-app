import { createServer, type IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import type { Socket } from 'node:net'
import { EGRESS_LIMITS, permitsDomain, isExactHostname, type NetworkPolicy } from '@maestrly/host-protocol'
import { runtimeError } from '../turns/service.js'
import type { EgressStream, EgressTransport } from './serial-transport.js'

export class LocalProxy {
  private policy: NetworkPolicy = { mode: 'offline', domains: [], revision: 0 }
  private tunnels = new Map<Duplex, { host: string; stream?: EgressStream }>()
  private server = createServer()
  constructor(
    private transport: EgressTransport,
    readonly port = Number(process.env.MAESTRLY_BOT_PROXY_PORT ?? 3128)
  ) {
    // Refused CONNECT clients can reset before a tunnel is registered.
    this.server.on('connection', (socket) => socket.on('error', () => socket.destroy()))
    this.server.on('connect', (request, socket, head) => {
      void this.connect(request, socket, head)
    })
    this.server.on('request', (request, response) => {
      // Raw response bytes are forwarded to the socket, so detach the HTTP response writer.
      response.shouldKeepAlive = false
      void this.request(request, request.socket)
    })
    this.server.on('clientError', (_error, socket) =>
      this.refuse(socket, runtimeError('INVALID_REQUEST', 'Malformed proxy request'))
    )
  }
  updatePolicy(policy: NetworkPolicy) {
    this.policy = policy
    for (const [socket, tunnel] of this.tunnels) {
      if (!permitsDomain(policy, tunnel.host)) {
        tunnel.stream?.destroy()
        socket.destroy()
      }
    }
  }
  async start() {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(this.port, '127.0.0.1', () => {
        this.server.off('error', reject)
        resolve()
      })
    })
  }
  get address() {
    return this.server.address()
  }
  private check(host: string, port: number) {
    if (host === 'localhost' || host.endsWith('.localhost') || /^127\./.test(host) || ['::1', '[::1]'].includes(host))
      throw runtimeError('LOCAL_ONLY', 'Guest-local destinations must be accessed directly')
    if (this.policy.mode === 'offline') throw runtimeError('OFFLINE', 'Network policy is offline')
    if (!isExactHostname(host))
      throw runtimeError('INVALID_HOST', 'An exact hostname is required; IP literals are refused')
    if (port !== 80 && port !== 443) throw runtimeError('PORT_DENIED', 'Only ports 80 and 443 are allowed')
    if (!permitsDomain(this.policy, host))
      throw runtimeError('DOMAIN_DENIED', 'Hostname is blocked by network policy')
    if (this.tunnels.size >= EGRESS_LIMITS.streamsPerVm) throw runtimeError('LIMIT', 'Too many concurrent tunnels')
  }
  private async open(socket: Duplex, host: string, port: number) {
    this.check(host, port)
    const tunnel: { host: string; stream?: EgressStream } = { host }
    this.tunnels.set(socket, tunnel)
    socket.on('error', () => socket.destroy())
    socket.once('close', () => {
      tunnel.stream?.destroy()
      this.tunnels.delete(socket)
    })
    try {
      const stream = await this.transport.open(host, port)
      tunnel.stream = stream
      if (socket.destroyed) {
        stream.destroy()
        throw runtimeError('CLOSED', 'Client disconnected')
      }
      this.checkAfterConnect(host)
      stream.once('error', () => socket.destroy())
      stream.once('close', () => socket.destroy())
      let timer: NodeJS.Timeout
      const touch = () => {
        clearTimeout(timer)
        timer = setTimeout(() => {
          stream.destroy()
          socket.destroy()
        }, EGRESS_LIMITS.idleTimeoutMs)
        timer.unref()
      }
      stream.on('activity', touch)
      stream.once('close', () => clearTimeout(timer))
      touch()
      return stream
    } catch (error) {
      tunnel.stream?.destroy()
      this.tunnels.delete(socket)
      throw error
    }
  }
  private checkAfterConnect(host: string) {
    if (this.policy.mode === 'offline' || !permitsDomain(this.policy, host))
      throw runtimeError('DOMAIN_DENIED', 'Network policy changed during connection')
  }
  private async connect(request: IncomingMessage, socket: Duplex, head: Buffer) {
    try {
      const target = new URL('http://' + request.url)
      if (target.username || target.password || target.pathname !== '/')
        throw runtimeError('INVALID_REQUEST', 'Invalid CONNECT authority')
      const stream = await this.open(socket, target.hostname.toLowerCase(), Number(target.port || 80))
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) stream.write(head)
      socket.pipe(stream).pipe(socket)
    } catch (error) {
      this.refuse(socket, error)
    }
  }
  private async request(request: IncomingMessage, socket: Socket) {
    try {
      const target = new URL(request.url ?? '')
      if (target.protocol !== 'http:' || target.username || target.password || (target.port && target.port !== '80'))
        throw runtimeError('INVALID_REQUEST', 'Plain proxy requests require an absolute HTTP URI on port 80')
      const stream = await this.open(socket, target.hostname.toLowerCase(), 80)
      const headers: string[] = []
      for (let index = 0; index < request.rawHeaders.length; index += 2) {
        const name = request.rawHeaders[index]
        if (
          !['connection', 'proxy-connection', 'proxy-authorization', 'host', 'transfer-encoding'].includes(
            name.toLowerCase()
          )
        )
          headers.push(name + ': ' + request.rawHeaders[index + 1])
      }
      headers.push('Host: ' + target.host, 'Connection: close')
      const chunked = request.headers['transfer-encoding'] !== undefined
      if (chunked) headers.push('Transfer-Encoding: chunked')
      stream.write(
        request.method +
          ' ' +
          (target.pathname || '/') +
          target.search +
          ' HTTP/' +
          request.httpVersion +
          '\r\n' +
          headers.join('\r\n') +
          '\r\n\r\n'
      )
      stream.pipe(socket)
      if (chunked) {
        request.on('data', (bytes: Buffer) => {
          if (
            !stream.write(Buffer.concat([Buffer.from(bytes.length.toString(16) + '\r\n'), bytes, Buffer.from('\r\n')]))
          )
            request.pause()
        })
        stream.on('drain', () => request.resume())
        request.once('end', () => stream.end('0\r\n\r\n'))
      } else request.pipe(stream)
    } catch (error) {
      this.refuse(socket, error)
    }
  }
  private refuse(socket: Duplex, error: unknown) {
    const value = error as { code?: string; message?: string }
    const body = JSON.stringify({
      code: value.code ?? 'PROXY_ERROR',
      message: value.message ?? 'Proxy request refused',
    })
    if (!socket.destroyed)
      socket.end(
        'HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ' +
          Buffer.byteLength(body) +
          '\r\n\r\n' +
          body
      )
  }
  async close() {
    for (const socket of this.tunnels.keys()) socket.destroy()
    if (this.server.listening) await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }
}
