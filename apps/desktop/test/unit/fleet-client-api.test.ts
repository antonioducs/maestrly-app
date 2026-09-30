import { createServer, type Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FLEET_GATEWAY_ROUTES, fleetPairRequestSchema, isAllowedFleetUrl } from '@maestrly/bot-fleet-protocol'
import { FleetApiClient, FleetClientError } from '../../src/main/fleet/client/api'
import { FleetEvents } from '../../src/main/fleet/client/events'

let server: Server
let origin: string
let status = 200
let holdEvents = false
let requests: { url: string; method: string; auth: string | undefined; protocol: string | undefined; body: unknown }[] =
  []

beforeEach(async () => {
  status = 200
  holdEvents = false
  requests = []
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const bodyText = Buffer.concat(chunks).toString()
    const body = bodyText ? JSON.parse(bodyText) : null
    requests.push({
      url: req.url ?? '',
      method: req.method ?? '',
      auth: req.headers.authorization,
      protocol: req.headers['x-maestrly-fleet-protocol'] as string | undefined,
      body,
    })
    if (req.headers['x-maestrly-fleet-protocol'] !== '1') {
      res
        .writeHead(426, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ code: 'PROTOCOL_INCOMPATIBLE', message: 'Version' }))
      return
    }
    if (req.url !== '/v1/meta' && req.url !== '/v1/pair' && req.headers.authorization !== 'Bearer valid') {
      res
        .writeHead(401, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ code: 'UNAUTHORIZED', message: 'No token' }))
      return
    }
    if (status !== 200) {
      res
        .writeHead(status, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ code: status === 426 ? 'PROTOCOL_INCOMPATIBLE' : 'CONFLICT', message: 'Rejected' }))
      return
    }
    if (req.url === '/v1/bots/bot/conversation/call') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ result: { imageGen: true } }))
      return
    }
    if (req.url === '/v1/bots/bot/images/t-png') {
      const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': png.length }).end(png)
      return
    }
    if (req.url === '/v1/bots/bot/images/missing') {
      res
        .writeHead(404, { 'content-type': 'application/json' })
        .end(JSON.stringify({ code: 'NOT_FOUND', message: 'Image not found' }))
      return
    }
    if (req.url === '/v1/meta')
      res
        .writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ protocol: 1, gatewayVersion: 'test', botImage: 'test', botImageVersion: null }))
    else if (req.url === '/v1/pair') {
      if (!fleetPairRequestSchema.safeParse(body).success) {
        res.writeHead(400).end()
        return
      }
      res
        .writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ deviceId: 'device', token: 'valid' }))
    } else if (req.url === '/v1/events?reasoning=1') {
      // Only the stream that asks for `reasoning` transcript items is served: the app must always ask.
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(': ping\n\nevent: fleet\ndata: {"type":"hello","at":"2026-01-01T00:00:00Z","lastActivitySeq":2}\n\n')
      if (!holdEvents) setTimeout(() => res.end(), 20)
    } else res.writeHead(204).end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
afterEach(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

describe('fleet API and events', () => {
  it('allows provisioning calls to outlive gateway login and skill timeouts', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    try {
      const api = new FleetApiClient(origin, 'valid')
      await expect(
        api.call('botLoginStart', { params: { id: 'bot' }, body: { kind: 'claude', method: 'browser', slot: 'auto' } })
      ).rejects.toThrow('Invalid gateway response')
      expect(timeout).toHaveBeenLastCalledWith(35_000)
      await expect(
        api.call('botSkillInstall', {
          params: { id: 'bot' },
          body: { name: 'review', files: [{ path: 'SKILL.md', data: 'c2tpbGw=', executable: false }] },
        })
      ).rejects.toThrow('Invalid gateway response')
      expect(timeout).toHaveBeenLastCalledWith(65_000)
      await api.call('meta')
      expect(timeout).toHaveBeenLastCalledWith(15_000)
    } finally {
      timeout.mockRestore()
    }
  })
  it('waits for environment lifecycle actions as long as the gateway does, and keeps reads fast', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    try {
      const api = new FleetApiClient(origin, 'valid')
      // The gateway answers these once the container stopped or its desktop answers again: up to 240 s, plus an
      // image replacement. A bot's own start, stop and restart act on its environment.
      const lifecycle = [
        ['environmentStart', { eid: 'acme' }, '/v1/environments/acme/start'],
        ['environmentStop', { eid: 'acme' }, '/v1/environments/acme/stop'],
        ['environmentRestart', { eid: 'acme' }, '/v1/environments/acme/restart'],
        ['environmentArchive', { eid: 'acme' }, '/v1/environments/acme/archive'],
        ['botStart', { id: 'scout' }, '/v1/bots/scout/start'],
        ['botStop', { id: 'scout' }, '/v1/bots/scout/stop'],
        ['botRestart', { id: 'scout' }, '/v1/bots/scout/restart'],
        ['botArchive', { id: 'scout' }, '/v1/bots/scout/archive'],
        ['archivedBotDelete', { id: 'scout' }, '/v1/archived-bots/scout'],
        ['archivedEnvironmentDelete', { eid: 'acme' }, '/v1/archived-environments/acme'],
      ] as const
      for (const [key, params, path] of lifecycle) {
        await api.call(key, { params }).catch(() => undefined)
        expect(requests.at(-1)?.url, key).toBe(path)
        expect(timeout, key).toHaveBeenLastCalledWith(300_000)
      }
      const reads = [
        ['environmentsList', {}],
        ['botsList', {}],
        ['botGet', { id: 'scout' }],
        ['environmentGet', { eid: 'acme' }],
      ] as const
      for (const [key, params] of reads) {
        await api.call(key, { params }).catch(() => undefined)
        expect(timeout, key).toHaveBeenLastCalledWith(15_000)
      }
    } finally {
      timeout.mockRestore()
    }
  })
  it('calls the bot conversation endpoint with a validated request', async () => {
    const api = new FleetApiClient(origin, 'valid')
    await expect(
      api.call('botConversationCall', { params: { id: 'bot' }, body: { op: 'chatGetConvTools', args: [] } })
    ).resolves.toEqual({ result: { imageGen: true } })
    expect(requests.at(-1)).toMatchObject({
      url: '/v1/bots/bot/conversation/call',
      method: 'POST',
      auth: 'Bearer valid',
      protocol: '1',
      body: { op: 'chatGetConvTools', args: [] },
    })
    await expect(
      api.call('botConversationCall', {
        params: { id: 'bot' },
        body: { op: 'chatGetConvTools', args: [], conversationId: 'other' },
      })
    ).rejects.toThrow()
    expect(requests).toHaveLength(1)
  })
  it('reads a binary bot image with a typed missing-image error', async () => {
    const api = new FleetApiClient(origin, 'valid')
    await expect(api.getImage('bot', 't-png')).resolves.toEqual({
      mediaType: 'image/png',
      data: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    })
    expect(requests.at(-1)).toMatchObject({ url: '/v1/bots/bot/images/t-png', auth: 'Bearer valid', protocol: '1' })
    await expect(api.getImage('bot', 'missing')).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 })
  })
  it('uses allowed URLs and route schemas with protocol and authorization headers', async () => {
    expect(isAllowedFleetUrl(origin).ok).toBe(true)
    expect(isAllowedFleetUrl('http://example.com').ok).toBe(false)
    expect(isAllowedFleetUrl('https://example.com/path').ok).toBe(false)
    const api = new FleetApiClient(origin)
    await expect(api.call('meta')).resolves.toMatchObject({ protocol: 1 })
    await expect(api.call('pair', { body: { code: 'ABCDEFGH', deviceName: 'Mac' } })).resolves.toEqual({
      deviceId: 'device',
      token: 'valid',
    })
    await expect(api.call('pair', { body: { code: 'bad', deviceName: 'Mac' } })).rejects.toThrow()
    await expect(api.withToken('valid').call('devicesSelfDelete')).resolves.toBeUndefined()
    expect(requests.map((r) => [r.url, r.method, r.protocol])).toEqual([
      ['/v1/meta', 'GET', '1'],
      ['/v1/pair', 'POST', '1'],
      ['/v1/devices/self', 'DELETE', '1'],
    ])
    expect(Object.keys(FLEET_GATEWAY_ROUTES).length).toBeGreaterThan(20)
  })

  it('maps gateway envelopes, unauthorized, and offline failures', async () => {
    await expect(new FleetApiClient(origin).call('host')).rejects.toMatchObject({ code: 'UNAUTHORIZED', status: 401 })
    status = 409
    await expect(new FleetApiClient(origin, 'valid').call('host')).rejects.toMatchObject({
      code: 'CONFLICT',
      status: 409,
      message: 'Rejected',
    })
    const invalid = new FleetApiClient('http://127.0.0.1:1')
    await expect(invalid.call('meta')).rejects.toMatchObject({ code: 'INSTANCE_UNAVAILABLE', status: 0 })
    expect(FleetClientError).toBeDefined()
  })

  it('reconnects after heartbeat silence with jittered backoff', async () => {
    holdEvents = true
    const delays: number[] = []
    const states: string[] = []
    const events = new FleetEvents(
      new FleetApiClient(origin, 'valid'),
      () => undefined,
      (state) => states.push(state),
      async () => undefined,
      async (ms) => {
        delays.push(ms)
        status = 401
      },
      25
    )
    events.start()
    await vi.waitFor(() => expect(states).toContain('unauthorized'))
    expect(delays).toHaveLength(1)
    expect(delays[0]).toBeGreaterThanOrEqual(750)
    expect(delays[0]).toBeLessThanOrEqual(1250)
  })

  it('starts the backoff over after each stream that opened', async () => {
    const delays: number[] = []
    const events: FleetEvents = new FleetEvents(
      new FleetApiClient(origin, 'valid'),
      () => undefined,
      () => undefined,
      async () => undefined,
      async (ms) => {
        delays.push(ms)
        if (delays.length >= 4) events.stop()
      }
    )
    events.start()
    // Each stream here opens, then ends: every reconnection waits about a second, never 2, 4 or 8.
    await vi.waitFor(() => expect(delays).toHaveLength(4))
    for (const delay of delays) expect(delay).toBeLessThanOrEqual(1250)
  })

  it('parses SSE comments and frames and stops on 401 or 426', async () => {
    const seen: string[] = []
    const states: string[] = []
    const events = new FleetEvents(
      new FleetApiClient(origin, 'valid'),
      (event) => seen.push(event.type),
      (state) => states.push(state),
      async () => undefined,
      async () => undefined
    )
    events.start()
    await vi.waitFor(() => expect(seen).toContain('hello'))
    events.stop()
    expect(states).toContain('connected')
    status = 426
    const incompatible: string[] = []
    const second = new FleetEvents(
      new FleetApiClient(origin, 'valid'),
      () => undefined,
      (state) => incompatible.push(state),
      async () => undefined,
      async () => undefined
    )
    second.start()
    await vi.waitFor(() => expect(incompatible).toContain('incompatible'))
    expect(incompatible.filter((s) => s === 'connecting')).toHaveLength(1)
    const unauthorized: string[] = []
    status = 200
    const third = new FleetEvents(
      new FleetApiClient(origin, 'bad'),
      () => undefined,
      (state) => unauthorized.push(state),
      async () => undefined,
      async () => undefined
    )
    third.start()
    await vi.waitFor(() => expect(unauthorized).toContain('unauthorized'))
    expect(unauthorized.filter((s) => s === 'connecting')).toHaveLength(1)
  })
})
