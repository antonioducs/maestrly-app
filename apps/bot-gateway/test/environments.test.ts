import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http, { type ServerResponse } from 'node:http'
import type net from 'node:net'
import { randomUUID } from 'node:crypto'
import { WebSocket } from 'ws'
import {
  FLEET_PROTOCOL_HEADER,
  fleetInstanceBotInstallSchema,
  fleetInstanceHoldRequestSchema,
  fleetInstanceProfileSchema,
  type FleetGatewayEvent,
  type FleetInstanceProfile,
  type FleetInstanceStatus,
} from '@maestrly/bot-fleet-protocol'
import { Auth } from '../src/auth.js'
import { loadConfig } from '../src/config.js'
import { DockerEngineDriver, DockerError, FakeDockerDriver } from '../src/docker.js'
import { EventHub } from '../src/events.js'
import { HostMonitor } from '../src/host.js'
import { InstanceClient } from '../src/instance.js'
import { Lifecycle } from '../src/lifecycle.js'
import { ScreenProxy } from '../src/screen.js'
import { createGatewayServers } from '../src/server.js'
import { Store } from '../src/store.js'
import { harness } from './harness.js'

const GiB = 1024 ** 3
const dirs: string[] = []
const closers: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
async function listen(server: http.Server) {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  )
  return (server.address() as net.AddressInfo).port
}
function lastIndex<T>(items: T[], test: (item: T) => boolean) {
  for (let index = items.length - 1; index >= 0; index--) if (test(items[index])) return index
  return -1
}
async function until(test: () => boolean) {
  for (let i = 0; i < 300; i++) {
    if (test()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Timed out')
}
type Hold = FleetInstanceStatus['hold']
const noHold: Hold = { state: 'none', reason: null, since: null, interruptedTurn: false }
function instanceStatus(botId: string, capabilities: string[], seq: number, hold: Hold): FleetInstanceStatus {
  return {
    capabilities,
    appVersion: '2.0.0',
    protocol: 1,
    ready: true,
    accounts: { connected: true, providers: [] },
    selection: null,
    ceiling: 'ask',
    profile: { botId, name: botId },
    conversationId: null,
    turn: { state: 'idle', startedAt: null, inputId: null },
    hold,
    queue: [],
    activity: null,
    pending: [],
    usage: null,
    compaction: null,
    lastEventSeq: seq,
  }
}
type Installed = { slot: number; gatewayToken: string | null; hold: Hold; profile: FleetInstanceProfile }
/**
 * A synthetic environment instance. With the `environments` capability it serves the environment routes and every bot
 * under `/v1/bots/:botId`; without it, it is a Maestrly from before environments: one bot on the unprefixed routes.
 */
async function environmentInstance(environmentId: string, capable = true) {
  const requests: Array<{ method: string; path: string; body: unknown }> = []
  const installed = new Map<string, Installed>()
  const streams = new Set<ServerResponse>()
  const subscriptions: number[] = []
  const upgrades: string[] = []
  const failures: Array<{ method: string; path: string; status: number; code: string }> = []
  const capabilities = capable ? ['provisioning', 'environments'] : ['provisioning']
  let seq = 0
  // Screens connect with the environment's real control token, which the gateway keeps.
  let tunnelToken = 'control'
  const statusOf = (botId: string) => instanceStatus(botId, capabilities, seq, installed.get(botId)?.hold ?? noHold)
  const emit = (event: Record<string, unknown>) => {
    seq++
    const frame = { ...event, seq, at: new Date().toISOString() }
    for (const res of streams) res.write('id: ' + seq + '\ndata: ' + JSON.stringify(frame) + '\n\n')
  }
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://instance')
    const send = (code: number, value?: unknown) => {
      if (value === undefined) {
        res.writeHead(code)
        return res.end()
      }
      res.writeHead(code, { 'content-type': 'application/json' })
      res.end(JSON.stringify(value))
    }
    if (req.headers[FLEET_PROTOCOL_HEADER.toLowerCase()] !== '1' || req.headers.authorization !== 'Bearer control')
      return send(401, { code: 'UNAUTHORIZED', message: 'Unauthorized' })
    let body: unknown
    if (['POST', 'PUT', 'PATCH'].includes(req.method ?? '')) {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const raw = Buffer.concat(chunks).toString()
      body = raw ? JSON.parse(raw) : undefined
    }
    const route = url.pathname + url.search
    requests.push({ method: req.method ?? '', path: route, body })
    const failure = failures.find((item) => item.method === req.method && item.path === route)
    if (failure) return send(failure.status, { code: failure.code, message: 'Synthetic failure' })
    if (url.pathname === '/v1/events') {
      subscriptions.push(Number(url.searchParams.get('since') ?? 0))
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      streams.add(res)
      res.on('close', () => streams.delete(res))
      return
    }
    if (url.pathname === '/v1/health')
      return send(200, { ok: true, appVersion: '2.0.0', protocol: 1, ready: true, capabilities })
    try {
      if (capable) {
        if (url.pathname === '/v1/environment/status')
          return send(200, {
            environmentId,
            capabilities,
            appVersion: '2.0.0',
            protocol: 1,
            ready: true,
            bots: [...installed]
              .sort((a, b) => a[1].slot - b[1].slot)
              .map(([botId, item]) => ({ botId, slot: item.slot, status: statusOf(botId) })),
          })
        const match = /^\/v1\/bots\/([^/]+)(\/.*)?$/.exec(url.pathname)
        if (match) {
          const [, botId, rest = ''] = match
          if (rest === '' && req.method === 'PUT') {
            const install = fleetInstanceBotInstallSchema.parse(body)
            if ([...installed].some(([id, item]) => id !== botId && item.slot === install.slot))
              return send(409, {
                code: 'CONFLICT',
                message: 'Display slot ' + install.slot + ' is used by another bot.',
              })
            installed.set(botId, {
              slot: install.slot,
              gatewayToken: install.gatewayToken,
              hold: installed.get(botId)?.hold ?? noHold,
              profile: install.profile,
            })
            return send(200, statusOf(botId))
          }
          const current = installed.get(botId)
          if (!current) return send(404, { code: 'NOT_FOUND', message: 'Bot does not exist.' })
          if (rest === '' && req.method === 'DELETE') {
            installed.delete(botId)
            return send(204)
          }
          if (rest === '/status') return send(200, statusOf(botId))
          if (rest === '/hold') {
            const input = fleetInstanceHoldRequestSchema.parse(body)
            if (current.hold.state !== 'none') return send(409, { code: 'CONFLICT', message: 'Already held' })
            current.hold = {
              state: 'held',
              reason: input.reason,
              since: new Date().toISOString(),
              interruptedTurn: false,
            }
            return send(200, current.hold)
          }
          if (rest === '/hold/release') {
            current.hold = noHold
            return send(200, noHold)
          }
          if (rest === '/inputs') return send(200, { inputId: randomUUID(), itemId: randomUUID(), queued: false })
        }
      } else {
        const [single] = [...installed.keys()]
        if (url.pathname === '/v1/profile' && req.method === 'PUT') {
          const profile = fleetInstanceProfileSchema.parse(body)
          const hold = installed.get(profile.botId)?.hold ?? noHold
          installed.clear()
          installed.set(profile.botId, { slot: 1, gatewayToken: null, hold, profile })
          return send(200, statusOf(profile.botId))
        }
        const current = single ? installed.get(single) : undefined
        if (current && url.pathname === '/v1/status') return send(200, statusOf(single))
        if (current && url.pathname === '/v1/hold') {
          const input = fleetInstanceHoldRequestSchema.parse(body)
          if (current.hold.state !== 'none') return send(409, { code: 'CONFLICT', message: 'Already held' })
          current.hold = {
            state: 'held',
            reason: input.reason,
            since: new Date().toISOString(),
            interruptedTurn: false,
          }
          return send(200, current.hold)
        }
        if (current && url.pathname === '/v1/hold/release') {
          current.hold = noHold
          return send(200, noHold)
        }
      }
    } catch {
      return send(400, { code: 'INVALID_REQUEST', message: 'Invalid request' })
    }
    return send(404, { code: 'NOT_FOUND', message: 'Route not found' })
  })
  const sockets = new Set<net.Socket>()
  server.on('upgrade', (req, socket: net.Socket, head: Buffer) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    upgrades.push(req.url ?? '')
    if (req.headers.authorization !== 'Bearer ' + tunnelToken || req.headers.upgrade !== 'maestrly-rfb') {
      socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n')
      return
    }
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: maestrly-rfb\r\n\r\n')
    if (head.length) socket.write(head)
    socket.on('data', (bytes) => socket.write(bytes))
  })
  const port = await listen(server)
  closers.push(async () => {
    for (const socket of sockets) socket.destroy()
  })
  const botPath = (method: string, botId: string, suffix = '') =>
    requests.findIndex((item) => item.method === method && item.path === '/v1/bots/' + botId + suffix)
  return {
    origin: 'http://127.0.0.1:' + port,
    port,
    requests,
    installed,
    subscriptions,
    upgrades,
    failures,
    emit,
    statusOf,
    setTunnelToken(value: string) {
      tunnelToken = value
    },
    /** The bot installations requested so far, in order. */
    installs: () =>
      requests
        .filter((item) => item.method === 'PUT' && item.path.startsWith('/v1/bots/'))
        .map((item) => {
          const body = fleetInstanceBotInstallSchema.parse(item.body)
          return { botId: body.profile.botId, slot: body.slot, gatewayToken: body.gatewayToken }
        }),
    /** Index of the last uninstall of a bot, or -1. */
    lastUninstall: (botId: string, purge = false) => {
      const indexes = requests
        .map((item, index) => ({ item, index }))
        .filter(({ item }) => item.method === 'DELETE' && item.path === '/v1/bots/' + botId + (purge ? '?purge=1' : ''))
      return indexes.at(-1)?.index ?? -1
    },
    firstInstall: (botId: string) => botPath('PUT', botId),
    lastInstall: (botId: string) =>
      lastIndex(requests, (item) => item.method === 'PUT' && item.path === '/v1/bots/' + botId),
  }
}
type Fake = Awaited<ReturnType<typeof environmentInstance>>
function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fleet-environments-'))
  dirs.push(dir)
  const cfg = loadConfig({ MAESTRLY_GATEWAY_DATA_DIR: dir })
  const store = new Store(dir),
    docker = new FakeDockerDriver()
  docker.images.add(cfg.botImage)
  const fakes = new Map<string, Fake>()
  const factory = (id: string) => {
    const fake = fakes.get(id)
    if (!fake) throw new Error('No synthetic instance for ' + id)
    return new InstanceClient(id, 'control', fake.origin)
  }
  const lifecycle = new Lifecycle(store, docker, cfg, factory, 400)
  const events: FleetGatewayEvent[] = []
  lifecycle.onEvent = (event) => events.push(event)
  closers.push(async () => {
    lifecycle.close()
    store.close()
  })
  return {
    dir,
    cfg,
    store,
    docker,
    lifecycle,
    events,
    factory,
    async instance(id: string, capable = true) {
      const fake = await environmentInstance(id, capable)
      fakes.set(id, fake)
      return fake
    },
  }
}
type Fixture = ReturnType<typeof fixture>
const botInput = (name: string) => ({
  name,
  instructions: '',
  ceiling: 'ask' as const,
  talksTo: [],
  idempotencyKey: randomUUID(),
})
async function running(f: Fixture, ...ids: string[]) {
  await until(() => ids.every((id) => f.lifecycle.get(id)?.lifecycle === 'running'))
}
/** A bot in a new environment, and the bots joining it. */
async function environment(f: Fixture, name: string, bots: string[]) {
  const [first, ...others] = bots
  const created = f.lifecycle.create({ ...botInput(first), environment: { name, memoryLimitBytes: null } })
  const environmentId = created.environmentId!
  await running(f, created.id)
  const ids = [created.id]
  for (const other of others) {
    const joined = f.lifecycle.create({ ...botInput(other), environmentId })
    await running(f, joined.id)
    ids.push(joined.id)
  }
  return { environmentId, ids }
}
const collapse = (values: string[]) => values.filter((value, index) => value !== values[index - 1])
const botSteps = (f: Fixture, id: string) =>
  f.events.flatMap((event) => (event.type === 'bot.updated' && event.bot.id === id ? [event.bot.setup.step] : []))
const environmentSteps = (f: Fixture, id: string) =>
  f.events.flatMap((event) =>
    event.type === 'environment.updated' && event.environment.id === id ? [event.environment.setup.step] : []
  )
const container = (f: Fixture, name: string) => [...f.docker.containers.values()].find((item) => item.name === name)

describe('environments', () => {
  it('creates an environment container and installs a second bot in it', async () => {
    const f = fixture()
    const work = await f.instance('work')
    const ads = f.lifecycle.create({ ...botInput('Ads'), environment: { name: 'Work', memoryLimitBytes: null } })
    expect(ads).toMatchObject({ environmentId: 'work', lifecycle: 'creating', setup: { step: 'container' } })
    await running(f, ads.id)
    const created = container(f, 'maestrly-env-work')!
    const secrets = f.store.environmentSecrets('work')!
    expect(created.spec).toMatchObject({
      hostname: 'work',
      volume: 'maestrly-env-work-home',
      labels: { 'org.maestrly.fleet.managed': 'true', 'org.maestrly.fleet.environment-id': 'work' },
      memory: f.cfg.botMemory,
    })
    // The container carries the environment, never a bot: bots arrive through the control API with their own token.
    expect([...created.spec.env].sort()).toEqual(
      [
        'MAESTRLY_BOT_MODE=1',
        'MAESTRLY_ENVIRONMENT_ID=work',
        'MAESTRLY_BOT_CONTROL_HOST=0.0.0.0',
        'MAESTRLY_BOT_CONTROL_PORT=7680',
        'MAESTRLY_BOT_CONTROL_TOKEN=' + secrets.controlToken,
        'MAESTRLY_BOT_GATEWAY_URL=' + f.cfg.internalUrl,
        'MAESTRLY_BOT_KEYRING_PASSWORD=' + secrets.keyringPassword,
        'TZ=' + f.cfg.timezone,
      ].sort()
    )
    expect(f.docker.volumes.has('maestrly-env-work-home')).toBe(true)
    expect(collapse([ads.setup.step, ...botSteps(f, ads.id)])).toEqual(['container', 'desktop', 'profile', 'ready'])
    expect(collapse(environmentSteps(f, 'work'))).toEqual(['container', 'desktop', 'ready'])

    const scout = f.lifecycle.create({ ...botInput('Scout'), environmentId: 'work' })
    expect(scout).toMatchObject({ environmentId: 'work', lifecycle: 'creating', setup: { step: 'profile' } })
    await running(f, scout.id)
    expect(collapse([scout.setup.step, ...botSteps(f, scout.id)])).toEqual(['profile', 'ready'])
    expect(f.docker.containers.size).toBe(1)
    expect(work.installs()).toEqual([
      { botId: ads.id, slot: 1, gatewayToken: f.store.botGatewaySecrets(ads.id)!.gatewayToken },
      { botId: scout.id, slot: 2, gatewayToken: f.store.botGatewaySecrets(scout.id)!.gatewayToken },
    ])
    expect(work.requests.some((item) => item.path === '/v1/profile')).toBe(false)
    expect(f.lifecycle.environment('work')).toMatchObject({
      lifecycle: 'running',
      setup: { step: 'ready' },
      botIds: [ads.id, scout.id],
      appVersion: '2.0.0',
      capabilities: ['provisioning', 'environments'],
      memoryLimitBytes: null,
    })
    expect(f.lifecycle.environments().map((item) => item.id)).toEqual(['work'])
    await until(() => work.subscriptions.length > 0)
    expect(work.subscriptions).toHaveLength(1)
    expect(f.store.activity().map((entry) => [entry.botId, entry.kind, entry.environmentId])).toEqual(
      expect.arrayContaining([
        [ads.id, 'bot_created', 'work'],
        [scout.id, 'bot_created', 'work'],
        [scout.id, 'bot_started', 'work'],
      ])
    )
  })

  it('fans one event stream out by bot and ignores bots outside the environment', async () => {
    const f = fixture()
    const work = await f.instance('work'),
      home = await f.instance('home')
    const {
      ids: [ads, scout],
    } = await environment(f, 'Work', ['Ads', 'Scout'])
    const {
      ids: [cleo],
    } = await environment(f, 'Home', ['Cleo'])
    await until(() => work.subscriptions.length > 0 && home.subscriptions.length > 0)
    const finished: string[] = []
    f.lifecycle.onTurnFinished = (botId) => finished.push(botId)
    const thinking = (botId: string) => ({ ...work.statusOf(botId), activity: { kind: 'thinking' } })
    const item = (id: string) => ({ kind: 'assistant', id, at: new Date().toISOString(), text: 'Hi', streaming: false })
    work.emit({ type: 'status', botId: scout, status: thinking(scout) })
    await until(() => f.lifecycle.get(scout)?.activity?.kind === 'thinking')
    expect(f.lifecycle.get(ads)?.activity).toBeNull()
    // Another environment's bot, an unknown bot and an event without a bot cannot be updated through this stream.
    work.emit({ type: 'status', botId: cleo, status: thinking(cleo) })
    work.emit({ type: 'status', botId: 'ghost', status: thinking('ghost') })
    work.emit({ type: 'status', botId: null, status: thinking(ads) })
    work.emit({ type: 'transcript.upsert', botId: cleo, item: item('foreign') })
    work.emit({ type: 'turn.finished', botId: 'ghost', outcome: 'completed', summary: 'Ghost' })
    work.emit({ type: 'turn.finished', botId: cleo, outcome: 'completed', summary: 'Foreign' })
    work.emit({ type: 'transcript.upsert', botId: ads, item: item('marker') })
    work.emit({ type: 'turn.finished', botId: scout, outcome: 'completed', summary: 'Done' })
    await until(() => finished.length > 0)
    expect(finished).toEqual([scout])
    expect(f.lifecycle.get(cleo)?.activity).toBeNull()
    expect(f.lifecycle.get(ads)?.activity).toBeNull()
    expect(
      f.events.flatMap((event) => (event.type === 'transcript.upsert' ? [[event.botId, event.item.id]] : []))
    ).toEqual([[ads, 'marker']])
    expect(f.store.activity().filter((entry) => entry.kind === 'turn_completed')).toEqual([
      expect.objectContaining({ botId: scout, environmentId: 'work', summary: 'Done' }),
    ])
    expect(f.store.getBot('ghost')).toBeNull()
    for (const fake of [work, home])
      expect(fake.requests.filter((request) => /ghost/.test(request.path) || request.method === 'DELETE')).toEqual([])
    expect(work.subscriptions).toHaveLength(1)
  })

  it('archives a bot without stopping its sibling and gives its slot to a new bot after it leaves', async () => {
    const f = fixture()
    const work = await f.instance('work')
    const {
      ids: [ads, scout],
    } = await environment(f, 'Work', ['Ads', 'Scout'])
    const archived = await f.lifecycle.archive(ads)
    expect(archived.lifecycle).toBe('archived')
    expect(work.lastUninstall(ads)).toBeGreaterThan(-1)
    expect(work.installed.has(ads)).toBe(false)
    expect(container(f, 'maestrly-env-work')?.state).toBe('running')
    expect(f.lifecycle.get(scout)?.lifecycle).toBe('running')
    expect(work.lastUninstall(scout)).toBe(-1)
    expect(f.store.botPlacement(ads)).toMatchObject({ environmentId: 'work', archivedWithEnvironment: false })
    expect(f.lifecycle.environment('work')?.botIds).toEqual([scout])
    expect((await f.lifecycle.archivedList()).map((bot) => [bot.id, bot.environmentId, bot.files])).toEqual([
      [ads, 'work', 'kept'],
    ])

    const cleo = f.lifecycle.create({ ...botInput('Cleo'), environmentId: 'work' })
    await running(f, cleo.id)
    expect(f.store.botPlacement(cleo.id)?.slot).toBe(1)
    expect(work.lastUninstall(ads)).toBeLessThan(work.firstInstall(cleo.id))

    const restored = f.lifecycle.restore(ads)
    expect(restored).toMatchObject({ lifecycle: 'creating', setup: { step: 'profile' } })
    await running(f, ads)
    // Its old slot went to Cleo, so it comes back in the lowest free one.
    expect(f.store.botPlacement(ads)?.slot).toBe(3)
    expect(work.installs().at(-1)).toMatchObject({ botId: ads, slot: 3 })
    expect(f.docker.containers.size).toBe(1)
    expect(await f.lifecycle.archivedList()).toEqual([])
  })

  it('removes a bot archived while its environment was unavailable before its slot is reused', async () => {
    const f = fixture()
    const work = await f.instance('work')
    const {
      ids: [ads, scout],
    } = await environment(f, 'Work', ['Ads', 'Scout'])
    await f.lifecycle.stopEnvironment('work')
    await f.lifecycle.archive(ads)
    expect(work.lastUninstall(ads)).toBe(-1)
    const cleo = f.lifecycle.create({ ...botInput('Cleo'), environmentId: 'work' })
    expect(f.store.botPlacement(cleo.id)?.slot).toBe(1)
    expect(f.lifecycle.get(cleo.id)?.lifecycle).toBe('stopped')
    await f.lifecycle.startEnvironment('work')
    await running(f, scout, cleo.id)
    // The instance still ran Ads in slot 1: it leaves before Cleo is installed there.
    expect(work.lastUninstall(ads)).toBeGreaterThan(-1)
    expect(work.lastUninstall(ads)).toBeLessThan(work.firstInstall(cleo.id))
    expect([...work.installed].map(([id, item]) => [id, item.slot]).sort()).toEqual(
      [
        [scout, 2],
        [cleo.id, 1],
      ].sort()
    )

    // The instance fails to uninstall Scout: archiving still succeeds, and Scout leaves before Dana takes its slot.
    work.failures.push({ method: 'DELETE', path: '/v1/bots/' + scout, status: 503, code: 'INSTANCE_UNAVAILABLE' })
    expect((await f.lifecycle.archive(scout)).lifecycle).toBe('archived')
    expect(work.installed.has(scout)).toBe(true)
    work.failures.length = 0
    const dana = f.lifecycle.create({ ...botInput('Dana'), environmentId: 'work' })
    await running(f, dana.id)
    expect(f.store.botPlacement(dana.id)?.slot).toBe(2)
    expect(work.installed.has(scout)).toBe(false)
    expect(work.lastUninstall(scout)).toBeLessThan(work.lastInstall(dana.id))
  })

  it('reconciles environments by label, legacy containers by their bot label, and slots the instance moved', async () => {
    const f = fixture()
    const work = await f.instance('work'),
      old = await f.instance('old', false)
    const {
      ids: [ads, scout],
    } = await environment(f, 'Work', ['Ads', 'Scout'])
    // A bot from before environments, migrated with its container, volume and label.
    const legacy = { ...f.store.getBot(ads)!, id: 'old', name: 'Old', lifecycle: 'running' as const, talksTo: [] }
    f.store.insertBot(legacy, {
      controlToken: 'synthetic-control',
      keyringPassword: 'synthetic-keyring',
      gatewayToken: 'synthetic-old-gateway-token',
      gatewayTokenSha256: 'a'.repeat(64),
    })
    const legacyId = await f.docker.containerCreate({
      name: 'maestrly-bot-old',
      image: f.cfg.botImage,
      hostname: 'old',
      labels: { 'org.maestrly.fleet.managed': 'true', 'org.maestrly.fleet.bot-id': 'old' },
      env: [],
      network: f.cfg.network,
      volume: 'maestrly-bot-old-home',
      memory: f.cfg.botMemory,
      shmSize: f.cfg.botShm,
      securityOpt: [],
    })
    await f.docker.start(legacyId)
    // The instance runs Scout in another slot than recorded.
    work.installed.get(scout)!.slot = 5
    const requests = work.requests.length
    f.lifecycle.close()
    const next = new Lifecycle(f.store, f.docker, f.cfg, f.factory, 400)
    closers.push(async () => next.close())
    await next.reconcile()
    expect(next.get('old')?.lifecycle).toBe('running')
    expect(old.requests.map((item) => item.method + ' ' + item.path)).toContain('PUT /v1/profile')
    expect(old.requests.some((item) => item.path.startsWith('/v1/bots/'))).toBe(false)
    expect(next.environment('work')?.lifecycle).toBe('running')
    expect(next.get(ads)?.lifecycle).toBe('running')
    expect(next.get(scout)?.lifecycle).toBe('running')
    const after = work.requests.slice(requests)
    const moved = after.findIndex((item) => item.method === 'DELETE' && item.path === '/v1/bots/' + scout)
    expect(moved).toBeGreaterThan(-1)
    expect(lastIndex(after, (item) => item.method === 'PUT' && item.path === '/v1/bots/' + scout)).toBeGreaterThan(
      moved
    )
    expect(work.installed.get(scout)?.slot).toBe(2)
    expect(work.installed.get(ads)?.slot).toBe(1)
  })

  it('starts, stops, restarts and updates every bot of an environment', async () => {
    const f = fixture()
    const work = await f.instance('work')
    const {
      ids: [ads, scout],
    } = await environment(f, 'Work', ['Ads', 'Scout'])
    const original = container(f, 'maestrly-env-work')!
    const secrets = f.store.environmentSecrets('work')
    expect((await f.lifecycle.stopEnvironment('work')).lifecycle).toBe('stopped')
    for (const id of [ads, scout]) {
      expect(f.lifecycle.get(id)).toMatchObject({ lifecycle: 'stopped', status: 'offline' })
      expect(f.lifecycle.statuses.has(id)).toBe(false)
    }
    expect(container(f, 'maestrly-env-work')?.state).toBe('exited')
    expect((await f.lifecycle.startEnvironment('work')).lifecycle).toBe('running')
    await running(f, ads, scout)
    f.docker.setImage(f.cfg.botImage, 'sha256:synthetic-new-image')
    const installs = work.installs().length
    expect((await f.lifecycle.restartEnvironment('work')).lifecycle).toBe('running')
    await running(f, ads, scout)
    const updated = container(f, 'maestrly-env-work')!
    expect(updated).not.toBe(original)
    expect(updated.imageId).toBe('sha256:synthetic-new-image')
    expect(updated.spec).toEqual(original.spec)
    expect(f.store.environmentSecrets('work')).toEqual(secrets)
    expect(
      work
        .installs()
        .slice(installs)
        .map((item) => item.botId)
    ).toEqual([ads, scout])
    const lifecycleEntries = f.store
      .activity()
      .filter((entry) => entry.kind.startsWith('environment_'))
      .map((entry) => [entry.kind, entry.botId, entry.environmentId])
    expect(lifecycleEntries).toEqual(
      expect.arrayContaining([
        ['environment_stopped', null, 'work'],
        ['environment_started', null, 'work'],
        ['environment_restarted', null, 'work'],
      ])
    )
    expect(
      f.store
        .activity()
        .filter((entry) => entry.kind === 'environment_restarted')
        .at(-1)?.data
    ).toMatchObject({
      updated: true,
      toImage: 'synthetic-ne',
    })
  })

  it('refuses bot lifecycle commands for a bot that shares its environment', async () => {
    const f = fixture()
    await f.instance('work')
    await f.instance('home')
    const {
      ids: [ads],
    } = await environment(f, 'Work', ['Ads', 'Scout'])
    for (const command of ['start', 'stop', 'restart'] as const)
      await expect(f.lifecycle[command](ads)).rejects.toMatchObject({
        code: 'CONFLICT',
        message: 'This bot shares its environment. Restart the environment instead.',
      })
    const {
      ids: [cleo],
    } = await environment(f, 'Home', ['Cleo'])
    expect((await f.lifecycle.stop(cleo)).lifecycle).toBe('stopped')
    expect(f.lifecycle.environment('home')?.lifecycle).toBe('stopped')
    expect((await f.lifecycle.start(cleo)).lifecycle).toBe('running')
    expect(f.store.activity().map((entry) => [entry.botId, entry.kind])).toEqual(
      expect.arrayContaining([
        [cleo, 'bot_stopped'],
        [cleo, 'bot_started'],
      ])
    )
  })

  it('archives an environment with its bots and restores only the bots archived with it', async () => {
    const f = fixture()
    await f.instance('work')
    const {
      ids: [ads, scout, cleo],
    } = await environment(f, 'Work', ['Ads', 'Scout', 'Cleo'])
    await f.lifecycle.archive(cleo)
    const secrets = f.store.environmentSecrets('work')
    const archived = await f.lifecycle.archiveEnvironment('work')
    expect(archived.lifecycle).toBe('archived')
    expect(container(f, 'maestrly-env-work')).toBeUndefined()
    expect(f.docker.volumes.has('maestrly-env-work-home')).toBe(true)
    expect(f.lifecycle.list()).toEqual([])
    expect(f.lifecycle.environments()).toEqual([])
    expect(f.lifecycle.environment('work')).toBeNull()
    expect(await f.lifecycle.archivedList()).toEqual([])
    expect(await f.lifecycle.archivedEnvironments()).toEqual([
      expect.objectContaining({
        id: 'work',
        name: 'Work',
        files: 'kept',
        bots: [ads, scout, cleo].map((id) => expect.objectContaining({ id })),
      }),
    ])
    expect(f.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'environment.removed', environmentId: 'work' }),
        expect.objectContaining({ type: 'bot.removed', botId: ads }),
        expect.objectContaining({ type: 'bot.removed', botId: scout }),
      ])
    )
    expect(() => f.lifecycle.restore(cleo)).toThrow('Restore its environment first')
    await expect(f.lifecycle.purge(cleo)).rejects.toThrow('Restore its environment first')
    const restored = f.lifecycle.restoreEnvironment('work')
    expect(restored.botIds).toEqual([ads, scout])
    expect(restored.environment.lifecycle).toBe('creating')
    expect(() => f.lifecycle.restoreEnvironment('work')).toThrow('Archived environment not found')
    await running(f, ads, scout)
    expect(f.lifecycle.get(cleo)?.lifecycle).toBe('archived')
    expect((await f.lifecycle.archivedList()).map((bot) => bot.id)).toEqual([cleo])
    expect(container(f, 'maestrly-env-work')?.spec.volume).toBe('maestrly-env-work-home')
    expect(f.store.environmentSecrets('work')).toEqual(secrets)
    expect(f.store.activity().map((entry) => [entry.kind, entry.environmentId])).toEqual(
      expect.arrayContaining([
        ['environment_archived', 'work'],
        ['environment_restored', 'work'],
      ])
    )
  })

  it('deletes an archived environment forever and nothing else', async () => {
    const f = fixture()
    await f.instance('work')
    await f.instance('home')
    const {
      ids: [ads],
    } = await environment(f, 'Work', ['Ads'])
    await environment(f, 'Home', ['Cleo'])
    const memory = (id: string, environmentId: string | null) =>
      f.store.saveOwnerMemory({
        id,
        content: 'Synthetic fact ' + id,
        status: 'active',
        author: { kind: 'owner' },
        origin: null,
        replacesId: null,
        replacedById: null,
        environmentId,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
    memory('global', null)
    memory('scoped', 'work')
    await expect(f.lifecycle.purgeEnvironment('work')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await f.lifecycle.archiveEnvironment('work')
    await f.lifecycle.purgeEnvironment('work')
    expect(f.docker.volumes.has('maestrly-env-work-home')).toBe(false)
    expect(f.docker.volumes.has('maestrly-env-home-home')).toBe(true)
    expect(f.store.getEnvironment('work')).toBeNull()
    expect(f.store.getBot(ads)).toBeNull()
    expect(f.store.ownerMemories().map((entry) => entry.id)).toEqual(['global'])
    expect(await f.lifecycle.archivedEnvironments()).toEqual([])
    expect(f.store.activity().at(-1)).toMatchObject({ botId: null, kind: 'environment_deleted', summary: 'Work' })
    await expect(f.lifecycle.purgeEnvironment('work')).rejects.toMatchObject({ code: 'NOT_FOUND' })

    // Files a container still uses stay, and so do the records.
    await f.lifecycle.archiveEnvironment('home')
    const user = await f.docker.containerCreate({
      name: 'synthetic-user',
      image: f.cfg.botImage,
      hostname: 'user',
      labels: {},
      env: [],
      network: f.cfg.network,
      volume: 'maestrly-env-home-home',
      memory: 1,
      shmSize: 1,
      securityOpt: [],
    })
    await expect(f.lifecycle.purgeEnvironment('home')).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(f.store.getEnvironment('home')?.archivedAt).not.toBeNull()
    await f.docker.remove(user, true)
    await f.lifecycle.purgeEnvironment('home')
    expect(f.store.getEnvironment('home')).toBeNull()
  })

  it('deletes an archived bot through its running environment and keeps the environment', async () => {
    const f = fixture()
    const work = await f.instance('work')
    const {
      ids: [ads, scout],
    } = await environment(f, 'Work', ['Ads', 'Scout'])
    await f.lifecycle.archive(scout)
    await f.lifecycle.purge(scout)
    expect(work.lastUninstall(scout, true)).toBeGreaterThan(work.lastUninstall(scout))
    expect(f.store.getBot(scout)).toBeNull()
    expect(f.store.getEnvironment('work')).not.toBeNull()
    expect(f.docker.volumes.has('maestrly-env-work-home')).toBe(true)
    expect(f.store.activity().at(-1)).toMatchObject({
      botId: null,
      environmentId: 'work',
      kind: 'bot_deleted',
      summary: 'Scout',
    })
    await f.lifecycle.archive(ads)
    await f.lifecycle.stopEnvironment('work')
    await expect(f.lifecycle.purge(ads)).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'Start its environment first',
    })
    expect(f.store.getBot(ads)?.lifecycle).toBe('archived')
    await f.lifecycle.startEnvironment('work')
    await f.lifecycle.purge(ads)
    expect(f.store.getBot(ads)).toBeNull()
    expect(f.lifecycle.environment('work')).toMatchObject({ lifecycle: 'running', botIds: [] })
  })

  it('changes the memory limit live and keeps the previous one when Docker refuses it', async () => {
    const f = fixture()
    await f.instance('work')
    const created = f.lifecycle.create({ ...botInput('Ads'), environment: { name: 'Work', memoryLimitBytes: 6 * GiB } })
    await running(f, created.id)
    const current = container(f, 'maestrly-env-work')!
    expect(current.spec.memory).toBe(6 * GiB)
    expect((await f.lifecycle.patchEnvironment('work', { memoryLimitBytes: 8 * GiB })).memoryLimitBytes).toBe(8 * GiB)
    expect(f.docker.memoryUpdates).toEqual([{ id: current.id, memory: 8 * GiB }])
    expect(f.store.getEnvironment('work')?.memoryLimitBytes).toBe(8 * GiB)
    f.docker.memoryUpdateFailure = new DockerError(409, 'Synthetic refusal')
    await expect(f.lifecycle.patchEnvironment('work', { memoryLimitBytes: 12 * GiB })).rejects.toMatchObject({
      code: 'CONFLICT',
    })
    expect(f.store.getEnvironment('work')?.memoryLimitBytes).toBe(8 * GiB)
    expect(f.lifecycle.environment('work')?.memoryLimitBytes).toBe(8 * GiB)
    f.docker.memoryUpdateFailure = null
    expect((await f.lifecycle.patchEnvironment('work', { name: 'Company' })).name).toBe('Company')
    expect(f.docker.memoryUpdates).toHaveLength(1)
    expect((await f.lifecycle.patchEnvironment('work', { memoryLimitBytes: null })).memoryLimitBytes).toBeNull()
    expect(f.docker.memoryUpdates.at(-1)).toEqual({ id: current.id, memory: f.cfg.botMemory })
    // A stopped container is updated too, so its next start uses the new limit.
    await f.lifecycle.stopEnvironment('work')
    await f.lifecycle.patchEnvironment('work', { memoryLimitBytes: 4 * GiB })
    expect(f.docker.memoryUpdates.at(-1)).toEqual({ id: current.id, memory: 4 * GiB })
    expect(container(f, 'maestrly-env-work')?.spec.memory).toBe(4 * GiB)
  })

  it('measures resources per environment and fills them in only for a bot alone in its environment', async () => {
    const f = fixture()
    await f.instance('work')
    await f.instance('home')
    const {
      ids: [ads, scout],
    } = await environment(f, 'Work', ['Ads', 'Scout'])
    const {
      ids: [cleo],
    } = await environment(f, 'Home', ['Cleo'])
    f.docker.stats = { memoryBytes: 300, memoryLimitBytes: 4000, cpuPercent: 5 }
    await f.lifecycle.refreshStats()
    expect([...f.lifecycle.resources.keys()].sort()).toEqual(['home', 'work'])
    expect([...f.lifecycle.resources.values()].reduce((sum, item) => sum + item.memoryBytes, 0)).toBe(600)
    expect(f.lifecycle.environment('work')?.resources).toMatchObject({ memoryBytes: 300, memoryLimitBytes: 4000 })
    for (const id of [ads, scout]) expect(f.lifecycle.get(id)?.resources.memoryBytes).toBeNull()
    expect(f.lifecycle.get(cleo)?.resources).toMatchObject({ memoryBytes: 300, cpuPercent: 5 })
    await f.lifecycle.stopEnvironment('home')
    expect(f.lifecycle.resources.has('home')).toBe(false)
  })

  it('installs bots that join while their environment is starting, each in its own slot', async () => {
    const f = fixture()
    const work = await f.instance('work')
    f.docker.startLatencyMs = 40
    const ads = f.lifecycle.create({ ...botInput('Ads'), environment: { name: 'Work', memoryLimitBytes: null } })
    const joined = ['Scout', 'Cleo', 'Dana'].map((name) =>
      f.lifecycle.create({ ...botInput(name), environmentId: ads.environmentId! })
    )
    await running(f, ads.id, ...joined.map((bot) => bot.id))
    expect([ads, ...joined].map((bot) => f.store.botPlacement(bot.id)?.slot).sort((a = 0, b = 0) => a - b)).toEqual([
      1, 2, 3, 4,
    ])
    expect(new Set(work.installs().map((item) => item.slot)).size).toBe(4)
    expect(f.store.activity().filter((entry) => entry.kind === 'bot_failed')).toEqual([])
    // A bot leaving and another joining at the same time: the newcomer is installed after the slot is free.
    const [leaving, archived] = await Promise.all([
      Promise.resolve(f.lifecycle.create({ ...botInput('Eve'), environmentId: 'work' })),
      f.lifecycle.archive(ads.id),
    ])
    await running(f, leaving.id)
    expect(archived.lifecycle).toBe('archived')
    expect(work.installed.has(ads.id)).toBe(false)
    expect(f.lifecycle.get(leaving.id)?.lifecycle).toBe('running')
  })

  it('keeps an environment that predates environments to one bot on its original routes', async () => {
    const f = fixture()
    const solo = await f.instance('solo', false)
    const {
      ids: [bot],
    } = await environment(f, 'Solo', ['Solo'])
    expect(solo.requests.map((item) => item.method + ' ' + item.path)).toContain('PUT /v1/profile')
    expect(
      solo.requests.some((item) => item.path.startsWith('/v1/bots/') || item.path.startsWith('/v1/environment/'))
    ).toBe(false)
    expect(f.lifecycle.environment('solo')?.capabilities).toEqual(['provisioning'])
    expect(() => f.lifecycle.create({ ...botInput('Pal'), environmentId: 'solo' })).toThrow(
      'Restart this environment to update it before adding bots.'
    )
    expect(f.store.botsOfEnvironment('solo').map((item) => item.id)).toEqual([bot])
    await until(() => solo.subscriptions.length > 0)
    // Its events name no bot: they belong to its one bot.
    solo.emit({ type: 'status', status: { ...solo.statusOf(bot), activity: { kind: 'thinking' } } })
    await until(() => f.lifecycle.get(bot)?.activity?.kind === 'thinking')
    await f.lifecycle.pause(bot)
    expect(solo.requests.at(-1)).toMatchObject({ method: 'POST', path: '/v1/hold', body: { reason: 'paused' } })
    await f.lifecycle.resume(bot)
    // After a gateway restart, a stopped environment's instance is not known yet: a bot may join, and waits.
    await f.lifecycle.stopEnvironment('solo')
    f.lifecycle.close()
    const next = new Lifecycle(f.store, f.docker, f.cfg, f.factory, 400)
    closers.push(async () => next.close())
    await next.reconcile()
    const pal = next.create({ ...botInput('Pal'), environmentId: 'solo' })
    await next.startEnvironment('solo')
    expect(next.get(bot)?.lifecycle).toBe('running')
    expect(next.get(pal.id)).toMatchObject({
      lifecycle: 'failed',
      setup: {
        step: 'failed',
        error: 'CONFLICT',
        errorMessage: 'Restart this environment to update it before adding bots.',
      },
    })
    expect([...solo.installed.keys()]).toEqual([bot])
  })

  it('drives Docker to change a live memory limit', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'fleet-engine-'))
    dirs.push(dir)
    const socket = path.join(dir, 'docker.sock')
    const calls: Array<{ url: string; body: unknown }> = []
    const server = http.createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const raw = Buffer.concat(chunks).toString()
      calls.push({ url: req.method + ' ' + req.url, body: raw ? JSON.parse(raw) : null })
      res.setHeader('Content-Type', 'application/json')
      if (req.url === '/version') return res.end(JSON.stringify({ ApiVersion: '1.45', Version: '28.0' }))
      if (req.url?.endsWith('/containers/refused/update')) {
        res.writeHead(409)
        return res.end(JSON.stringify({ message: 'Synthetic refusal' }))
      }
      res.end(JSON.stringify({ Warnings: [] }))
    })
    await new Promise<void>((resolve) => server.listen(socket, resolve))
    closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
    const docker = new DockerEngineDriver(socket)
    await docker.updateMemory('abc', 6 * GiB)
    expect(calls.at(-1)).toEqual({
      url: 'POST /v1.45/containers/abc/update',
      body: { Memory: 6 * GiB, MemorySwap: 12 * GiB },
    })
    await expect(docker.updateMemory('refused', 2 * GiB)).rejects.toMatchObject({ status: 409 })
  })
})

describe('environment instances', () => {
  it("sends a bot's calls to its own routes and the environment's to the environment's routes", async () => {
    const h = await harness(Date.now, { environments: true })
    expect(h.instance.installs).toEqual([
      expect.objectContaining({
        slot: 1,
        gatewayToken: h.store.botGatewaySecrets(h.bot.id)!.gatewayToken,
        profile: expect.objectContaining({ botId: h.bot.id }),
      }),
    ])
    const base = '/v1/bots/' + h.bot.id
    expect((await h.request('GET', base + '/memories?status=all')).status).toBe(200)
    expect((await h.request('POST', base + '/messages', { text: 'Hello', idempotencyKey: randomUUID() })).status).toBe(
      201
    )
    expect((await h.request('POST', base + '/takeover')).status).toBe(200)
    expect((await h.request('GET', base + '/accounts')).status).toBe(200)
    expect(h.instance.botRequests.map((item) => [item.botId, item.method + ' ' + item.path])).toEqual([
      [h.bot.id, 'GET /memories?status=all'],
      [h.bot.id, 'POST /inputs'],
      [h.bot.id, 'POST /hold'],
    ])
    expect(h.instance.provisioningRequests).toEqual([{ method: 'GET', path: '/v1/accounts', body: undefined }])
  })
})

describe('environment screens', () => {
  async function screens(f: Fixture, fake: Fake, environmentId: string) {
    fake.setTunnelToken(f.store.environmentSecrets(environmentId)!.controlToken)
    let time = Date.now()
    const screen = new ScreenProxy(
      f.lifecycle,
      () => '127.0.0.1',
      fake.port,
      () => time
    )
    const cfg = { ...f.cfg, publicPort: 0, internalPort: 0 }
    const gateway = createGatewayServers({
      auth: new Auth(f.store),
      config: cfg,
      events: new EventHub(async () => {}),
      host: new HostMonitor(cfg, f.docker),
      lifecycle: f.lifecycle,
      store: f.store,
      screen,
    })
    await gateway.listen()
    closers.push(() => gateway.close())
    const base = 'ws://127.0.0.1:' + (gateway.publicServer.address() as net.AddressInfo).port
    return {
      screen,
      base,
      advance(ms: number) {
        time += ms
      },
    }
  }
  const connect = (url: string) => {
    const ws = new WebSocket(url)
    return new Promise<WebSocket>((resolve, reject) => {
      ws.once('open', () => resolve(ws))
      ws.once('error', reject)
      ws.once('close', (code) => reject(new Error('closed ' + code)))
    })
  }
  const closed = (ws: WebSocket) => new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)))
  const rejected = (url: string) => closed(new WebSocket(url))

  it('binds tickets to a surface and gives one control session the environment display at a time', async () => {
    const f = fixture()
    const work = await f.instance('work')
    const {
      ids: [ads, scout],
    } = await environment(f, 'Work', ['Ads', 'Scout'])
    const { screen, base } = await screens(f, work, 'work')
    // Bot surfaces need the bot's takeover for control; the environment screen only needs a paired device.
    expect(() => screen.ticket(ads, 'one', 'control', 'browser')).toThrow('Takeover required for control')
    expect(() => screen.ticket(scout, 'one', 'control', 'apps')).toThrow('Takeover required for control')
    const settingsView = await connect(base + screen.environmentTicket('work', 'one', 'view').path)
    const settings = await connect(base + screen.environmentTicket('work', 'one', 'control').path)
    await f.lifecycle.takeover(ads, 'one', 'Mac')
    await f.lifecycle.takeover(scout, 'one', 'Mac')
    // The display is taken by the environment screen: a browser area cannot be controlled, an apps area can.
    expect(() => screen.ticket(ads, 'one', 'control', 'browser')).toThrow(
      'Another screen in this environment is being controlled.'
    )
    const apps = await connect(base + screen.ticket(scout, 'one', 'control', 'apps').path)
    const settingsClosed = closed(settings)
    settings.close()
    await settingsClosed
    const connections = (screen as unknown as { connections: Set<{ surface: string; mode: string }> }).connections
    await until(() => ![...connections].some((entry) => entry.surface === 'environment' && entry.mode === 'control'))
    // Two control tickets issued while the display is free: the first one used wins it.
    const browserTicket = screen.ticket(ads, 'one', 'control', 'browser')
    const settingsTicket = screen.environmentTicket('work', 'one', 'control')
    const browser = await connect(base + browserTicket.path)
    expect(await rejected(base + settingsTicket.path)).toBe(4003)
    const echoed: Buffer[] = []
    browser.on('message', (bytes) => echoed.push(Buffer.from(bytes as Buffer)))
    browser.send(Buffer.from([7, 8, 9]))
    await until(() => Buffer.concat(echoed).includes(Buffer.from([7, 8, 9])))
    expect(work.upgrades).toEqual([
      '/v1/screen/environment/view',
      '/v1/screen/environment/control',
      '/v1/bots/' + scout + '/screen/apps/control',
      '/v1/bots/' + ads + '/screen/browser/control',
    ])
    // Giving back Ads's screen closes its control session only.
    const browserClosed = closed(browser)
    await f.lifecycle.releaseTakeover(ads, 'one', null, true)
    expect(await browserClosed).toBe(4001)
    expect(apps.readyState).toBe(WebSocket.OPEN)
    expect(settingsView.readyState).toBe(WebSocket.OPEN)
    // Stopping the environment closes every screen in it.
    const closings = [apps, settingsView].map(closed)
    await f.lifecycle.stopEnvironment('work')
    expect(await Promise.all(closings)).toEqual([4002, 4002])
    expect(() => screen.environmentTicket('work', 'one', 'view')).toThrow()
  })

  it('offers only the browser area of an environment that predates environments', async () => {
    const f = fixture()
    const solo = await f.instance('solo', false)
    const {
      ids: [bot],
    } = await environment(f, 'Solo', ['Solo'])
    const { screen, base } = await screens(f, solo, 'solo')
    expect(() => screen.ticket(bot, 'one', 'view', 'apps')).toThrow(
      'Restart this environment to update it before opening this screen.'
    )
    expect(() => screen.environmentTicket('solo', 'one', 'view')).toThrow(
      'Restart this environment to update it before opening this screen.'
    )
    const view = await connect(base + screen.ticket(bot, 'one', 'view').path)
    expect(view.readyState).toBe(WebSocket.OPEN)
    await until(() => solo.upgrades.length > 0)
    expect(solo.upgrades).toEqual(['/v1/screen/view'])
  })
})
