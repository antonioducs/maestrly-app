import http, { type IncomingHttpHeaders } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, test } from 'vitest'
import type { ArtifactAdmin } from '@maestrly/artifact-host'
import { ArtifactViewerProxy, isArtifactViewerRequest, MAX_VIEWER_BODY_BYTES } from '../src/artifact-viewer-proxy.js'
import { harness } from './harness.js'

interface Reply {
  status: number
  headers: IncomingHttpHeaders
  bytes: Buffer
  body: string
  json: any
}

const servers: http.Server[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

async function listen(handler: http.RequestListener): Promise<number> {
  const server = http.createServer(handler)
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as AddressInfo).port
}

function request(
  port: number,
  method: string,
  target: string,
  options: { headers?: Record<string, string | string[]>; body?: string | Buffer } = {}
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path: target, headers: options.headers, agent: false, setHost: true },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          const bytes = Buffer.concat(chunks)
          const body = bytes.toString('utf8')
          let json: unknown = null
          try {
            json = JSON.parse(body)
          } catch {
            // Not every reply has a JSON body.
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, bytes, body, json })
        })
      }
    )
    req.on('error', reject)
    req.end(options.body)
  })
}

const PAGE = '<html><head></head><body><p id="p">The quick brown fox jumps over the lazy dog.</p></body></html>'
const IMAGE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x01, 0x80, 0x7f, 0xfe])

async function publish(admin: ArtifactAdmin) {
  const detail = await admin.create({
    title: 'Synthetic page',
    owner: { kind: 'device', id: 'device-1' },
    origin: { workspaceId: null, conversationId: 'conversation', conversationTitle: 'Test' },
    files: [
      { path: 'index.html', bytes: new TextEncoder().encode(PAGE) },
      { path: 'app.css', bytes: new TextEncoder().encode('p{color:rgb(1,2,3)}') },
      { path: 'logo.png', bytes: new Uint8Array(IMAGE) },
    ],
  })
  return detail.id
}

/** A browser on one gateway origin: it keeps the cookies the viewer sets and sends what the viewer shell sends. */
function browser(port: number, site: { host: string; origin: string }) {
  const cookies = new Map<string, string>()
  const cookieHeader = (): Record<string, string> =>
    cookies.size ? { cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; ') } : {}
  const remember = (reply: Reply): Reply => {
    for (const line of reply.headers['set-cookie'] ?? []) {
      const [pair] = line.split(';')
      const [name, value = ''] = pair!.split('=')
      if (/Max-Age=0(?:;|$)/.test(line) || value === '') cookies.delete(name!)
      else cookies.set(name!, value)
    }
    return reply
  }
  return {
    cookies,
    raw: (method: string, target: string, headers: Record<string, string> = {}, body?: string) =>
      request(port, method, target, { headers: { host: site.host, ...headers }, body }),
    get: async (target: string, headers: Record<string, string> = {}) =>
      remember(
        await request(port, 'GET', target, {
          headers: { host: site.host, ...cookieHeader(), 'x-maestrly-artifact': '1', ...headers },
        })
      ),
    send: async (method: string, target: string, body?: unknown, headers: Record<string, string> = {}) =>
      remember(
        await request(port, method, target, {
          headers: {
            host: site.host,
            origin: site.origin,
            'x-maestrly-artifact': '1',
            'content-type': 'application/json',
            ...cookieHeader(),
            ...headers,
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        })
      ),
  }
}

async function gatewayViewer(publicAddress = '') {
  const h = await harness()
  await h.artifacts.update({ enabled: true, publicAddress })
  const admin = h.artifacts.admin()!
  const id = await publish(admin)
  const port = Number(new URL(h.origin).port)
  return { h, admin, id, port }
}

async function ownerOf(port: number, admin: ArtifactAdmin, id: string, site: { host: string; origin: string }) {
  const owner = browser(port, site)
  const { ticket } = await admin.mintOwnerTicket(id)
  const session = await owner.send('POST', `/a/${id}/api/session/owner`, { ticket })
  expect(session.status).toBe(204)
  return { owner, session }
}

describe('isArtifactViewerRequest', () => {
  test('recognizes only the viewer paths, in origin form', () => {
    for (const target of [
      '/a/AAAAAAAAAAAAAAAAAAAAAA',
      '/a/AAAAAAAAAAAAAAAAAAAAAA/api/state?x=1',
      '/c/capability.signature/index.html',
      '/_maestrly/shell/0123456789abcdef/viewer.js',
      '/robots.txt',
      '/robots.txt?q',
    ])
      expect(isArtifactViewerRequest(target), target).toBe(true)
    for (const target of [
      '/',
      '/v1/meta',
      '/a',
      '/robots.txt/x',
      '/A/AAAAAAAAAAAAAAAAAAAAAA',
      '/internal/v1/artifacts/admin',
      'http://evil.test/a/AAAAAAAAAAAAAAAAAAAAAA',
      '*',
      '',
    ])
      expect(isArtifactViewerRequest(target), target).toBe(false)
  })
})

describe('ArtifactViewerProxy', () => {
  async function front(proxy: ArtifactViewerProxy, upstream: number) {
    return listen((req, res) => void proxy.forward(req, res, upstream))
  }

  test('preserves the request and response, minus hop-by-hop headers', async () => {
    let seen: { method?: string; url?: string; headers: IncomingHttpHeaders; body: string } | null = null
    const upstream = await listen(async (req, res) => {
      let body = ''
      for await (const chunk of req) body += chunk
      seen = { method: req.method, url: req.url, headers: req.headers, body }
      res.setHeader('set-cookie', ['a=1; Path=/a/x/api; HttpOnly', 'b=2; Path=/a/x/api; HttpOnly'])
      res.setHeader('x-custom', 'kept')
      res.setHeader('connection', 'close, x-upstream-only')
      res.setHeader('x-upstream-only', 'dropped')
      res.setHeader('proxy-authenticate', 'Basic')
      res.setHeader('content-type', 'application/octet-stream')
      res.end(req.method === 'HEAD' ? undefined : IMAGE)
    })
    const proxy = new ArtifactViewerProxy()
    const port = await front(proxy, upstream)
    const reply = await request(port, 'POST', '/a/x/api/frame?version=2&b=%2F', {
      headers: {
        host: 'bots.example.test',
        origin: 'https://bots.example.test',
        cookie: 'maestrly_artifact_session=abc; other=1',
        'x-maestrly-artifact': '1',
        'content-type': 'application/json',
        connection: 'keep-alive, x-drop-me',
        'x-drop-me': 'secret',
        te: 'trailers',
        'proxy-authorization': 'Basic Zm9vOmJhcg==',
      },
      body: '{"version":2}',
    })
    expect(reply.status).toBe(200)
    expect(reply.bytes.equals(IMAGE)).toBe(true)
    expect(reply.headers['set-cookie']).toEqual(['a=1; Path=/a/x/api; HttpOnly', 'b=2; Path=/a/x/api; HttpOnly'])
    expect(reply.headers['x-custom']).toBe('kept')
    expect(reply.headers['x-upstream-only']).toBeUndefined()
    expect(reply.headers['proxy-authenticate']).toBeUndefined()
    expect(seen).toMatchObject({
      method: 'POST',
      url: '/a/x/api/frame?version=2&b=%2F',
      body: '{"version":2}',
      headers: {
        host: 'bots.example.test',
        origin: 'https://bots.example.test',
        cookie: 'maestrly_artifact_session=abc; other=1',
        'x-maestrly-artifact': '1',
        'content-type': 'application/json',
      },
    })
    expect(seen!.headers['x-drop-me']).toBeUndefined()
    expect(seen!.headers.te).toBeUndefined()
    expect(seen!.headers['proxy-authorization']).toBeUndefined()

    const head = await request(port, 'HEAD', '/c/cap.sig/logo.png', { headers: { host: 'bots.example.test' } })
    expect(head.status).toBe(200)
    expect(head.bytes.length).toBe(0)
    expect(seen!.method).toBe('HEAD')
  })

  test('keeps each request body framed, whatever the client lists as hop-by-hop', async () => {
    const seen: Array<{ method?: string; url?: string; body: string; length?: string; chunked: boolean }> = []
    const upstream = await listen(async (req, res) => {
      let body = ''
      for await (const chunk of req) body += chunk
      seen.push({
        method: req.method,
        url: req.url,
        body,
        length: req.headers['content-length'],
        chunked: req.headers['transfer-encoding'] === 'chunked',
      })
      res.end()
    })
    const port = await front(new ArtifactViewerProxy(), upstream)
    const send = (method: string, target: string, headers: Record<string, string>, parts: string[]) =>
      new Promise<number>((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, method, path: target, headers, agent: false }, (res) => {
          res.resume()
          res.on('end', () => resolve(res.statusCode ?? 0))
        })
        req.on('error', reject)
        for (const part of parts) req.write(part)
        req.end()
      })
    expect(
      await send('POST', '/a/x/api/one', { 'content-length': '7', connection: 'content-length' }, ['{"a":1}'])
    ).toBe(200)
    expect(await send('DELETE', '/a/x/api/two', { 'transfer-encoding': 'chunked' }, ['ab', 'cd'])).toBe(200)
    expect(seen).toEqual([
      { method: 'POST', url: '/a/x/api/one', body: '{"a":1}', length: '7', chunked: false },
      { method: 'DELETE', url: '/a/x/api/two', body: 'abcd', length: undefined, chunked: true },
    ])
  })

  test('never invents a Host, even when the client lists it as hop-by-hop', async () => {
    let host: string | undefined = 'unset'
    const upstream = await listen((req, res) => {
      host = req.headers.host
      res.end()
    })
    const port = await front(new ArtifactViewerProxy(), upstream)
    await request(port, 'GET', '/robots.txt', { headers: { host: 'bots.example.test', connection: 'host' } })
    expect(host).toBe('bots.example.test')
  })

  test('answers 503 when the host is down or too slow, and 413 for an oversized body', async () => {
    const closed = await listen(() => {})
    servers.pop()!.close()
    const slow = await listen(() => {})
    let contacted = false
    const counting = await listen((req, res) => {
      contacted = true
      req.resume()
      req.on('end', () => res.end())
    })
    const proxy = new ArtifactViewerProxy({ timeoutMs: 100 })
    const down = await request(await front(proxy, closed), 'GET', '/robots.txt')
    expect(down.status).toBe(503)
    expect(down.headers['content-type']).toBe('text/plain; charset=utf-8')
    expect(down.body).toBe('Artifact hosting is unavailable')
    expect((await request(await front(proxy, slow), 'GET', '/robots.txt')).status).toBe(503)
    const countingFront = await front(proxy, counting)
    // The answer comes before the body is sent; a client still writing a large body would race the closed connection.
    const declared = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: countingFront,
          method: 'POST',
          path: '/a/x/api/comments',
          headers: { 'content-type': 'application/json', 'content-length': String(MAX_VIEWER_BODY_BYTES + 1) },
          agent: false,
        },
        (res) => {
          res.resume()
          resolve(res.statusCode ?? 0)
          req.destroy()
        }
      )
      req.on('error', reject)
      req.write('{')
    })
    expect(declared).toBe(413)
    expect(contacted).toBe(false)
    // Without a declared length, the body is counted as it arrives.
    const streamed = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: countingFront,
          method: 'POST',
          path: '/a/x/api/comments',
          headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' },
          agent: false,
        },
        (res) => {
          res.resume()
          resolve(res.statusCode ?? 0)
          req.destroy()
        }
      )
      req.on('error', (error) => (req.destroyed ? undefined : reject(error)))
      req.write(Buffer.alloc(MAX_VIEWER_BODY_BYTES + 1, 32))
    })
    expect(streamed).toBe(413)
  })

  test('stops the upstream request when the client leaves or the proxy closes', async () => {
    const upstreamClosed: string[] = []
    const upstream = await listen((req) => {
      req.on('close', () => upstreamClosed.push(req.url!))
    })
    const proxy = new ArtifactViewerProxy()
    const port = await front(proxy, upstream)

    const client = http.request({ host: '127.0.0.1', port, path: '/a/leaving', agent: false })
    client.on('error', () => {})
    client.end()
    for (let i = 0; i < 100 && proxy.activeCount() === 0; i++) await new Promise((r) => setTimeout(r, 10))
    expect(proxy.activeCount()).toBe(1)
    client.destroy()
    for (let i = 0; i < 100 && !upstreamClosed.includes('/a/leaving'); i++) await new Promise((r) => setTimeout(r, 10))
    expect(upstreamClosed).toContain('/a/leaving')
    for (let i = 0; i < 100 && proxy.activeCount() > 0; i++) await new Promise((r) => setTimeout(r, 10))
    expect(proxy.activeCount()).toBe(0)

    const pending = request(port, 'GET', '/a/closing')
    for (let i = 0; i < 100 && proxy.activeCount() === 0; i++) await new Promise((r) => setTimeout(r, 10))
    proxy.close()
    expect((await pending).status).toBe(503)
    expect(proxy.activeCount()).toBe(0)
    expect((await request(port, 'GET', '/a/after')).status).toBe(503)
  })
})

describe('gateway entry', () => {
  test('serves the whole viewer through the public port with the API', async () => {
    const { h, admin, id, port } = await gatewayViewer()
    const site = { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}` }
    const shell = await browser(port, site).get(`/a/${id}`)
    expect(shell.status).toBe(200)
    expect(shell.headers['content-type']).toBe('text/html; charset=utf-8')
    expect(shell.headers['content-security-policy']).toContain(`frame-src ${site.origin}/c/`)
    const asset = /\/_maestrly\/shell\/[0-9a-f]{16}\/[a-z0-9-]+\.js/.exec(shell.body)![0]
    expect((await browser(port, site).get(asset)).status).toBe(200)
    expect((await browser(port, site).get('/robots.txt')).body).toContain('Disallow: /')

    const { owner, session } = await ownerOf(port, admin, id, site)
    expect(session.headers['set-cookie']?.[0]).toContain(`Path=/a/${id}/api`)
    expect(session.headers['set-cookie']?.[0]).not.toContain('Secure')
    const state = await owner.get(`/a/${id}/api/state`)
    expect(state.status).toBe(200)
    expect(state.json).toMatchObject({ artifact: { id, title: 'Synthetic page' }, identity: { kind: 'owner' } })
    expect(state.json.sharing.link).toBe(`${site.origin}/a/${id}`)

    const frame = await owner.send('POST', `/a/${id}/api/frame`, { version: 1 })
    expect(frame.status).toBe(200)
    const content: string = frame.json.url
    expect(content).toMatch(/^\/c\/[^/]+\/index\.html$/)
    const html = await owner.raw('GET', content)
    expect(html.status).toBe(200)
    expect(html.body).toContain('The quick brown fox')
    expect(html.body).toContain('_maestrly/bridge.js')
    expect(html.headers['content-security-policy']).toContain(`frame-ancestors ${site.origin}`)
    const base = content.slice(0, -'index.html'.length)
    const css = await owner.raw('GET', `${base}app.css?cache=1`)
    expect(css.status).toBe(200)
    expect(css.body).toBe('p{color:rgb(1,2,3)}')
    const image = await owner.raw('GET', `${base}logo.png`)
    expect(image.status).toBe(200)
    expect(image.headers['content-type']).toBe('image/png')
    expect(image.bytes.equals(IMAGE)).toBe(true)
    const head = await owner.raw('HEAD', `${base}logo.png`)
    expect(head.status).toBe(200)
    expect(head.bytes.length).toBe(0)

    expect((await owner.send('POST', `/a/${id}/api/comments`, { version: 1, body: 'First' })).status).toBe(201)
    expect((await owner.send('POST', `/a/${id}/api/comments`, { version: 1, body: 'Second' })).status).toBe(201)
    const page = await owner.get(`/a/${id}/api/comments?limit=1`)
    expect(page.status).toBe(200)
    expect(page.json.comments).toHaveLength(1)
    expect(page.json.nextCursor).toEqual(expect.any(String))
    expect((await owner.get(`/a/${id}/api/comments?limit=bad`)).status).toBe(400)

    // The fleet API keeps its own rules on the same port.
    expect((await request(port, 'GET', '/v1/bots', { headers: { origin: site.origin } })).status).toBe(403)
    expect((await request(port, 'GET', '/v1/bots', { headers: { 'x-maestrly-fleet-protocol': '1' } })).status).toBe(401)
    expect((await h.request('GET', '/v1/meta')).status).toBe(200)
  })

  test('keeps sharing, revocation and the viewer’s own checks through the gateway', async () => {
    const { admin, id, port } = await gatewayViewer()
    const site = { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}` }
    const stranger = browser(port, site)
    expect((await stranger.get(`/a/${id}/api/state`)).status).toBe(404)

    await admin.setSharing(id, { visibility: 'link' })
    const guest = browser(port, site)
    expect((await guest.send('POST', `/a/${id}/api/session/code`, {})).status).toBe(204)
    expect((await guest.get(`/a/${id}/api/state`)).json.identity).toEqual({ kind: 'guest', name: null })
    const frame = await guest.send('POST', `/a/${id}/api/frame`, { version: 1 })
    expect(frame.status).toBe(200)
    expect((await guest.raw('GET', frame.json.url)).status).toBe(200)

    await admin.setSharing(id, { visibility: 'private' })
    expect((await guest.get(`/a/${id}/api/state`)).status).toBe(404)
    expect((await guest.raw('GET', frame.json.url)).status).toBe(404)

    const { owner } = await ownerOf(port, admin, id, site)
    const writes = `/a/${id}/api/frame`
    expect((await browser(port, { ...site, host: 'evil.test' }).get(`/a/${id}`)).status).toBe(403)
    expect((await owner.send('POST', writes, { version: 1 }, { origin: 'http://evil.test' })).status).toBe(403)
    expect((await owner.send('POST', writes, { version: 1 }, { origin: 'null' })).status).toBe(403)
    expect((await owner.send('POST', writes, { version: 1 }, { 'x-maestrly-artifact': '0' })).status).toBe(403)
    expect((await owner.send('POST', writes, { pad: 'x'.repeat(70 * 1024), version: 1 })).status).toBe(413)
  })

  test('uses the public HTTPS address the gateway is exposed at', async () => {
    const publicAddress = 'https://bots.example.ts.net'
    const { admin, id, port } = await gatewayViewer(publicAddress)
    const site = { host: 'bots.example.ts.net', origin: publicAddress }
    const shell = await browser(port, site).get(`/a/${id}`)
    expect(shell.status).toBe(200)
    expect(shell.headers['content-security-policy']).toContain(`frame-src ${publicAddress}/c/`)
    const { owner, session } = await ownerOf(port, admin, id, site)
    expect(session.headers['set-cookie']?.[0]).toMatch(/; Secure$/)
    const state = await owner.get(`/a/${id}/api/state`)
    expect(state.json.sharing).toMatchObject({ link: `${publicAddress}/a/${id}`, local: false })
    const frame = await owner.send('POST', `/a/${id}/api/frame`, { version: 1 })
    const html = await owner.raw('GET', frame.json.url)
    expect(html.status).toBe(200)
    expect(html.headers['content-security-policy']).toContain(`frame-ancestors ${publicAddress}`)
    expect((await browser(port, { host: 'other.ts.net', origin: 'https://other.ts.net' }).get(`/a/${id}`)).status).toBe(
      403
    )

    await admin.setSharing(id, { visibility: 'link', accessCode: 'letmein1' })
    const guest = browser(port, site)
    expect((await guest.send('POST', `/a/${id}/api/session/code`, { code: 'wrong-code' })).status).toBe(403)
    const entered = await guest.send('POST', `/a/${id}/api/session/code`, { code: 'letmein1' })
    expect(entered.status).toBe(204)
    expect(entered.headers['set-cookie']?.some((line) => line.endsWith('; Secure'))).toBe(true)
    const guestFrame = await guest.send('POST', `/a/${id}/api/frame`, { version: 1 })
    expect((await guest.raw('GET', guestFrame.json.url)).status).toBe(200)
    await admin.revokeAllSessions(id)
    expect((await guest.raw('GET', guestFrame.json.url)).status).toBe(404)
    expect((await guest.get(`/a/${id}/api/state`)).json.artifact).toBeUndefined()
  })

  test('answers 503 while hosting is off or restarting, then serves the reopened host', async () => {
    const { h, admin, id, port } = await gatewayViewer()
    const site = { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}` }
    const { owner } = await ownerOf(port, admin, id, site)

    // A request still sending its body when the host restarts is answered, not left hanging.
    const inFlight = new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: `/a/${id}/api/frame`,
          headers: {
            host: site.host,
            origin: site.origin,
            'x-maestrly-artifact': '1',
            'content-type': 'application/json',
            'content-length': '64',
            cookie: [...owner.cookies].map(([name, value]) => `${name}=${value}`).join('; '),
          },
          agent: false,
        },
        (res) => {
          res.resume()
          resolve(res.statusCode ?? 0)
        }
      )
      req.on('error', reject)
      req.write('{"version":')
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    await h.artifacts.update({ ownerName: 'Restarted' })
    expect(await inFlight).toBe(503)

    const reopened = h.artifacts.admin()!
    expect((await ownerOf(port, reopened, id, site)).session.status).toBe(204)
    await h.artifacts.update({ enabled: false })
    const off = await browser(port, site).get(`/a/${id}`)
    expect(off.status).toBe(503)
    expect(off.body).toBe('Artifact hosting is unavailable')
  })
})
