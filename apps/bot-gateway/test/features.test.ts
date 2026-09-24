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
import { Routines, nextWeeklyRun } from '../src/routines.js'
import { Store } from '../src/store.js'

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
  const holds: unknown[] = []
  let holdFailure: string | null = null
  const releases: unknown[] = []
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
        fleetInstanceProfileSchema.parse(body)
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
        return res.end(JSON.stringify({ inputId: randomUUID(), itemId: randomUUID(), queued: false }))
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
    inputs,
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
      "CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); INSERT INTO meta VALUES('schema_version','1'); CREATE TABLE bot_secrets(bot_id TEXT PRIMARY KEY,control_token TEXT NOT NULL,gateway_token TEXT NOT NULL,gateway_token_sha256 TEXT NOT NULL UNIQUE); INSERT INTO bot_secrets VALUES('test','control','gateway','hash')"
    )
    db.close()
    const store = new Store(dir),
      password = store.botSecrets('test')?.keyringPassword
    expect(password).toMatch(/^[A-Za-z0-9_-]{43}$/)
    store.close()
    const reopened = new Store(dir)
    expect(reopened.botSecrets('test')?.keyringPassword).toBe(password)
    reopened.close()
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
  it('derives status, inbox, activity, forwards transcript, and handles regression', async () => {
    const fake = await fakeInstance(),
      f = fixture(fake.origin)
    const bot = f.lifecycle.create(botInput())
    expect(bot.accounts).toEqual({ connected: false, providers: [] })
    await until(() => f.lifecycle.get(bot.id)?.lifecycle === 'running')
    await until(() => fake.state.lastEventSeq === 0)
    fake.setState({ ...fake.state, accounts: { connected: true, providers: [{ id: 'prov_test', label: 'Test' }] } })
    await until(() => f.lifecycle.get(bot.id)?.accounts.providers[0]?.id === 'prov_test')
    expect(f.lifecycle.get(bot.id)?.accounts).toEqual({
      connected: true,
      providers: [{ id: 'prov_test', label: 'Test' }],
    })
    const pending = {
      kind: 'permission' as const,
      id: 'p1',
      at: new Date().toISOString(),
      title: 'Open browser',
      detail: null,
      itemId: 'perm:p1',
    }
    fake.setState({ ...fake.state, pending: [pending], activity: { kind: 'permission', title: pending.title } })
    await until(() => f.lifecycle.get(bot.id)?.status === 'waiting')
    expect(f.lifecycle.inbox()).toHaveLength(1)
    fake.setState({ ...fake.state })
    await until(() => f.events.filter((event: any) => event.type === 'bot.updated').length >= 2)
    expect(f.store.activity().filter((entry) => entry.kind === 'needs_you')).toHaveLength(1)
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
describe('routines', () => {
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
