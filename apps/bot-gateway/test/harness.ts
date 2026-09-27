import { afterEach, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import {
  FLEET_PROTOCOL_HEADER,
  FLEET_INSTANCE_ROUTES,
  type FleetImportResults,
  type FleetInstanceBotInstall,
  fleetInstanceBotInstallSchema,
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
/**
 * A synthetic bot instance. With `environments` it hosts several bots like an environment's Maestrly: it installs
 * and uninstalls them and serves each one's routes under `/v1/bots/:botId`, recorded in `botRequests`. With
 * `compaction` it also lists its environment's models, as a Maestrly with environment compaction defaults does.
 */
async function fake(environments: boolean, compaction = false) {
  let account: { id: string; label: string } | null = null
  const installed = new Map<string, { slot: number; gatewayToken: string }>()
  const installs: FleetInstanceBotInstall[] = []
  const uninstalls: Array<{ botId: string; purge: boolean }> = []
  const botRequests: Array<{ botId: string; method: string; path: string }> = []
  const uiOpens: unknown[] = []
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
  const provisioningRequests: Array<{ method: string; path: string; body: unknown }> = []
  /**
   * Installations to refuse with a synthetic internal error, or to drop (the connection closes unanswered), the next
   * ones first; and how many installations were asked for, answered or not.
   */
  const control = { installFailures: 0, installDrops: 0, installAttempts: 0 }
  const selectionOptions = [
    {
      id: 'prov_test::model-a',
      providerId: 'prov_test',
      providerLabel: 'Test',
      modelId: 'model-a',
      modelLabel: 'Model A',
      efforts: [],
      fastMode: false,
    },
  ]
  const provisioning = {
    capabilities: environments
      ? ['provisioning', 'environments', ...(compaction ? ['environment-compaction'] : [])]
      : ['provisioning'],
    results: { results: [{ index: 0, target: 'prov_test', outcome: 'added', error: null }] } as FleetImportResults,
    skill: { name: 'x', outcome: 'added' },
    failure: null as { code: string; message: string } | null,
    login: {
      loginId: 'login-test',
      kind: 'claude',
      accountId: null,
      method: 'browser',
      state: 'pending',
      expiresAt: '2026-09-25T12:15:00.000Z',
      browser: { authUrl: 'https://claude.ai/oauth/authorize', callback: { port: 4567, path: '/callback' } },
      device: null,
      manual: null,
      account: null,
      error: null,
    },
    callback: { status: 302, location: 'https://claude.ai', contentType: null, body: '' },
  }
  const provisioningKeys = [
    'accountsList',
    'accountsImport',
    'subscriptionRemove',
    'loginStart',
    'loginGet',
    'loginCallback',
    'loginCode',
    'loginCancel',
    'skillsList',
    'skillInstall',
    'skillRemove',
    'mcpServersList',
    'mcpServersImport',
    'mcpServerRemove',
  ] as const
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
    // A bot's route of an environment instance is the route a single-bot instance serves, under /v1/bots/:botId.
    const scoped = environments ? /^\/v1\/bots\/([^/?]+)(\/[^?]*)(\?.*)?$/.exec(req.url ?? '') : null
    if (scoped) {
      botRequests.push({
        botId: decodeURIComponent(scoped[1]),
        method: req.method ?? '',
        path: scoped[2] + (scoped[3] ?? ''),
      })
      req.url = '/v1' + scoped[2] + (scoped[3] ?? '')
    }
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
      capabilities: provisioning.capabilities,
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
      const raw = Buffer.concat(chunks).toString()
      body = raw ? JSON.parse(raw) : undefined
    }
    try {
      const url = new URL(req.url!, 'http://instance')
      if (environments && url.pathname === '/v1/environment/status')
        return send(200, {
          environmentId: null,
          capabilities: provisioning.capabilities,
          appVersion: '1.0',
          protocol: 1,
          ready: true,
          bots: [...installed].map(([botId, item]) => ({
            botId,
            slot: item.slot,
            status: { ...status, profile: { botId, name: botId } },
          })),
        })
      if (compaction && url.pathname === '/v1/environment/selections' && req.method === 'GET')
        return send(200, { options: selectionOptions, current: null })
      const member = environments ? /^\/v1\/bots\/([^/]+)$/.exec(url.pathname) : null
      if (member && req.method === 'PUT') {
        const install = fleetInstanceBotInstallSchema.parse(body)
        control.installAttempts++
        if (control.installDrops > 0) {
          control.installDrops--
          return req.socket.destroy()
        }
        if (control.installFailures > 0) {
          control.installFailures--
          return send(500, { code: 'INTERNAL', message: 'Synthetic failure' })
        }
        installed.set(decodeURIComponent(member[1]), { slot: install.slot, gatewayToken: install.gatewayToken })
        installs.push(install)
        return send(200, { ...status, profile: { botId: install.profile.botId, name: install.profile.name } })
      }
      if (member && req.method === 'DELETE') {
        const botId = decodeURIComponent(member[1])
        uninstalls.push({ botId, purge: url.searchParams.get('purge') === '1' })
        installed.delete(botId)
        res.writeHead(204)
        return res.end()
      }
      const provisioningKey = provisioningKeys.find((key) => {
        const route = FLEET_INSTANCE_ROUTES[key]
        return (
          route.method === req.method &&
          new RegExp('^' + route.path.replace(/:[A-Za-z]+/g, '[^/]+') + '$').test(url.pathname)
        )
      })
      if (provisioningKey) {
        provisioningRequests.push({ method: req.method!, path: url.pathname, body })
        if (provisioning.failure) return send(409, provisioning.failure)
        switch (provisioningKey) {
          case 'accountsList':
            return send(200, { apiKeys: [], subscriptions: [] })
          case 'skillsList':
            return send(200, { skills: [] })
          case 'mcpServersList':
            return send(200, { servers: [] })
          case 'accountsImport':
          case 'mcpServersImport':
            return send(200, provisioning.results)
          case 'skillInstall':
            return send(200, provisioning.skill)
          case 'loginStart':
          case 'loginGet':
          case 'loginCode':
            return send(200, provisioning.login)
          case 'loginCallback':
            return send(200, provisioning.callback)
          default:
            res.writeHead(204)
            return res.end()
        }
      }
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
      if (req.url === '/v1/health')
        return send(200, {
          ok: true,
          appVersion: '1.0',
          protocol: 1,
          ready: true,
          ...(environments ? { capabilities: provisioning.capabilities } : {}),
        })
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
      if (req.url === '/v1/ui/open' && req.method === 'POST') {
        uiOpens.push(body)
        res.writeHead(204)
        return res.end()
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
    provisioning,
    provisioningRequests,
    installed,
    installs,
    uninstalls,
    botRequests,
    uiOpens,
    control,
    selectionOptions,
  }
}

/**
 * A gateway with one running bot, `test`, alone in its environment. By default its instance predates environments;
 * with `environments` it is an environment instance (every environment of the harness shares it), which with
 * `compaction` also lists its environment's models.
 */
export async function harness(
  now: () => number = Date.now,
  options: { environments?: boolean; compaction?: boolean } = {}
) {
  const instance = await fake(options.environments === true, options.compaction === true),
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
