import { afterEach, describe, expect, it } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import http, { type ServerResponse } from 'node:http'
import type net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import {
  FLEET_BOT_MOVE_FEATURE,
  FLEET_PROTOCOL_HEADER,
  fleetInstanceBotInstallSchema,
  fleetInstanceHoldRequestSchema,
  type FleetBotMove,
  type FleetGatewayEvent,
  type FleetInstanceStatus,
} from '@maestrly/bot-fleet-protocol'
import { Auth } from '../src/auth.js'
import { loadConfig } from '../src/config.js'
import { FakeDockerDriver } from '../src/docker.js'
import { EventHub } from '../src/events.js'
import { HostMonitor } from '../src/host.js'
import { InstanceClient } from '../src/instance.js'
import {
  BOT_MOVING,
  Lifecycle,
  MOVE_DIFFERS,
  MOVE_INTERRUPTED,
  MOVE_NEEDS_SAME_VERSION,
  MOVE_NEEDS_UPDATE,
} from '../src/lifecycle.js'
import { createGatewayServers } from '../src/server.js'
import { Store } from '../src/store.js'

const dirs: string[] = []
const closers: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
async function until(test: () => boolean, attempts = 400) {
  for (let i = 0; i < attempts; i++) {
    if (test()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Timed out')
}
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')
const noHold = { state: 'none' as const, reason: null, since: null, interruptedTurn: false }
type Hold = FleetInstanceStatus['hold']

/**
 * A synthetic environment instance that moves bots: it installs and uninstalls them, and freezes, exports and imports
 * the data each one holds (its "package" is that data), reducing it to the digest a real environment computes.
 */
async function environmentInstance(environmentId: string, options: { capabilities?: string[]; version?: string } = {}) {
  const requests: Array<{ method: string; path: string }> = []
  const installed = new Map<string, { slot: number; gatewayToken: string; hold: Hold }>()
  /** What the environment holds of each bot, installed or not. */
  const data = new Map<string, Buffer>()
  const failures: Array<{ method: string; path: string; status: number; code: string }> = []
  /** Requests it carries out without answering, once each: the gateway stopped waiting for them. */
  const drops: Array<{ method: string; path: string }> = []
  const capabilities = options.capabilities ?? ['provisioning', 'environments', FLEET_BOT_MOVE_FEATURE]
  const deferred = new Map<string, Promise<void>>()
  /** How it misbehaves on purpose: an export whose bytes differ from its digest, an import that reports another. */
  const quirks = { corruptExport: false, alterDigest: false }
  const streams = new Set<ServerResponse>()
  const digestOf = (bytes: Buffer) => ({
    conversationId: null,
    messages: bytes.length,
    lastSeq: -1,
    messagesSha256: sha(bytes),
    memories: 0,
    memoriesSha256: sha(''),
    files: 0,
    filesSha256: sha(''),
  })
  const statusOf = (botId: string): FleetInstanceStatus => ({
    capabilities,
    appVersion: options.version ?? '2.0.0',
    protocol: 1,
    ready: true,
    accounts: { connected: true, providers: [] },
    selection: null,
    ceiling: 'ask',
    profile: { botId, name: botId },
    conversationId: null,
    turn: { state: 'idle', startedAt: null, inputId: null },
    hold: installed.get(botId)?.hold ?? noHold,
    queue: [],
    activity: null,
    pending: [],
    usage: null,
    compaction: null,
    runtimes: null,
    lastEventSeq: 0,
  })
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://instance')
    const route = url.pathname + url.search
    const send = (code: number, value?: unknown) => {
      if (res.headersSent) return
      const drop = drops.findIndex((item) => item.method === req.method && item.path === route)
      if (drop >= 0) {
        drops.splice(drop, 1)
        return req.socket.destroy()
      }
      if (value === undefined) {
        res.writeHead(code)
        return res.end()
      }
      res.writeHead(code, { 'content-type': 'application/json' })
      res.end(JSON.stringify(value))
    }
    if (req.headers[FLEET_PROTOCOL_HEADER.toLowerCase()] !== '1' || req.headers.authorization !== 'Bearer control')
      return send(401, { code: 'UNAUTHORIZED', message: 'Unauthorized' })
    requests.push({ method: req.method ?? '', path: route })
    const gate = deferred.get(req.method + ' ' + route)
    if (gate) {
      deferred.delete(req.method + ' ' + route)
      await gate
    }
    const failure = failures.find((item) => item.method === req.method && item.path === route)
    if (failure) {
      req.resume()
      return send(failure.status, { code: failure.code, message: 'Synthetic failure' })
    }
    const read = async () => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      return Buffer.concat(chunks)
    }
    if (url.pathname === '/v1/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      streams.add(res)
      res.on('close', () => streams.delete(res))
      return
    }
    if (url.pathname === '/v1/health')
      return send(200, { ok: true, appVersion: options.version ?? '2.0.0', protocol: 1, ready: true, capabilities })
    if (url.pathname === '/v1/environment/status')
      return send(200, {
        environmentId,
        capabilities,
        appVersion: options.version ?? '2.0.0',
        protocol: 1,
        ready: true,
        bots: [...installed].map(([botId, item]) => ({ botId, slot: item.slot, status: statusOf(botId) })),
      })
    const match = /^\/v1\/bots\/([^/]+)(\/.*)?$/.exec(url.pathname)
    if (!match) return send(404, { code: 'NOT_FOUND', message: 'Route not found' })
    const [, botId, rest = ''] = match
    if (rest === '' && req.method === 'PUT') {
      const install = fleetInstanceBotInstallSchema.parse(JSON.parse((await read()).toString()))
      if ([...installed].some(([id, item]) => id !== botId && item.slot === install.slot))
        return send(409, { code: 'CONFLICT', message: 'Display slot in use' })
      installed.set(botId, {
        slot: install.slot,
        gatewayToken: install.gatewayToken,
        hold: install.paused ? { ...noHold, state: 'held', reason: 'paused', since: new Date().toISOString() } : noHold,
      })
      if (!data.has(botId)) data.set(botId, Buffer.from('conversation and files of ' + botId + ' in ' + environmentId))
      return send(200, statusOf(botId))
    }
    if (rest === '' && req.method === 'DELETE') {
      installed.delete(botId)
      if (url.searchParams.get('purge') === '1') data.delete(botId)
      return send(204)
    }
    if (rest === '/freeze' && req.method === 'POST') {
      installed.delete(botId)
      const held = data.get(botId)
      if (!held) return send(404, { code: 'NOT_FOUND', message: 'Bot does not exist.' })
      return send(200, { digest: digestOf(held) })
    }
    if (rest === '/export' && req.method === 'GET') {
      if (installed.has(botId)) return send(409, { code: 'CONFLICT', message: 'Freeze the bot before moving it.' })
      const held = data.get(botId)
      if (!held) return send(404, { code: 'NOT_FOUND', message: 'Bot does not exist.' })
      const bytes = quirks.corruptExport ? Buffer.from(held.toString().toUpperCase()) : held
      res.writeHead(200, {
        'content-type': 'application/zstd',
        'content-length': bytes.length,
        'x-maestrly-package-sha256': sha(held),
      })
      return res.end(bytes)
    }
    if (rest === '/import' && req.method === 'PUT') {
      if (installed.has(botId)) return send(409, { code: 'CONFLICT', message: 'Installed here' })
      if (data.has(botId) && url.searchParams.get('replace') !== '1')
        return send(409, { code: 'CONFLICT', message: 'Held here' })
      let bytes: Buffer
      try {
        bytes = await read()
      } catch {
        return
      }
      if (
        bytes.length !== Number(req.headers['content-length']) ||
        sha(bytes) !== req.headers['x-maestrly-package-sha256']
      )
        return send(400, { code: 'INVALID_REQUEST', message: 'The package differs from what was sent.' })
      data.set(botId, bytes)
      return send(200, { digest: digestOf(quirks.alterDigest ? Buffer.from('another bot') : bytes) })
    }
    const current = installed.get(botId)
    if (!current) return send(404, { code: 'NOT_FOUND', message: 'Bot does not exist.' })
    if (rest === '/status') return send(200, statusOf(botId))
    if (rest === '/hold') {
      const input = fleetInstanceHoldRequestSchema.parse(JSON.parse((await read()).toString()))
      current.hold = { state: 'held', reason: input.reason, since: new Date().toISOString(), interruptedTurn: false }
      return send(200, current.hold)
    }
    if (rest === '/hold/release') {
      await read()
      current.hold = noHold
      return send(200, noHold)
    }
    return send(404, { code: 'NOT_FOUND', message: 'Route not found' })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        for (const res of streams) res.destroy()
        server.closeAllConnections()
        server.close(() => resolve())
      })
  )
  return {
    origin: 'http://127.0.0.1:' + (server.address() as net.AddressInfo).port,
    requests,
    installed,
    data,
    failures,
    drops,
    quirks,
    capabilities,
    /** Holds back the next answer to a request until `resume` is called. */
    defer(method: string, route: string) {
      let resume = () => {}
      deferred.set(method + ' ' + route, new Promise<void>((resolve) => (resume = resolve)))
      return { resume: () => resume() }
    },
    called: (method: string, route: string) => requests.some((item) => item.method === method && item.path === route),
  }
}
type Fake = Awaited<ReturnType<typeof environmentInstance>>

function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fleet-bot-moves-'))
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
  const events: FleetGatewayEvent[] = []
  const lifecycle = new Lifecycle(store, docker, cfg, factory, 1000)
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
    async instance(id: string, options: { capabilities?: string[]; version?: string } = {}) {
      const fake = await environmentInstance(id, options)
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
/** Two environments, Work with Ads and Scout, Home with Cleo, each with its own synthetic instance. */
async function twoEnvironments(f: Fixture, homeOptions: { capabilities?: string[]; version?: string } = {}) {
  const work = await f.instance('work')
  const home = await f.instance('home', homeOptions)
  const {
    ids: [ads, scout],
  } = await environment(f, 'Work', ['Ads', 'Scout'])
  const {
    ids: [cleo],
  } = await environment(f, 'Home', ['Cleo'])
  return { work, home, ads, scout, cleo }
}
/** The bot's last move once it is over for the bot: failed, or complete (its former copy may still be going). */
const settled = async (f: Fixture, id: string) => {
  await until(() => f.store.latestBotMove(id)?.state !== 'running')
  return f.store.latestBotMove(id)!
}
/** The bot's last move once nothing of it is left to do: failed, or complete with its former copy deleted. */
const finished = async (f: Fixture, id: string) => {
  await until(() => {
    const move = f.store.latestBotMove(id)
    return move?.state === 'failed' || move?.phase === 'completed'
  })
  return f.store.latestBotMove(id)!
}
const movesOf = (f: Fixture, id: string) =>
  f.events.flatMap((event) =>
    event.type === 'bot.updated' && event.bot.id === id ? [event.bot.move?.phase ?? null] : []
  )
const collapse = <T>(values: T[]) => values.filter((value, index) => value !== values[index - 1])
const move = (f: Fixture, id: string, request: { environmentId?: string; newEnvironment?: { name: string } }) =>
  f.lifecycle.moveBot(id, { ...request, idempotencyKey: randomUUID() })

describe('moving a bot to another environment', () => {
  it('moves a bot with its data under its own id, and its siblings and records stay as they were', async () => {
    const f = fixture()
    const { work, home, ads, scout } = await twoEnvironments(f)
    const original = work.data.get(ads)!
    const token = f.store.botGatewaySecrets(ads)!.gatewayToken
    const routine = {
      id: randomUUID(),
      botId: ads,
      title: 'Morning',
      prompt: 'Check the inbox',
      schedule: { kind: 'interval' as const, everyMinutes: 60 },
      enabled: true,
      nextRunAt: null,
      lastRunAt: null,
      lastOutcome: null,
      createdBy: 'owner' as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    f.store.saveRoutine(routine)
    const memory = (id: string, environmentId: string | null, author: string) => ({
      id,
      content: 'Synthetic fact ' + id,
      status: 'active' as const,
      author: { kind: 'bot' as const, botId: author, name: author },
      origin: 'auto' as const,
      replacesId: null,
      replacedById: null,
      environmentId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    f.store.saveOwnerMemory(memory('own', 'work', ads))
    f.store.saveOwnerMemory(memory('sibling', 'work', scout))
    f.store.saveOwnerMemory(memory('global', null, ads))
    const revision = f.store.ownerMemoryRevision()

    f.events.length = 0
    const started = move(f, ads, { environmentId: 'home' })
    expect(started).toMatchObject({
      botId: ads,
      fromEnvironmentId: 'work',
      toEnvironmentId: 'home',
      newEnvironment: false,
      phase: 'prepared',
      state: 'running',
      error: null,
    })
    expect(f.lifecycle.get(ads)?.move).toMatchObject({ id: started.id, phase: 'prepared' })
    expect(f.store.freeSlot('home')).toBe(3)
    const done = await finished(f, ads)
    expect(done).toMatchObject({ state: 'completed', phase: 'completed', error: null })
    expect(collapse(movesOf(f, ads))).toEqual([
      'prepared',
      'freezing',
      'exporting',
      'importing',
      'verifying',
      'committing',
      'releasing-source',
      null,
    ])
    expect(f.store.botPlacement(ads)).toMatchObject({ environmentId: 'home', slot: 2 })
    expect(f.lifecycle.get(ads)).toMatchObject({ environmentId: 'home', lifecycle: 'running', move: null })
    expect(home.data.get(ads)).toEqual(original)
    expect(home.installed.get(ads)).toMatchObject({ slot: 2, gatewayToken: token })
    expect(work.data.has(ads)).toBe(false)
    expect(work.installed.has(ads)).toBe(false)
    expect(work.called('DELETE', '/v1/bots/' + ads + '?purge=1')).toBe(true)
    // Its sibling never left, its routine and its id are the same, and so is everything that names it.
    expect(work.installed.has(scout)).toBe(true)
    expect(work.requests.some((item) => item.path.includes(scout) && item.method === 'DELETE')).toBe(false)
    expect(f.store.routines(ads).map((item) => item.id)).toEqual([routine.id])
    expect(f.store.botGatewaySecrets(ads)!.gatewayToken).toBe(token)
    expect(f.lifecycle.environment('work')?.botIds).toEqual([scout])
    expect(f.lifecycle.environment('home')?.botIds.sort()).toEqual([ads, 'cleo'].sort())
    // The owner memories it wrote in its former environment go with it; the others stay.
    expect(f.store.ownerMemoryById('own')?.environmentId).toBe('home')
    expect(f.store.ownerMemoryById('sibling')?.environmentId).toBe('work')
    expect(f.store.ownerMemoryById('global')?.environmentId).toBeNull()
    expect(f.store.ownerMemoryRevision()).toBe(revision + 1)
    expect(f.events.some((event) => event.type === 'owner_memory.updated')).toBe(true)
    expect(f.lifecycle.latestMove(ads)).toMatchObject({ id: started.id, state: 'completed' })
  })

  it('moves a bot to a new environment, created and started for it first', async () => {
    const f = fixture()
    const { work, ads } = await twoEnvironments(f)
    const lab = await f.instance('lab')
    const started = move(f, ads, { newEnvironment: { name: 'Lab' } })
    expect(started).toMatchObject({ toEnvironmentId: 'lab', newEnvironment: true })
    expect(f.lifecycle.environment('lab')).toMatchObject({ name: 'Lab', kind: 'bots', lifecycle: 'creating' })
    expect(await finished(f, ads)).toMatchObject({ state: 'completed', phase: 'completed' })
    expect(f.lifecycle.environment('lab')).toMatchObject({ lifecycle: 'running', botIds: [ads] })
    expect([...f.docker.containers.values()].some((item) => item.name === 'maestrly-env-lab')).toBe(true)
    expect(lab.installed.get(ads)?.slot).toBe(1)
    expect(lab.data.get(ads)).toBeDefined()
    expect(work.data.has(ads)).toBe(false)
  })

  it('refuses a move it cannot make before touching the bot', async () => {
    const f = fixture()
    const { work, ads, scout } = await twoEnvironments(f)
    await f.instance('older', { capabilities: ['provisioning', 'environments'] })
    await f.instance('newer', { version: '2.1.0' })
    await environment(f, 'Older', ['Olga'])
    await environment(f, 'Newer', ['Nina'])
    const full = await f.instance('full')
    await environment(f, 'Full', ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8'])
    expect(full.installed.size).toBe(8)
    const refusal = (request: Parameters<typeof move>[2]) => {
      try {
        move(f, ads, request)
      } catch (error) {
        return (error as Error).message
      }
      return null
    }
    expect(refusal({ environmentId: 'full' })).toBe('This environment already has 8 bots.')
    expect(refusal({ environmentId: 'older' })).toBe(MOVE_NEEDS_UPDATE)
    expect(refusal({ environmentId: 'newer' })).toBe(MOVE_NEEDS_SAME_VERSION)
    expect(refusal({ environmentId: 'work' })).toBe('The bot is already there.')
    expect(refusal({ environmentId: 'ghost' })).toBe('Environment not found')
    await f.lifecycle.stopEnvironment('home')
    expect(refusal({ environmentId: 'home' })).toBe('Start both environments before moving the bot.')
    expect(f.store.latestBotMove(ads)).toBeNull()
    expect(work.requests.some((item) => item.path.endsWith('/freeze'))).toBe(false)
    expect(f.lifecycle.get(ads)?.move).toBeNull()
    expect(f.lifecycle.get(scout)?.lifecycle).toBe('running')
  })

  it('holds the bot still while it moves, and keeps its slot in the destination', async () => {
    const f = fixture()
    const { work, home, ads } = await twoEnvironments(f)
    const gate = work.defer('POST', '/v1/bots/' + ads + '/freeze')
    move(f, ads, { environmentId: 'home' })
    await until(() => work.called('POST', '/v1/bots/' + ads + '/freeze'))
    expect(f.lifecycle.get(ads)?.move?.phase).toBe('freezing')
    await expect(f.lifecycle.patch(ads, { name: 'Renamed' })).rejects.toThrow(BOT_MOVING)
    await expect(f.lifecycle.pause(ads)).rejects.toThrow(BOT_MOVING)
    await expect(f.lifecycle.archive(ads)).rejects.toThrow(BOT_MOVING)
    expect(() => f.lifecycle.instanceFor(ads)).toThrow(BOT_MOVING)
    expect(() => move(f, ads, { environmentId: 'home' })).toThrow(BOT_MOVING)
    // A bot joining the destination meanwhile does not take the slot the move holds.
    const dana = f.lifecycle.create({ ...botInput('Dana'), environmentId: 'home' })
    expect(f.store.botPlacement(dana.id)?.slot).toBe(3)
    gate.resume()
    expect(await finished(f, ads)).toMatchObject({ state: 'completed' })
    await running(f, dana.id)
    expect(home.installed.get(ads)?.slot).toBe(2)
    expect(home.installed.get(dana.id)?.slot).toBe(3)
  })
})

describe('a move that fails', () => {
  const cases: Array<{
    name: string
    phase: FleetBotMove['phase']
    break: (fakes: { work: Fake; home: Fake }, ads: string) => void
    discards: boolean
    code: string
    message?: string
  }> = [
    {
      name: 'cannot freeze the bot',
      phase: 'freezing',
      break: ({ work }, ads) =>
        work.failures.push({ method: 'POST', path: `/v1/bots/${ads}/freeze`, status: 503, code: 'INTERNAL' }),
      discards: false,
      code: 'INSTANCE_UNAVAILABLE',
    },
    {
      name: 'cannot export it',
      phase: 'exporting',
      break: ({ work }, ads) =>
        work.failures.push({ method: 'GET', path: `/v1/bots/${ads}/export`, status: 503, code: 'INTERNAL' }),
      discards: true,
      code: 'INSTANCE_UNAVAILABLE',
    },
    {
      name: 'sends bytes that differ from its digest',
      phase: 'importing',
      break: ({ work }) => {
        work.quirks.corruptExport = true
      },
      discards: true,
      code: 'INSTANCE_UNAVAILABLE',
    },
    {
      name: 'cannot import it',
      phase: 'importing',
      break: ({ home }, ads) =>
        home.failures.push({ method: 'PUT', path: `/v1/bots/${ads}/import?replace=1`, status: 409, code: 'CONFLICT' }),
      discards: true,
      code: 'CONFLICT',
    },
    {
      name: 'imports something else',
      phase: 'verifying',
      break: ({ home }) => {
        home.quirks.alterDigest = true
      },
      discards: true,
      code: 'INTERNAL',
      message: MOVE_DIFFERS,
    },
  ]
  for (const item of cases)
    it(`puts everything back when the move ${item.name}`, async () => {
      const f = fixture()
      const { work, home, ads, scout } = await twoEnvironments(f)
      const original = work.data.get(ads)!
      item.break({ work, home }, ads)
      move(f, ads, { environmentId: 'home' })
      const failed = await settled(f, ads)
      expect(failed).toMatchObject({ state: 'failed', phase: item.phase, error: { code: item.code } })
      if (item.message) expect(failed.error?.message).toBe(item.message)
      // The bot runs where it was, with its data, in its slot; the destination keeps nothing of it.
      await running(f, ads)
      expect(f.store.botPlacement(ads)).toMatchObject({ environmentId: 'work', slot: 1 })
      expect(work.installed.get(ads)?.slot).toBe(1)
      expect(work.data.get(ads)).toEqual(original)
      expect(home.data.has(ads)).toBe(false)
      expect(home.installed.has(ads)).toBe(false)
      expect(home.called('DELETE', `/v1/bots/${ads}?purge=1`)).toBe(item.discards)
      expect(f.lifecycle.get(ads)?.move).toBeNull()
      expect(f.store.freeSlot('home')).toBe(2)
      expect(work.installed.has(scout)).toBe(true)
      // It can move again once the cause is gone.
      work.failures.length = 0
      home.failures.length = 0
      work.quirks.corruptExport = home.quirks.alterDigest = false
      move(f, ads, { environmentId: 'home' })
      expect(await finished(f, ads)).toMatchObject({ state: 'completed' })
      expect(home.data.get(ads)).toEqual(original)
    })

  it('removes a destination it created when the bot cannot move there', async () => {
    const f = fixture()
    const { work, ads } = await twoEnvironments(f)
    await f.instance('lab', { version: '9.9.9' })
    move(f, ads, { newEnvironment: { name: 'Lab' } })
    const failed = await settled(f, ads)
    expect(failed).toMatchObject({ state: 'failed', error: { code: 'CONFLICT', message: MOVE_NEEDS_SAME_VERSION } })
    await until(() => !f.store.getEnvironment('lab'))
    expect([...f.docker.containers.values()].some((item) => item.name === 'maestrly-env-lab')).toBe(false)
    expect(f.docker.volumes.has('maestrly-env-lab-home')).toBe(false)
    expect(f.events.some((event) => event.type === 'environment.removed' && event.environmentId === 'lab')).toBe(true)
    expect(work.requests.some((item) => item.path.endsWith('/freeze'))).toBe(false)
    expect(f.lifecycle.get(ads)).toMatchObject({ environmentId: 'work', lifecycle: 'running', move: null })
  })

  it('installs the bot back once its environment answers again, without failing it meanwhile', async () => {
    const f = fixture()
    const { work, ads, scout } = await twoEnvironments(f)
    // The environment froze the bot and installed it back, but answered neither in time: it was busy hashing.
    work.drops.push({ method: 'POST', path: `/v1/bots/${ads}/freeze` }, { method: 'PUT', path: `/v1/bots/${ads}` })
    f.events.length = 0
    move(f, ads, { environmentId: 'home' })
    expect(await settled(f, ads)).toMatchObject({
      state: 'failed',
      phase: 'freezing',
      error: { code: 'INSTANCE_UNAVAILABLE' },
    })
    expect(f.lifecycle.get(ads)).toMatchObject({ environmentId: 'work', lifecycle: 'starting', move: null })
    await running(f, ads)
    expect(work.installed.get(ads)?.slot).toBe(1)
    expect(work.installed.has(scout)).toBe(true)
    expect(
      f.events.some((event) => event.type === 'bot.updated' && event.bot.id === ads && event.bot.lifecycle === 'failed')
    ).toBe(false)
  })
})

describe('the copy a moved bot leaves', () => {
  it('is deleted once its former environment runs again, and the move is complete meanwhile', async () => {
    const f = fixture()
    const { work, home, ads } = await twoEnvironments(f)
    work.failures.push({ method: 'DELETE', path: `/v1/bots/${ads}?purge=1`, status: 503, code: 'INTERNAL' })
    move(f, ads, { environmentId: 'home' })
    const done = await settled(f, ads)
    expect(done).toMatchObject({ state: 'completed', phase: 'releasing-source' })
    expect(f.lifecycle.get(ads)).toMatchObject({ environmentId: 'home', move: null })
    expect(home.installed.has(ads)).toBe(true)
    expect(work.data.has(ads)).toBe(true)
    work.failures.length = 0
    await f.lifecycle.restartEnvironment('work')
    await until(() => f.store.latestBotMove(ads)?.phase === 'completed')
    expect(work.data.has(ads)).toBe(false)
    expect(home.data.has(ads)).toBe(true)
  })

  it('is never deleted once the bot moved back there', async () => {
    const f = fixture()
    const { work, home, ads } = await twoEnvironments(f)
    work.failures.push({ method: 'DELETE', path: `/v1/bots/${ads}?purge=1`, status: 503, code: 'INTERNAL' })
    move(f, ads, { environmentId: 'home' })
    await settled(f, ads)
    expect(work.data.has(ads)).toBe(true)
    work.failures.length = 0
    // It comes back: its import replaces what it left, and the first move has nothing left to delete.
    move(f, ads, { environmentId: 'work' })
    expect(await finished(f, ads)).toMatchObject({ state: 'completed', phase: 'completed' })
    expect(f.store.pendingReleases('work')).toEqual([])
    expect(work.called('PUT', `/v1/bots/${ads}/import?replace=1`)).toBe(true)
    await f.lifecycle.restartEnvironment('work')
    expect(work.installed.has(ads)).toBe(true)
    expect(work.data.has(ads)).toBe(true)
    expect(home.data.has(ads)).toBe(false)
    expect(f.lifecycle.get(ads)).toMatchObject({ environmentId: 'work', lifecycle: 'running' })
  })
})

describe('a gateway restarted during a move', () => {
  async function interrupted(phase: FleetBotMove['phase'], committed: boolean) {
    const f = fixture()
    const { work, home, ads } = await twoEnvironments(f)
    const journal = f.store.beginBotMove({
      id: randomUUID(),
      botId: ads,
      toEnvironmentId: 'home',
      newEnvironment: false,
    })
    // What the move had done when the gateway stopped: the bot frozen in Work, its package in Home.
    work.installed.delete(ads)
    home.data.set(ads, work.data.get(ads)!)
    f.store.updateBotMove(journal.id, { phase: committed ? 'committing' : phase })
    if (committed) f.store.commitBotMove(journal.id)
    f.lifecycle.close()
    const next = new Lifecycle(f.store, f.docker, f.cfg, f.factory, 1000)
    closers.push(async () => next.close())
    await next.reconcile()
    return { f, next, work, home, ads, journal }
  }

  it('puts back a move that had not committed: the bot runs where it was and the destination forgets it', async () => {
    const { f, next, work, home, ads, journal } = await interrupted('importing', false)
    expect(f.store.botMove(journal.id)).toMatchObject({
      state: 'failed',
      phase: 'importing',
      error: { code: 'INTERNAL', message: MOVE_INTERRUPTED },
    })
    await until(() => next.get(ads)?.lifecycle === 'running' && work.installed.has(ads))
    expect(next.get(ads)).toMatchObject({ environmentId: 'work', move: null })
    await until(() => !home.data.has(ads))
    expect(home.installed.has(ads)).toBe(false)
  })

  it('removes a destination the interrupted move created, while it holds no bot', async () => {
    const f = fixture()
    const { work, ads } = await twoEnvironments(f)
    const lab = await f.instance('lab')
    f.lifecycle.createEnvironment({ name: 'Lab', memoryLimitBytes: null })
    await until(() => f.lifecycle.environment('lab')?.lifecycle === 'running')
    const journal = f.store.beginBotMove({ id: randomUUID(), botId: ads, toEnvironmentId: 'lab', newEnvironment: true })
    work.installed.delete(ads)
    lab.data.set(ads, work.data.get(ads)!)
    f.store.updateBotMove(journal.id, { phase: 'importing' })
    f.lifecycle.close()
    const next = new Lifecycle(f.store, f.docker, f.cfg, f.factory, 1000)
    closers.push(async () => next.close())
    await next.reconcile()
    expect(f.store.botMove(journal.id)).toMatchObject({ state: 'failed', error: { message: MOVE_INTERRUPTED } })
    await until(() => !f.store.getEnvironment('lab'))
    expect(lab.data.has(ads)).toBe(false)
    expect([...f.docker.containers.values()].some((item) => item.name === 'maestrly-env-lab')).toBe(false)
    expect(f.docker.volumes.has('maestrly-env-lab-home')).toBe(false)
    await until(() => next.get(ads)?.lifecycle === 'running' && work.installed.has(ads))
    expect(next.get(ads)?.environmentId).toBe('work')
  })

  it('completes a move that had committed: the bot runs in its destination and its copy goes', async () => {
    const { f, next, work, home, ads, journal } = await interrupted('committing', true)
    await until(() => f.store.botMove(journal.id)?.phase === 'completed')
    expect(f.store.botMove(journal.id)?.state).toBe('completed')
    await until(() => home.installed.has(ads))
    expect(next.get(ads)).toMatchObject({ environmentId: 'home', lifecycle: 'running', move: null })
    expect(work.data.has(ads)).toBe(false)
    expect(home.data.has(ads)).toBe(true)
  })
})

describe('the move routes', () => {
  it('starts a move once per key, reports the last one, and announces the feature', async () => {
    const f = fixture()
    const { ads } = await twoEnvironments(f)
    const auth = new Auth(f.store)
    const paired = auth.pair(auth.createPairing().code, 'Mac', 'one')
    const gateway = createGatewayServers({
      auth,
      config: { ...f.cfg, publicPort: 0, internalPort: 0 },
      events: new EventHub(async () => {}),
      host: new HostMonitor(f.cfg, f.docker),
      lifecycle: f.lifecycle,
      store: f.store,
    })
    await gateway.listen()
    closers.push(() => gateway.close())
    const origin = 'http://127.0.0.1:' + (gateway.publicServer.address() as net.AddressInfo).port
    const request = (method: string, route: string, body?: unknown) =>
      fetch(origin + route, {
        method,
        headers: {
          [FLEET_PROTOCOL_HEADER]: '1',
          Authorization: 'Bearer ' + paired.token,
          'Content-Type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    const meta = await (await request('GET', '/v1/meta')).json()
    expect(meta.moreFeatures).toContain(FLEET_BOT_MOVE_FEATURE)
    expect((await request('GET', `/v1/bots/${ads}/move`)).status).toBe(404)
    const body = { environmentId: 'home', idempotencyKey: randomUUID() }
    const first = await request('POST', `/v1/bots/${ads}/move`, body)
    expect(first.status).toBe(202)
    const started = await first.json()
    const again = await request('POST', `/v1/bots/${ads}/move`, body)
    expect(again.status).toBe(202)
    expect((await again.json()).id).toBe(started.id)
    expect((await request('POST', `/v1/bots/${ads}/move`, { ...body, environmentId: 'work' })).status).toBe(409)
    expect((await request('POST', `/v1/bots/${ads}/move`, { idempotencyKey: randomUUID() })).status).toBe(400)
    await finished(f, ads)
    const last = await request('GET', `/v1/bots/${ads}/move`)
    expect(await last.json()).toMatchObject({ id: started.id, state: 'completed', toEnvironmentId: 'home' })
  })
})
