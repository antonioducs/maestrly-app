import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  FLEET_GATEWAY_ROUTES,
  FLEET_RUNNER_LIMITS,
  FLEET_RUNNER_TRANSFER_ROUTE_KEYS,
} from '@maestrly/bot-fleet-protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { GatewayError } from '../src/errors.js'
import { RunnerTransfers, type RunnerTransfersDeps } from '../src/runner-transfers.js'

const servers: http.Server[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
async function listen(server: http.Server) {
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return (server.address() as AddressInfo).port
}

type Seen = { method: string; url: string; headers: http.IncomingHttpHeaders; body: Buffer }

/** A bot environment's control server: it records each request and answers as `answer` says. */
async function environment(answer: (req: http.IncomingMessage, res: http.ServerResponse) => void) {
  const seen: Seen[] = []
  const port = await listen(
    http.createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks) })
      answer(req, res)
    })
  )
  return { port, seen }
}

/** A gateway that sends every runner transfer to the proxy, the device named by `x-device`. */
async function gateway(proxy: RunnerTransfers) {
  return (
    'http://127.0.0.1:' +
    (await listen(
      http.createServer(async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://gateway')
        const key = FLEET_RUNNER_TRANSFER_ROUTE_KEYS.find((candidate) => {
          const route = FLEET_GATEWAY_ROUTES[candidate]
          return (
            route.method === req.method &&
            new RegExp('^' + route.path.replace(/:[A-Za-z]+/g, '[^/]+') + '$').test(url.pathname)
          )
        })!
        const route = FLEET_GATEWAY_ROUTES[key]
        const names = [...route.path.matchAll(/:([A-Za-z]+)/g)].map((match) => match[1])
        const values = new RegExp('^' + route.path.replace(/:[A-Za-z]+/g, '([^/]+)') + '$').exec(url.pathname)!
        const params = Object.fromEntries(names.map((name, index) => [name, decodeURIComponent(values[index + 1])]))
        try {
          await proxy.forward(key, params, url, req, res, String(req.headers['x-device'] ?? 'runner'))
        } catch (error) {
          const known = error instanceof GatewayError ? error : new GatewayError('INTERNAL', 'failed')
          res.writeHead(known.status, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ code: known.code, message: known.message }))
        }
      })
    ))
  )
}

async function setup(answer: Parameters<typeof environment>[0], overrides: Partial<RunnerTransfersDeps> = {}) {
  const upstream = await environment(answer)
  const proxy = new RunnerTransfers({
    authorize: (_jobId, deviceId) => {
      if (deviceId !== 'runner') throw new GatewayError('FORBIDDEN', 'This job was assigned to another computer')
      return 'alpha'
    },
    target: () => ({ host: '127.0.0.1', secret: 'control' }),
    instancePort: upstream.port,
    idleTimeoutMs: 2_000,
    ...overrides,
  })
  return { proxy, origin: await gateway(proxy), seen: upstream.seen }
}
const headers = { authorization: 'Bearer device-token', 'x-maestrly-fleet-protocol': '1' }

describe('runner transfers', () => {
  it("streams an output chunk to the job's environment with its control token, untouched", async () => {
    const h = await setup((_req, res) => {
      res.writeHead(204)
      res.end()
    })
    const bytes = randomBytes(1024 * 1024)
    const response = await fetch(h.origin + '/v1/runner-jobs/job_0123456789abcdef/outputs/0', {
      method: 'PUT',
      headers: { ...headers, 'content-type': 'application/octet-stream', 'x-maestrly-sha256': 'abc' },
      body: bytes,
    })
    expect(response.status).toBe(204)
    const [request] = h.seen
    expect(request.url).toBe('/v1/bots/alpha/runner-jobs/job_0123456789abcdef/outputs/0')
    expect(request.headers.authorization).toBe('Bearer control')
    expect(request.headers['x-maestrly-sha256']).toBe('abc')
    expect(JSON.stringify(request.headers)).not.toContain('device-token')
    expect(request.body.equals(bytes)).toBe(true)
  })

  it('streams a manifest back as the environment sends it', async () => {
    const manifest = JSON.stringify({ files: [{ path: 'a.txt', size: 1, mode: 420, sha256: 'f'.repeat(64) }] })
    const h = await setup((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(manifest)) })
      res.end(manifest)
    })
    const response = await fetch(h.origin + '/v1/runner-jobs/job_0123456789abcdef/manifest', { headers })
    expect(response.status).toBe(200)
    expect(await response.text()).toBe(manifest)
    expect(h.seen[0].url).toBe('/v1/bots/alpha/runner-jobs/job_0123456789abcdef/manifest')
  })

  it("refuses another computer, a body over the route's cap, and a job whose environment cannot serve it", async () => {
    const h = await setup((_req, res) => {
      res.writeHead(204)
      res.end()
    })
    const other = await fetch(h.origin + '/v1/runner-jobs/job_0123456789abcdef/manifest', {
      headers: { ...headers, 'x-device': 'intruder' },
    })
    expect(other.status).toBe(403)
    const large = await fetch(h.origin + '/v1/runner-jobs/job_0123456789abcdef/log', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'text/plain' },
      body: 'x'.repeat(FLEET_RUNNER_LIMITS.logBatchBytesMax + 1),
    })
    expect(large.status).toBe(400)
    expect(h.seen).toEqual([])
    const stopped = await setup(() => {}, { target: () => null })
    const unavailable = await fetch(stopped.origin + '/v1/runner-jobs/job_0123456789abcdef/manifest', { headers })
    expect(unavailable.status).toBe(503)
  })
})
