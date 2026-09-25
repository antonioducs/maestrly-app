import { afterEach, expect } from 'vitest'
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
  fleetConversationCallRequestSchema,
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
import { Routines } from '../src/routines.js'

const cleanups: Array<() => Promise<void>> = []
const dirs: string[] = []
const servers: http.Server[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close()
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
  const inputs: import('@maestrly/bot-fleet-protocol').FleetInstanceInput[] = []
  const receipts = new Map<string, { inputId: string; itemId: string; queued: boolean }>()
  const conversationCalls: unknown[] = []
  const memoryRequests: unknown[] = []
  const memories: import('@maestrly/bot-fleet-protocol').FleetBotMemory[] = [
    {
      id: 'm1',
      title: 'Preference',
      content: 'Keep answers short.',
      truncated: false,
      type: 'preference',
      status: 'active',
      pinned: false,
      source: 'auto',
      useCount: 1,
      createdAt: '2026-09-25T10:00:00.000Z',
      updatedAt: '2026-09-25T10:00:00.000Z',
    },
  ]
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
    if (req.url === '/v1/images/t-png') {
      const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': png.length })
      return res.end(png)
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
    if (['POST', 'PUT', 'PATCH'].includes(req.method ?? '')) {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      body = JSON.parse(Buffer.concat(chunks).toString())
    }
    try {
      const url = new URL(req.url!, 'http://instance')
      if (url.pathname === '/v1/memories' && req.method === 'GET') {
        const status = url.searchParams.get('status') ?? 'active'
        memoryRequests.push({ method: 'GET', status })
        return send(200, { memories: memories.filter((memory) => status === 'all' || memory.status === status) })
      }
      if (url.pathname.startsWith('/v1/memories/')) {
        const id = decodeURIComponent(url.pathname.slice('/v1/memories/'.length))
        const index = memories.findIndex((memory) => memory.id === id)
        if (index < 0) return send(404, { code: 'NOT_FOUND', message: 'Memory not found' })
        if (req.method === 'PATCH') {
          memoryRequests.push({ method: 'PATCH', id, body })
          Object.assign(memories[index], body)
          return send(200, memories[index])
        }
        if (req.method === 'DELETE') {
          memoryRequests.push({ method: 'DELETE', id })
          memories.splice(index, 1)
          res.writeHead(204)
          return res.end()
        }
      }
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
      if (req.url === '/v1/conversation/call' && req.method === 'POST') {
        const call = fleetConversationCallRequestSchema.parse(body)
        if (call.op === 'chatGetConvTools' && call.args.length !== 0) throw new Error('Invalid arguments')
        conversationCalls.push(call)
        return send(200, { result: { app: true, mcpDisabled: [], imageGen: true } })
      }
      if (req.url === '/v1/inputs') {
        const input = fleetInstanceInputSchema.parse(body)
        inputs.push(input)
        const receipt = receipts.get(input.idempotencyKey) ?? {
          inputId: randomUUID(),
          itemId: randomUUID(),
          queued: false,
        }
        receipts.set(input.idempotencyKey, receipt)
        return send(200, receipt)
      }
      return send(404, { code: 'NOT_FOUND', message: 'Not found' })
    } catch {
      return send(400, { code: 'INVALID_REQUEST', message: 'Invalid' })
    }
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    origin: 'http://127.0.0.1:' + (server.address() as { port: number }).port,
    inputs,
    conversationCalls,
    receipts,
    memories,
    memoryRequests,
  }
}

export async function harness(now: () => number = Date.now) {
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
    events: import('@maestrly/bot-fleet-protocol').FleetGatewayEvent[] = []
  lifecycle.onEvent = (event) => events.push(event)
  const gateway = createGatewayServers({
    auth,
    config: { ...cfg, publicPort: 0, internalPort: 0 },
    events: new EventHub(async () => {}),
    host: new HostMonitor(cfg, docker),
    lifecycle,
    routines: new Routines(store, lifecycle, now),
    store,
  })
  await gateway.listen()
  const origin = 'http://127.0.0.1:' + (gateway.publicServer.address() as { port: number }).port
  const internalOrigin = 'http://127.0.0.1:' + (gateway.internalServer.address() as { port: number }).port
  const headers = (token: string) => ({
    [FLEET_PROTOCOL_HEADER]: '1',
    Authorization: 'Bearer ' + token,
    'Content-Type': 'application/json',
  })
  cleanups.push(async () => {
    await gateway.close()
    store.close()
  })
  const publicHeaders = headers(one.token)
  const botHeaders = (id = bot.id) => headers(store.botSecrets(id)!.gatewayToken)
  const request = (
    method: string,
    route: string,
    body?: unknown,
    internal = false,
    requestHeaders = internal ? botHeaders() : publicHeaders
  ) =>
    fetch((internal ? internalOrigin : origin) + route, {
      method,
      headers: requestHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  return {
    dir,
    store,
    lifecycle,
    gateway,
    bot,
    instance,
    events,
    origin,
    internalOrigin,
    publicHeaders,
    botHeaders,
    request,
  }
}
