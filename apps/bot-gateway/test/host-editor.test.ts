import { once } from 'node:events'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'
import { FLEET_HOST_EDITOR_GATEWAY_ERRORS, parseFleetGatewayEditorPath } from '@maestrly/bot-fleet-protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'
import { GatewayError } from '../src/errors.js'
import { HostEditorProxy, type HostEditorProxyDeps } from '../src/host-editor.js'

const servers: http.Server[] = []
const clients: WebSocket[] = []
afterEach(async () => {
  for (const client of clients.splice(0)) client.terminate()
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

type Seen = { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }

/** A workspaces environment's control server serving its editor: it records requests and echoes on WebSockets. */
async function environment(options: { silent?: boolean } = {}) {
  const seen: Seen[] = []
  const upgrades: Seen[] = []
  const server = http.createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body })
    if (options.silent) return
    res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'vscode-cli-secret-half=s; HttpOnly; Path=/' })
    res.end('workbench')
  })
  const wss = new WebSocketServer({
    server,
    verifyClient: (info: { req: http.IncomingMessage }, done: (ok: boolean, code?: number) => void) =>
      done(!(info.req.url ?? '').includes('refuse'), 503),
  })
  wss.on('connection', (socket, req) => {
    upgrades.push({ method: 'GET', url: req.url ?? '', headers: req.headers, body: '' })
    socket.on('message', (data) => socket.send('echo:' + String(data)))
  })
  return { port: await listen(server), seen, upgrades }
}

/** A gateway that sends every editor path to the proxy, as the public server does once the device is authenticated. */
async function gateway(proxy: HostEditorProxy) {
  const answer = (error: unknown) => (error instanceof GatewayError ? error : new GatewayError('INTERNAL', 'failed'))
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://gateway')
    const editor = parseFleetGatewayEditorPath(url.pathname)!
    try {
      await proxy.forward(
        editor.environmentId,
        editor.editorPath + url.search,
        req,
        res,
        String(req.headers['x-device'] ?? 'd1')
      )
    } catch (error) {
      const known = answer(error)
      res.writeHead(known.status, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ code: known.code, message: known.message }))
    }
  })
  server.on('upgrade', (req, socket: Duplex, head) => {
    const url = new URL(req.url ?? '/', 'http://gateway')
    const editor = parseFleetGatewayEditorPath(url.pathname)!
    try {
      proxy.upgrade(
        editor.environmentId,
        editor.editorPath + url.search,
        req,
        socket,
        head,
        String(req.headers['x-device'] ?? 'd1')
      )
    } catch (error) {
      const known = answer(error)
      socket.end(`HTTP/1.1 ${known.status} Error\r\nContent-Length: 0\r\n\r\n`)
    }
  })
  return `127.0.0.1:${await listen(server)}`
}

async function setup(overrides: Partial<HostEditorProxyDeps> = {}, options: { silent?: boolean } = {}) {
  const upstream = await environment(options)
  const proxy = new HostEditorProxy({
    host: () => '127.0.0.1',
    secret: () => 'control',
    supports: () => true,
    instancePort: upstream.port,
    idleTimeoutMs: 2_000,
    socketsPerDevice: 64,
    ...overrides,
  })
  return { proxy, address: await gateway(proxy), upstream }
}

function open(url: string, headers: Record<string, string> = {}): Promise<WebSocket> {
  const socket = new WebSocket(url, { headers: { authorization: 'Bearer device-token', ...headers } })
  clients.push(socket)
  return new Promise((resolve, reject) => {
    socket.once('open', () => resolve(socket))
    socket.once('unexpected-response', (_request, response) => reject(new Error(`HTTP ${response.statusCode}`)))
    socket.once('error', reject)
  })
}

describe('host editor proxy', () => {
  it('passes a request to the editor prefix of the environment with the control token, and its answer back', async () => {
    const h = await setup()
    const response = await fetch(`http://${h.address}/v1/environments/workspaces/editor/?folder=%2Fsrv%2Fapp`, {
      headers: {
        authorization: 'Bearer device-token',
        'x-maestrly-fleet-protocol': '1',
        cookie: 'vscode-cli-secret-half=s',
        'x-forwarded-host': '127.0.0.1:41234',
      },
    })
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('workbench')
    expect(response.headers.getSetCookie()).toEqual(['vscode-cli-secret-half=s; HttpOnly; Path=/'])
    const [seen] = h.upstream.seen
    expect(seen.url).toBe('/v1/editor/?folder=%2Fsrv%2Fapp')
    expect(seen.headers.authorization).toBe('Bearer control')
    expect(seen.headers['x-maestrly-fleet-protocol']).toBe('1')
    expect(seen.headers.cookie).toBe('vscode-cli-secret-half=s')
    expect(seen.headers['x-forwarded-host']).toBe('127.0.0.1:41234')
    expect(JSON.stringify(seen.headers)).not.toContain('device-token')
  })

  it('streams a request body to the environment', async () => {
    const h = await setup()
    await fetch(`http://${h.address}/v1/environments/workspaces/editor/_vscode-cli/mint-key`, {
      method: 'POST',
      headers: { authorization: 'Bearer device-token' },
      body: 'key-material',
    })
    expect(h.upstream.seen[0]).toMatchObject({
      method: 'POST',
      url: '/v1/editor/_vscode-cli/mint-key',
      body: 'key-material',
    })
  })

  it('refuses an environment that does not run or does not serve its editor', async () => {
    const stopped = await setup({ host: () => null })
    const notRunning = await fetch(`http://${stopped.address}/v1/environments/workspaces/editor/`)
    expect(notRunning.status).toBe(409)
    expect((await notRunning.json()).message).toBe(FLEET_HOST_EDITOR_GATEWAY_ERRORS.notRunning)
    const old = await setup({ supports: () => false })
    const outdated = await fetch(`http://${old.address}/v1/environments/workspaces/editor/`)
    expect((await outdated.json()).message).toBe(FLEET_HOST_EDITOR_GATEWAY_ERRORS.updateHost)
    await expect(open(`ws://${old.address}/v1/environments/workspaces/editor/stable-x`)).rejects.toThrow('HTTP 409')
    expect([...stopped.upstream.seen, ...old.upstream.seen, ...old.upstream.upgrades]).toEqual([])
  })

  it('cuts a request the environment leaves unanswered', async () => {
    const h = await setup({ idleTimeoutMs: 100 }, { silent: true })
    const response = await fetch(`http://${h.address}/v1/environments/workspaces/editor/`)
    expect(response.status).toBe(503)
  })

  it('passes WebSocket connections through with the control token', async () => {
    const h = await setup()
    const socket = await open(`ws://${h.address}/v1/environments/workspaces/editor/stable-x?reconnectionToken=r1`, {
      cookie: 'vscode-cli-secret-half=s',
    })
    socket.send('hello')
    const [reply] = await once(socket, 'message')
    expect(String(reply)).toBe('echo:hello')
    const [seen] = h.upstream.upgrades
    expect(seen.url).toBe('/v1/editor/stable-x?reconnectionToken=r1')
    expect(seen.headers.authorization).toBe('Bearer control')
    expect(seen.headers.cookie).toBe('vscode-cli-secret-half=s')
    expect(JSON.stringify(seen.headers)).not.toContain('device-token')
  })

  it("passes the environment's refusal of an upgrade back", async () => {
    const h = await setup()
    await expect(open(`ws://${h.address}/v1/environments/workspaces/editor/refuse`)).rejects.toThrow('HTTP 503')
  })

  it('bounds the editor connections of a device', async () => {
    const h = await setup({ socketsPerDevice: 2 })
    const url = `ws://${h.address}/v1/environments/workspaces/editor/stable-x`
    await open(url)
    await open(url)
    await expect(open(url)).rejects.toThrow('HTTP 429')
    // Another device has its own allowance.
    await expect(open(url, { 'x-device': 'd2' })).resolves.toBeInstanceOf(WebSocket)
  })

  it('cuts the connections of a revoked device, and every connection of a stopped environment', async () => {
    const h = await setup()
    const url = `ws://${h.address}/v1/environments/workspaces/editor/stable-x`
    const first = await open(url)
    const other = await open(url, { 'x-device': 'd2' })
    const closed = once(first, 'close')
    h.proxy.closeDevice('d1')
    await closed
    expect(other.readyState).toBe(WebSocket.OPEN)
    const otherClosed = once(other, 'close')
    h.proxy.closeEnvironment('workspaces')
    await otherClosed
    await vi.waitFor(async () => expect(await open(url)).toBeInstanceOf(WebSocket))
  })
})
