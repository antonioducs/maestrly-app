import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { FLEET_PROTOCOL_HEADER } from '@maestrly/bot-fleet-protocol'
import { Auth } from '../src/auth.js'
import { loadConfig } from '../src/config.js'
import { DockerEngineDriver, FakeDockerDriver, parseDockerStats } from '../src/docker.js'
import { EventHub } from '../src/events.js'
import { cpuPercent, parseMeminfo, parseProcStat } from '../src/host.js'
import { InstanceClient } from '../src/instance.js'
import { Lifecycle } from '../src/lifecycle.js'
import { run } from '../src/main.js'
import { createGatewayServers } from '../src/server.js'
import { Store } from '../src/store.js'

const dirs: string[] = []
const servers: http.Server[] = []
function temp() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'gateway-test-'))
  dirs.push(dir)
  return dir
}
function config(dir = temp()) {
  return loadConfig({
    MAESTRLY_GATEWAY_DATA_DIR: dir,
    MAESTRLY_GATEWAY_PUBLIC_PORT: '7443',
    MAESTRLY_GATEWAY_INTERNAL_PORT: '7444',
  })
}
async function listen(server: http.Server) {
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return Number((server.address() as { port: number }).port)
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const status = (id = 'test') => ({
  appVersion: '0.1.0',
  protocol: 1,
  ready: true,
  accounts: { connected: true, providers: [] },
  selection: null,
  ceiling: 'ask',
  profile: { botId: id, name: 'Test' },
  conversationId: null,
  turn: { state: 'idle', startedAt: null },
  hold: { state: 'none', reason: null, since: null, interruptedTurn: false },
  queue: [],
  activity: null,
  pending: [],
  lastEventSeq: 0,
})
async function instanceServer() {
  const calls: string[] = []
  const server = http.createServer((req, res) => {
    if (req.headers[FLEET_PROTOCOL_HEADER.toLowerCase()] !== '1' || req.headers.authorization !== 'Bearer control') {
      res.writeHead(401)
      res.end(JSON.stringify({ code: 'UNAUTHORIZED', message: 'Unauthorized' }))
      return
    }
    calls.push(req.method + ' ' + req.url)
    res.setHeader('content-type', 'application/json')
    if (req.url === '/v1/health') res.end(JSON.stringify({ ok: true, appVersion: '0.1.0', protocol: 1, ready: true }))
    else if (req.url === '/v1/status') res.end(JSON.stringify(status()))
    else if (req.url === '/v1/profile') res.end(JSON.stringify(status()))
    else if (req.url === '/v1/hold' || req.url === '/v1/hold/release')
      res.end(JSON.stringify({ state: 'none', reason: null, since: null, interruptedTurn: false }))
    else if (req.url === '/v1/inputs') res.end(JSON.stringify({ inputId: 'input-1', itemId: 'item-1', queued: false }))
    else {
      res.writeHead(204)
      res.end()
    }
  })
  const port = await listen(server)
  return { calls, origin: 'http://127.0.0.1:' + port }
}
function fixture(dir = temp(), origin?: string) {
  const cfg = config(dir),
    store = new Store(dir),
    docker = new FakeDockerDriver()
  docker.images.add(cfg.botImage)
  const lifecycle = new Lifecycle(store, docker, cfg, (id) => new InstanceClient(id, 'control', origin), 200)
  return { cfg, store, docker, lifecycle }
}
const input = () => ({
  name: 'Test',
  instructions: 'Work',
  ceiling: 'ask' as const,
  talksTo: [],
  idempotencyKey: randomUUID(),
})
async function until(fn: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (fn()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Timed out')
}
describe('config and storage', () => {
  it('parses defaults, byte limits, security options and rejects invalid config', () => {
    const cfg = loadConfig({
      MAESTRLY_GATEWAY_DATA_DIR: temp(),
      MAESTRLY_GATEWAY_BOT_MEMORY: '512m',
      MAESTRLY_GATEWAY_BOT_SECURITY_OPT: '["no-new-privileges"]',
    })
    expect(cfg.botMemory).toBe(512 * 1024 * 1024)
    expect(cfg.botSecurityOpt).toEqual(['no-new-privileges'])
    expect(() => loadConfig({ MAESTRLY_GATEWAY_DATA_DIR: temp(), MAESTRLY_GATEWAY_BOT_SECURITY_OPT: '{}' })).toThrow()
  })
  it('migrates empty database and reopens it', () => {
    const dir = temp(),
      store = new Store(dir)
    expect(store.db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()).toEqual({ value: '1' })
    store.close()
    const reopened = new Store(dir)
    expect(reopened.listDevices()).toEqual([])
    reopened.close()
  })
  it('runs CLI pair and devices list on a shared data dir', async () => {
    const dir = temp(),
      env = { MAESTRLY_GATEWAY_DATA_DIR: dir },
      lines: string[] = []
    expect(await run(['--version'], (line) => lines.push(line), env)).toBe(0)
    expect(await run(['pair'], (line) => lines.push(line), env)).toBe(0)
    expect(lines[1]).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}/)
    expect(await run(['devices', 'list'], (line) => lines.push(line), env)).toBe(0)
  })
})
describe('auth', () => {
  it('pairs once, rejects wrong/expired/reused codes, rate limits and revokes', () => {
    const store = new Store(temp()),
      auth = new Auth(store)
    const pair = auth.createPairing()
    expect(() => auth.pair('0000-0000', 'Mac', 'a')).toThrow()
    const result = auth.pair(pair.code, 'Mac', 'a')
    expect(auth.device('Bearer ' + result.token).id).toBe(result.deviceId)
    expect(() => auth.pair(pair.code, 'Mac', 'a')).toThrow()
    for (let i = 0; i < 4; i++) expect(() => auth.pair(pair.code, 'Mac', 'code-' + i)).toThrow()
    expect(() => auth.pair(pair.code, 'Mac', 'code-limit')).toThrow('Pairing code attempt limit reached')
    store.revokeDevice(result.deviceId)
    expect(() => auth.device('Bearer ' + result.token)).toThrow()
    const expired = auth.createPairing()
    store.db.prepare('UPDATE pairing_codes SET expires_at=? WHERE used_at IS NULL').run('2000-01-01T00:00:00.000Z')
    expect(() => auth.pair(expired.code, 'Mac', 'b')).toThrow()
    for (let i = 0; i < 5; i++)
      try {
        auth.pair('11111111', 'Mac', 'c')
      } catch {}
    expect(() => auth.pair('11111111', 'Mac', 'c')).toThrow('Too many pairing attempts')
    store.close()
  })
})
describe('lifecycle', () => {
  it('creates through profile, persists transitions and reconciles', async () => {
    const instance = await instanceServer(),
      { store, docker, lifecycle, cfg } = fixture(temp(), instance.origin)
    const bot = lifecycle.create(input())
    expect(bot.lifecycle).toBe('creating')
    await until(() => lifecycle.get(bot.id)?.lifecycle === 'running')
    expect(instance.calls).toContain('PUT /v1/profile')
    const second = lifecycle.create({ ...input(), name: 'Second' })
    await until(() => lifecycle.get(second.id)?.lifecycle === 'running')
    await lifecycle.patch(bot.id, { talksTo: [second.id] })
    expect(lifecycle.get(second.id)?.talksTo).toContain(bot.id)
    await lifecycle.patch(bot.id, { talksTo: [] })
    expect(lifecycle.get(second.id)?.talksTo).toEqual([])
    expect(docker.containers.get('fake-maestrly-bot-test')?.spec.env).toContain('MAESTRLY_BOT_MODE=1')
    expect((await lifecycle.stop(bot.id)).lifecycle).toBe('stopped')
    expect((await lifecycle.start(bot.id)).lifecycle).toBe('running')
    expect((await lifecycle.restart(bot.id)).lifecycle).toBe('running')
    expect((await lifecycle.pause(bot.id)).paused).toBe(true)
    expect((await lifecycle.resume(bot.id)).paused).toBe(false)
    const next = new Lifecycle(store, docker, cfg, (id) => new InstanceClient(id, 'control', instance.origin), 200)
    await next.reconcile()
    expect(next.get(bot.id)?.lifecycle).toBe('running')
    expect((await next.archive(bot.id)).lifecycle).toBe('archived')
    expect(next.list().map((item) => item.id)).toEqual([second.id])
    expect(store.activity().map((item) => item.kind)).toContain('bot_archived')
    store.close()
  })
  it('marks missing image as failed', async () => {
    const { store, docker, lifecycle, cfg } = fixture()
    docker.images.delete(cfg.botImage)
    const bot = lifecycle.create(input())
    await until(() => lifecycle.get(bot.id)?.lifecycle === 'failed')
    expect(lifecycle.get(bot.id)?.setup.error).toBe('IMAGE_MISSING')
    store.close()
  })
})
describe('Docker and host parsers', () => {
  it('enforces fake Docker naming, conflicts and missing images', async () => {
    const docker = new FakeDockerDriver()
    const spec = {
      name: 'bad!',
      image: 'missing',
      hostname: 'bad',
      labels: {},
      env: [],
      network: 'fleet',
      volume: 'home',
      memory: 1,
      shmSize: 1,
      securityOpt: [],
    }
    await expect(docker.containerCreate(spec)).rejects.toMatchObject({ status: 400 })
    spec.name = 'valid-name'
    const id = await docker.containerCreate(spec)
    await expect(docker.containerCreate(spec)).rejects.toMatchObject({ status: 409 })
    await expect(docker.start(id)).rejects.toMatchObject({ status: 404 })
    await docker.stop(id)
    await expect(docker.inspect('unknown')).rejects.toMatchObject({ status: 404 })
  })
  it('parses Docker stats and proc fixtures', () => {
    expect(
      parseDockerStats({
        cpu_stats: { cpu_usage: { total_usage: 200 }, system_cpu_usage: 1000, online_cpus: 2 },
        precpu_stats: { cpu_usage: { total_usage: 100 }, system_cpu_usage: 500 },
        memory_stats: { usage: 1000, limit: 2000, stats: { inactive_file: 200 } },
      })
    ).toEqual({ memoryBytes: 800, memoryLimitBytes: 2000, cpuPercent: 40 })
    expect(parseMeminfo('MemTotal: 1000 kB\nMemAvailable: 250 kB\n')).toEqual({
      totalBytes: 1024000,
      usedBytes: 768000,
    })
    expect(cpuPercent(parseProcStat('cpu  100 0 0 100 0\n'), parseProcStat('cpu  200 0 0 100 0\n'))).toBe(100)
  })
  it('calls Docker Engine through a unix socket', async () => {
    const dir = temp(),
      socket = path.join(dir, 'docker.sock'),
      calls: string[] = []
    const server = http.createServer((req, res) => {
      calls.push(req.method + ' ' + req.url)
      res.setHeader('Content-Type', 'application/json')
      if (req.url === '/version') res.end(JSON.stringify({ ApiVersion: '1.45', Version: '28.0' }))
      else if (req.url?.includes('/images/missing/json')) {
        res.writeHead(404)
        res.end(JSON.stringify({ message: 'No such image' }))
      } else if (req.url?.includes('/networks?')) res.end('[]')
      else if (req.url?.includes('/networks/create')) res.end('{}')
      else if (req.url?.includes('/containers/create')) res.end(JSON.stringify({ Id: 'abc' }))
      else if (req.url?.includes('/stats?')) res.end('{}')
      else if (req.url?.includes('/containers/json')) res.end('[]')
      else if (req.url?.endsWith('/containers/abc/json'))
        res.end(
          JSON.stringify({
            Id: 'abc',
            Name: '/bot',
            State: { Running: true, StartedAt: new Date().toISOString() },
            Config: { Labels: {} },
          })
        )
      else res.end('{}')
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(socket, resolve))
    const docker = new DockerEngineDriver(socket)
    expect(await docker.version()).toBe('28.0')
    await docker.ensureNetwork('fleet')
    expect(await docker.imageInspect('missing')).toBeNull()
    await docker.volumeCreate('home', {})
    expect(
      await docker.containerCreate({
        name: 'bot',
        image: 'image',
        hostname: 'bot',
        labels: {},
        env: [],
        network: 'fleet',
        volume: 'home',
        memory: 1,
        shmSize: 1,
        securityOpt: [],
      })
    ).toBe('abc')
    await docker.start('abc')
    await docker.stop('abc')
    await docker.restart('abc')
    expect((await docker.inspect('abc')).state).toBe('running')
    expect(await docker.list()).toEqual([])
    expect((await docker.statsOnce('abc')).memoryBytes).toBe(0)
    await docker.remove('abc', true)
    expect(calls.some((call) => call.includes('/v1.45/containers/create'))).toBe(true)
  })
})

describe('HTTP gateway', () => {
  it('enforces protocol, Origin and auth; idempotently creates and streams events', async () => {
    const instance = await instanceServer(),
      base = fixture(temp(), instance.origin)
    const cfg = { ...base.cfg, publicPort: 0, internalPort: 0 }
    const auth = new Auth(base.store),
      host = new (await import('../src/host.js')).HostMonitor(cfg, base.docker)
    const events = new EventHub(async () => {})
    base.lifecycle.onEvent = (event) => events.emit(event)
    const gateway = createGatewayServers({
      auth,
      config: cfg,
      events,
      host,
      lifecycle: base.lifecycle,
      store: base.store,
    })
    await gateway.listen()
    const origin = 'http://127.0.0.1:' + (gateway.publicServer.address() as { port: number }).port
    const pair = auth.createPairing()
    const paired = await fetch(origin + '/v1/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: pair.code.replace('-', ''), deviceName: 'Mac' }),
    })
    const { token } = (await paired.json()) as { token: string }
    const headers = {
      Authorization: 'Bearer ' + token,
      [FLEET_PROTOCOL_HEADER]: '1',
      'Content-Type': 'application/json',
    }
    expect((await fetch(origin + '/v1/meta')).status).toBe(200)
    expect((await fetch(origin + '/v1/bots', { headers: { Authorization: 'Bearer ' + token } })).status).toBe(426)
    expect((await fetch(origin + '/v1/bots', { headers: { [FLEET_PROTOCOL_HEADER]: '1' } })).status).toBe(401)
    expect((await fetch(origin + '/v1/bots', { headers: { ...headers, Origin: 'http://evil' } })).status).toBe(403)
    const stream = await fetch(origin + '/v1/events', { headers })
    const reader = stream.body!.getReader()
    const hello = new TextDecoder().decode((await reader.read()).value)
    expect(hello).toContain('"type":"hello"')
    const create = input()
    const first = await fetch(origin + '/v1/bots', { method: 'POST', headers, body: JSON.stringify(create) })
    expect(first.status).toBe(201)
    const bot = (await first.json()) as { id: string }
    const replay = await fetch(origin + '/v1/bots', { method: 'POST', headers, body: JSON.stringify(create) })
    expect(((await replay.json()) as { id: string }).id).toBe(bot.id)
    expect(base.store.listBots()).toHaveLength(1)
    let found = false
    for (let i = 0; i < 10; i++) {
      const chunk = new TextDecoder().decode((await reader.read()).value)
      if (chunk.includes('bot.updated')) {
        found = true
        break
      }
    }
    expect(found).toBe(true)
    await until(() => base.lifecycle.get(bot.id)?.lifecycle === 'running')
    const message = { text: 'Hello', idempotencyKey: randomUUID() }
    const requests = await Promise.all(
      [1, 2].map(() =>
        fetch(origin + '/v1/bots/' + bot.id + '/messages', {
          method: 'POST',
          headers,
          body: JSON.stringify(message),
        })
      )
    )
    expect(requests.map((response) => response.status)).toEqual([201, 201])
    expect(instance.calls.filter((call) => call === 'POST /v1/inputs')).toHaveLength(1)
    await reader.cancel()
    await gateway.close()
    base.store.close()
  })
})

describe('instance event client', () => {
  it('validates headers and parses CRLF SSE frames with ids and comments', async () => {
    const server = http.createServer((req, res) => {
      expect(req.headers[FLEET_PROTOCOL_HEADER.toLowerCase()]).toBe('1')
      expect(req.headers.authorization).toBe('Bearer control')
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(
        ': ping\r\n\r\nid: 1\r\ndata: ' +
          JSON.stringify({ seq: 1, at: new Date().toISOString(), type: 'status', status: status() }) +
          '\r\n\r\n'
      )
    })
    const port = await listen(server)
    const client = new InstanceClient('test', 'control', 'http://127.0.0.1:' + port)
    const events = []
    for await (const event of client.events(0)) events.push(event)
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('status')
  })
})
