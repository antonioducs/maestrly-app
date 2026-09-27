import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http, { type ServerResponse } from 'node:http'
import type net from 'node:net'
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import {
  FLEET_PROTOCOL_HEADER,
  fleetInstanceInputSchema,
  fleetInstanceProfileSchema,
  fleetInstanceHoldRequestSchema,
  fleetInstanceReleaseRequestSchema,
  type FleetInstanceEvent,
  type FleetInstanceStatus,
} from '@maestrly/bot-fleet-protocol'
import { loadConfig } from '../src/config.js'
import { FakeDockerDriver } from '../src/docker.js'
import { InstanceClient } from '../src/instance.js'
import { Lifecycle } from '../src/lifecycle.js'
import { Routines, nextRun, nextWeeklyRun } from '../src/routines.js'
import { Store } from '../src/store.js'
import { createSchema5Database } from './store-fixtures.js'

const dirs: string[] = []
const closeFns: (() => Promise<void>)[] = []
function temp() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fleet-feature-'))
  dirs.push(dir)
  return dir
}
async function listen(server: http.Server | net.Server) {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  closeFns.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
  return (server.address() as net.AddressInfo).port
}
afterEach(async () => {
  for (const close of closeFns.splice(0).reverse()) await close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function status(id = 'test'): FleetInstanceStatus {
  return {
    appVersion: '1.2.3',
    capabilities: [],
    protocol: 1,
    ready: true,
    accounts: { connected: true, providers: [] },
    selection: null,
    ceiling: 'ask',
    profile: { botId: id, name: id },
    conversationId: null,
    turn: { state: 'idle', startedAt: null },
    hold: { state: 'none', reason: null, since: null, interruptedTurn: false },
    queue: [],
    activity: null,
    pending: [],
    usage: null,
    lastEventSeq: 0,
  }
}
async function fakeInstance() {
  let state = status()
  let seq = 0
  let low = 0
  const streams = new Set<ServerResponse>()
  const subscriptions: number[] = []
  const inputs: unknown[] = []
  const inputReceipts: string[] = []
  const holds: unknown[] = []
  let holdFailure: string | null = null
  const releases: unknown[] = []
  const profiles: unknown[] = []
  const send = (res: ServerResponse, event: FleetInstanceEvent) =>
    res.write('id: ' + event.seq + '\nevent: instance\ndata: ' + JSON.stringify(event) + '\n\n')
  const emit = (event: Omit<FleetInstanceEvent, 'seq' | 'at'>) => {
    seq++
    state = { ...state, lastEventSeq: seq }
    if (event.type === 'status') state = { ...event.status, lastEventSeq: seq }
    const frame = { ...event, seq, at: new Date().toISOString() } as FleetInstanceEvent
    for (const res of streams) send(res, frame)
  }
  const server = http.createServer(async (req, res) => {
    const fail = (status: number, code: string) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ code, message: code }))
    }
    if (req.headers.origin) return fail(403, 'FORBIDDEN')
    if (req.headers[FLEET_PROTOCOL_HEADER.toLowerCase()] !== '1') return fail(426, 'PROTOCOL_INCOMPATIBLE')
    if (req.headers.authorization !== 'Bearer control') return fail(401, 'UNAUTHORIZED')
    const url = new URL(req.url ?? '/', 'http://instance')
    if (url.pathname === '/v1/events') {
      subscriptions.push(Number(url.searchParams.get('since') ?? 0))
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      streams.add(res)
      res.on('close', () => streams.delete(res))
      if (Number(url.searchParams.get('since') ?? 0) < low)
        send(res, { seq: ++seq, at: new Date().toISOString(), type: 'reset' })
      return
    }
    let body: unknown
    if (['POST', 'PUT'].includes(req.method ?? '')) {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      try {
        body = JSON.parse(Buffer.concat(chunks).toString())
      } catch {
        return fail(400, 'INVALID_REQUEST')
      }
    }
    res.setHeader('content-type', 'application/json')
    try {
      if (url.pathname === '/v1/health')
        return res.end(JSON.stringify({ ok: true, ready: state.ready, appVersion: state.appVersion, protocol: 1 }))
      if (url.pathname === '/v1/status') return res.end(JSON.stringify(state))
      if (url.pathname === '/v1/profile') {
        profiles.push(fleetInstanceProfileSchema.parse(body))
        return res.end(JSON.stringify(state))
      }
      if (url.pathname === '/v1/hold') {
        fleetInstanceHoldRequestSchema.parse(body)
        if (holdFailure) {
          res.writeHead(409)
          return res.end(JSON.stringify({ code: 'CONFLICT', message: holdFailure }))
        }
        if (state.hold.state !== 'none') return fail(409, 'CONFLICT')
        holds.push(body)
        state = {
          ...state,
          hold: {
            state: 'held',
            reason: (body as { reason: 'paused' | 'takeover' }).reason,
            since: new Date().toISOString(),
            interruptedTurn: false,
          },
        }
        return res.end(JSON.stringify(state.hold))
      }
      if (url.pathname === '/v1/hold/release') {
        fleetInstanceReleaseRequestSchema.parse(body)
        if (state.hold.state === 'none') return fail(409, 'CONFLICT')
        releases.push(body)
        state = { ...state, hold: { state: 'none', reason: null, since: null, interruptedTurn: false } }
        return res.end(JSON.stringify(state.hold))
      }
      if (url.pathname === '/v1/inputs') {
        fleetInstanceInputSchema.parse(body)
        inputs.push(body)
        const inputId = randomUUID()
        inputReceipts.push(inputId)
        return res.end(JSON.stringify({ inputId, itemId: randomUUID(), queued: false }))
      }
      return fail(404, 'NOT_FOUND')
    } catch {
      return fail(400, 'INVALID_REQUEST')
    }
  })
  const port = await listen(server)
  return {
    origin: 'http://127.0.0.1:' + port,
    get state() {
      return state
    },
    setState(next: FleetInstanceStatus) {
      state = next
      emit({ type: 'status', status: next })
    },
    emit,
    regress() {
      seq = 0
    },
    setLow(value: number) {
      low = value
    },
    disconnect() {
      for (const stream of streams) stream.end()
    },
    subscriptions,
    profiles,
    inputs,
    inputReceipts,
    holds,
    setHoldFailure(value: string | null) {
      holdFailure = value
    },
    releases,
  }
}
function fixture(origin: string, lostMs = 300000) {
  const dir = temp(),
    cfg = loadConfig({
      MAESTRLY_GATEWAY_DATA_DIR: dir,
      MAESTRLY_GATEWAY_PUBLIC_PORT: '1',
      MAESTRLY_GATEWAY_INTERNAL_PORT: '2',
    })
  const store = new Store(dir),
    docker = new FakeDockerDriver()
  docker.images.add(cfg.botImage)
  const lifecycle = new Lifecycle(store, docker, cfg, (id) => new InstanceClient(id, 'control', origin), 200, lostMs)
  const events: unknown[] = []
  lifecycle.onEvent = (event) => events.push(event)
  return { cfg, store, docker, lifecycle, events }
}
const botInput = (name = 'Test') => ({
  name,
  instructions: '',
  ceiling: 'ask' as const,
  talksTo: [],
  idempotencyKey: randomUUID(),
})
async function until(test: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (test()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Timed out')
}

describe('secrets and configuration', () => {
  it('migrates version 1 passwords and keeps them stable', () => {
    const dir = temp(),
      db = new DatabaseSync(path.join(dir, 'gateway.sqlite'))
    db.exec(
      "CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); INSERT INTO meta VALUES('schema_version','1'); CREATE TABLE bots(id TEXT PRIMARY KEY,name TEXT NOT NULL,role TEXT NOT NULL,instructions TEXT NOT NULL,tint TEXT NOT NULL,ceiling TEXT NOT NULL,selection_json TEXT,talks_to_json TEXT NOT NULL,paused INTEGER NOT NULL,lifecycle TEXT NOT NULL,setup_json TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,archived_at TEXT); INSERT INTO bots VALUES('test','Test','','','#ffffff','ask','null','[]',0,'stopped','{}','2026-01-05T10:00:00.000Z','2026-01-05T10:00:00.000Z',NULL); CREATE TABLE bot_secrets(bot_id TEXT PRIMARY KEY,control_token TEXT NOT NULL,gateway_token TEXT NOT NULL,gateway_token_sha256 TEXT NOT NULL UNIQUE); INSERT INTO bot_secrets VALUES('test','control','gateway','hash'); CREATE TABLE routines(id TEXT PRIMARY KEY); CREATE TABLE activity(seq INTEGER PRIMARY KEY AUTOINCREMENT,at TEXT NOT NULL,bot_id TEXT REFERENCES bots(id),kind TEXT NOT NULL,summary TEXT,data_json TEXT NOT NULL)"
    )
    db.close()
    const store = new Store(dir),
      password = store.botSecrets('test')?.keyringPassword
    expect(password).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(store.environmentSecrets('test')).toEqual({ controlToken: 'control', keyringPassword: password })
    store.close()
    const reopened = new Store(dir)
    expect(reopened.botSecrets('test')?.keyringPassword).toBe(password)
    reopened.close()
  })
  it('migrates version 2 routines to owner-created records', () => {
    const dir = temp()
    const db = createSchema5Database(dir)
    db.prepare("UPDATE meta SET value='2' WHERE key='schema_version'").run()
    const botId = 'test'
    const at = '2026-01-05T10:00:00.000Z'
    db.prepare(
      'INSERT INTO bots(id,name,role,instructions,tint,ceiling,selection_json,talks_to_json,paused,lifecycle,setup_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)'
    ).run(botId, 'Test', '', '', '#ffffff', 'ask', 'null', '[]', 0, 'running', '{}', at, at)
    db.prepare(
      'INSERT INTO routines(id,bot_id,title,prompt,schedule_json,enabled,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)'
    ).run(
      'old',
      botId,
      'Old',
      'Check',
      JSON.stringify({ kind: 'weekly', time: '09:00', days: [], timezone: 'UTC' }),
      1,
      at,
      at
    )
    db.exec('ALTER TABLE routines DROP COLUMN created_by; ALTER TABLE routines DROP COLUMN last_input_id')
    db.close()
    const migrated = new Store(dir)
    expect(migrated.routineById('old')?.createdBy).toBe('owner')
    expect(migrated.db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()).toEqual({ value: '6' })
    migrated.close()
  })
  it('migrates version 3 bots and persists their compaction model', () => {
    const dir = temp()
    const db = createSchema5Database(dir)
    db.exec('ALTER TABLE bots DROP COLUMN compaction_json')
    db.prepare("UPDATE meta SET value='3' WHERE key='schema_version'").run()
    db.close()
    const migrated = new Store(dir)
    expect(migrated.db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()).toEqual({ value: '6' })
    expect(migrated.db.prepare('PRAGMA table_info(bots)').all()).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'compaction_json' })])
    )
    migrated.close()
  })
  it('resolves auto seccomp in gateway and validates JSON arrays', () => {
    const dir = temp(),
      profilePath = path.join(dir, 'profile.json')
    writeFileSync(profilePath, '{"defaultAction":"SCMP_ACT_ALLOW"}')
    const cfg = loadConfig({
      MAESTRLY_GATEWAY_DATA_DIR: dir,
      MAESTRLY_GATEWAY_BOT_SECURITY_OPT: 'auto',
      MAESTRLY_GATEWAY_BOT_SECCOMP_PROFILE: profilePath,
    })
    expect(cfg.botSecurityOpt).toEqual(['seccomp={"defaultAction":"SCMP_ACT_ALLOW"}'])
    expect(() => loadConfig({ MAESTRLY_GATEWAY_DATA_DIR: dir, MAESTRLY_GATEWAY_BOT_SECURITY_OPT: '[1]' })).toThrow()
  })
})
describe('instance link and takeover', () => {
  it('saves and forwards compaction settings and reports setup until configured', async () => {
    const fake = await fakeInstance()
    const f = fixture(fake.origin)
    const created = f.lifecycle.create(botInput())
    await until(() => f.lifecycle.get(created.id)?.lifecycle === 'running')
    const compaction = {
      providerId: 'prov_test',
      modelId: 'model',
      reasoning: null,
      fastMode: false,
      intervalTokens: 100_000,
    }
    await f.lifecycle.patch(created.id, { compaction })
    expect(f.store.getBot(created.id)?.compaction).toEqual(compaction)
    expect(fake.profiles.at(-1)).toMatchObject({ compaction })
    fake.setState({
      ...fake.state,
      compaction: {
        configured: false,
        problem: 'missing',
        background: { status: 'idle', error: null },
        progress: null,
      },
    })
    await until(() => f.lifecycle.get(created.id)?.compactionState?.problem === 'missing')
    expect(f.lifecycle.get(created.id)?.status).toBe('setup')
    f.lifecycle.close()
    f.store.close()
  })
  it('derives status, inbox, activity, forwards transcript, and handles regression', async () => {
    const fake = await fakeInstance(),
      f = fixture(fake.origin)
    const bot = f.lifecycle.create(botInput())
    expect(bot.accounts).toEqual({ connected: false, providers: [] })
    await until(() => f.lifecycle.get(bot.id)?.lifecycle === 'running')
    await until(() => fake.subscriptions.length > 0)
    fake.setState({ ...fake.state, accounts: { connected: true, providers: [{ id: 'prov_test', label: 'Test' }] } })
    await until(() => f.lifecycle.get(bot.id)?.accounts.providers[0]?.id === 'prov_test')
    expect(f.lifecycle.get(bot.id)?.accounts).toEqual({
      connected: true,
      providers: [{ id: 'prov_test', label: 'Test' }],
    })
    const usage = {
      contextUsedTokens: 100,
      contextWindowTokens: 1000,
      contextQuality: 'measured' as const,
      costUsd: 0.01,
      updatedAt: new Date().toISOString(),
    }
    fake.setState({ ...fake.state, usage })
    await until(() => f.lifecycle.get(bot.id)?.usage?.contextUsedTokens === 100)
    expect(f.events.some((event: any) => event.type === 'bot.updated' && event.bot.usage?.costUsd === 0.01)).toBe(true)
    const pending = {
      kind: 'permission' as const,
      id: 'p1',
      at: new Date().toISOString(),
      title: 'Open browser',
      detail: null,
      tool: { name: 'computer_click', target: '(10, 20)' },
      itemId: 'perm:p1',
    }
    fake.setState({ ...fake.state, pending: [pending], activity: { kind: 'permission', title: pending.title } })
    await until(() => f.lifecycle.get(bot.id)?.status === 'waiting')
    expect(f.lifecycle.inbox()).toHaveLength(1)
    fake.setState({ ...fake.state })
    await until(() => f.events.filter((event: any) => event.type === 'bot.updated').length >= 2)
    expect(f.store.activity().filter((entry) => entry.kind === 'needs_you')).toHaveLength(1)
    expect(f.store.activity().find((entry) => entry.kind === 'needs_you')?.summary).toBe('computer_click')
    expect(f.lifecycle.inbox()[0]?.interaction).toMatchObject({ tool: pending.tool })
    fake.emit({
      type: 'transcript.upsert',
      item: { kind: 'assistant', id: 'a1', at: new Date().toISOString(), text: 'Done', streaming: false },
    })
    fake.emit({ type: 'turn.finished', outcome: 'completed', summary: 'Finished' })
    await until(() => f.events.some((event: any) => event.type === 'transcript.upsert'))
    expect(f.store.activity().some((entry) => entry.kind === 'turn_completed' && entry.summary === 'Finished')).toBe(
      true
    )
    fake.regress()
    fake.setState({ ...fake.state, pending: [] })
    await until(() => f.events.some((event: any) => event.type === 'transcript.reset'))
    expect(f.lifecycle.inbox()).toEqual([])
    const before = fake.subscriptions.length
    fake.disconnect()
    await until(() => fake.subscriptions.length > before)
    expect(fake.subscriptions.at(-1)).toBe(fake.state.lastEventSeq)
    f.lifecycle.close()
    f.store.close()
  })
  it('reverts a refused takeover and forwards the hold conflict message', async () => {
    const fake = await fakeInstance()
    const f = fixture(fake.origin)
    const bot = f.lifecycle.create(botInput())
    await until(() => f.lifecycle.get(bot.id)?.lifecycle === 'running')
    fake.setHoldFailure('The bot is finishing a step')
    const updates: string[] = []
    f.lifecycle.onEvent = (event) => {
      if (event.type === 'bot.updated') updates.push(event.bot.takeover.state)
    }
    await expect(f.lifecycle.takeover(bot.id, 'one', 'Mac')).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'The bot is finishing a step',
    })
    expect(f.lifecycle.get(bot.id)?.takeover.state).toBe('none')
    expect(updates).toContain('acquiring')
    expect(updates.at(-1)).toBe('none')
    for (const state of ['acquiring', 'human', 'releasing'] as const) {
      f.lifecycle.takeovers.set(bot.id, { state, deviceId: 'one', deviceName: 'Mac', since: null })
      await expect(f.lifecycle.resume(bot.id)).rejects.toMatchObject({ code: 'CONFLICT' })
      expect(f.lifecycle.get(bot.id)?.takeover.state).toBe(state)
    }
    f.lifecycle.takeovers.delete(bot.id)
    f.lifecycle.close()
    f.store.close()
  })
  it('retries a running container until its instance is ready and reapplies a paused hold', async () => {
    const fake = await fakeInstance()
    const f = fixture(fake.origin)
    const bot = f.lifecycle.create(botInput())
    await until(() => f.lifecycle.get(bot.id)?.lifecycle === 'running')
    await f.lifecycle.pause(bot.id)
    fake.setState({
      ...fake.state,
      ready: false,
      hold: { state: 'none', reason: null, since: null, interruptedTurn: false },
    })
    const restarted = new Lifecycle(
      f.store,
      f.docker,
      f.cfg,
      (id) => new InstanceClient(id, 'control', fake.origin),
      200
    )
    await restarted.reconcile()
    expect(restarted.get(bot.id)?.lifecycle).toBe('starting')
    const links = fake.subscriptions.length
    fake.setState({ ...fake.state, ready: true })
    await until(() => restarted.get(bot.id)?.lifecycle === 'running')
    expect(fake.holds.at(-1)).toEqual({ reason: 'paused' })
    await until(() => fake.subscriptions.length > links)
    restarted.close()
    f.lifecycle.close()
    f.store.close()
  })
  it('takes over, rejects another device, auto releases, and recovers after restart', async () => {
    const fake = await fakeInstance(),
      f = fixture(fake.origin, 30)
    const bot = f.lifecycle.create(botInput())
    await until(() => f.lifecycle.get(bot.id)?.lifecycle === 'running')
    expect((await f.lifecycle.takeover(bot.id, 'one', 'Mac')).state).toBe('human')
    await expect(f.lifecycle.takeover(bot.id, 'two', 'Other')).rejects.toMatchObject({ code: 'CONFLICT' })
    await until(() => f.lifecycle.get(bot.id)?.takeover.state === 'none')
    expect(fake.releases.at(-1)).toMatchObject({ note: null, continue: true })
    expect(f.store.activity().at(-1)?.data.reason).toBe('controller_lost')
    await f.lifecycle.takeover(bot.id, 'one', 'Mac')
    expect((await f.lifecycle.releaseTakeover(bot.id, 'one', 'Done', true)).state).toBe('none')
    fake.setState({
      ...fake.state,
      hold: { state: 'held', reason: 'takeover', since: new Date().toISOString(), interruptedTurn: false },
    })
    const next = new Lifecycle(f.store, f.docker, f.cfg, (id) => new InstanceClient(id, 'control', fake.origin), 200)
    await next.reconcile()
    expect(fake.releases.at(-1)).toMatchObject({ note: null, continue: true })
    next.close()
    f.lifecycle.close()
    f.store.close()
  })
})
describe('archived bots', () => {
  // Each bot here has an environment of its own, named after it, whose home volume holds its files.
  const home = (id: string) => 'maestrly-env-' + id + '-home'
  it('lists, restores on the same home and secrets, and reconnects only surviving peers', async () => {
    const fake = await fakeInstance(),
      f = fixture(fake.origin)
    const ads = f.lifecycle.create(botInput('Ads'))
    const scout = f.lifecycle.create(botInput('Scout'))
    const dev = f.lifecycle.create({ ...botInput('Dev'), talksTo: [ads.id, scout.id] })
    await until(() => [ads, scout, dev].every((bot) => f.lifecycle.get(bot.id)?.lifecycle === 'running'))
    const secrets = f.store.botSecrets(dev.id)
    await f.lifecycle.archive(scout.id)
    await f.lifecycle.archive(dev.id)
    // Archiving a bot uninstalls it from its environment, whose container stays.
    expect([...f.docker.containers.values()].map((item) => item.name)).toEqual([
      'maestrly-env-ads',
      'maestrly-env-scout',
      'maestrly-env-dev',
    ])
    expect(f.docker.volumes.has(home(dev.id))).toBe(true)
    expect(f.lifecycle.list().map((bot) => bot.id)).toEqual([ads.id])
    const archived = await f.lifecycle.archivedList()
    expect(archived.map((bot) => [bot.id, bot.name, bot.files])).toEqual([
      [scout.id, 'Scout', 'kept'],
      [dev.id, 'Dev', 'kept'],
    ])
    expect(Date.parse(archived[1].archivedAt)).toBeGreaterThanOrEqual(Date.parse(archived[1].createdAt))

    const restored = f.lifecycle.restore(dev.id)
    expect(restored.lifecycle).toBe('creating')
    // A second request while the first is provisioning must not race it into a container name conflict.
    expect(() => f.lifecycle.restore(dev.id)).toThrow('Archived bot not found')
    await until(() => f.lifecycle.get(dev.id)?.lifecycle === 'running')
    const container = [...f.docker.containers.values()].find((item) => item.name === 'maestrly-env-' + dev.id)!
    expect(container.spec.volume).toBe(home(dev.id))
    expect(f.store.botSecrets(dev.id)).toEqual(secrets)
    expect(container.spec.env).toContain('MAESTRLY_BOT_KEYRING_PASSWORD=' + secrets!.keyringPassword)
    // Scout stays archived: the restored bot talks to Ads again, and Ads to it, but not to Scout.
    expect(f.lifecycle.get(dev.id)?.talksTo).toEqual([ads.id])
    expect(f.lifecycle.get(ads.id)?.talksTo).toEqual([dev.id])
    expect((await f.lifecycle.archivedList()).map((bot) => bot.id)).toEqual([scout.id])
    expect(f.events).toContainEqual(
      expect.objectContaining({
        type: 'activity',
        entry: expect.objectContaining({ botId: dev.id, kind: 'bot_restored' }),
      })
    )
    expect(() => f.lifecycle.restore(ads.id)).toThrow('Archived bot not found')
    f.lifecycle.close()
    f.store.close()
  })

  it('reports an archived bot whose home volume is gone', async () => {
    const fake = await fakeInstance(),
      f = fixture(fake.origin)
    const bot = f.lifecycle.create(botInput())
    await until(() => f.lifecycle.get(bot.id)?.lifecycle === 'running')
    await f.lifecycle.archive(bot.id)
    f.docker.volumes.delete(home(bot.id))
    expect((await f.lifecycle.archivedList()).map((item) => item.files)).toEqual(['missing'])
    f.lifecycle.close()
    f.store.close()
  })

  it('deletes an archived bot forever: its volume and every record, freeing its id', async () => {
    const fake = await fakeInstance(),
      f = fixture(fake.origin)
    const bot = f.lifecycle.create(botInput('Scout'))
    const other = f.lifecycle.create(botInput('Other'))
    await until(() => [bot, other].every((item) => f.lifecycle.get(item.id)?.lifecycle === 'running'))
    const routines = new Routines(f.store, f.lifecycle)
    routines.create(bot.id, {
      title: 'Check',
      prompt: 'Check now',
      enabled: true,
      schedule: { kind: 'weekly', time: '10:01', days: [], timezone: 'UTC' },
      idempotencyKey: randomUUID(),
    })
    const at = new Date().toISOString()
    f.store.insertPeerMessage({ id: randomUUID(), at, from: bot.id, to: other.id, text: 'hi', delivered: false })
    f.store.insertPeerMessage({ id: randomUUID(), at, from: other.id, to: bot.id, text: 'hello', delivered: true })
    f.store.markOwnerMessage(bot.id)
    f.store.blockPair(bot.id, other.id, at)
    const secrets = f.store.botSecrets(bot.id)!
    await expect(f.lifecycle.purge(bot.id)).rejects.toThrow('Archived bot not found')
    await f.lifecycle.archive(bot.id)
    await f.lifecycle.purge(bot.id)
    expect(f.docker.volumes.has(home(bot.id))).toBe(false)
    expect(f.docker.volumes.has(home(other.id))).toBe(true)
    expect(f.store.getBot(bot.id)).toBeNull()
    expect(f.store.botSecrets(bot.id)).toBeNull()
    expect(f.store.routines(bot.id)).toEqual([])
    expect(f.store.peerMessages().filter((item) => item.from === bot.id || item.to === bot.id)).toEqual([])
    expect(f.store.pendingPeers()).toEqual([])
    expect(f.store.pairBlockedUntil(bot.id, other.id)).toBeNull()
    expect(f.store.activity().filter((entry) => entry.botId === bot.id)).toEqual([])
    expect(f.store.activity().at(-1)).toMatchObject({ botId: null, kind: 'bot_deleted', summary: 'Scout' })
    expect(await f.lifecycle.archivedList()).toEqual([])
    await expect(f.lifecycle.purge(bot.id)).rejects.toThrow('Archived bot not found')
    // The id is free again, and a new bot with it shares nothing with the deleted one.
    const again = f.lifecycle.create(botInput('Scout'))
    expect(again.id).toBe(bot.id)
    expect(f.store.botSecrets(again.id)?.keyringPassword).not.toBe(secrets.keyringPassword)
    await until(() => f.lifecycle.get(again.id)?.lifecycle === 'running')
    expect(f.store.routines(again.id)).toEqual([])
    f.lifecycle.close()
    f.store.close()
  })

  it('refuses to delete a home volume that a container still uses', async () => {
    const fake = await fakeInstance(),
      f = fixture(fake.origin)
    const bot = f.lifecycle.create(botInput())
    await until(() => f.lifecycle.get(bot.id)?.lifecycle === 'running')
    await expect(f.docker.volumeRemove(home(bot.id))).rejects.toMatchObject({ status: 409 })
    await f.lifecycle.archiveEnvironment(bot.environmentId!)
    await f.docker.volumeRemove(home(bot.id))
    // Removing a volume that is already gone is not an error.
    await f.docker.volumeRemove(home(bot.id))
    expect(await f.docker.volumeExists(home(bot.id))).toBe(false)
    f.lifecycle.close()
    f.store.close()
  })
})

describe('routines', () => {
  it('calculates intervals and skips missed slots after an outage', async () => {
    const fake = await fakeInstance(),
      f = fixture(fake.origin)
    const bot = f.lifecycle.create(botInput())
    await until(() => f.lifecycle.get(bot.id)?.lifecycle === 'running')
    let time = Date.parse('2026-01-05T10:00:00Z')
    const routines = new Routines(f.store, f.lifecycle, () => time)
    const schedule = { kind: 'interval' as const, everyMinutes: 30 }
    expect(nextRun(schedule, new Date(time))).toBe('2026-01-05T10:30:00.000Z')
    const routine = routines.create(bot.id, {
      title: 'Check',
      prompt: 'Check',
      schedule,
      enabled: true,
      idempotencyKey: randomUUID(),
    })
    expect(routine.nextRunAt).toBe('2026-01-05T10:30:00.000Z')
    time += 4 * 60 * 60 * 1000
    await routines.tick()
    expect(f.store.routineById(routine.id)).toMatchObject({
      lastOutcome: 'skipped_missed',
      nextRunAt: '2026-01-05T14:30:00.000Z',
    })
    expect(f.store.activity().filter((entry) => entry.kind === 'routine_skipped')).toHaveLength(1)
    f.lifecycle.close()
    f.store.close()
  })
  it('skips a queued or running previous input and logs only the first skip in a streak', async () => {
    const fake = await fakeInstance(),
      f = fixture(fake.origin)
    const bot = f.lifecycle.create(botInput())
    await until(() => f.lifecycle.get(bot.id)?.lifecycle === 'running')
    let time = Date.parse('2026-01-05T10:00:00Z')
    const routines = new Routines(f.store, f.lifecycle, () => time)
    const routine = routines.create(bot.id, {
      title: 'Check',
      prompt: 'Check',
      schedule: { kind: 'interval', everyMinutes: 15 },
      enabled: true,
      idempotencyKey: randomUUID(),
    })
    time += 15 * 60000
    await routines.tick()
    const inputId = fake.inputReceipts.at(-1)!
    expect(f.store.routineLastInputId(routine.id)).toBe(inputId)
    fake.setState({ ...fake.state, queue: [{ inputId, source: 'routine', preview: 'Check' }] })
    await until(() => f.lifecycle.statuses.get(bot.id)?.queue.some((item) => item.inputId === inputId) === true)
    for (let count = 0; count < 2; count++) {
      time += 15 * 60000
      await routines.tick()
      expect(f.store.routineById(routine.id)?.lastOutcome).toBe('skipped_busy')
    }
    expect(fake.inputs).toHaveLength(1)
    expect(f.store.activity().filter((entry) => entry.kind === 'routine_skipped')).toHaveLength(1)
    fake.setState({
      ...fake.state,
      queue: [],
      turn: { state: 'running', startedAt: new Date(time).toISOString(), inputId },
    })
    await until(() => f.lifecycle.statuses.get(bot.id)?.turn.inputId === inputId)
    time += 15 * 60000
    await routines.tick()
    expect(fake.inputs).toHaveLength(1)
    fake.setState({ ...fake.state, turn: { state: 'idle', startedAt: null, inputId: null } })
    await until(() => f.lifecycle.statuses.get(bot.id)?.turn.inputId === null)
    time += 15 * 60000
    await routines.tick()
    expect(fake.inputs).toHaveLength(2)
    const secondInputId = fake.inputReceipts.at(-1)!
    fake.setState({ ...fake.state, queue: [{ inputId: secondInputId, source: 'routine', preview: 'Check' }] })
    await until(() => f.lifecycle.statuses.get(bot.id)?.queue.some((item) => item.inputId === secondInputId) === true)
    await routines.run(bot.id, routine.id)
    expect(fake.inputs).toHaveLength(3)
    f.lifecycle.close()
    f.store.close()
  })
  it('neither fires nor records an archived bot routine, and restarts its schedule from the restore', async () => {
    const fake = await fakeInstance(),
      f = fixture(fake.origin)
    const bot = f.lifecycle.create(botInput())
    await until(() => f.lifecycle.get(bot.id)?.lifecycle === 'running')
    let time = Date.parse('2026-01-05T10:00:00Z')
    const routines = new Routines(f.store, f.lifecycle, () => time)
    const routine = routines.create(bot.id, {
      title: 'Check',
      prompt: 'Check now',
      enabled: true,
      schedule: { kind: 'weekly', time: '10:01', days: [], timezone: 'UTC' },
      idempotencyKey: randomUUID(),
    })
    await f.lifecycle.archive(bot.id)
    const activityBefore = f.store.activity().length
    time = Date.parse('2026-01-26T12:00:00Z')
    await routines.tick()
    expect(f.store.routineById(routine.id)).toMatchObject({ lastRunAt: null, lastOutcome: null })
    expect(f.store.activity()).toHaveLength(activityBefore)
    f.lifecycle.restore(bot.id)
    routines.reschedule(bot.id)
    expect(f.store.routineById(routine.id)?.nextRunAt).toBe('2026-01-27T10:01:00.000Z')
    await routines.tick()
    expect(f.store.routineById(routine.id)?.lastOutcome).toBeNull()
    await until(() => f.lifecycle.get(bot.id)?.lifecycle === 'running')
    f.lifecycle.close()
    f.store.close()
  })

  it('chooses first overlap, first instant after gap, and filtered weekdays', () => {
    const s = (timezone: string, time: string, days: number[] = []) => ({
      kind: 'weekly' as const,
      timezone,
      time,
      days,
    })
    expect(nextWeeklyRun(s('America/New_York', '02:30', [7]), new Date('2026-03-08T00:00:00Z'))).toBe(
      '2026-03-08T07:00:00.000Z'
    )
    expect(nextWeeklyRun(s('America/New_York', '01:30', [7]), new Date('2026-11-01T00:00:00Z'))).toBe(
      '2026-11-01T05:30:00.000Z'
    )
    expect(nextWeeklyRun(s('Europe/Lisbon', '01:30', [7]), new Date('2026-03-29T00:00:00Z'))).toBe(
      '2026-03-29T01:00:00.000Z'
    )
    expect(nextWeeklyRun(s('America/Sao_Paulo', '09:00', [1]), new Date('2026-01-02T12:00:00Z'))).toBe(
      '2026-01-05T12:00:00.000Z'
    )
  })
  it('records sent, paused, offline, and missed outcomes using a fake clock', async () => {
    const fake = await fakeInstance(),
      f = fixture(fake.origin)
    const bot = f.lifecycle.create(botInput())
    await until(() => f.lifecycle.get(bot.id)?.lifecycle === 'running')
    let time = Date.parse('2026-01-05T10:00:00Z')
    const routines = new Routines(f.store, f.lifecycle, () => time)
    const routine = routines.create(bot.id, {
      title: 'Check',
      prompt: 'Check now',
      enabled: true,
      schedule: { kind: 'weekly', time: '10:01', days: [], timezone: 'UTC' },
      idempotencyKey: randomUUID(),
    })
    time = Date.parse(routine.nextRunAt!)
    await routines.tick()
    expect(f.store.routineById(routine.id)?.lastOutcome).toBe('sent')
    expect(fake.inputs.at(-1)).toMatchObject({ source: 'routine', text: 'Check now' })
    time = Date.parse(f.store.routineById(routine.id)!.nextRunAt!)
    await f.lifecycle.pause(bot.id)
    await routines.tick()
    expect(f.store.routineById(routine.id)?.lastOutcome).toBe('skipped_paused')
    await f.lifecycle.resume(bot.id)
    await f.lifecycle.stop(bot.id)
    time = Date.parse(f.store.routineById(routine.id)!.nextRunAt!)
    await routines.tick()
    expect(f.store.routineById(routine.id)?.lastOutcome).toBe('skipped_offline')
    await f.lifecycle.start(bot.id)
    time = Date.parse(f.store.routineById(routine.id)!.nextRunAt!) + 16 * 60000
    await routines.tick()
    expect(f.store.routineById(routine.id)?.lastOutcome).toBe('skipped_missed')
    f.lifecycle.close()
    f.store.close()
  })
})
