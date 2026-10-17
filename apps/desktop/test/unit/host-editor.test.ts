import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'
import { parseBotInstanceConfig } from '../../src/main/fleet/instance/config'
import {
  createInstanceControlServer,
  type InstanceEnvironment,
  InstanceEvents,
} from '../../src/main/fleet/instance/server'
import { HostEditor } from '../../src/main/remote-host/server/host-editor'

const controlToken = randomBytes(32).toString('base64url')
const editorToken = 'editor-token-1234'
const config = parseBotInstanceConfig({
  MAESTRLY_BOT_MODE: '1',
  MAESTRLY_BOT_CONTROL_TOKEN: controlToken,
  MAESTRLY_BOT_CONTROL_HOST: '127.0.0.1',
  MAESTRLY_BOT_CONTROL_PORT: '0',
})!
const environment = { events: new InstanceEvents() } as unknown as InstanceEnvironment
const servers: http.Server[] = []
const sockets: WebSocket[] = []

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate()
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
})

async function listen(server: http.Server): Promise<number> {
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return (server.address() as AddressInfo).port
}

type Seen = { url: string; headers: http.IncomingHttpHeaders }

/** VS Code's serve-web in miniature: it records what reaches it, sets its cookies and echoes on its WebSocket. */
async function serveWeb() {
  const requests: Seen[] = []
  const upgrades: Seen[] = []
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url ?? '', headers: req.headers })
    const bare = (req.url ?? '').includes('bare=1')
    res.writeHead(200, {
      'content-type': 'text/html',
      ...(bare
        ? {}
        : {
            'set-cookie': [`vscode-tkn=${editorToken}; Max-Age=604800`, 'vscode-cli-secret-half=abc; HttpOnly; Path=/'],
          }),
    })
    res.end('<html>workbench</html>')
  })
  const wss = new WebSocketServer({
    server,
    verifyClient: (info: { req: http.IncomingMessage }, done: (ok: boolean, code?: number) => void) =>
      done(!(info.req.url ?? '').includes('refuse'), 403),
  })
  wss.on('headers', (headers) => headers.push(`Set-Cookie: vscode-tkn=${editorToken}`, 'Set-Cookie: kept=1'))
  wss.on('connection', (socket, req) => {
    upgrades.push({ url: req.url ?? '', headers: req.headers })
    socket.on('message', (data) => socket.send('echo:' + String(data)))
  })
  const port = await listen(server)
  return { port, requests, upgrades }
}

async function setup(options: { failing?: boolean } = {}) {
  const upstream = await serveWeb()
  const activity: number[] = []
  const ensureServer = vi.fn(async () => {
    if (options.failing) throw new Error('could not start')
    return { port: upstream.port, token: editorToken }
  })
  const editor = new HostEditor({ ensureServer, onActivity: (count) => void activity.push(count) })
  const port = await listen(createInstanceControlServer(config, environment, { editor }))
  const origin = `http://127.0.0.1:${port}`
  const credentials = { 'X-Maestrly-Fleet-Protocol': '1', Authorization: `Bearer ${controlToken}` }
  return { upstream, editor, activity, ensureServer, origin, port, credentials }
}

function open(url: string, headers: Record<string, string>): Promise<WebSocket> {
  const socket = new WebSocket(url, { headers })
  sockets.push(socket)
  return new Promise((resolve, reject) => {
    socket.once('open', () => resolve(socket))
    socket.once('unexpected-response', (_request, response) => reject(new Error(`HTTP ${response.statusCode}`)))
    socket.once('error', reject)
  })
}

describe("a workspaces host's editor", () => {
  it("passes requests to serve-web with the host's token, never the caller's credentials", async () => {
    const h = await setup()
    const response = await fetch(h.origin + '/v1/editor/?folder=%2Fsrv%2Fproj', {
      headers: {
        ...h.credentials,
        Cookie: 'vscode-cli-secret-half=abc; vscode-tkn=forged',
        'X-Forwarded-Host': '127.0.0.1:41234',
        'X-Forwarded-Proto': 'https',
      },
    })
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('<html>workbench</html>')
    // The workbench page keeps the cookies serve-web sets, the token it authenticates its connection with included.
    expect(response.headers.getSetCookie()).toEqual([
      `vscode-tkn=${editorToken}; Max-Age=604800`,
      'vscode-cli-secret-half=abc; HttpOnly; Path=/',
    ])
    const [seen] = h.upstream.requests
    expect(seen.url).toBe('/?folder=%2Fsrv%2Fproj')
    expect(seen.headers.cookie).toBe(`vscode-cli-secret-half=abc; vscode-tkn=${editorToken}`)
    expect(seen.headers.host).toBe(`127.0.0.1:${h.upstream.port}`)
    expect(seen.headers['x-forwarded-host']).toBe('127.0.0.1:41234')
    expect(seen.headers.authorization).toBeUndefined()
    expect(seen.headers['x-maestrly-fleet-protocol']).toBeUndefined()
    expect(seen.headers['x-forwarded-proto']).toBeUndefined()
    expect(h.activity).toEqual([0])
  })

  it("prefers the computer's own origin header to an X-Forwarded-Host a proxy before the gateway replaced", async () => {
    const h = await setup()
    await fetch(h.origin + '/v1/editor/', {
      headers: {
        ...h.credentials,
        'X-Maestrly-Editor-Host': '127.0.0.1:41234',
        'X-Forwarded-Host': 'server.tailnet.ts.net',
      },
    })
    const socket = await open(`ws://127.0.0.1:${h.port}/v1/editor/stable-x`, {
      ...h.credentials,
      'X-Maestrly-Editor-Host': '127.0.0.1:41234',
      'X-Forwarded-Host': 'server.tailnet.ts.net',
    })
    socket.close()
    for (const seen of [h.upstream.requests[0], h.upstream.upgrades[0]]) {
      expect(seen.headers['x-forwarded-host']).toBe('127.0.0.1:41234')
      expect(seen.headers['x-maestrly-editor-host']).toBeUndefined()
    }
  })

  it('drops an origin the editor would be reached at other than a loopback one', async () => {
    const h = await setup()
    await fetch(h.origin + '/v1/editor', {
      headers: {
        ...h.credentials,
        'X-Maestrly-Editor-Host': 'attacker.example:443',
        'X-Forwarded-Host': 'attacker.example:443',
      },
    })
    expect(h.upstream.requests[0].url).toBe('/')
    expect(h.upstream.requests[0].headers['x-forwarded-host']).toBeUndefined()
    expect(h.upstream.requests[0].headers.cookie).toBe(`vscode-tkn=${editorToken}`)
  })

  it('serves only authenticated requests without an Origin, as every route of the control server', async () => {
    const h = await setup()
    expect((await fetch(h.origin + '/v1/editor/')).status).toBe(426)
    expect(
      (
        await fetch(h.origin + '/v1/editor/', {
          headers: { 'X-Maestrly-Fleet-Protocol': '1', Authorization: 'Bearer x' },
        })
      ).status
    ).toBe(401)
    expect(
      (await fetch(h.origin + '/v1/editor/', { headers: { ...h.credentials, Origin: 'http://127.0.0.1:1' } })).status
    ).toBe(403)
    await expect(open(`ws://127.0.0.1:${h.port}/v1/editor/stable-x`, {})).rejects.toThrow('HTTP 426')
    expect(h.upstream.requests).toEqual([])
    expect(h.ensureServer).not.toHaveBeenCalled()
  })

  it('passes WebSocket connections through and counts them while they are open', async () => {
    const h = await setup()
    const socket = await open(`ws://127.0.0.1:${h.port}/v1/editor/stable-x?reconnectionToken=r1`, {
      ...h.credentials,
      Cookie: 'vscode-tkn=forged; other=2',
      'X-Forwarded-Host': 'localhost:41234',
    })
    socket.send('hello')
    const [reply] = await once(socket, 'message')
    expect(String(reply)).toBe('echo:hello')
    const [seen] = h.upstream.upgrades
    expect(seen.url).toBe('/stable-x?reconnectionToken=r1')
    expect(seen.headers.cookie).toBe(`other=2; vscode-tkn=${editorToken}`)
    expect(seen.headers['x-forwarded-host']).toBe('localhost:41234')
    expect(seen.headers.authorization).toBeUndefined()
    expect(h.editor.connections()).toBe(1)
    expect(h.activity).toEqual([1])
    socket.close()
    await vi.waitFor(() => expect(h.editor.connections()).toBe(0))
    expect(h.activity).toEqual([1, 0])
  })

  it('gives the workbench page its token when serve-web did not, and no other answer', async () => {
    const h = await setup()
    const page = await fetch(h.origin + '/v1/editor/?bare=1', { headers: h.credentials })
    expect(page.headers.getSetCookie()).toEqual([`vscode-tkn=${editorToken}; Path=/; Max-Age=604800; SameSite=Strict`])
    const asset = await fetch(h.origin + '/v1/editor/stable-x/static/a.js?bare=1', { headers: h.credentials })
    expect(asset.headers.getSetCookie()).toEqual([])
  })

  it('passes the answer of an accepted upgrade as serve-web gave it', async () => {
    const h = await setup()
    const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const request = http.request({
        host: '127.0.0.1',
        port: h.port,
        path: '/v1/editor/stable-x',
        headers: {
          ...h.credentials,
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Version': '13',
          'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
        },
      })
      request.on('upgrade', (incoming, socket) => {
        socket.destroy()
        resolve(incoming)
      })
      request.on('error', reject)
      request.end()
    })
    expect(response.statusCode).toBe(101)
    expect(response.headers['set-cookie']).toEqual([`vscode-tkn=${editorToken}`, 'kept=1'])
  })

  it("passes serve-web's refusal of an upgrade back", async () => {
    const h = await setup()
    await expect(open(`ws://127.0.0.1:${h.port}/v1/editor/refuse`, h.credentials)).rejects.toThrow('HTTP 403')
    expect(h.editor.connections()).toBe(0)
  })

  it('answers 503 when the editor cannot start', async () => {
    const h = await setup({ failing: true })
    const response = await fetch(h.origin + '/v1/editor/', { headers: h.credentials })
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ code: 'INSTANCE_UNAVAILABLE' })
    await expect(open(`ws://127.0.0.1:${h.port}/v1/editor/stable-x`, h.credentials)).rejects.toThrow('HTTP 503')
  })

  it('ends every editor connection when the host stops serving', async () => {
    const h = await setup()
    const socket = await open(`ws://127.0.0.1:${h.port}/v1/editor/stable-x`, h.credentials)
    const closed = once(socket, 'close')
    h.editor.closeAll()
    await closed
    await vi.waitFor(() => expect(h.editor.connections()).toBe(0))
  })

  it('leaves the editor prefix unrouted on a control server without an editor', async () => {
    const port = await listen(createInstanceControlServer(config, environment, {}))
    const response = await fetch(`http://127.0.0.1:${port}/v1/editor/`, {
      headers: { 'X-Maestrly-Fleet-Protocol': '1', Authorization: `Bearer ${controlToken}` },
    })
    expect(response.status).toBe(404)
  })
})
