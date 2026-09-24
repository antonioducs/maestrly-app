import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
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
      accounts: { connected: true, providers: [] },
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
  } finally {
    await gateway.close()
    store.close()
  }
})
