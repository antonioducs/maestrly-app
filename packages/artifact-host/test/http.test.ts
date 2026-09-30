import http from 'node:http'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type ArtifactAdmin, createArtifactAdmin } from '../src/admin.js'
import { ArtifactHostError } from '../src/errors.js'
import { BRIDGE_SCRIPT, SHELL_VERSION } from '../src/generated/shell-assets.js'
import { contentHeaders } from '../src/http/headers.js'
import { createPublicServer, type PublicServer } from '../src/http/server.js'
import { CAPABILITY_TTL_MS } from '../src/limits.js'
import { ArtifactStore } from '../src/store/artifact-store.js'
import { BlobStore } from '../src/store/blobs.js'
import { openDatabase } from '../src/store/db.js'
import { tempDir, testClock, utf8 } from './helpers.js'

interface Reply {
  status: number
  headers: http.IncomingHttpHeaders
  body: string
}

let cleanup: () => void
let store: ArtifactStore
let blobs: BlobStore
let admin: ArtifactAdmin
let server: PublicServer
let clock: ReturnType<typeof testClock>
let port: number
let origin: string
let id: string

function request(
  method: string,
  target: string,
  options: { headers?: Record<string, string>; body?: string | Buffer } = {}
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path: target, headers: options.headers, agent: false },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') })
        )
      }
    )
    req.on('error', reject)
    req.end(options.body)
  })
}

const writeHeaders = (extra: Record<string, string> = {}) => ({
  origin,
  'x-maestrly-artifact': '1',
  'content-type': 'application/json',
  ...extra,
})

async function ownerSession(artifactId = id): Promise<string> {
  const { ticket } = await admin.mintOwnerTicket(artifactId)
  const reply = await request('POST', `/a/${artifactId}/api/session/owner`, {
    headers: writeHeaders(),
    body: JSON.stringify({ ticket }),
  })
  expect(reply.status).toBe(204)
  return (reply.headers['set-cookie']?.[0] ?? '').split(';')[0]!
}

async function frameUrl(cookie: string, version = 1): Promise<string> {
  const reply = await request('POST', `/a/${id}/api/frame`, {
    headers: writeHeaders({ cookie }),
    body: JSON.stringify({ version }),
  })
  expect(reply.status).toBe(200)
  return JSON.parse(reply.body).url as string
}

beforeEach(async () => {
  const temp = tempDir()
  cleanup = temp.cleanup
  store = new ArtifactStore(openDatabase(path.join(temp.dir, 'artifacts.sqlite')))
  blobs = new BlobStore(path.join(temp.dir, 'blobs'))
  clock = testClock()
  admin = createArtifactAdmin({ store, blobs, clock: clock.now, quotaBytes: 10 * 1024 * 1024 })
  server = createPublicServer({ store, blobs, capabilityKey: store.capabilityKey(), clock: clock.now, port: 0 })
  port = await server.listen()
  origin = `http://127.0.0.1:${port}`
  ;({ id } = await admin.create({
    title: 'Probe',
    owner: { kind: 'local', id: 'local' },
    origin: { workspaceId: null, conversationId: 'c1', conversationTitle: null },
    files: [
      { path: 'index.html', bytes: utf8('<p>hi</p><script>1</script>') },
      { path: 'app.css', bytes: utf8('p{}') },
      { path: 'sub/index.html', bytes: utf8('<html><head></head><body>sub</body></html>') },
    ],
  }))
})

afterEach(async () => {
  await server.close()
  store.close()
  cleanup()
})

describe('public server', () => {
  it('serves the static viewer shell', async () => {
    const reply = await request('GET', `/a/${id}`)
    expect(reply.status).toBe(200)
    expect(reply.headers['content-type']).toBe('text/html; charset=utf-8')
    expect(reply.headers['content-security-policy']).toContain("frame-ancestors 'none'")
    expect(reply.body).toContain(`/_maestrly/shell/${SHELL_VERSION}/viewer.js`)
    expect(reply.body).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/)
  })

  it('refuses unknown hosts', async () => {
    expect((await request('GET', `/a/${id}`, { headers: { host: 'evil.test' } })).status).toBe(403)
    expect((await request('GET', `/a/${id}`, { headers: { host: `localhost:${port}` } })).status).toBe(200)
  })

  it('answers the same 404 for missing and inaccessible artifacts', async () => {
    const hidden = await request('GET', `/a/${id}/api/state`)
    const missing = await request('GET', `/a/${'A'.repeat(22)}/api/state`)
    expect(hidden.status).toBe(404)
    expect(JSON.parse(hidden.body)).toEqual({ error: 'not_found' })
    expect(missing.status).toBe(404)
    expect(missing.body).toBe(hidden.body)
  })

  it('accepts owner tickets only from the viewer, once, and before they expire', async () => {
    const post = async (headers: Record<string, string>, artifactId = id) => {
      const { ticket } = await admin.mintOwnerTicket(artifactId)
      return (await request('POST', `/a/${id}/api/session/owner`, { headers, body: JSON.stringify({ ticket }) })).status
    }
    const { origin: _origin, ...withoutOrigin } = writeHeaders()
    expect(await post(withoutOrigin)).toBe(403)
    expect(await post(writeHeaders({ origin: 'http://evil.test' }))).toBe(403)
    const { 'x-maestrly-artifact': _header, ...withoutHeader } = writeHeaders()
    expect(await post(withoutHeader)).toBe(403)
    expect(await post(writeHeaders({ 'content-type': 'text/plain' }))).toBe(403)

    const { ticket } = await admin.mintOwnerTicket(id)
    const exchange = () =>
      request('POST', `/a/${id}/api/session/owner`, { headers: writeHeaders(), body: JSON.stringify({ ticket }) })
    const accepted = await exchange()
    expect(accepted.status).toBe(204)
    const cookie = accepted.headers['set-cookie']?.[0] ?? ''
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Strict')
    expect(cookie).toContain(`Path=/a/${id}/api`)
    expect(cookie).not.toContain('Secure')
    expect((await exchange()).status).toBe(404)

    const late = await admin.mintOwnerTicket(id)
    clock.advance(61_000)
    const expired = await request('POST', `/a/${id}/api/session/owner`, {
      headers: writeHeaders(),
      body: JSON.stringify({ ticket: late.ticket }),
    })
    expect(expired.status).toBe(404)

    const other = await admin.create({
      title: 'Other',
      owner: { kind: 'local', id: 'local' },
      origin: { workspaceId: null, conversationId: null, conversationTitle: null },
      files: [{ path: 'index.html', bytes: utf8('x') }],
    })
    expect(await post(writeHeaders(), other.id)).toBe(404)
  })

  it('returns the viewer state to the owner', async () => {
    const cookie = await ownerSession()
    const reply = await request('GET', `/a/${id}/api/state`, { headers: { cookie } })
    expect(reply.status).toBe(200)
    expect(reply.headers['cache-control']).toBe('no-store')
    const state = JSON.parse(reply.body)
    expect(state.identity).toEqual({ kind: 'owner' })
    expect(state).toMatchObject({ ownerName: '', can: { comment: true, resolve: true } })
    // Without a public address the owner's link is the one they opened, on this computer.
    expect(state.sharing).toEqual({
      visibility: 'private',
      link: `http://127.0.0.1:${port}/a/${id}`,
      local: true,
      linkExpiresAt: null,
      people: [],
      peopleCount: 0,
      requests: 0,
    })
    expect(state.artifact).toMatchObject({ id, title: 'Probe', currentVersion: 1 })
    expect(state.artifact.versions).toEqual([{ number: 1, createdAt: clock.now(), summary: '' }])
  })

  it('serves isolated content under a capability', async () => {
    const cookie = await ownerSession()
    const url = await frameUrl(cookie)
    expect(url).toMatch(/^\/c\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\/index\.html$/)
    const capabilityPath = url.slice(0, url.lastIndexOf('/'))

    const page = await request('GET', url)
    expect(page.status).toBe(200)
    for (const [name, value] of Object.entries(contentHeaders(origin, capabilityPath)))
      expect(page.headers[name], name).toBe(value)
    expect(page.headers['content-type']).toBe('text/html; charset=utf-8')
    expect(page.body).toBe(`<script src="${capabilityPath}/_maestrly/bridge.js"></script><p>hi</p><script>1</script>`)

    expect((await request('GET', `${capabilityPath}/app.css`)).headers['content-type']).toBe('text/css; charset=utf-8')
    const sub = await request('GET', `${capabilityPath}/sub/`)
    expect(sub.body).toBe(
      `<html><head><script src="${capabilityPath}/_maestrly/bridge.js"></script></head><body>sub</body></html>`
    )
    const bridge = await request('GET', `${capabilityPath}/_maestrly/bridge.js`)
    expect(bridge.status).toBe(200)
    expect(bridge.body).toBe(BRIDGE_SCRIPT)
    expect((await request('GET', `${capabilityPath}/missing.css`)).status).toBe(404)
  })

  it('refuses tampered, expired and revoked capabilities', async () => {
    const cookie = await ownerSession()
    const url = await frameUrl(cookie)
    const tampered = url.replace(/\.([A-Za-z0-9_-])/, (_match, char: string) => `.${char === 'A' ? 'B' : 'A'}`)
    expect((await request('GET', tampered)).status).toBe(404)

    clock.advance(CAPABILITY_TTL_MS + 1)
    expect((await request('GET', url)).status).toBe(404)

    const fresh = await frameUrl(cookie)
    expect((await request('GET', fresh)).status).toBe(200)
    const left = await request('DELETE', `/a/${id}/api/session`, { headers: writeHeaders({ cookie }) })
    expect(left.status).toBe(204)
    expect(left.headers['set-cookie']?.[0]).toContain('Max-Age=0')
    expect((await request('GET', fresh)).status).toBe(404)
    expect((await request('GET', `/a/${id}/api/state`, { headers: { cookie } })).status).toBe(404)
  })

  it('refuses encoded path traversal', async () => {
    const cookie = await ownerSession()
    const url = await frameUrl(cookie)
    const capabilityPath = url.slice(0, url.lastIndexOf('/'))
    for (const suffix of ['..%2Fx', '%2e%2e/x', 'a%2Fb.html', '%E0%A4%A.html', '.env'])
      expect((await request('GET', `${capabilityPath}/${suffix}`)).status, suffix).toBe(404)
  })

  it('stops serving a deleted artifact', async () => {
    const cookie = await ownerSession()
    const url = await frameUrl(cookie)
    await admin.delete(id)
    expect((await request('GET', `/a/${id}/api/state`, { headers: { cookie } })).status).toBe(404)
    expect((await request('GET', url)).status).toBe(404)
  })

  it('serves robots.txt and immutable shell assets', async () => {
    const robots = await request('GET', '/robots.txt')
    expect(robots.body).toContain('Disallow: /')
    const asset = await request('GET', `/_maestrly/shell/${SHELL_VERSION}/viewer.js`)
    expect(asset.status).toBe(200)
    expect(asset.headers['cache-control']).toContain('immutable')
    expect(asset.headers['content-type']).toBe('text/javascript; charset=utf-8')
    expect((await request('GET', `/_maestrly/shell/${'0'.repeat(16)}/viewer.js`)).status).toBe(404)
    expect((await request('GET', '/anything')).status).toBe(404)
    expect((await request('POST', `/a/${id}`)).status).toBe(404)
  })

  it('reports a busy port', async () => {
    const second = createPublicServer({
      store,
      blobs,
      capabilityKey: store.capabilityKey(),
      clock: clock.now,
      port,
    })
    const error = await second.listen().catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(ArtifactHostError)
    expect((error as ArtifactHostError).code).toBe('port_in_use')
  })

  it('limits request bodies', async () => {
    const cookie = await ownerSession()
    const reply = await request('POST', `/a/${id}/api/frame`, {
      headers: writeHeaders({ cookie }),
      body: JSON.stringify({ version: 1, padding: 'x'.repeat(65 * 1024) }),
    })
    expect(reply.status).toBe(413)
    const invalid = await request('POST', `/a/${id}/api/frame`, { headers: writeHeaders({ cookie }), body: '{' })
    expect(invalid.status).toBe(400)
  })
})
