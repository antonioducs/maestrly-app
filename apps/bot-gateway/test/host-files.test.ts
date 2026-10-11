import { createHash, randomBytes } from 'node:crypto'
import { once } from 'node:events'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  FLEET_HOST_FILE_GATEWAY_ERRORS,
  FLEET_HOST_FILE_LIMITS,
  FLEET_HOST_FILE_ROUTE_KEYS,
  FLEET_GATEWAY_ROUTES,
} from '@maestrly/bot-fleet-protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { GatewayError } from '../src/errors.js'
import { HostFilesProxy, type HostFilesProxyDeps } from '../src/host-files.js'

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const servers: http.Server[] = []
afterEach(async () => {
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

type Seen = { method: string; url: string; headers: http.IncomingHttpHeaders; body: Buffer }
type Scenario = (req: http.IncomingMessage, res: http.ServerResponse, body: Buffer) => void

/** A workspaces environment's control server: it records each request and answers as the scenario says. */
async function environment(scenario: Scenario) {
  const seen: Seen[] = []
  const port = await listen(
    http.createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      const body = Buffer.concat(chunks)
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body })
      scenario(req, res, body)
    })
  )
  return { port, seen }
}

/** A gateway that sends every request to the proxy, as the fleet API does once the device is authenticated. */
async function gateway(proxy: HostFilesProxy) {
  const port = await listen(
    http.createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://gateway')
      const key = FLEET_HOST_FILE_ROUTE_KEYS.find((candidate) => {
        const route = FLEET_GATEWAY_ROUTES[candidate]
        const pattern = new RegExp('^' + route.path.replace(/:[A-Za-z]+/g, '[^/]+') + '$')
        return route.method === req.method && pattern.test(url.pathname)
      })!
      const names = [...FLEET_GATEWAY_ROUTES[key].path.matchAll(/:([A-Za-z]+)/g)].map((match) => match[1])
      const values = new RegExp('^' + FLEET_GATEWAY_ROUTES[key].path.replace(/:[A-Za-z]+/g, '([^/]+)') + '$').exec(
        url.pathname
      )!
      const params = Object.fromEntries(names.map((name, index) => [name, decodeURIComponent(values[index + 1])]))
      try {
        await proxy.forward(key, params, url, req, res, String(req.headers['x-device'] ?? 'd1'))
      } catch (error) {
        const known = error instanceof GatewayError ? error : new GatewayError('INTERNAL', 'failed')
        res.writeHead(known.status, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ code: known.code, message: known.message }))
      }
    })
  )
  return `http://127.0.0.1:${port}`
}

async function setup(scenario: Scenario, overrides: Partial<HostFilesProxyDeps> = {}) {
  const upstream = await environment(scenario)
  const proxy = new HostFilesProxy({
    host: () => '127.0.0.1',
    secret: () => 'control',
    supports: () => true,
    instancePort: upstream.port,
    idleTimeoutMs: 2_000,
    slowTimeoutMs: 5_000,
    ...overrides,
  })
  return { proxy, origin: await gateway(proxy), seen: upstream.seen }
}

/** A body that arrives slowly: the first bytes at once, the rest never. */
const slow: Scenario = (_req, res) => {
  res.writeHead(206, { 'content-type': 'application/octet-stream' })
  res.write(Buffer.alloc(1024, 1))
}

describe('host files proxy', () => {
  it('passes a range read through with the control token, and its answer back untouched', async () => {
    const body = Buffer.from('0123456789')
    const h = await setup((_req, res) => {
      res.writeHead(206, {
        'content-range': 'bytes 2-9/10',
        'x-maestrly-sha256': sha(body.subarray(2)),
        'x-maestrly-length': '8',
        'content-length': '8',
      })
      res.end(body.subarray(2))
    })
    const response = await fetch(h.origin + '/v1/environments/workspaces/host-files/content?path=%2Fsrv%2Fa', {
      headers: {
        authorization: 'Bearer device-token',
        'x-maestrly-fleet-protocol': '1',
        range: 'bytes=2-9',
        'x-maestrly-file-identity': '10:1:2',
      },
    })
    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe('bytes 2-9/10')
    expect(response.headers.get('x-maestrly-sha256')).toBe(sha(body.subarray(2)))
    expect(await response.text()).toBe('23456789')
    const [request] = h.seen
    expect(request.method).toBe('GET')
    expect(request.url).toBe('/v1/host-files/content?path=%2Fsrv%2Fa')
    expect(request.headers.authorization).toBe('Bearer control')
    expect(request.headers['x-maestrly-fleet-protocol']).toBe('1')
    expect(request.headers.range).toBe('bytes=2-9')
    expect(request.headers['x-maestrly-file-identity']).toBe('10:1:2')
    expect(JSON.stringify(request.headers)).not.toContain('device-token')
  })

  it('streams a chunk to the host as it was sent', async () => {
    const h = await setup((_req, res) => {
      res.writeHead(204)
      res.end()
    })
    const bytes = randomBytes(256 * 1024)
    const response = await fetch(
      h.origin + '/v1/environments/workspaces/host-files/uploads/upload-0000000000000000000?offset=16',
      {
        method: 'PUT',
        headers: { 'x-maestrly-sha256': sha(bytes), 'x-maestrly-length': String(bytes.length) },
        body: bytes,
      }
    )
    expect(response.status).toBe(204)
    expect(h.seen[0].url).toBe('/v1/host-files/uploads/upload-0000000000000000000?offset=16')
    expect(h.seen[0].headers['content-length']).toBe(String(bytes.length))
    expect(sha(h.seen[0].body)).toBe(sha(bytes))
  })

  it('refuses bodies larger than a chunk, and bodies of unknown length', async () => {
    const h = await setup(() => undefined)
    const status = (headers: Record<string, string>) =>
      new Promise<number>((resolve, reject) => {
        const request = http.request(
          h.origin + '/v1/environments/workspaces/host-files/uploads/abcdefghijklmnopqrstuv?offset=0',
          {
            method: 'PUT',
            headers,
            // The declared body is never sent: a kept-alive socket would carry the next request as that body.
            agent: false,
          }
        )
        request.on('response', (response) => {
          response.resume()
          resolve(response.statusCode ?? 0)
        })
        request.on('error', reject)
        request.end()
      })
    const limit = FLEET_HOST_FILE_LIMITS.uploadChunkBytes + FLEET_HOST_FILE_LIMITS.chunkBodySlackBytes
    expect(await status({ 'content-length': String(limit + 1) })).toBe(400)
    expect(await status({ 'transfer-encoding': 'chunked' })).toBe(400)
    expect(h.seen).toHaveLength(0)
  })

  it('says why an environment cannot serve files', async () => {
    const stopped = await setup(() => undefined, { host: () => null })
    const notRunning = await fetch(stopped.origin + '/v1/environments/workspaces/host-files/stat', { method: 'POST' })
    expect(notRunning.status).toBe(409)
    expect((await notRunning.json()).message).toBe(FLEET_HOST_FILE_GATEWAY_ERRORS.notRunning)
    const old = await setup(() => undefined, { supports: () => false })
    const update = await fetch(old.origin + '/v1/environments/workspaces/host-files/stat', { method: 'POST' })
    expect(update.status).toBe(409)
    expect((await update.json()).message).toBe(FLEET_HOST_FILE_GATEWAY_ERRORS.updateHost)
  })

  it('cuts the transfers of a revoked device or a stopped environment, and only those', async () => {
    const h = await setup(slow)
    const open = async (device: string) => {
      const response = await fetch(h.origin + '/v1/environments/workspaces/host-files/content?path=%2Fa', {
        headers: { 'x-device': device },
      })
      const reader = response.body!.getReader()
      await reader.read()
      return reader
    }
    const one = await open('d1')
    const two = await open('d2')
    h.proxy.closeDevice('d1')
    await expect(one.read()).rejects.toThrow()
    h.proxy.closeEnvironment('other')
    const still = await Promise.race([
      two.read().then(() => 'read'),
      new Promise((r) => setTimeout(() => r('open'), 200)),
    ])
    expect(still).toBe('open')
    h.proxy.closeEnvironment('workspaces')
    await expect(two.read()).rejects.toThrow()
  })

  it('answers that the environment is unavailable when nothing listens', async () => {
    const h = await setup(() => undefined, { instancePort: 1 })
    const response = await fetch(h.origin + '/v1/environments/workspaces/host-files/stat', { method: 'POST' })
    expect(response.status).toBe(503)
    expect((await response.json()).code).toBe('INSTANCE_UNAVAILABLE')
  })

  it('cuts a transfer whose environment goes silent', async () => {
    const h = await setup(() => undefined, { idleTimeoutMs: 200 })
    const started = Date.now()
    const response = await fetch(h.origin + '/v1/environments/workspaces/host-files/stat', { method: 'POST' })
    expect(response.status).toBe(503)
    expect(Date.now() - started).toBeLessThan(2_000)
  })
})
