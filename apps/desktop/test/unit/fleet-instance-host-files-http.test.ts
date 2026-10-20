import { once } from 'node:events'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  type HostFilesRoutes,
  isHostFilesRoute,
  serveHostFilesRoute,
} from '../../src/main/fleet/instance/host-files-http'
import { routeFor, sendInstanceError } from '../../src/main/fleet/instance/http'

const STAT = { path: '/home/u/a.txt', name: 'a.txt', size: 3, modifiedAt: 1, identity: '1:2:3' }
const UPLOAD_ID = 'abcdefghijklmnopqrstuv'

function fakeRoutes() {
  return {
    stat: vi.fn(async () => STAT),
    digest: vi.fn(),
    content: vi.fn(async (_request: http.IncomingMessage, response: http.ServerResponse, url: URL) => {
      response.writeHead(200, { 'content-type': 'application/octet-stream' })
      response.end(`content of ${url.searchParams.get('path')}`)
    }),
    beginUpload: vi.fn(),
    uploadChunk: vi.fn(),
    commitUpload: vi.fn(),
    abortUpload: vi.fn(async () => undefined),
    beginArchive: vi.fn(),
    archiveStatus: vi.fn(),
    releaseArchive: vi.fn(),
  }
}

const closers: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of closers.splice(0)) await close()
})

async function serve(routes: ReturnType<typeof fakeRoutes>): Promise<string> {
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://localhost')
      const match = routeFor(request.method ?? '', url.pathname)
      if (!match || !isHostFilesRoute(match.key)) throw new Error('not a host-files route')
      await serveHostFilesRoute(
        routes as unknown as HostFilesRoutes,
        { key: match.key, params: match.params },
        request,
        response,
        url
      )
    } catch (error) {
      sendInstanceError(response, error)
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  closers.push(() => new Promise((resolve) => server.close(() => resolve())))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

describe('host-files routes', () => {
  it('answers a JSON route with what the host files return', async () => {
    const routes = fakeRoutes()
    const origin = await serve(routes)
    const response = await fetch(`${origin}/v1/host-files/stat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: '/home/u/a.txt' }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(STAT)
    expect(routes.stat).toHaveBeenCalledWith({ path: '/home/u/a.txt' })
  })

  it('answers a route without a result with no content', async () => {
    const routes = fakeRoutes()
    const origin = await serve(routes)
    const response = await fetch(`${origin}/v1/host-files/uploads/${UPLOAD_ID}`, { method: 'DELETE' })
    expect(response.status).toBe(204)
    expect(routes.abortUpload).toHaveBeenCalledWith(UPLOAD_ID)
  })

  it('streams content through the host files', async () => {
    const routes = fakeRoutes()
    const origin = await serve(routes)
    const response = await fetch(`${origin}/v1/host-files/content?path=x`)
    expect(await response.text()).toBe('content of x')
    expect(routes.content).toHaveBeenCalledTimes(1)
  })

  it('refuses a body that is not JSON', async () => {
    const routes = fakeRoutes()
    const origin = await serve(routes)
    const response = await fetch(`${origin}/v1/host-files/stat`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'path',
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ code: 'INVALID_REQUEST' })
    expect(routes.stat).not.toHaveBeenCalled()
  })
})
