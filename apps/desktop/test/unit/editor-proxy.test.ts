import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'
import {
  EDITOR_ACCESS_COOKIE,
  EditorProxy,
  EditorUnavailable,
  type EditorUpstream,
} from '../../src/main/remote-host/client/editor-proxy'
import {
  RemoteEditors,
  editorFailureReason,
  remoteEditorPartition,
  resolveEditorUpstream,
} from '../../src/main/remote-host/client/editor'
import type { HostView } from '../../src/shared/hosts'

const closers: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close()
})

async function listen(server: http.Server): Promise<number> {
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  )
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return (server.address() as AddressInfo).port
}

type Seen = { method: string; url: string; headers: http.IncomingHttpHeaders }

/** The gateway's editor route in miniature: it records what reaches it and echoes on WebSockets. */
async function gateway() {
  const seen: Seen[] = []
  const upgrades: Seen[] = []
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers })
    res.writeHead(200, {
      'content-type': 'text/html',
      'set-cookie': ['vscode-cli-secret-half=s; HttpOnly; Path=/', `${EDITOR_ACCESS_COOKIE}=stolen; Path=/`],
    })
    res.end('workbench')
  })
  const wss = new WebSocketServer({ server })
  wss.on('connection', (socket, req) => {
    upgrades.push({ method: 'GET', url: req.url ?? '', headers: req.headers })
    socket.on('message', (data) => socket.send('echo:' + String(data)))
  })
  closers.push(() => {
    for (const client of wss.clients) client.terminate()
  })
  const port = await listen(server)
  const upstream: EditorUpstream = {
    origin: `http://127.0.0.1:${port}`,
    prefix: '/v1/environments/workspaces/editor',
    headers: () => ({ authorization: 'Bearer device-token', 'x-maestrly-fleet-protocol': '1' }),
  }
  return { seen, upgrades, upstream }
}

async function setup(options: { unavailable?: boolean } = {}) {
  const g = await gateway()
  const onPort = vi.fn()
  const proxy = new EditorProxy({
    upstream: () => {
      if (options.unavailable) throw new EditorUnavailable('offline')
      return g.upstream
    },
    preferredPort: null,
    onPort,
  })
  closers.push(() => proxy.close())
  const port = await proxy.start()
  const access = `${EDITOR_ACCESS_COOKIE}=${proxy.access}`
  return { ...g, proxy, port, access, onPort }
}

function get(port: number, pathname: string, headers: Record<string, string>) {
  return new Promise<http.IncomingMessage & { body: string }>((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, path: pathname, headers }, (response) => {
      let body = ''
      response.on('data', (chunk) => (body += chunk))
      response.on('end', () => resolve(Object.assign(response, { body })))
    })
    request.on('error', reject)
    request.end()
  })
}

function open(port: number, headers: Record<string, string>): Promise<WebSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/stable-x?reconnectionToken=r1`, { headers })
  closers.push(() => socket.terminate())
  return new Promise((resolve, reject) => {
    socket.once('open', () => resolve(socket))
    socket.once('unexpected-response', (_request, response) => reject(new Error(`HTTP ${response.statusCode}`)))
    socket.once('error', reject)
  })
}

describe("this computer's door to a host's editor", () => {
  it('passes only requests that carry the access cookie, for its own origin', async () => {
    const h = await setup()
    expect((await get(h.port, '/', {})).statusCode).toBe(403)
    expect((await get(h.port, '/', { cookie: `${EDITOR_ACCESS_COOKIE}=guess` })).statusCode).toBe(403)
    expect((await get(h.port, '/', { cookie: h.access, host: 'attacker.example' })).statusCode).toBe(403)
    expect((await get(h.port, '/', { cookie: h.access, origin: 'http://attacker.example' })).statusCode).toBe(403)
    await expect(open(h.port, {})).rejects.toThrow('HTTP 403')
    await expect(open(h.port, { cookie: h.access, origin: 'http://attacker.example' })).rejects.toThrow('HTTP 403')
    expect([...h.seen, ...h.upgrades]).toEqual([])
  })

  it("passes a request under the upstream's prefix with this device's credentials, never the page's", async () => {
    const h = await setup()
    const response = await get(h.port, '/?folder=%2Fsrv%2Fapp', {
      cookie: `vscode-cli-secret-half=s; ${h.access}`,
      origin: `http://127.0.0.1:${h.port}`,
      referer: `http://127.0.0.1:${h.port}/`,
      authorization: 'Bearer from-the-page',
    })
    expect(response.statusCode).toBe(200)
    expect(response.body).toBe('workbench')
    // The editor's cookies come back; one that would claim the access cookie does not.
    expect(response.headers['set-cookie']).toEqual(['vscode-cli-secret-half=s; HttpOnly; Path=/'])
    const [seen] = h.seen
    expect(seen.url).toBe('/v1/environments/workspaces/editor/?folder=%2Fsrv%2Fapp')
    expect(seen.headers.authorization).toBe('Bearer device-token')
    expect(seen.headers['x-maestrly-fleet-protocol']).toBe('1')
    expect(seen.headers.cookie).toBe('vscode-cli-secret-half=s')
    expect(seen.headers['x-forwarded-host']).toBe(`127.0.0.1:${h.port}`)
    expect(seen.headers['x-maestrly-editor-host']).toBe(`127.0.0.1:${h.port}`)
    expect(seen.headers.origin).toBeUndefined()
    expect(seen.headers.referer).toBeUndefined()
    expect(JSON.stringify(seen.headers)).not.toContain(h.proxy.access)
  })

  it('passes the editor WebSockets the same way', async () => {
    const h = await setup()
    const socket = await open(h.port, { cookie: h.access, origin: `http://127.0.0.1:${h.port}` })
    socket.send('hello')
    const [reply] = await once(socket, 'message')
    expect(String(reply)).toBe('echo:hello')
    const [seen] = h.upgrades
    expect(seen.url).toBe('/v1/environments/workspaces/editor/stable-x?reconnectionToken=r1')
    expect(seen.headers.authorization).toBe('Bearer device-token')
    expect(seen.headers.origin).toBeUndefined()
    expect(seen.headers.cookie).toBeUndefined()
    expect(seen.headers['x-forwarded-host']).toBe(`127.0.0.1:${h.port}`)
    expect(seen.headers['x-maestrly-editor-host']).toBe(`127.0.0.1:${h.port}`)
  })

  it('answers 503 while the host cannot be reached', async () => {
    const h = await setup({ unavailable: true })
    expect((await get(h.port, '/', { cookie: h.access })).statusCode).toBe(503)
    await expect(open(h.port, { cookie: h.access })).rejects.toThrow('HTTP 503')
  })

  it('keeps the port of last time, and takes another when it is busy', async () => {
    const h = await setup()
    expect(h.onPort).toHaveBeenCalledWith(h.port)
    h.proxy.close()
    const again = new EditorProxy({ upstream: () => h.upstream, preferredPort: h.port, onPort: vi.fn() })
    closers.push(() => again.close())
    expect(await again.start()).toBe(h.port)
    const busy = new EditorProxy({ upstream: () => h.upstream, preferredPort: h.port, onPort: vi.fn() })
    closers.push(() => busy.close())
    const port = await busy.start()
    expect(port).not.toBe(h.port)
    expect(busy.origin()).toBe(`http://127.0.0.1:${port}`)
  })
})

const host = (patch: Partial<HostView>): HostView => ({
  id: 'server-1/workspaces',
  remote: true,
  label: 'Server',
  server: 'vps',
  tint: null,
  state: 'online',
  epoch: 1,
  os: 'linux',
  homeDir: '/home/bot',
  desktopEffects: false,
  editor: true,
  browser: true,
  computer: false,
  folderTransfers: false,
  environment: { id: 'workspaces', lifecycle: 'running', updateAvailable: false },
  hostVersion: null,
  ...patch,
})

describe("where a host's editor is reached", () => {
  const fleet = (features: string[], paired = true) => ({
    hasFeature: (feature: string) => features.includes(feature),
    hostFilesAccess: () =>
      paired ? { origin: 'https://gateway.example', headers: { Authorization: 'Bearer device' } } : null,
  })
  const registry = (hosts: HostView[], direct = false) => ({
    list: () => hosts,
    directHost: () => (direct ? { origin: 'http://127.0.0.1:9000', token: 'control' } : null),
  })

  it("goes through the paired gateway, under the environment's editor prefix", () => {
    const upstream = resolveEditorUpstream('server-1/workspaces', {
      registry: registry([host({})]),
      fleet: fleet(['host-editor']),
    })
    expect(upstream.origin).toBe('https://gateway.example')
    expect(upstream.prefix).toBe('/v1/environments/workspaces/editor')
    expect(upstream.headers()).toEqual({ Authorization: 'Bearer device' })
  })

  it('goes straight to a development host', () => {
    const upstream = resolveEditorUpstream('direct/host', {
      registry: registry([host({ id: 'direct/host', environment: null })], true),
      fleet: fleet([]),
    })
    expect(upstream).toMatchObject({ origin: 'http://127.0.0.1:9000', prefix: '/v1/editor' })
    expect(upstream.headers()).toEqual({ 'X-Maestrly-Fleet-Protocol': '1', Authorization: 'Bearer control' })
  })

  it('says why it cannot be reached', () => {
    const reason = (run: () => unknown) => {
      try {
        run()
        return null
      } catch (error) {
        return editorFailureReason(error)
      }
    }
    const with_ =
      (hosts: HostView[], features: string[], paired = true) =>
      () =>
        resolveEditorUpstream('server-1/workspaces', { registry: registry(hosts), fleet: fleet(features, paired) })
    expect(reason(with_([], ['host-editor']))).toBe('unknown-host')
    expect(
      reason(
        with_(
          [host({ environment: { id: 'workspaces', lifecycle: 'stopped', updateAvailable: false } })],
          ['host-editor']
        )
      )
    ).toBe('offline')
    expect(reason(with_([host({})], []))).toBe('gateway-update-required')
    expect(reason(with_([host({})], ['host-editor'], false))).toBe('unauthorized')
    expect(reason(() => resolveEditorUpstream('local', { registry: registry([]), fleet: fleet([]) }))).toBe(
      'unknown-host'
    )
    expect(editorFailureReason(Object.assign(new Error('x'), { code: 'connection-lost' }))).toBe('offline')
    expect(editorFailureReason(Object.assign(new Error('x'), { code: 'unknown-channel' }))).toBe('host-update-required')
    expect(editorFailureReason(new Error('x'))).toBe('failed')
  })

  it("keeps each host's editor in a session of its own", () => {
    expect(remoteEditorPartition('server-1/workspaces')).toMatch(/^persist:remote-editor-[0-9a-f]{16}$/)
    expect(remoteEditorPartition('server-1/workspaces')).not.toBe(remoteEditorPartition('direct/host'))
  })
})

describe('the editors of remote hosts', () => {
  it('remember the port of each host and call the host as the main window', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'remote-editors-'))
    closers.push(() => rmSync(dir, { recursive: true, force: true }))
    const portsFile = path.join(dir, 'remote-editor-ports.json')
    const invoke = vi.fn(async () => ({ folder: '/srv/app', phase: 'ready' }))
    const use = vi.fn(() => ({ invoke }))
    const editors = new RemoteEditors({
      registry: () => ({
        list: () => [host({ id: 'direct/host', environment: null })],
        directHost: () => ({ origin: 'http://127.0.0.1:9', token: 'control' }),
        use,
      }),
      fleet: { hasFeature: () => false, hostFilesAccess: () => null },
      portsFile,
      origin: () => 42,
    })
    closers.push(() => editors.close())
    const proxy = await editors.proxy('direct/host')
    expect(await editors.proxy('direct/host')).toBe(proxy)
    const port = Number(new URL(proxy.origin()).port)
    await vi.waitFor(() => expect(JSON.parse(readFileSync(portsFile, 'utf8'))).toEqual({ 'direct/host': port }))

    await expect(editors.call('direct/host', 'editor:open', 'conv-1')).resolves.toEqual({
      folder: '/srv/app',
      phase: 'ready',
    })
    expect(use).toHaveBeenCalledWith('direct/host', 42, expect.any(Function))
    expect(invoke).toHaveBeenCalledWith(42, 'editor:open', ['conv-1'])
    await expect(editors.proxy('server-9/workspaces')).rejects.toMatchObject({ reason: 'unknown-host' })
  })
})
