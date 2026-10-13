import { once } from 'node:events'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'
import { BridgeProxy, type BridgeProxyDeps } from '../src/bridge.js'

const servers: http.Server[] = []
const sockets: WebSocket[] = []
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate()
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

async function listen(server: http.Server): Promise<number> {
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return (server.address() as AddressInfo).port
}

/** A workspaces environment's control server: it accepts the bridge with the control token and echoes messages. */
async function environment() {
  const upgrades: http.IncomingHttpHeaders[] = []
  const wss = new WebSocketServer({ noServer: true })
  const server = http.createServer()
  server.on('upgrade', (req, socket, head) => {
    upgrades.push(req.headers)
    if (
      req.url !== '/v1/bridge' ||
      req.headers.authorization !== 'Bearer ctl' ||
      req.headers['x-maestrly-fleet-protocol'] !== '1'
    )
      return socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n')
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on('message', (data, binary) => ws.send(binary ? data : 'echo:' + String(data), { binary }))
    })
  })
  return { port: await listen(server), upgrades }
}

async function setup(overrides: Partial<BridgeProxyDeps> = {}) {
  const upstream = await environment()
  let tokens = 0
  const state = { now: 1_000_000 }
  const proxy = new BridgeProxy({
    now: () => state.now,
    token: () => 'ticket-' + ++tokens,
    host: () => '127.0.0.1',
    secret: () => 'ctl',
    deviceActive: (id) => id !== 'revoked',
    instancePort: upstream.port,
    ...overrides,
  })
  const gateway = http.createServer()
  gateway.on('upgrade', (req, socket, head) => proxy.upgrade(req, socket, head))
  const port = await listen(gateway)
  const connect = (path: string) => {
    const socket = new WebSocket('ws://127.0.0.1:' + port + path)
    sockets.push(socket)
    return socket
  }
  /** Resolves with 'open', or with the HTTP status the gateway refused the upgrade with. */
  const outcome = (socket: WebSocket) =>
    new Promise<'open' | number>((resolve, reject) => {
      socket.once('open', () => resolve('open'))
      socket.once('unexpected-response', (_request, response) => resolve(response.statusCode ?? 0))
      socket.once('error', reject)
    })
  return { proxy, upstream, state, connect, outcome, port }
}

describe('bridge proxy', () => {
  it('passes a WebSocket through to the environment, adding only the control token', async () => {
    const h = await setup()
    const ticket = h.proxy.ticket('workspaces', 'device-1')
    expect(ticket).toEqual({
      ticket: 'ticket-1',
      path: '/v1/bridge?ticket=ticket-1',
      expiresAt: new Date(1_030_000).toISOString(),
    })
    const socket = h.connect(ticket.path)
    expect(await h.outcome(socket)).toBe('open')
    socket.send('hello')
    expect(String((await once(socket, 'message'))[0])).toBe('echo:hello')
    socket.send(Buffer.from([1, 2, 3]))
    expect([...((await once(socket, 'message'))[0] as Buffer)]).toEqual([1, 2, 3])
    // The handshake the environment saw is the client's own; the ticket did not travel upstream.
    const headers = h.upstream.upgrades[0]
    expect(headers.authorization).toBe('Bearer ctl')
    expect(headers['sec-websocket-key']).toEqual(expect.any(String))
    expect(headers['sec-websocket-version']).toBe('13')
    expect(JSON.stringify(headers)).not.toContain('ticket-1')
  })

  it('accepts on a phone ticket only the Origin it named, and keeps it from the environment', async () => {
    const h = await setup()
    const open = (path: string, origin?: string) => {
      const socket = new WebSocket('ws://127.0.0.1:' + h.port + path, origin ? { origin } : {})
      sockets.push(socket)
      return h.outcome(socket)
    }
    expect(await open(h.proxy.ticket('workspaces', 'phone', 'https://bots.example.dev').path, 'https://bots.example.dev')).toBe(
      'open'
    )
    expect(h.upstream.upgrades[0].origin).toBeUndefined()
    // Written as a client may write it: the comparison is on the normalized Origin.
    expect(await open(h.proxy.ticket('workspaces', 'phone', 'https://bots.example.dev').path, 'https://BOTS.example.dev:443')).toBe(
      'open'
    )
    expect(await open(h.proxy.ticket('workspaces', 'phone', 'https://bots.example.dev').path, 'https://evil.example')).toBe(403)
    // A phone's ticket also opens without an Origin; a computer's ticket never accepts one.
    expect(await open(h.proxy.ticket('workspaces', 'phone', 'https://bots.example.dev').path)).toBe('open')
    expect(await open(h.proxy.ticket('workspaces', 'device-1').path, 'https://bots.example.dev')).toBe(403)
  })

  it('accepts a ticket once, and not after it expired', async () => {
    const h = await setup()
    const ticket = h.proxy.ticket('workspaces', 'device-1')
    expect(await h.outcome(h.connect(ticket.path))).toBe('open')
    expect(await h.outcome(h.connect(ticket.path))).toBe(403)
    expect(await h.outcome(h.connect('/v1/bridge?ticket=unknown'))).toBe(403)
    expect(await h.outcome(h.connect('/v1/bridge'))).toBe(403)

    const late = h.proxy.ticket('workspaces', 'device-1')
    h.state.now += 30_000
    expect(await h.outcome(h.connect(late.path))).toBe(403)
  })

  it('refuses a revoked device and closes the bridges of a device revoked later', async () => {
    const h = await setup()
    expect(await h.outcome(h.connect(h.proxy.ticket('workspaces', 'revoked').path))).toBe(403)

    const socket = h.connect(h.proxy.ticket('workspaces', 'device-1').path)
    const other = h.connect(h.proxy.ticket('workspaces', 'device-2').path)
    expect(await h.outcome(socket)).toBe('open')
    expect(await h.outcome(other)).toBe('open')
    const unused = h.proxy.ticket('workspaces', 'device-1')
    const closed = once(socket, 'close')
    h.proxy.closeDevice('device-1')
    await closed
    expect(await h.outcome(h.connect(unused.path))).toBe(403)
    expect(other.readyState).toBe(WebSocket.OPEN)
  })

  it('closes the bridges of an environment that stops, and only those', async () => {
    const h = await setup()
    const socket = h.connect(h.proxy.ticket('workspaces', 'device-1').path)
    const other = h.connect(h.proxy.ticket('elsewhere', 'device-1').path)
    expect(await h.outcome(socket)).toBe('open')
    expect(await h.outcome(other)).toBe('open')
    const closed = once(socket, 'close')
    h.proxy.closeEnvironment('workspaces')
    await closed
    expect(other.readyState).toBe(WebSocket.OPEN)
  })

  it('limits the bridges one device holds', async () => {
    const h = await setup()
    const held: WebSocket[] = []
    for (let index = 0; index < 8; index++) {
      const socket = h.connect(h.proxy.ticket('workspaces', 'device-1').path)
      expect(await h.outcome(socket)).toBe('open')
      held.push(socket)
    }
    expect(await h.outcome(h.connect(h.proxy.ticket('workspaces', 'device-1').path))).toBe(429)
    // Another device is not affected, and a closed bridge frees its place.
    expect(await h.outcome(h.connect(h.proxy.ticket('workspaces', 'device-2').path))).toBe('open')
    const closed = once(held[0], 'close')
    held[0].close()
    await closed
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(await h.outcome(h.connect(h.proxy.ticket('workspaces', 'device-1').path))).toBe('open')
  })

  it('answers without a bridge when the environment is not running or refuses the upgrade', async () => {
    const stopped = await setup({ host: () => null })
    expect(await stopped.outcome(stopped.connect(stopped.proxy.ticket('workspaces', 'device-1').path))).toBe(503)

    const wrongToken = await setup({ secret: () => 'other' })
    expect(await wrongToken.outcome(wrongToken.connect(wrongToken.proxy.ticket('workspaces', 'device-1').path))).toBe(
      502
    )
    // A refused upgrade does not keep a place in the device's limit.
    for (let index = 0; index < 9; index++)
      expect(await wrongToken.outcome(wrongToken.connect(wrongToken.proxy.ticket('workspaces', 'device-1').path))).toBe(
        502
      )
  })
})
