import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { Writable } from 'node:stream'
import { randomUUID } from 'node:crypto'
import {
  FLEET_PROTOCOL_HEADER,
  fleetInstanceProfileSchema,
  fleetInstanceInputSchema,
  fleetInstanceHoldRequestSchema,
  fleetInstanceReleaseRequestSchema,
} from '@maestrly/bot-fleet-protocol'
import { Auth } from '../src/auth.js'
import { loadConfig } from '../src/config.js'
import { FakeDockerDriver } from '../src/docker.js'
import { EventHub } from '../src/events.js'
import { HostMonitor } from '../src/host.js'
import { InstanceClient } from '../src/instance.js'
import { Lifecycle } from '../src/lifecycle.js'
import { Logger } from '../src/logger.js'
import { createGatewayServers } from '../src/server.js'
import { Store } from '../src/store.js'

const dirs: string[] = []
const servers: http.Server[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
async function fake() {
  let account: { id: string; label: string } | null = null
  let hold: {
    state: 'none' | 'held'
    reason: 'takeover' | 'paused' | null
    since: string | null
    interruptedTurn: boolean
  } = { state: 'none', reason: null, since: null, interruptedTurn: false }
  const inputs: unknown[] = []
  const server = http.createServer(async (req, res) => {
    const send = (code: number, value: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json' })
      res.end(JSON.stringify(value))
    }
    if (req.headers[FLEET_PROTOCOL_HEADER.toLowerCase()] !== '1' || req.headers.authorization !== 'Bearer control')
      return send(401, { code: 'UNAUTHORIZED', message: 'Unauthorized' })
    if (req.url?.startsWith('/v1/events')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      return
    }
    const status = {
      appVersion: '1.0',
      protocol: 1,
      ready: true,
      accounts: { connected: true, providers: account ? [account] : [] },
      selection: null,
      ceiling: 'ask',
      profile: { botId: 'test', name: 'Test' },
      conversationId: null,
      turn: { state: 'idle', startedAt: null },
      hold,
      queue: [],
      activity: null,
      pending: [],
      lastEventSeq: 0,
    }
    let body: unknown
    if (['POST', 'PUT'].includes(req.method ?? '')) {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      body = JSON.parse(Buffer.concat(chunks).toString())
    }
    try {
      if (req.url === '/v1/health') return send(200, { ok: true, appVersion: '1.0', protocol: 1, ready: true })
      if (req.url === '/v1/status') return send(200, status)
      if (req.url === '/v1/accounts/api-key' && req.method === 'POST') {
        const input = body as { name: string }
        account = { id: 'prov_test', label: input.name }
        return send(200, { providerId: account.id })
      }
      if (req.url === '/v1/accounts/prov_test' && req.method === 'DELETE') {
        account = null
        res.writeHead(204)
        return res.end()
      }
      if (req.url === '/v1/profile') {
        fleetInstanceProfileSchema.parse(body)
        return send(200, status)
      }
      if (req.url === '/v1/hold') {
        const input = fleetInstanceHoldRequestSchema.parse(body)
        if (hold.state !== 'none') return send(409, { code: 'CONFLICT', message: 'Already held' })
        hold = { state: 'held', reason: input.reason, since: new Date().toISOString(), interruptedTurn: false }
        return send(200, hold)
      }
      if (req.url === '/v1/hold/release') {
        fleetInstanceReleaseRequestSchema.parse(body)
        hold = { state: 'none', reason: null, since: null, interruptedTurn: false }
        return send(200, hold)
      }
      if (req.url === '/v1/inputs') {
        inputs.push(fleetInstanceInputSchema.parse(body))
        return send(200, { inputId: randomUUID(), itemId: randomUUID(), queued: false })
      }
      return send(404, { code: 'NOT_FOUND', message: 'Not found' })
    } catch {
      return send(400, { code: 'INVALID_REQUEST', message: 'Invalid' })
    }
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { origin: 'http://127.0.0.1:' + (server.address() as { port: number }).port, inputs }
}
it('routes takeover, tickets and routine CRUD with protocol validation', async () => {
  const instance = await fake(),
    dir = mkdtempSync(path.join(os.tmpdir(), 'fleet-routes-'))
  dirs.push(dir)
  const cfg = loadConfig({
    MAESTRLY_GATEWAY_DATA_DIR: dir,
    MAESTRLY_GATEWAY_PUBLIC_PORT: '1',
    MAESTRLY_GATEWAY_INTERNAL_PORT: '2',
  })
  const store = new Store(dir),
    docker = new FakeDockerDriver()
  docker.images.add(cfg.botImage)
  const lifecycle = new Lifecycle(store, docker, cfg, (id) => new InstanceClient(id, 'control', instance.origin), 200)
  const bot = lifecycle.create({
    name: 'Test',
    instructions: '',
    ceiling: 'ask',
    talksTo: [],
    idempotencyKey: randomUUID(),
  })
  for (let i = 0; i < 100 && lifecycle.get(bot.id)?.lifecycle !== 'running'; i++)
    await new Promise((resolve) => setTimeout(resolve, 10))
  expect(lifecycle.get(bot.id)?.lifecycle).toBe('running')
  const auth = new Auth(store),
    one = auth.pair(auth.createPairing().code, 'Mac', 'one'),
    two = auth.pair(auth.createPairing().code, 'Other', 'two')
  const gateway = createGatewayServers({
    auth,
    config: { ...cfg, publicPort: 0, internalPort: 0 },
    events: new EventHub(async () => {}),
    host: new HostMonitor(cfg, docker),
    lifecycle,
    store,
  })
  await gateway.listen()
  const origin = 'http://127.0.0.1:' + (gateway.publicServer.address() as { port: number }).port
  const headers = (token: string) => ({
    [FLEET_PROTOCOL_HEADER]: '1',
    Authorization: 'Bearer ' + token,
    'Content-Type': 'application/json',
  })
  const post = (path: string, token: string, body?: unknown) =>
    fetch(origin + path, {
      method: 'POST',
      headers: headers(token),
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  try {
    const secret = 'gateway-account-secret-test'
    const accountBody = { kind: 'openai', name: 'Fake model', key: secret, baseURL: 'http://fake-model:8080/v1' }
    const addedAccount = await post('/v1/bots/test/accounts/api-key', one.token, accountBody)
    expect(addedAccount.status).toBe(201)
    const addedText = await addedAccount.text()
    expect(addedText).toBe(JSON.stringify({ providerId: 'prov_test' }))
    expect(addedText).not.toContain(secret)
    expect(readFileSync(path.join(dir, 'gateway.sqlite')).includes(Buffer.from(secret))).toBe(false)
    const lines: string[] = []
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        lines.push(String(chunk))
        callback()
      },
    })
    new Logger('debug', stream, stream).info('account added', { key: secret, nested: { apiKey: secret } })
    expect(lines.join('')).not.toContain(secret)
    const removedAccount = await fetch(origin + '/v1/bots/test/accounts/prov_test', {
      method: 'DELETE',
      headers: headers(one.token),
    })
    expect(removedAccount.status).toBe(204)
    expect((await post('/v1/bots/test/screen-tickets', one.token, { mode: 'control' })).status).toBe(403)
    const takeover = await post('/v1/bots/test/takeover', one.token)
    expect(takeover.status).toBe(200)
    expect(((await takeover.json()) as { state: string }).state).toBe('human')
    expect((await post('/v1/bots/test/takeover', two.token)).status).toBe(409)
    expect((await post('/v1/bots/test/screen-tickets', two.token, { mode: 'control' })).status).toBe(403)
    const ticket = await post('/v1/bots/test/screen-tickets', one.token, { mode: 'control' })
    expect(ticket.status).toBe(201)
    expect(((await ticket.json()) as { path: string }).path).toMatch(/^\/v1\/screen\?ticket=/)
    const release = await post('/v1/bots/test/takeover/release', one.token, { note: 'Done', continue: true })
    expect(release.status).toBe(200)
    expect(((await release.json()) as { state: string }).state).toBe('none')
    const schedule = { kind: 'weekly', time: '09:00', days: [1], timezone: 'America/New_York' }
    const request = { title: 'Weekly', prompt: 'Check', schedule, enabled: true, idempotencyKey: randomUUID() }
    const created = await post('/v1/bots/test/routines', one.token, request)
    expect(created.status).toBe(201)
    const routine = (await created.json()) as { id: string }
    expect(((await (await post('/v1/bots/test/routines', one.token, request)).json()) as { id: string }).id).toBe(
      routine.id
    )
    expect(
      (
        await post('/v1/bots/test/routines', one.token, {
          ...request,
          idempotencyKey: randomUUID(),
          schedule: { ...schedule, timezone: 'Bad/Timezone' },
        })
      ).status
    ).toBe(400)
    expect((await fetch(origin + '/v1/bots/test/routines', { headers: headers(one.token) })).status).toBe(200)
    const run = await post('/v1/bots/test/routines/' + routine.id + '/run', one.token)
    expect(run.status).toBe(200)
    expect(instance.inputs.at(-1)).toMatchObject({ source: 'routine', text: 'Check' })
    expect(
      (
        await fetch(origin + '/v1/bots/test/routines/' + routine.id, {
          method: 'PATCH',
          headers: headers(one.token),
          body: JSON.stringify({ enabled: false }),
        })
      ).status
    ).toBe(200)
    expect(
      (await fetch(origin + '/v1/bots/test/routines/' + routine.id, { method: 'DELETE', headers: headers(one.token) }))
        .status
    ).toBe(204)
    const activeTakeover = await post('/v1/bots/test/takeover', one.token)
    expect(activeTakeover.status).toBe(200)
    const resume = await post('/v1/bots/test/resume', one.token)
    expect(resume.status).toBe(409)
    expect((await resume.json()).message).toMatch(/Give back the screen/)
    const viewTicket = await post('/v1/bots/test/screen-tickets', one.token, { mode: 'view' })
    const viewPath = ((await viewTicket.json()) as { path: string }).path
    const events = await fetch(origin + '/v1/events', { headers: headers(one.token) })
    expect(events.status).toBe(200)
    const reader = events.body!.getReader()
    await reader.read()
    const revoked = await fetch(origin + '/v1/devices/self', { method: 'DELETE', headers: headers(one.token) })
    expect(revoked.status).toBe(204)
    expect(lifecycle.get(bot.id)?.takeover.state).toBe('none')
    expect(store.activity().at(-1)?.data.reason).toBe('device_revoked')
    await expect(reader.read()).rejects.toThrow()
    const { WebSocket } = await import('ws')
    const socket = new WebSocket(origin.replace('http:', 'ws:') + viewPath)
    const code = await new Promise<number>((resolve) => socket.on('close', resolve))
    expect(code).toBe(4003)
    expect((await post('/v1/bots/test/screen-tickets', one.token, { mode: 'view' })).status).toBe(401)
    expect((await post('/v1/bots/test/takeover', two.token)).status).toBe(200)
    const cliEvents = await fetch(origin + '/v1/events', { headers: headers(two.token) })
    const cliReader = cliEvents.body!.getReader()
    await cliReader.read()
    const cliStore = new Store(dir)
    expect(cliStore.revokeDevice(two.deviceId)).toBe(true)
    cliStore.close()
    await gateway.sweepRevocations()
    await expect(cliReader.read()).rejects.toThrow()
    expect(lifecycle.get(bot.id)?.takeover.state).toBe('none')
    expect(store.activity().at(-1)?.data.reason).toBe('device_revoked')
  } finally {
    await gateway.close()
    store.close()
  }
})

it('blocks fleet addresses from the public API, pairing, and screen upgrades', async () => {
  const { WebSocket } = await import('ws')
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fleet-network-'))
  dirs.push(dir)
  const cfg = loadConfig({ MAESTRLY_GATEWAY_DATA_DIR: dir })
  const store = new Store(dir)
  const docker = new FakeDockerDriver()
  // 127.0.0.1 plays a bot address here; the bridge gateway (the host side) is elsewhere in the subnet.
  docker.networkInspect = async () => [{ subnet: '127.0.0.0/8', gateway: '127.0.0.254' }]
  const lifecycle = new Lifecycle(store, docker, cfg)
  const gateway = createGatewayServers({
    auth: new Auth(store),
    config: { ...cfg, publicPort: 0, internalPort: 0 },
    events: new EventHub(async () => {}),
    host: new HostMonitor(cfg, docker),
    lifecycle,
    store,
  })
  await gateway.listen()
  const port = (gateway.publicServer.address() as { port: number }).port
  try {
    const meta = await fetch(`http://127.0.0.1:${port}/v1/meta`)
    expect(meta.status).toBe(403)
    expect((await meta.json()).code).toBe('FORBIDDEN')
    const pair = await fetch(`http://127.0.0.1:${port}/v1/pair`, { method: 'POST' })
    expect(pair.status).toBe(403)
    const upgrade = await new Promise<number>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/screen?ticket=none`)
      ws.on('unexpected-response', (_request, response) => {
        response.resume()
        resolve(response.statusCode ?? 0)
      })
      ws.on('error', () => resolve(0))
    })
    expect(upgrade).toBe(403)
  } finally {
    await gateway.close()
    store.close()
  }
})

it('lets the host reach the public API through the bridge gateway address inside the fleet subnet', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fleet-network-host-'))
  dirs.push(dir)
  const cfg = loadConfig({ MAESTRLY_GATEWAY_DATA_DIR: dir })
  const store = new Store(dir)
  const docker = new FakeDockerDriver()
  // Docker's port proxy (and `tailscale serve` on the host) connects from the bridge gateway, here 127.0.0.1.
  docker.networkInspect = async () => [{ subnet: '127.0.0.0/8', gateway: '127.0.0.1' }]
  const lifecycle = new Lifecycle(store, docker, cfg)
  const gateway = createGatewayServers({
    auth: new Auth(store),
    config: { ...cfg, publicPort: 0, internalPort: 0 },
    events: new EventHub(async () => {}),
    host: new HostMonitor(cfg, docker),
    lifecycle,
    store,
  })
  await gateway.listen()
  const port = (gateway.publicServer.address() as { port: number }).port
  try {
    const meta = await fetch(`http://127.0.0.1:${port}/v1/meta`)
    expect(meta.status).toBe(200)
    // Pairing is reachable (and fails only on its own validation), not refused by the network rule.
    const pair = await fetch(`http://127.0.0.1:${port}/v1/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(pair.status).toBe(400)
  } finally {
    await gateway.close()
    store.close()
  }
})
