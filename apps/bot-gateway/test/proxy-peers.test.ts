import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import type net from 'node:net'
import { randomUUID } from 'node:crypto'
import { WebSocket } from 'ws'
import {
  FLEET_PROTOCOL_HEADER,
  fleetInstanceInputSchema,
  fleetInstanceProfileSchema,
  fleetInstanceHoldRequestSchema,
  fleetInstanceReleaseRequestSchema,
} from '@maestrly/bot-fleet-protocol'
import { Auth } from '../src/auth.js'
import { loadConfig } from '../src/config.js'
import { FakeDockerDriver } from '../src/docker.js'
import { EventHub } from '../src/events.js'
import { HostMonitor } from '../src/host.js'
import { InstanceClient } from '../src/instance.js'
import { Lifecycle } from '../src/lifecycle.js'
import { Peers } from '../src/peers.js'
import { ScreenProxy } from '../src/screen.js'
import { createGatewayServers } from '../src/server.js'
import { Store } from '../src/store.js'

const dirs: string[] = []
const closers: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function temp() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fleet-proxy-'))
  dirs.push(dir)
  return dir
}
async function listen(server: http.Server | net.Server) {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        if (server instanceof http.Server) server.closeAllConnections()
        server.close(() => resolve())
      })
  )
  return (server.address() as net.AddressInfo).port
}
async function instance() {
  let tunnelToken = 'control'
  const inputs: any[] = []
  const server = http.createServer(async (req, res) => {
    const send = (code: number, value: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json' })
      res.end(JSON.stringify(value))
    }
    if (req.headers.origin) return send(403, { code: 'FORBIDDEN', message: 'Origin forbidden' })
    if (req.headers[FLEET_PROTOCOL_HEADER.toLowerCase()] !== '1')
      return send(426, { code: 'PROTOCOL_INCOMPATIBLE', message: 'Protocol mismatch' })
    if (req.headers.authorization !== 'Bearer control')
      return send(401, { code: 'UNAUTHORIZED', message: 'Unauthorized' })
    const url = new URL(req.url ?? '/', 'http://instance')
    if (url.pathname === '/v1/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      return
    }
    const state = {
      appVersion: '1.0',
      protocol: 1,
      ready: true,
      accounts: { connected: true, providers: [] },
      selection: null,
      ceiling: 'ask',
      profile: { botId: 'test', name: 'Test' },
      conversationId: null,
      turn: { state: 'idle', startedAt: null },
      hold: { state: 'none', reason: null, since: null, interruptedTurn: false },
      queue: [],
      activity: null,
      pending: [],
      lastEventSeq: 0,
    }
    let body: unknown = null
    if (['POST', 'PUT'].includes(req.method ?? '')) {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      body = JSON.parse(Buffer.concat(chunks).toString())
    }
    try {
      if (url.pathname === '/v1/health') return send(200, { ok: true, appVersion: '1.0', protocol: 1, ready: true })
      if (url.pathname === '/v1/status') return send(200, state)
      if (url.pathname === '/v1/profile') {
        fleetInstanceProfileSchema.parse(body)
        return send(200, state)
      }
      if (url.pathname === '/v1/hold') {
        fleetInstanceHoldRequestSchema.parse(body)
        return send(200, {
          state: 'held',
          reason: (body as any).reason,
          since: new Date().toISOString(),
          interruptedTurn: false,
        })
      }
      if (url.pathname === '/v1/hold/release') {
        fleetInstanceReleaseRequestSchema.parse(body)
        return send(200, state.hold)
      }
      if (url.pathname === '/v1/inputs') {
        inputs.push(fleetInstanceInputSchema.parse(body))
        return send(200, { inputId: randomUUID(), itemId: randomUUID(), queued: false })
      }
      return send(404, { code: 'NOT_FOUND', message: 'Not found' })
    } catch {
      return send(400, { code: 'INVALID_REQUEST', message: 'Invalid request' })
    }
  })
  const upgraded = new Set<net.Socket>()
  server.on('upgrade', (req, socket, head) => {
    upgraded.add(socket)
    socket.on('close', () => upgraded.delete(socket))
    if (
      req.headers.authorization !== 'Bearer ' + tunnelToken ||
      req.headers[FLEET_PROTOCOL_HEADER.toLowerCase()] !== '1' ||
      req.headers.upgrade !== 'maestrly-rfb' ||
      !['/v1/screen/view', '/v1/screen/control'].includes(req.url ?? '')
    ) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n')
      return
    }
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: maestrly-rfb\r\n\r\n')
    const echo = (bytes: Buffer) => {
      socket.write(Buffer.from([1, 2, 3]))
      socket.write(bytes)
    }
    if (head.length) echo(head)
    socket.on('data', echo)
  })
  const port = await listen(server)
  closers.push(async () => {
    for (const socket of upgraded) socket.destroy()
  })
  return {
    origin: 'http://127.0.0.1:' + port,
    inputs,
    setTunnelToken: (value: string) => {
      tunnelToken = value
    },
  }
}
function fixture(origin: string) {
  const dir = temp(),
    cfg = loadConfig({ MAESTRLY_GATEWAY_DATA_DIR: dir })
  const store = new Store(dir),
    docker = new FakeDockerDriver()
  docker.images.add(cfg.botImage)
  const lifecycle = new Lifecycle(store, docker, cfg, (id) => new InstanceClient(id, 'control', origin), 200)
  closers.push(async () => {
    lifecycle.close()
    store.close()
  })
  return { cfg, store, docker, lifecycle }
}
async function until(test: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (test()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Timed out')
}
async function bot(f: ReturnType<typeof fixture>, name: string) {
  const value = f.lifecycle.create({
    name,
    instructions: '',
    ceiling: 'ask',
    talksTo: [],
    idempotencyKey: randomUUID(),
  })
  await until(() => f.lifecycle.get(value.id)?.lifecycle === 'running')
  return value.id
}
function wsConnect(url: string) {
  const ws = new WebSocket(url)
  return new Promise<WebSocket>((resolve, reject) => {
    ws.once('open', () => resolve(ws))
    ws.once('error', reject)
  })
}
function wsClose(ws: WebSocket) {
  return new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)))
}
function wsRejected(url: string) {
  const ws = new WebSocket(url)
  return wsClose(ws)
}
describe('peers', () => {
  it('enforces ACL, stores offline delivery, retries on ready, budgets and pair guard', async () => {
    const fake = await instance(),
      f = fixture(fake.origin)
    const a = await bot(f, 'Alpha'),
      b = await bot(f, 'Beta'),
      c = await bot(f, 'Gamma')
    const peers = new Peers(f.store, f.lifecycle)
    await expect(peers.send(a, { to: b, text: 'No', idempotencyKey: randomUUID() })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
    await f.lifecycle.patch(a, { talksTo: [b] })
    expect(peers.list(a).peers.map((peer) => peer.botId)).toEqual([b])
    await f.lifecycle.stop(b)
    const offline = await peers.send(a, { to: b, text: 'Offline', idempotencyKey: randomUUID() })
    expect(offline.delivered).toBe(false)
    expect(f.store.pendingPeers(b)).toHaveLength(1)
    f.lifecycle.onReady = (id) => {
      void peers.retry(id)
    }
    await f.lifecycle.start(b)
    await until(() => f.store.pendingPeers(b).length === 0)
    expect(f.store.pendingPeers(b)).toHaveLength(0)
    expect(fake.inputs.at(-1)).toMatchObject({ source: 'peer', text: 'Offline', peer: { botId: a } })
    for (let i = 0; i < 19; i++) await peers.send(a, { to: b, text: String(i), idempotencyKey: randomUUID() })
    await expect(peers.send(a, { to: b, text: 'loop', idempotencyKey: randomUUID() })).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    })
    expect(f.store.activity().filter((entry) => entry.kind === 'needs_you')).toHaveLength(1)
    f.store.markOwnerMessage(b)
    expect((await peers.send(a, { to: b, text: 'reset', idempotencyKey: randomUUID() })).delivered).toBe(true)
    await f.lifecycle.patch(a, { talksTo: [b, c] })
    for (let i = 0; i < 9; i++) await peers.send(a, { to: c, text: String(i), idempotencyKey: randomUUID() })
    await expect(peers.send(a, { to: c, text: 'budget', idempotencyKey: randomUUID() })).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    })
  })
  it('authenticates internal HTTP with each bot token', async () => {
    const fake = await instance(),
      f = fixture(fake.origin)
    const a = await bot(f, 'Alpha'),
      b = await bot(f, 'Beta')
    await f.lifecycle.patch(a, { talksTo: [b] })
    const cfg = { ...f.cfg, publicPort: 0, internalPort: 0 }
    const gateway = createGatewayServers({
      auth: new Auth(f.store),
      config: cfg,
      events: new EventHub(async () => {}),
      host: new HostMonitor(cfg, f.docker),
      lifecycle: f.lifecycle,
      store: f.store,
    })
    await gateway.listen()
    closers.push(() => gateway.close())
    const url = 'http://127.0.0.1:' + (gateway.internalServer.address() as net.AddressInfo).port + '/internal/v1/peers'
    expect((await fetch(url, { headers: { [FLEET_PROTOCOL_HEADER]: '1' } })).status).toBe(401)
    const token = f.store.botSecrets(a)!.gatewayToken
    expect(
      (await fetch(url, { headers: { [FLEET_PROTOCOL_HEADER]: '1', Authorization: 'Bearer ' + token } })).status
    ).toBe(200)
    expect(
      (
        await fetch(url, {
          headers: { [FLEET_PROTOCOL_HEADER]: '1', Authorization: 'Bearer ' + token, Origin: 'http://evil' },
        })
      ).status
    ).toBe(403)
  })
})
describe('screen', () => {
  it('enforces ticket mode, expiry, single use, socket limits, byte flow and close codes', async () => {
    const fake = await instance(),
      f = fixture(fake.origin)
    const id = await bot(f, 'Test')
    fake.setTunnelToken(f.store.botSecrets(id)!.controlToken)
    let time = Date.now()
    const screen = new ScreenProxy(
      f.lifecycle,
      () => '127.0.0.1',
      Number(new URL(fake.origin).port),
      () => time
    )
    const cfg = { ...f.cfg, publicPort: 0, internalPort: 0 }
    const gateway = createGatewayServers({
      auth: new Auth(f.store),
      config: cfg,
      events: new EventHub(async () => {}),
      host: new HostMonitor(cfg, f.docker),
      lifecycle: f.lifecycle,
      store: f.store,
      screen,
    })
    await gateway.listen()
    closers.push(() => gateway.close())
    const base = 'ws://127.0.0.1:' + (gateway.publicServer.address() as net.AddressInfo).port
    expect(() => screen.ticket(id, 'one', 'control')).toThrow()
    const originTicket = screen.ticket(id, 'one', 'view')
    const originStatus = await new Promise<number>((resolve, reject) => {
      const req = http.get(
        base.replace('ws:', 'http:') + originTicket.path,
        {
          headers: {
            Connection: 'Upgrade',
            Upgrade: 'websocket',
            Origin: 'http://evil',
            'Sec-WebSocket-Key': Buffer.from('origin-test-key!').toString('base64'),
            'Sec-WebSocket-Version': '13',
          },
        },
        (res) => {
          res.resume()
          resolve(res.statusCode ?? 0)
        }
      )
      req.on('error', reject)
    })
    expect(originStatus).toBe(403)
    const expiring = screen.ticket(id, 'one', 'view')
    time += 30001
    expect(await wsRejected(base + expiring.path)).toBe(4003)
    const sockets: WebSocket[] = []
    for (let i = 0; i < 4; i++) sockets.push(await wsConnect(base + screen.ticket(id, 'one', 'view').path))
    await until(() => (screen as any).connections.size === 4)
    expect(await wsRejected(base + screen.ticket(id, 'one', 'view').path)).toBe(4003)
    expect(await wsRejected(base + expiring.path)).toBe(4003)
    await f.lifecycle.takeover(id, 'one', 'Mac')
    expect(() => screen.ticket(id, 'two', 'control')).toThrow()
    const control = await wsConnect(base + screen.ticket(id, 'one', 'control').path)
    const received: Buffer[] = []
    control.on('message', (bytes) => received.push(Buffer.from(bytes as Buffer)))
    control.send(Buffer.from([4, 5, 6]))
    await until(() => Buffer.concat(received).includes(Buffer.from([4, 5, 6])))
    expect(Buffer.concat(received).includes(Buffer.from([1, 2, 3]))).toBe(true)
    expect(await wsRejected(base + screen.ticket(id, 'one', 'control').path)).toBe(4003)
    const controlClosed = wsClose(control)
    await f.lifecycle.releaseTakeover(id, 'one', null, true)
    expect(await controlClosed).toBe(4001)
    const oversized = sockets.shift()!
    const oversizedClosed = wsClose(oversized)
    // Only the header of a frame one byte over the limit, which the gateway refuses by its declared length. Sending
    // the whole frame races the refusal: Windows resets a connection closed while data still arrives (code 1006).
    const header = Buffer.alloc(14)
    header[0] = 0x82 // final binary frame
    header[1] = 0xff // masked, with a 64-bit length
    header.writeBigUInt64BE(BigInt(256 * 1024 + 1), 2)
    ;(oversized as unknown as { _socket: net.Socket })._socket.write(header)
    expect(await oversizedClosed).toBe(1009)
    const auth = new Auth(f.store)
    const paired = auth.pair(auth.createPairing().code, 'Revoked Mac', 'test')
    const liveTicket = screen.ticket(id, paired.deviceId, 'view')
    const unusedTicket = screen.ticket(id, paired.deviceId, 'view')
    const live = await wsConnect(base + liveTicket.path)
    await until(() => (screen as any).connections.size === 4)
    const revokedClose = wsClose(live)
    f.store.revokeDevice(paired.deviceId)
    screen.closeDevice(paired.deviceId)
    expect(await revokedClose).toBe(4003)
    expect(await wsRejected(base + unusedTicket.path)).toBe(4003)
    const closings = sockets.map(wsClose)
    await f.lifecycle.stop(id)
    expect(await Promise.all(closings)).toEqual([4002, 4002, 4002])
  })
})
