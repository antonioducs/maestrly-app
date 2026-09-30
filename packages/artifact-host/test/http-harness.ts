import http from 'node:http'
import path from 'node:path'
import { vi } from 'vitest'
import { type ArtifactAdmin, createArtifactAdmin } from '../src/admin.js'
import { createPublicServer, type PublicServer } from '../src/http/server.js'
import { createActivityRecorder } from '../src/sharing-admin.js'
import { ArtifactStore } from '../src/store/artifact-store.js'
import { BlobStore } from '../src/store/blobs.js'
import { openDatabase } from '../src/store/db.js'
import { SharingStore } from '../src/store/sharing-store.js'
import { tempDir, testClock, utf8 } from './helpers.js'

export interface Reply {
  status: number
  headers: http.IncomingHttpHeaders
  body: string
  json: any
}

/** One visitor's browser: it keeps the cookies the host sets and sends what the viewer shell sends. */
export interface Browser {
  cookies: Map<string, string>
  get(target: string, headers?: Record<string, string>): Promise<Reply>
  send(
    method: 'POST' | 'PUT' | 'DELETE',
    target: string,
    body?: unknown,
    headers?: Record<string, string>
  ): Promise<Reply>
  /** A request without the cookies, for URLs that carry their own capability. */
  raw(method: string, target: string, options?: { headers?: Record<string, string>; body?: string }): Promise<Reply>
}

export interface Harness {
  store: ArtifactStore
  sharing: SharingStore
  admin: ArtifactAdmin
  server: PublicServer
  clock: ReturnType<typeof testClock>
  onActivity: ReturnType<typeof vi.fn>
  port: number
  origin: string
  /** An artifact with `index.html` (a paragraph) published as version 1. */
  id: string
  browser(): Browser
  /** A browser holding an owner session for `id`. */
  owner(): Promise<Browser>
  createArtifact(title?: string): Promise<string>
  close(): Promise<void>
}

export const PAGE = '<html><head></head><body><p id="p">The quick brown fox jumps over the lazy dog.</p></body></html>'

export async function startHarness(options: { ownerName?: string } = {}): Promise<Harness> {
  const temp = tempDir()
  const store = new ArtifactStore(openDatabase(path.join(temp.dir, 'artifacts.sqlite')))
  const sharing = new SharingStore(store.db)
  const blobs = new BlobStore(path.join(temp.dir, 'blobs'))
  const clock = testClock()
  const onActivity = vi.fn()
  const ownerName = options.ownerName ?? 'Antonio'
  const admin = createArtifactAdmin({
    store,
    blobs,
    clock: clock.now,
    quotaBytes: 10 * 1024 * 1024,
    sharing,
    onActivity,
  })
  const server = createPublicServer({
    store,
    blobs,
    capabilityKey: store.capabilityKey(),
    clock: clock.now,
    port: 0,
    sharing,
    ownerName,
    recordActivity: createActivityRecorder({ sharing, clock: clock.now, onActivity }),
  })
  const port = await server.listen()
  const origin = `http://127.0.0.1:${port}`

  function request(
    method: string,
    target: string,
    options: { headers?: Record<string, string>; body?: string } = {}
  ): Promise<Reply> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, method, path: target, headers: options.headers, agent: false },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (chunk: Buffer) => chunks.push(chunk))
          res.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf8')
            let json: unknown = null
            try {
              json = JSON.parse(body)
            } catch {
              // Not every reply has a JSON body.
            }
            resolve({ status: res.statusCode ?? 0, headers: res.headers, body, json })
          })
        }
      )
      req.on('error', reject)
      req.end(options.body)
    })
  }

  function browser(): Browser {
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
      get: async (target, headers = {}) =>
        remember(
          await request('GET', target, { headers: { ...cookieHeader(), 'x-maestrly-artifact': '1', ...headers } })
        ),
      send: async (method, target, body, headers = {}) =>
        remember(
          await request(method, target, {
            headers: {
              origin,
              'x-maestrly-artifact': '1',
              'content-type': 'application/json',
              ...cookieHeader(),
              ...headers,
            },
            body: body === undefined ? undefined : JSON.stringify(body),
          })
        ),
      raw: request,
    }
  }

  const createArtifact = async (title = 'Probe') =>
    (
      await admin.create({
        title,
        owner: { kind: 'local', id: 'local' },
        origin: { workspaceId: null, conversationId: 'c1', conversationTitle: null },
        files: [{ path: 'index.html', bytes: utf8(PAGE) }],
      })
    ).id
  const id = await createArtifact()

  return {
    store,
    sharing,
    admin,
    server,
    clock,
    onActivity,
    port,
    origin,
    id,
    browser,
    createArtifact,
    async owner() {
      const mine = browser()
      const { ticket } = await admin.mintOwnerTicket(id)
      const reply = await mine.send('POST', `/a/${id}/api/session/owner`, { ticket })
      if (reply.status !== 204) throw new Error(`owner session failed: ${reply.status}`)
      return mine
    },
    async close() {
      await server.close()
      store.close()
      temp.cleanup()
    },
  }
}
