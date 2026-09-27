import { afterEach, describe, expect, it, vi } from 'vitest'
import { once } from 'node:events'
import { randomBytes, randomUUID } from 'node:crypto'
import http from 'node:http'
import net, { type AddressInfo } from 'node:net'
import {
  FLEET_PROTOCOL_HEADER,
  fleetInstanceStatusSchema,
  type FleetAccountImportRequest,
  type FleetAddApiKeyAccountRequest,
  type FleetBotMemoryPatchRequest,
  type FleetConversationCallRequest,
  type FleetInstanceBotInstall,
  type FleetInstanceEvent,
  type FleetInstanceHold,
  type FleetInstanceInput,
  type FleetInstanceReleaseRequest,
  type FleetInstanceStatus,
  type FleetInteractionResolution,
  type FleetLoginCallbackRequest,
  type FleetLoginStartRequest,
  type FleetMcpImportRequest,
  type FleetSkillInstallRequest,
  type FleetSubscriptionKind,
  type FleetUiOpenRequest,
} from '@maestrly/bot-fleet-protocol'
import {
  createInstanceControlServer,
  INSTANCE_CAPABILITIES,
  InstanceEvents,
  InstanceHttpError,
  type InstanceBot,
  type InstanceEnvironment,
} from '../../src/main/fleet/instance/server'
import type { DisplaySurface, VncMode } from '../../src/main/fleet/instance/displays'
import { parseBotInstanceConfig } from '../../src/main/fleet/instance/config'

const baseStatus: FleetInstanceStatus = fleetInstanceStatusSchema.parse({
  appVersion: '1.0.0',
  protocol: 1,
  ready: true,
  accounts: { connected: false, providers: [] },
  selection: null,
  ceiling: 'ask',
  profile: null,
  conversationId: null,
  turn: { state: 'idle', startedAt: null },
  hold: { state: 'none', reason: null, since: null, interruptedTurn: false },
  queue: [],
  activity: { kind: 'setup' },
  pending: [],
  lastEventSeq: 0,
})
const token = randomBytes(32).toString('base64url')
const config = parseBotInstanceConfig({
  MAESTRLY_BOT_MODE: '1',
  MAESTRLY_BOT_CONTROL_TOKEN: token,
  MAESTRLY_BOT_CONTROL_HOST: '127.0.0.1',
  MAESTRLY_BOT_CONTROL_PORT: '0',
})!
const botMemory = {
  id: 'm1',
  title: 'Portal',
  content: 'Open the portal',
  truncated: false,
  type: 'procedure' as const,
  status: 'active' as const,
  pinned: false,
  source: 'auto' as const,
  useCount: 0,
  createdAt: '2026-09-20T10:00:00.000Z',
  updatedAt: '2026-09-20T10:00:00.000Z',
}
const loginAttempt = {
  loginId: 'login-1',
  kind: 'codex' as const,
  method: 'device' as const,
  accountId: null,
  state: 'pending' as const,
  expiresAt: '2026-09-25T20:00:00.000Z',
  browser: null,
  device: { verificationUrl: 'https://auth.openai.com/device', userCode: 'SYNTHETIC' },
  manual: null,
  account: null,
  error: null,
}
const CAPABILITIES = ['provisioning', 'environments']
const NO_HOLD: FleetInstanceHold = { state: 'none', reason: null, since: null, interruptedTurn: false }
const takeover = (): FleetInstanceHold => ({
  state: 'held',
  reason: 'takeover',
  since: new Date().toISOString(),
  interruptedTurn: false,
})
const profileOf = (botId: string) => ({
  botId,
  name: `Bot ${botId}`,
  instructions: '',
  ceiling: 'ask' as const,
  selection: null,
  compaction: null,
  gateway: { peersEnabled: true },
})

function fakeBot(botId: string, slot: number) {
  const state = { hold: NO_HOLD }
  const statusOf = (): FleetInstanceStatus => ({
    ...baseStatus,
    profile: { botId, name: `Bot ${botId}` },
    conversationId: `conv-${botId}`,
    hold: state.hold,
  })
  return {
    botId,
    slot,
    state,
    holdManager: {
      get state(): FleetInstanceHold {
        return state.hold
      },
    },
    status: vi.fn(async () => statusOf()),
    selections: vi.fn(async () => ({ options: [], current: null })),
    memories: vi.fn(async (_status: 'active' | 'archived' | 'superseded' | 'all') => ({
      memories: [{ ...botMemory, title: botId }],
    })),
    patchMemory: vi.fn(async (_id: string, _patch: FleetBotMemoryPatchRequest) => ({ ...botMemory, pinned: true })),
    deleteMemory: vi.fn(async (_id: string) => {}),
    transcript: vi.fn(async (_before: string | null, _limit: number) => ({ items: [], before: null })),
    image: vi.fn(async (_imageId: string) => ({ mediaType: 'image/png', bytes: new Uint8Array([137, 80, 78, 71]) })),
    input: vi.fn(async (_value: FleetInstanceInput) => ({
      inputId: `input-${botId}`,
      itemId: `input:${botId}`,
      queued: true,
    })),
    deleteInput: vi.fn(async (_id: string) => {}),
    cancel: vi.fn(async () => {}),
    resolve: vi.fn(async (_id: string, _value: FleetInteractionResolution) => {}),
    hold: vi.fn(async (reason: 'takeover' | 'paused') => {
      state.hold = reason === 'takeover' ? takeover() : { ...takeover(), reason: 'paused' }
      return state.hold
    }),
    release: vi.fn(async (_value: FleetInstanceReleaseRequest) => {
      state.hold = NO_HOLD
      return state.hold
    }),
    conversationCall: vi.fn(async (_value: FleetConversationCallRequest) => ({ result: { bot: botId } })),
  }
}
type FakeBot = ReturnType<typeof fakeBot>

function fakeEnvironment() {
  const events = new InstanceEvents()
  const bots = new Map<string, FakeBot>([
    ['alpha', fakeBot('alpha', 1)],
    ['beta', fakeBot('beta', 2)],
  ])
  const screen = { port: 0, delayMs: 0, fail: false }
  const leases: Array<{ surface: DisplaySurface; mode: VncMode; release: ReturnType<typeof vi.fn> }> = []
  const environment = {
    events,
    health: vi.fn(() => ({
      ok: true as const,
      appVersion: '1.0.0',
      protocol: 1 as const,
      ready: true,
      capabilities: CAPABILITIES,
    })),
    environmentStatus: vi.fn(async () => ({
      environmentId: 'env-one',
      capabilities: CAPABILITIES,
      appVersion: '1.0.0',
      protocol: 1 as const,
      ready: true,
      bots: await Promise.all(
        [...bots.values()].map(async (bot) => ({ botId: bot.botId, slot: bot.slot, status: await bot.status() }))
      ),
    })),
    selections: vi.fn(async () => ({
      options: [
        {
          id: 'prov_test::model-a',
          providerId: 'prov_test',
          providerLabel: 'Synthetic account',
          modelId: 'model-a',
          modelLabel: 'Model A',
          efforts: ['low', 'high'],
          fastMode: false,
        },
      ],
      current: null,
    })),
    bot: vi.fn((botId: string): FakeBot => {
      const bot = bots.get(botId)
      if (!bot) throw new InstanceHttpError(404, 'NOT_FOUND', 'Bot does not exist.')
      return bot
    }),
    installBot: vi.fn(async (value: FleetInstanceBotInstall) => {
      const bot = bots.get(value.profile.botId) ?? fakeBot(value.profile.botId, value.slot)
      bot.slot = value.slot
      bots.set(bot.botId, bot)
      return bot.status()
    }),
    uninstallBot: vi.fn(async (botId: string, _options: { purge: boolean }) => {
      bots.delete(botId)
    }),
    acquireScreen: vi.fn(async (surface: DisplaySurface, mode: VncMode) => {
      if (screen.delayMs) await new Promise((resolve) => setTimeout(resolve, screen.delayMs))
      if (screen.fail) throw new Error('The apps display of bot alpha is not running.')
      const release = vi.fn()
      leases.push({ surface, mode, release })
      return { port: screen.port, release }
    }),
    startLogin: vi.fn(async (_request: FleetLoginStartRequest) => loginAttempt),
    login: vi.fn((_loginId: string) => loginAttempt),
    loginCallback: vi.fn(async (_loginId: string, _request: FleetLoginCallbackRequest) => ({
      status: 200,
      location: null,
      contentType: null,
      body: '',
    })),
    submitLoginCode: vi.fn(async (_loginId: string, _code: string) => loginAttempt),
    cancelLogin: vi.fn(async (_loginId: string) => {}),
    accounts: vi.fn(() => ({ apiKeys: [], subscriptions: [] })),
    importAccounts: vi.fn(async (_request: FleetAccountImportRequest) => ({ results: [] })),
    removeSubscription: vi.fn(async (_kind: FleetSubscriptionKind, _slot: string) => {}),
    skills: vi.fn(async () => ({ skills: [] })),
    installSkill: vi.fn(async (_request: FleetSkillInstallRequest) => ({ name: 'sample', outcome: 'added' as const })),
    removeSkill: vi.fn(async (_name: string) => {}),
    mcpServers: vi.fn(() => ({ servers: [] })),
    importMcpServers: vi.fn(async (_request: FleetMcpImportRequest) => ({ results: [] })),
    removeMcpServer: vi.fn(async (_id: string) => {}),
    addApiKeyAccount: vi.fn(async (_value: FleetAddApiKeyAccountRequest) => ({ providerId: 'prov_test' })),
    removeAccount: vi.fn(async (_providerId: string) => {}),
    open: vi.fn(async (_target: FleetUiOpenRequest['target']) => {}),
  }
  const typed: InstanceEnvironment = environment
  const bot: InstanceBot = bots.get('alpha')!
  void typed
  void bot
  return { environment, bots, screen, leases, events }
}
type Fake = ReturnType<typeof fakeEnvironment>

const servers: http.Server[] = []
const vncServers: net.Server[] = []
const clients = new Set<net.Socket>()
afterEach(async () => {
  for (const socket of clients) socket.destroy()
  clients.clear()
  await Promise.all(
    servers.splice(0).map(async (server) => {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    })
  )
  await Promise.all(vncServers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  vi.restoreAllMocks()
})
async function setup(fake: Fake = fakeEnvironment()) {
  const server = createInstanceControlServer(config, fake.environment)
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = (server.address() as AddressInfo).port
  return { ...fake, server, port, base: `http://127.0.0.1:${port}` }
}
function headers(extra: Record<string, string> = {}): Record<string, string> {
  return { [FLEET_PROTOCOL_HEADER]: '1', Authorization: 'Bearer ' + token, ...extra }
}
function send(base: string, method: string, route: string, body?: unknown, extra: Record<string, string> = {}) {
  return fetch(base + route, {
    method,
    headers: headers(body === undefined ? extra : { 'content-type': 'application/json', ...extra }),
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}
/** A VNC server stand-in that echoes what it receives. */
async function echoVnc() {
  const connections = new Set<net.Socket>()
  const stats = { accepted: 0 }
  const server = net.createServer((socket) => {
    stats.accepted++
    connections.add(socket)
    socket.on('close', () => connections.delete(socket))
    socket.on('error', () => {})
    socket.on('data', (data) => socket.write(data))
  })
  vncServers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return { port: (server.address() as AddressInfo).port, connections, stats }
}
async function unusedPort(): Promise<number> {
  const server = net.createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = (server.address() as AddressInfo).port
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}
function upgrade(port: number, path: string, extra: Record<string, string> = {}) {
  return new Promise<{ status: number; socket?: net.Socket; body?: string }>((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port,
      path,
      headers: { ...headers(), Connection: 'Upgrade', Upgrade: 'maestrly-rfb', ...extra },
    })
    request.on('upgrade', (response, socket) => {
      clients.add(socket)
      socket.on('error', () => {})
      resolve({ status: response.statusCode ?? 0, socket })
    })
    request.on('response', (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk: string) => {
        body += chunk
      })
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body }))
    })
    request.on('error', reject)
    request.end()
  })
}
async function echoes(socket: net.Socket, bytes: number[]): Promise<void> {
  const received = once(socket, 'data')
  socket.write(Buffer.from(bytes))
  expect((await received)[0]).toEqual(Buffer.from(bytes))
}
async function readFrames(response: Response, count: number): Promise<FleetInstanceEvent[]> {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let text = ''
  const frames = () => text.split('\n\n').filter((frame) => frame.includes('data: '))
  while (frames().length < count) {
    const chunk = await reader.read()
    if (chunk.done) break
    text += decoder.decode(chunk.value)
  }
  return frames().map((frame) => JSON.parse(frame.slice(frame.indexOf('data: ') + 6)) as FleetInstanceEvent)
}
const ownerInput = (text = 'Hi') => ({ idempotencyKey: randomUUID(), source: 'owner', text })

describe('instance control HTTP', () => {
  it('serves the environment health and status with the environments capability', async () => {
    const { base } = await setup()
    const health = await send(base, 'GET', '/v1/health')
    expect(health.status).toBe(200)
    expect(await health.json()).toEqual({
      ok: true,
      appVersion: '1.0.0',
      protocol: 1,
      ready: true,
      capabilities: CAPABILITIES,
    })
    const status = await send(base, 'GET', '/v1/environment/status')
    expect(status.status).toBe(200)
    expect(await status.json()).toMatchObject({
      environmentId: 'env-one',
      capabilities: CAPABILITIES,
      bots: [
        { botId: 'alpha', slot: 1, status: { profile: { botId: 'alpha' } } },
        { botId: 'beta', slot: 2, status: { profile: { botId: 'beta' } } },
      ],
    })
  })

  it("lists the environment's models for its default compaction model", async () => {
    expect(INSTANCE_CAPABILITIES).toEqual(['provisioning', 'environments', 'environment-compaction'])
    const { base, environment } = await setup()
    const response = await send(base, 'GET', '/v1/environment/selections')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      options: [
        {
          id: 'prov_test::model-a',
          providerId: 'prov_test',
          providerLabel: 'Synthetic account',
          modelId: 'model-a',
          modelLabel: 'Model A',
          efforts: ['low', 'high'],
          fastMode: false,
        },
      ],
      current: null,
    })
    expect(environment.selections).toHaveBeenCalledTimes(1)
    const unauthorized = await send(base, 'GET', '/v1/environment/selections', undefined, {
      Authorization: 'Bearer wrong',
    })
    expect(unauthorized.status).toBe(401)
    expect(environment.selections).toHaveBeenCalledTimes(1)
  })

  it('enforces protocol, bearer, Origin and response schema', async () => {
    const { base } = await setup()
    const incompatible = await fetch(base + '/v1/health', { headers: { Authorization: 'Bearer ' + token } })
    expect(incompatible.status).toBe(426)
    expect((await incompatible.json()).code).toBe('PROTOCOL_INCOMPATIBLE')
    const unauthorized = await fetch(base + '/v1/health', { headers: headers({ Authorization: 'Bearer wrong' }) })
    expect(unauthorized.status).toBe(401)
    const origin = await fetch(base + '/v1/health', { headers: headers({ Origin: 'https://evil.example' }) })
    expect(origin.status).toBe(403)
    const missing = await fetch(base + '/v1/missing', { headers: headers() })
    expect(missing.status).toBe(404)
    expect((await missing.json()).code).toBe('NOT_FOUND')
    const botUnauthorized = await send(base, 'GET', '/v1/bots/alpha/status', undefined, { Authorization: 'Bearer bad' })
    expect(botUnauthorized.status).toBe(401)
  })

  it('protects conversation calls and rejects caller-selected ids', async () => {
    const { base, bots, environment } = await setup()
    const alpha = bots.get('alpha')!
    const request = (body: unknown, extra: Record<string, string> = {}) =>
      send(base, 'POST', '/v1/bots/alpha/conversation/call', body, extra)
    const called = await request({ op: 'chatGetConvTools', args: [] })
    expect(called.status).toBe(200)
    expect(await called.json()).toEqual({ result: { bot: 'alpha' } })
    expect(alpha.conversationCall).toHaveBeenCalledWith({ op: 'chatGetConvTools', args: [] })
    expect((await request({ op: 'chatGetConvTools', args: [], conversationId: 'other' })).status).toBe(400)
    expect((await request({ op: 'chatGetConvTools', args: [] }, { Origin: 'https://evil.test' })).status).toBe(403)
    expect((await request({ op: 'chatGetConvTools', args: [] }, { Authorization: 'Bearer bad' })).status).toBe(401)
    expect(alpha.conversationCall).toHaveBeenCalledTimes(1)
    for (const target of ['accounts', 'skills', 'mcp'] as const)
      expect((await send(base, 'POST', '/v1/ui/open', { target })).status).toBe(204)
    expect(environment.open.mock.calls).toEqual([['accounts'], ['skills'], ['mcp']])
  })

  it('serves binary images only with fleet credentials and keeps the larger body limit on bot inputs', async () => {
    const { base, bots } = await setup()
    const route = base + '/v1/bots/beta/images/t-valid'
    const image = await fetch(route, { headers: headers() })
    expect(image.status).toBe(200)
    expect(image.headers.get('content-type')).toBe('image/png')
    expect(image.headers.get('x-content-type-options')).toBe('nosniff')
    expect(Buffer.from(await image.arrayBuffer())).toEqual(Buffer.from([137, 80, 78, 71]))
    expect(bots.get('beta')!.image).toHaveBeenCalledWith('t-valid')
    expect(bots.get('alpha')!.image).not.toHaveBeenCalled()
    expect((await fetch(route, { headers: headers({ Origin: 'https://example.test' }) })).status).toBe(403)
    expect((await fetch(route, { headers: headers({ Authorization: 'Bearer bad' }) })).status).toBe(401)
    const bytes = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(900_000)])
    const sent = await send(base, 'POST', '/v1/bots/beta/inputs', {
      ...ownerInput(''),
      attachments: [{ name: 'large.png', mediaType: 'image/png', dataBase64: bytes.toString('base64') }],
    })
    expect(sent.status).toBe(200)
    expect(bots.get('beta')!.input).toHaveBeenCalledOnce()
    const tooLarge = await send(base, 'PUT', '/v1/bots/beta', { padding: 'x'.repeat(1_048_576) })
    expect(tooLarge.status).toBe(400)
  })

  it('adds and removes an API key account without echoing the key', async () => {
    const { base, environment } = await setup()
    const key = 'private-test-key'
    const added = await send(base, 'POST', '/v1/accounts/api-key', {
      kind: 'openai',
      name: 'Fake model',
      key,
      baseURL: 'http://fake-model:8080/v1',
    })
    expect(added.status).toBe(200)
    const response = await added.text()
    expect(response).toBe(JSON.stringify({ providerId: 'prov_test' }))
    expect(response).not.toContain(key)
    expect(environment.addApiKeyAccount).toHaveBeenCalledWith({
      kind: 'openai',
      name: 'Fake model',
      key,
      baseURL: 'http://fake-model:8080/v1',
    })
    const removed = await send(base, 'DELETE', '/v1/accounts/prov_test')
    expect(removed.status).toBe(204)
    expect(environment.removeAccount).toHaveBeenCalledWith('prov_test')
  })

  it('validates request bodies and refuses bodies above 1 MiB', async () => {
    const { base, bots } = await setup()
    const malformed = await fetch(base + '/v1/bots/alpha/inputs', {
      method: 'POST',
      headers: headers({ 'content-type': 'application/json' }),
      body: '{',
    })
    expect(malformed.status).toBe(400)
    expect((await send(base, 'POST', '/v1/bots/alpha/inputs', { text: 'x' })).status).toBe(400)
    const large = await send(base, 'POST', '/v1/bots/alpha/inputs', { padding: 'x'.repeat(1_048_576) })
    expect(large.status).toBe(400)
    const oversized = await send(base, 'POST', '/v1/bots/alpha/hold', { reason: 'x'.repeat(1_048_576) })
    expect(oversized.status).toBe(400)
    expect(bots.get('alpha')!.hold).not.toHaveBeenCalled()
    const valid = await send(base, 'POST', '/v1/bots/alpha/inputs', ownerInput())
    expect(valid.status).toBe(200)
    expect(await valid.json()).toMatchObject({ inputId: 'input-alpha', queued: true })
    expect((await send(base, 'GET', '/v1/bots/alpha/transcript?limit=501')).status).toBe(400)
    expect((await send(base, 'GET', '/v1/bots/alpha/transcript?limit=0')).status).toBe(400)
    expect(bots.get('alpha')!.input).toHaveBeenCalledOnce()
    expect(bots.get('alpha')!.transcript).not.toHaveBeenCalled()
  })

  it('validates responses before sending them', async () => {
    const fake = fakeEnvironment()
    fake.bots.get('alpha')!.status.mockResolvedValue({ ...baseStatus, protocol: 2 } as unknown as FleetInstanceStatus)
    const { base } = await setup(fake)
    const response = await send(base, 'GET', '/v1/bots/alpha/status')
    expect(response.status).toBe(500)
    expect((await response.json()).code).toBe('INTERNAL')
  })

  it('streams every event once with its bot id and resets old cursors', async () => {
    const { base, events } = await setup()
    events.publish({ type: 'status', status: baseStatus, botId: 'alpha' })
    events.publish({
      type: 'turn.finished',
      inputId: null,
      text: null,
      source: null,
      outcome: 'completed',
      summary: 'Hello',
      botId: 'beta',
    })
    events.publish({ type: 'reset' })
    const controller = new AbortController()
    const stream = await fetch(base + '/v1/events?since=0', { headers: headers(), signal: controller.signal })
    expect(stream.status).toBe(200)
    const frames = await readFrames(stream, 3)
    expect(frames.map((event) => [event.seq, event.type, event.botId])).toEqual([
      [1, 'status', 'alpha'],
      [2, 'turn.finished', 'beta'],
      [3, 'reset', null],
    ])
    controller.abort()
    const replay = new AbortController()
    const resumed = await fetch(base + '/v1/events?since=1', { headers: headers(), signal: replay.signal })
    expect((await readFrames(resumed, 2)).map((event) => event.seq)).toEqual([2, 3])
    replay.abort()
    for (let index = 0; index < 2_001; index++) events.publish({ type: 'reset' })
    const old = new AbortController()
    const reset = await fetch(base + '/v1/events?since=0', { headers: headers(), signal: old.signal })
    expect(await readFrames(reset, 1)).toMatchObject([{ type: 'reset', botId: null }])
    old.abort()
    expect((await send(base, 'GET', '/v1/events?since=x')).status).toBe(400)
    expect(events.replay(events.lastSeq + 1)).toBeNull()
  })
})

describe('bot routes', () => {
  const routes: Array<{
    method: string
    path: string
    body?: unknown
    call: keyof FakeBot & string
    args: unknown[]
    status: number
  }> = [
    { method: 'GET', path: 'status', call: 'status', args: [], status: 200 },
    { method: 'GET', path: 'selections', call: 'selections', args: [], status: 200 },
    { method: 'GET', path: 'memories?status=archived', call: 'memories', args: ['archived'], status: 200 },
    { method: 'GET', path: 'memories', call: 'memories', args: ['active'], status: 200 },
    {
      method: 'PATCH',
      path: 'memories/m1',
      body: { pinned: true },
      call: 'patchMemory',
      args: ['m1', { pinned: true }],
      status: 200,
    },
    { method: 'DELETE', path: 'memories/m1', call: 'deleteMemory', args: ['m1'], status: 204 },
    { method: 'GET', path: 'transcript?before=item-9&limit=20', call: 'transcript', args: ['item-9', 20], status: 200 },
    { method: 'GET', path: 'transcript', call: 'transcript', args: [null, 200], status: 200 },
    { method: 'GET', path: 'images/img-1', call: 'image', args: ['img-1'], status: 200 },
    {
      method: 'POST',
      path: 'inputs',
      body: { idempotencyKey: '8e0f3c5a-2b6d-4c1e-9f7a-3d5b1c2e4f60', source: 'owner', text: 'Hi' },
      call: 'input',
      args: [
        expect.objectContaining({
          idempotencyKey: '8e0f3c5a-2b6d-4c1e-9f7a-3d5b1c2e4f60',
          source: 'owner',
          text: 'Hi',
        }),
      ],
      status: 200,
    },
    { method: 'DELETE', path: 'inputs/in-1', call: 'deleteInput', args: ['in-1'], status: 204 },
    { method: 'POST', path: 'turn/cancel', call: 'cancel', args: [], status: 204 },
    {
      method: 'POST',
      path: 'interactions/i-1/resolve',
      body: { kind: 'help', note: null },
      call: 'resolve',
      args: ['i-1', { kind: 'help', note: null }],
      status: 204,
    },
    { method: 'POST', path: 'hold', body: { reason: 'takeover' }, call: 'hold', args: ['takeover'], status: 200 },
    {
      method: 'POST',
      path: 'hold/release',
      body: { note: null, durationMs: null, continue: false },
      call: 'release',
      args: [{ note: null, durationMs: null, continue: false }],
      status: 200,
    },
    {
      method: 'POST',
      path: 'conversation/call',
      body: { op: 'chatGetConvTools', args: [] },
      call: 'conversationCall',
      args: [{ op: 'chatGetConvTools', args: [] }],
      status: 200,
    },
  ]
  const legacy: Array<[string, string, unknown?]> = [
    ['GET', '/v1/status'],
    ['PUT', '/v1/profile', profileOf('alpha')],
    ['GET', '/v1/selections'],
    ['GET', '/v1/memories'],
    ['PATCH', '/v1/memories/m1', { pinned: true }],
    ['DELETE', '/v1/memories/m1'],
    ['GET', '/v1/transcript'],
    ['GET', '/v1/images/img-1'],
    ['POST', '/v1/inputs', ownerInput()],
    ['DELETE', '/v1/inputs/in-1'],
    ['POST', '/v1/turn/cancel'],
    ['POST', '/v1/interactions/i-1/resolve', { kind: 'help', note: null }],
    ['POST', '/v1/hold', { reason: 'takeover' }],
    ['POST', '/v1/hold/release', { note: null, durationMs: null, continue: false }],
    ['POST', '/v1/conversation/call', { op: 'chatGetConvTools', args: [] }],
    ['GET', '/v1/screen/view'],
    ['GET', '/v1/screen/control'],
  ]
  const calls = (bot: FakeBot) =>
    routes.reduce((total, route) => total + (bot[route.call] as ReturnType<typeof vi.fn>).mock.calls.length, 0)

  it('routes every bot route to the bot it names, and only to it', async () => {
    const { base, bots } = await setup()
    const alpha = bots.get('alpha')!
    const beta = bots.get('beta')!
    for (const route of routes) {
      const method = beta[route.call] as ReturnType<typeof vi.fn>
      method.mockClear()
      const response = await send(base, route.method, `/v1/bots/beta/${route.path}`, route.body)
      expect(response.status, `${route.method} ${route.path}`).toBe(route.status)
      if (route.status === 204) expect(await response.text()).toBe('')
      expect(method, `${route.method} ${route.path}`).toHaveBeenCalledExactlyOnceWith(...route.args)
    }
    expect(calls(alpha)).toBe(0)
    expect(await (await send(base, 'GET', '/v1/bots/alpha/status')).json()).toMatchObject({
      profile: { botId: 'alpha' },
      conversationId: 'conv-alpha',
    })
    expect(await (await send(base, 'GET', '/v1/bots/beta/memories')).json()).toEqual({
      memories: [{ ...botMemory, title: 'beta' }],
    })
    expect((await send(base, 'GET', '/v1/bots/beta/memories?status=invalid')).status).toBe(400)
    expect((await send(base, 'PATCH', '/v1/bots/beta/memories/m1', { pinned: 'yes' })).status).toBe(400)
  })

  it('answers NOT_FOUND for unknown bots, invalid bot ids and the unprefixed bot routes', async () => {
    const { base, bots, environment } = await setup()
    for (const botId of ['gamma', 'Not_A_Bot', '%E0%A4%A'])
      for (const route of routes) {
        const response = await send(base, route.method, `/v1/bots/${botId}/${route.path}`, route.body)
        expect(response.status, `${botId} ${route.method} ${route.path}`).toBe(404)
        expect((await response.json()).code).toBe('NOT_FOUND')
      }
    for (const [method, route, body] of legacy) {
      const response = await send(base, method, route, body)
      expect(response.status, `${method} ${route}`).toBe(404)
      expect(await response.json()).toMatchObject({ code: 'NOT_FOUND' })
    }
    for (const bot of bots.values()) expect(calls(bot)).toBe(0)
    expect(environment.installBot).not.toHaveBeenCalled()
    expect(environment.uninstallBot).not.toHaveBeenCalled()
  })

  it('installs a bot only with its own profile and uninstalls it with or without purge', async () => {
    const { base, environment, bots } = await setup()
    const install = (path: string, botId: string, extra: Record<string, unknown> = {}) =>
      send(base, 'PUT', path, { profile: profileOf(botId), slot: 3, gatewayToken: 'synthetic-gateway-token', ...extra })
    const mismatch = await install('/v1/bots/gamma', 'delta')
    expect(mismatch.status).toBe(400)
    expect((await mismatch.json()).code).toBe('INVALID_REQUEST')
    expect((await install('/v1/bots/gamma', 'gamma', { gatewayToken: 'short' })).status).toBe(400)
    expect((await install('/v1/bots/gamma', 'gamma', { slot: 9 })).status).toBe(400)
    expect(environment.installBot).not.toHaveBeenCalled()
    const installed = await install('/v1/bots/gamma', 'gamma')
    expect(installed.status).toBe(200)
    expect(await installed.json()).toMatchObject({ profile: { botId: 'gamma' } })
    expect(environment.installBot).toHaveBeenCalledExactlyOnceWith({
      profile: profileOf('gamma'),
      slot: 3,
      gatewayToken: 'synthetic-gateway-token',
    })
    expect(bots.get('gamma')?.slot).toBe(3)

    const cases: Array<[string, boolean]> = [
      ['', false],
      ['?purge=0', false],
      ['?purge=false', false],
      ['?purge=1', true],
      ['?purge=true', true],
    ]
    for (const [query, purge] of cases) {
      environment.uninstallBot.mockClear()
      const removed = await send(base, 'DELETE', '/v1/bots/gamma' + query)
      expect(removed.status, query).toBe(204)
      expect(environment.uninstallBot).toHaveBeenCalledExactlyOnceWith('gamma', { purge })
    }
    environment.uninstallBot.mockClear()
    expect((await send(base, 'DELETE', '/v1/bots/gamma?purge=yes')).status).toBe(400)
    expect((await send(base, 'DELETE', '/v1/bots/Not_A_Bot')).status).toBe(404)
    expect(environment.uninstallBot).not.toHaveBeenCalled()
  })

  it('dispatches provisioning routes to the environment, validates slots and accepts a 9 MiB skill body', async () => {
    const { base, environment } = await setup()
    const routes: Array<[string, string, unknown, keyof typeof environment]> = [
      ['GET', '/v1/accounts', undefined, 'accounts'],
      [
        'POST',
        '/v1/accounts/import',
        { items: [{ type: 'github-copilot', label: 'Fake', token: 'synthetic' }] },
        'importAccounts',
      ],
      ['DELETE', '/v1/subscriptions/codex/default', undefined, 'removeSubscription'],
      ['GET', '/v1/skills', undefined, 'skills'],
      [
        'POST',
        '/v1/skills',
        {
          name: 'sample',
          files: [0, 1, 2].map((i) => ({
            path: i ? 'f' + i : 'SKILL.md',
            data: 'a'.repeat(3 * 1024 * 1024),
            executable: false,
          })),
        },
        'installSkill',
      ],
      ['DELETE', '/v1/skills/sample', undefined, 'removeSkill'],
      ['GET', '/v1/mcp-servers', undefined, 'mcpServers'],
      [
        'POST',
        '/v1/mcp-servers/import',
        { servers: [{ name: 'Echo', transport: 'stdio', command: 'node', enabled: true }] },
        'importMcpServers',
      ],
      ['DELETE', '/v1/mcp-servers/m1', undefined, 'removeMcpServer'],
    ]
    for (const [method, route, body, name] of routes) {
      const response = await send(base, method, route, body)
      expect(response.status, route).toBe(method === 'DELETE' ? 204 : 200)
      expect(environment[name]).toHaveBeenCalledOnce()
    }
    expect(environment.removeSubscription).toHaveBeenCalledWith('codex', 'default')
    for (const route of ['/v1/subscriptions/bogus/default', '/v1/subscriptions/codex/bad'])
      expect((await send(base, 'DELETE', route)).status).toBe(400)
  })

  it('dispatches login routes and rejects Grok browser before starting a provider', async () => {
    const { base, environment } = await setup()
    expect((await send(base, 'POST', '/v1/logins', { kind: 'codex', method: 'device', slot: 'auto' })).status).toBe(200)
    expect(environment.startLogin).toHaveBeenCalledWith({ kind: 'codex', method: 'device', slot: 'auto' })
    expect((await send(base, 'GET', '/v1/logins/login-1')).status).toBe(200)
    expect(environment.login).toHaveBeenCalledWith('login-1')
    expect(
      (await send(base, 'POST', '/v1/logins/login-1/callback', { path: '/callback', query: 'code=a' })).status
    ).toBe(200)
    expect(environment.loginCallback).toHaveBeenCalledWith('login-1', { path: '/callback', query: 'code=a' })
    expect((await send(base, 'POST', '/v1/logins/login-1/code', { code: 'synthetic' })).status).toBe(200)
    expect(environment.submitLoginCode).toHaveBeenCalledWith('login-1', 'synthetic')
    expect((await send(base, 'DELETE', '/v1/logins/login-1')).status).toBe(204)
    expect(environment.cancelLogin).toHaveBeenCalledWith('login-1')
    expect((await send(base, 'POST', '/v1/logins', { kind: 'grok', method: 'browser' })).status).toBe(400)
    expect(environment.startLogin).toHaveBeenCalledOnce()
  })
})

describe('instance screen tunnels', () => {
  it('authenticates screens, relays bytes and releases the VNC lease when a client leaves', async () => {
    const vnc = await echoVnc()
    const { port, base, bots, screen, leases, environment } = await setup()
    screen.port = vnc.port
    expect((await fetch(base + '/v1/bots/alpha/screen/browser/view', { headers: headers() })).status).toBe(400)
    expect((await fetch(base + '/v1/screen/environment/view', { headers: headers() })).status).toBe(400)
    const view = '/v1/screen/environment/view'
    expect((await upgrade(port, view, { Authorization: 'Bearer wrong' })).status).toBe(401)
    expect((await upgrade(port, view, { [FLEET_PROTOCOL_HEADER]: '2' })).status).toBe(426)
    expect((await upgrade(port, view, { Origin: 'https://bad.example' })).status).toBe(403)
    expect((await upgrade(port, view, { Upgrade: 'websocket' })).status).toBe(400)
    for (const path of [
      '/v1/screen/view',
      '/v1/screen/control',
      '/v1/screen/environment/edit',
      '/v1/bots/gamma/screen/browser/view',
      '/v1/bots/Not_A_Bot/screen/apps/view',
      '/v1/bots/alpha/screen/desktop/view',
    ])
      expect((await upgrade(port, path)).status, path).toBe(404)
    expect(environment.acquireScreen).not.toHaveBeenCalled()

    // The environment screen shows only Maestrly's settings: its control needs no takeover.
    const settings = await upgrade(port, '/v1/screen/environment/control')
    expect(settings.status).toBe(101)
    await echoes(settings.socket!, [1, 2, 3])
    // A bot's screens need that bot's own takeover.
    bots.get('beta')!.state.hold = takeover()
    const refused = await upgrade(port, '/v1/bots/alpha/screen/apps/control')
    expect(refused.status).toBe(409)
    expect(JSON.parse(refused.body!)).toMatchObject({ code: 'CONFLICT' })
    bots.get('alpha')!.state.hold = takeover()
    const apps = await upgrade(port, '/v1/bots/alpha/screen/apps/control')
    expect(apps.status).toBe(101)
    await echoes(apps.socket!, [4, 5, 6])
    const browser = await upgrade(port, '/v1/bots/beta/screen/browser/view')
    expect(browser.status).toBe(101)
    await echoes(browser.socket!, [7])
    expect(leases.map(({ surface, mode }) => [surface, mode])).toEqual([
      [{ kind: 'environment' }, 'control'],
      [{ kind: 'apps', botId: 'alpha' }, 'control'],
      [{ kind: 'browser', botId: 'beta' }, 'view'],
    ])
    expect(vnc.connections.size).toBe(3)

    browser.socket!.destroy()
    await vi.waitFor(() => expect(leases[2].release).toHaveBeenCalledOnce())
    expect(leases[0].release).not.toHaveBeenCalled()
    expect(leases[1].release).not.toHaveBeenCalled()
    settings.socket!.destroy()
    apps.socket!.destroy()
    await vi.waitFor(() => {
      expect(leases[0].release).toHaveBeenCalledOnce()
      expect(leases[1].release).toHaveBeenCalledOnce()
      expect(vnc.connections.size).toBe(0)
    })
    expect(leases[2].release).toHaveBeenCalledOnce()
  })

  it('allows one control of the environment display at a time, reserved before connecting', async () => {
    const vnc = await echoVnc()
    const { port, bots, screen, leases } = await setup()
    screen.port = vnc.port
    screen.delayMs = 50
    for (const bot of bots.values()) bot.state.hold = takeover()
    const zero = await Promise.all([
      upgrade(port, '/v1/screen/environment/control'),
      upgrade(port, '/v1/bots/alpha/screen/browser/control'),
      upgrade(port, '/v1/bots/beta/screen/browser/control'),
    ])
    expect(zero.map((result) => result.status).sort()).toEqual([101, 409, 409])
    for (const result of zero.filter((entry) => entry.status === 409))
      expect(JSON.parse(result.body!)).toMatchObject({ code: 'CONFLICT' })
    expect(leases.filter((lease) => lease.mode === 'control')).toHaveLength(1)
    // Each bot's apps display is a screen of its own: its control does not take the environment display.
    const apps = await Promise.all([
      upgrade(port, '/v1/bots/alpha/screen/apps/control'),
      upgrade(port, '/v1/bots/beta/screen/apps/control'),
    ])
    expect(apps.map((result) => result.status)).toEqual([101, 101])
    // Viewers of the environment display are not limited by its control.
    const views = await Promise.all([
      upgrade(port, '/v1/bots/alpha/screen/browser/view'),
      upgrade(port, '/v1/screen/environment/view'),
    ])
    expect(views.map((result) => result.status)).toEqual([101, 101])
    expect((await upgrade(port, '/v1/bots/beta/screen/browser/control')).status).toBe(409)

    const winner = zero.find((result) => result.status === 101)!
    const lease = leases.find((entry) => entry.mode === 'control')!
    winner.socket!.destroy()
    await vi.waitFor(() => expect(lease.release).toHaveBeenCalledOnce())
    const next = await upgrade(port, '/v1/bots/beta/screen/browser/control')
    expect(next.status).toBe(101)
    await echoes(next.socket!, [9])
  })

  it('limits each surface to four viewers and one controller', async () => {
    const vnc = await echoVnc()
    const { port, bots, screen } = await setup()
    screen.port = vnc.port
    const views = await Promise.all(Array.from({ length: 4 }, () => upgrade(port, '/v1/bots/alpha/screen/apps/view')))
    expect(views.map((result) => result.status)).toEqual([101, 101, 101, 101])
    expect((await upgrade(port, '/v1/bots/alpha/screen/apps/view')).status).toBe(409)
    expect((await upgrade(port, '/v1/bots/beta/screen/apps/view')).status).toBe(101)
    expect((await upgrade(port, '/v1/bots/alpha/screen/browser/view')).status).toBe(101)
    bots.get('alpha')!.state.hold = takeover()
    screen.delayMs = 30
    const controls = await Promise.all([
      upgrade(port, '/v1/bots/alpha/screen/apps/control'),
      upgrade(port, '/v1/bots/alpha/screen/apps/control'),
    ])
    expect(controls.map((result) => result.status).sort()).toEqual([101, 409])
    views[0].socket!.destroy()
    await vi.waitFor(async () => expect((await upgrade(port, '/v1/bots/alpha/screen/apps/view')).status).toBe(101))
  })

  it('releases the lease and the reservation when a screen cannot connect or its client leaves', async () => {
    const { port, bots, screen, leases, environment } = await setup()
    bots.get('alpha')!.state.hold = takeover()
    screen.fail = true
    const unavailable = await upgrade(port, '/v1/bots/alpha/screen/browser/control')
    expect(unavailable.status).toBe(503)
    expect(JSON.parse(unavailable.body!)).toMatchObject({ code: 'INSTANCE_UNAVAILABLE' })
    screen.fail = false
    screen.port = await unusedPort()
    const refused = await upgrade(port, '/v1/screen/environment/control')
    expect(refused.status).toBe(503)
    expect(leases).toHaveLength(1)
    expect(leases[0].release).toHaveBeenCalledOnce()

    // A client that leaves while its screen starts gives the lease back as soon as it arrives.
    const vnc = await echoVnc()
    screen.port = vnc.port
    screen.delayMs = 200
    const request = http.request({
      host: '127.0.0.1',
      port,
      path: '/v1/screen/environment/control',
      headers: { ...headers(), Connection: 'Upgrade', Upgrade: 'maestrly-rfb' },
    })
    request.on('error', () => {})
    request.end()
    await vi.waitFor(() => expect(environment.acquireScreen).toHaveBeenCalledTimes(3))
    request.destroy()
    await vi.waitFor(() => {
      expect(leases).toHaveLength(2)
      expect(leases[1].release).toHaveBeenCalledOnce()
    })
    // It never reached the VNC server.
    expect(vnc.stats.accepted).toBe(0)
    expect(vnc.connections.size).toBe(0)

    // None of these failures keeps the environment display reserved.
    screen.delayMs = 0
    const control = await upgrade(port, '/v1/bots/alpha/screen/browser/control')
    expect(control.status).toBe(101)
    await echoes(control.socket!, [1])
  })

  it("ends only the controls of the bot whose takeover ends, never a neighbour's", async () => {
    const vnc = await echoVnc()
    const { port, base, bots, screen, events } = await setup()
    screen.port = vnc.port
    const alpha = bots.get('alpha')!
    const beta = bots.get('beta')!
    alpha.state.hold = takeover()
    beta.state.hold = takeover()
    const settings = await upgrade(port, '/v1/screen/environment/control')
    const alphaApps = await upgrade(port, '/v1/bots/alpha/screen/apps/control')
    const alphaView = await upgrade(port, '/v1/bots/alpha/screen/browser/view')
    const betaApps = await upgrade(port, '/v1/bots/beta/screen/apps/control')
    expect([settings, alphaApps, alphaView, betaApps].map((result) => result.status)).toEqual([101, 101, 101, 101])

    // Beta's takeover ends: its control closes, Alpha's and the environment screen's stay.
    const betaClosed = once(betaApps.socket!, 'close')
    beta.state.hold = NO_HOLD
    events.publish({ type: 'status', status: await beta.status(), botId: 'beta' })
    await betaClosed
    await echoes(alphaApps.socket!, [1])
    await echoes(settings.socket!, [2])
    // A late status of Alpha from before its takeover does not end the control it has now, nor does an event
    // of the environment.
    events.publish({ type: 'status', status: { ...baseStatus, hold: NO_HOLD }, botId: 'alpha' })
    events.publish({ type: 'reset' })
    await echoes(alphaApps.socket!, [3])

    // Releasing Alpha's takeover ends its control at once; its viewers and the environment screen stay.
    const alphaClosed = once(alphaApps.socket!, 'close')
    const released = await send(base, 'POST', '/v1/bots/alpha/hold/release', {
      note: null,
      durationMs: null,
      continue: false,
    })
    expect(released.status).toBe(200)
    await alphaClosed
    await echoes(alphaView.socket!, [4])
    await echoes(settings.socket!, [5])

    // Pausing a bot under takeover ends its control too.
    settings.socket!.destroy()
    alpha.state.hold = takeover()
    const browser = await vi.waitFor(async () => {
      const result = await upgrade(port, '/v1/bots/alpha/screen/browser/control')
      expect(result.status).toBe(101)
      return result
    })
    const browserClosed = once(browser.socket!, 'close')
    expect((await send(base, 'POST', '/v1/bots/alpha/hold', { reason: 'paused' })).status).toBe(200)
    await browserClosed
    await echoes(alphaView.socket!, [6])
  })

  it('ends the screens of a bot that is uninstalled or moves to another slot', async () => {
    const vnc = await echoVnc()
    const { port, base, bots, screen, leases } = await setup()
    screen.port = vnc.port
    bots.get('alpha')!.state.hold = takeover()
    const install = (slot: number) =>
      send(base, 'PUT', '/v1/bots/alpha', {
        profile: profileOf('alpha'),
        slot,
        gatewayToken: 'synthetic-gateway-token',
      })
    const control = await upgrade(port, '/v1/bots/alpha/screen/browser/control')
    const view = await upgrade(port, '/v1/bots/alpha/screen/apps/view')
    const neighbour = await upgrade(port, '/v1/bots/beta/screen/browser/view')
    expect([control, view, neighbour].map((result) => result.status)).toEqual([101, 101, 101])

    // Installing the same slot again keeps the screens open.
    expect((await install(1)).status).toBe(200)
    await echoes(control.socket!, [1])
    await echoes(view.socket!, [2])
    // Moving to another slot moves both screens: the old tunnels end.
    const closed = [once(control.socket!, 'close'), once(view.socket!, 'close')]
    expect((await install(3)).status).toBe(200)
    await Promise.all(closed)
    await echoes(neighbour.socket!, [3])
    await vi.waitFor(() => {
      for (const lease of leases.slice(0, 2)) expect(lease.release).toHaveBeenCalledOnce()
    })

    const again = await upgrade(port, '/v1/bots/alpha/screen/apps/view')
    expect(again.status).toBe(101)
    const gone = once(again.socket!, 'close')
    expect((await send(base, 'DELETE', '/v1/bots/alpha')).status).toBe(204)
    await gone
    await echoes(neighbour.socket!, [4])
    expect((await upgrade(port, '/v1/bots/alpha/screen/apps/view')).status).toBe(404)
    await vi.waitFor(() => expect(leases[3].release).toHaveBeenCalledOnce())
    expect(leases[2].release).not.toHaveBeenCalled()
  })
})
