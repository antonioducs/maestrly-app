import { afterEach, describe, expect, it, vi } from 'vitest'
import { once } from 'node:events'
import { randomBytes, randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import {
  FLEET_PROTOCOL_HEADER,
  fleetInstanceStatusSchema,
  type FleetInstanceStatus,
} from '@maestrly/bot-fleet-protocol'
import { createInstanceControlServer, InstanceEvents, type InstanceControl } from '../../src/main/fleet/instance/server'
import { parseBotInstanceConfig } from '../../src/main/fleet/instance/config'

const status: FleetInstanceStatus = fleetInstanceStatusSchema.parse({
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
const control: InstanceControl = {
  startLogin: async () => loginAttempt,
  login: () => loginAttempt,
  loginCallback: async () => ({ status: 200, location: null, contentType: null, body: '' }),
  submitLoginCode: async () => loginAttempt,
  cancelLogin: async () => {},
  accounts: () => ({ apiKeys: [], subscriptions: [] }),
  importAccounts: async () => ({ results: [] }),
  removeSubscription: async () => {},
  skills: async () => ({ skills: [] }),
  installSkill: async () => ({ name: 'sample', outcome: 'added' }),
  removeSkill: async () => {},
  mcpServers: () => ({ servers: [] }),
  importMcpServers: async () => ({ results: [] }),
  removeMcpServer: async () => {},
  memories: async () => ({ memories: [botMemory] }),
  patchMemory: async () => botMemory,
  deleteMemory: async () => {},
  health: () => ({ ok: true, appVersion: '1.0.0', protocol: 1, ready: true }),
  status: () => status,
  profile: async () => status,
  selections: async () => ({ options: [], current: null }),
  addApiKeyAccount: async () => ({ providerId: 'prov_test' }),
  removeAccount: async () => {},
  transcript: () => ({ items: [], before: null }),
  image: async () => ({ mediaType: 'image/png', bytes: new Uint8Array([137, 80, 78, 71]) }),
  input: async () => ({ inputId: 'input', itemId: 'input:input', queued: true }),
  deleteInput: async () => {},
  cancel: async () => {},
  resolve: async () => {},
  hold: async () => ({ state: 'held', reason: 'takeover', since: new Date().toISOString(), interruptedTurn: false }),
  release: async () => ({ state: 'none', reason: null, since: null, interruptedTurn: false }),
  open: async () => {},
  conversationCall: async () => ({ result: { app: true, mcpDisabled: [], imageGen: true } }),
}
const servers: ReturnType<typeof createInstanceControlServer>[] = []
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(async (server) => {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    })
  )
  vi.restoreAllMocks()
})
async function setup(instanceControl: InstanceControl = control) {
  const events = new InstanceEvents()
  const server = createInstanceControlServer(config, instanceControl, events)
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, events }
}
function headers(extra: Record<string, string> = {}): Record<string, string> {
  return { [FLEET_PROTOCOL_HEADER]: '1', Authorization: 'Bearer ' + token, ...extra }
}
describe('instance control HTTP', () => {
  it('protects conversation calls and rejects caller-selected ids', async () => {
    const conversationCall = vi.fn(async () => ({ result: { app: true, mcpDisabled: [], imageGen: true } }))
    const { base } = await setup({ ...control, conversationCall })
    const request = (body: unknown, extra: Record<string, string> = {}) =>
      fetch(base + '/v1/conversation/call', {
        method: 'POST',
        headers: headers({ 'content-type': 'application/json', ...extra }),
        body: JSON.stringify(body),
      })
    expect((await request({ op: 'chatGetConvTools', args: [] })).status).toBe(200)
    expect(conversationCall).toHaveBeenCalledWith({ op: 'chatGetConvTools', args: [] })
    expect((await request({ op: 'chatGetConvTools', args: [], conversationId: 'other' })).status).toBe(400)
    expect((await request({ op: 'chatGetConvTools', args: [] }, { Origin: 'https://evil.test' })).status).toBe(403)
    expect((await request({ op: 'chatGetConvTools', args: [] }, { Authorization: 'Bearer bad' })).status).toBe(401)
    expect(conversationCall).toHaveBeenCalledTimes(1)
    const open = vi.fn(async () => {})
    const opened = await setup({ ...control, open })
    for (const target of ['accounts', 'skills', 'mcp'] as const) {
      const response = await fetch(opened.base + '/v1/ui/open', {
        method: 'POST',
        headers: headers({ 'content-type': 'application/json' }),
        body: JSON.stringify({ target }),
      })
      expect(response.status).toBe(204)
    }
    expect(open.mock.calls).toEqual([['accounts'], ['skills'], ['mcp']])
  })

  it('serves binary images only with fleet credentials and keeps the larger body limit on inputs', async () => {
    const input = vi.fn(async () => ({ inputId: 'input', itemId: 'input:input', queued: true }))
    const { base } = await setup({ ...control, input })
    const route = base + '/v1/images/t-valid'
    const image = await fetch(route, { headers: headers() })
    expect(image.status).toBe(200)
    expect(image.headers.get('content-type')).toBe('image/png')
    expect(image.headers.get('x-content-type-options')).toBe('nosniff')
    expect(Buffer.from(await image.arrayBuffer())).toEqual(Buffer.from([137, 80, 78, 71]))
    expect((await fetch(route, { headers: headers({ Origin: 'https://example.test' }) })).status).toBe(403)
    expect((await fetch(route, { headers: headers({ Authorization: 'Bearer bad' }) })).status).toBe(401)
    const bytes = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(900_000)])
    const sent = await fetch(base + '/v1/inputs', {
      method: 'POST',
      headers: headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        idempotencyKey: randomUUID(),
        source: 'owner',
        text: '',
        attachments: [{ name: 'large.png', mediaType: 'image/png', dataBase64: bytes.toString('base64') }],
      }),
    })
    expect(sent.status).toBe(200)
    expect(input).toHaveBeenCalledOnce()
    const tooLarge = await fetch(base + '/v1/profile', {
      method: 'PUT',
      headers: headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ padding: 'x'.repeat(1_048_576) }),
    })
    expect(tooLarge.status).toBe(400)
  })
  it('adds and removes an API key account without echoing the key', async () => {
    const addApiKeyAccount = vi.fn(async () => ({ providerId: 'prov_test' }))
    const removeAccount = vi.fn(async () => {})
    const { base } = await setup({ ...control, addApiKeyAccount, removeAccount })
    const key = 'private-test-key'
    const added = await fetch(base + '/v1/accounts/api-key', {
      method: 'POST',
      headers: headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ kind: 'openai', name: 'Fake model', key, baseURL: 'http://fake-model:8080/v1' }),
    })
    expect(added.status).toBe(200)
    const response = await added.text()
    expect(response).toBe(JSON.stringify({ providerId: 'prov_test' }))
    expect(response).not.toContain(key)
    expect(addApiKeyAccount).toHaveBeenCalledWith({
      kind: 'openai',
      name: 'Fake model',
      key,
      baseURL: 'http://fake-model:8080/v1',
    })
    const removed = await fetch(base + '/v1/accounts/prov_test', { method: 'DELETE', headers: headers() })
    expect(removed.status).toBe(204)
    expect(removeAccount).toHaveBeenCalledWith('prov_test')
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
    const health = await fetch(base + '/v1/health', { headers: headers() })
    expect(health.status).toBe(200)
    expect(await health.json()).toEqual({ ok: true, appVersion: '1.0.0', protocol: 1, ready: true })
    const missing = await fetch(base + '/v1/missing', { headers: headers() })
    expect(missing.status).toBe(404)
  })
  it('validates request bodies and refuses bodies above 1 MiB', async () => {
    const { base } = await setup()
    const malformed = await fetch(base + '/v1/inputs', {
      method: 'POST',
      headers: headers({ 'content-type': 'application/json' }),
      body: '{',
    })
    expect(malformed.status).toBe(400)
    const invalid = await fetch(base + '/v1/inputs', {
      method: 'POST',
      headers: headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ text: 'x' }),
    })
    expect(invalid.status).toBe(400)
    const large = await fetch(base + '/v1/inputs', {
      method: 'POST',
      headers: headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ padding: 'x'.repeat(1_048_576) }),
    })
    expect(large.status).toBe(400)
    const valid = await fetch(base + '/v1/inputs', {
      method: 'POST',
      headers: headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ idempotencyKey: randomUUID(), source: 'owner', text: 'Hi' }),
    })
    expect(valid.status).toBe(200)
    expect(await valid.json()).toMatchObject({ inputId: 'input', queued: true })
    const limit = await fetch(base + '/v1/transcript?limit=501', { headers: headers() })
    expect(limit.status).toBe(400)
  })
  it('validates responses before sending them', async () => {
    const invalid = { ...control, status: () => ({ ...status, protocol: 2 }) as unknown as FleetInstanceStatus }
    const { base } = await setup(invalid)
    const response = await fetch(base + '/v1/status', { headers: headers() })
    expect(response.status).toBe(500)
    expect((await response.json()).code).toBe('INTERNAL')
  })
  it('replays SSE events and resets old cursors', async () => {
    const { base, events } = await setup()
    events.publish({ type: 'status', status })
    events.publish({ type: 'turn.finished', inputId: null, text: null, outcome: 'completed', summary: 'Hello' })
    const controller = new AbortController()
    const replay = await fetch(base + '/v1/events?since=1', { headers: headers(), signal: controller.signal })
    expect(replay.status).toBe(200)
    const chunk = await replay.body!.getReader().read()
    expect(new TextDecoder().decode(chunk.value)).toContain('id: 2\nevent: fleet\ndata:')
    controller.abort()
    for (let index = 0; index < 2_001; index++) events.publish({ type: 'reset' })
    const old = new AbortController()
    const reset = await fetch(base + '/v1/events?since=0', { headers: headers(), signal: old.signal })
    const resetChunk = await reset.body!.getReader().read()
    expect(new TextDecoder().decode(resetChunk.value)).toContain('"type":"reset"')
    old.abort()
    expect(events.replay(events.lastSeq + 1)).toBeNull()
  })
})

describe('instance screen tunnel', () => {
  it('authenticates, limits, relays bytes, and closes control on hold release', async () => {
    const net = await import('node:net')
    const http = await import('node:http')
    const vnc = net.createServer((socket) => socket.on('data', (data) => socket.write(data)))
    vnc.listen(0, '127.0.0.1')
    await once(vnc, 'listening')
    const vncPort = (vnc.address() as AddressInfo).port
    let held = false
    const events = new InstanceEvents()
    const tunnelControl: InstanceControl = {
      ...control,
      status: () => ({
        ...status,
        hold: held
          ? { state: 'held', reason: 'takeover', since: new Date().toISOString(), interruptedTurn: false }
          : { state: 'none', reason: null, since: null, interruptedTurn: false },
      }),
    }
    const server = createInstanceControlServer(config, tunnelControl, events, { view: vncPort, control: vncPort })
    servers.push(server)
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const port = (server.address() as AddressInfo).port
    expect((await fetch(`http://127.0.0.1:${port}/v1/screen/view`, { headers: headers() })).status).toBe(400)
    const upgrade = (mode: 'view' | 'control', extra: Record<string, string> = {}) =>
      new Promise<{ status: number; socket?: import('node:net').Socket }>((resolve, reject) => {
        const req = http.request({
          host: '127.0.0.1',
          port,
          path: '/v1/screen/' + mode,
          headers: { ...headers(), Connection: 'Upgrade', Upgrade: 'maestrly-rfb', ...extra },
        })
        req.on('upgrade', (res, socket) => resolve({ status: res.statusCode ?? 0, socket }))
        req.on('response', (res) => {
          res.resume()
          resolve({ status: res.statusCode ?? 0 })
        })
        req.on('error', reject)
        req.end()
      })
    expect((await upgrade('view', { Authorization: 'Bearer wrong' })).status).toBe(401)
    expect((await upgrade('view', { [FLEET_PROTOCOL_HEADER]: '2' })).status).toBe(426)
    expect((await upgrade('view', { Origin: 'https://bad.example' })).status).toBe(403)
    expect((await upgrade('control')).status).toBe(409)
    held = true
    const views = await Promise.all(Array.from({ length: 4 }, () => upgrade('view')))
    expect(views.map((item) => item.status)).toEqual([101, 101, 101, 101])
    expect((await upgrade('view')).status).toBe(409)
    const controlTunnel = await upgrade('control')
    expect(controlTunnel.status).toBe(101)
    expect((await upgrade('control')).status).toBe(409)
    const received = once(controlTunnel.socket!, 'data')
    controlTunnel.socket!.write(Buffer.from([4, 5, 6]))
    expect((await received)[0]).toEqual(Buffer.from([4, 5, 6]))
    const closed = once(controlTunnel.socket!, 'close')
    held = false
    events.publish({ type: 'status', status: await tunnelControl.status() })
    await closed
    for (const view of views) view.socket?.destroy()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    servers.splice(servers.indexOf(server), 1)
    await new Promise<void>((resolve) => vnc.close(() => resolve()))
  })
})

it('dispatches memory routes and rejects invalid patches and statuses', async () => {
  const memories = vi.fn(async () => ({ memories: [botMemory] }))
  const patchMemory = vi.fn(async () => ({ ...botMemory, pinned: true }))
  const deleteMemory = vi.fn(async () => {})
  const { base } = await setup({ ...control, memories, patchMemory, deleteMemory })
  const listed = await fetch(base + '/v1/memories?status=all', { headers: headers() })
  expect(listed.status).toBe(200)
  expect(await listed.json()).toEqual({ memories: [botMemory] })
  expect(memories).toHaveBeenCalledWith('all')
  expect((await fetch(base + '/v1/memories', { headers: headers() })).status).toBe(200)
  expect(memories).toHaveBeenLastCalledWith('active')
  expect((await fetch(base + '/v1/memories?status=invalid', { headers: headers() })).status).toBe(400)
  const patch = (body: unknown) =>
    fetch(base + '/v1/memories/m1', {
      method: 'PATCH',
      headers: headers({ 'content-type': 'application/json' }),
      body: JSON.stringify(body),
    })
  expect((await patch({ pinned: true })).status).toBe(200)
  expect(patchMemory).toHaveBeenCalledWith('m1', { pinned: true })
  expect((await patch({ pinned: 'yes' })).status).toBe(400)
  expect(patchMemory).toHaveBeenCalledTimes(1)
  expect((await fetch(base + '/v1/memories/m1', { method: 'DELETE', headers: headers() })).status).toBe(204)
  expect(deleteMemory).toHaveBeenCalledWith('m1')
})

it('dispatches provisioning routes, validates slots and accepts a 9 MiB skill body', async () => {
  const methods = {
    accounts: vi.fn(control.accounts),
    importAccounts: vi.fn(control.importAccounts),
    removeSubscription: vi.fn(control.removeSubscription),
    skills: vi.fn(control.skills),
    installSkill: vi.fn(control.installSkill),
    removeSkill: vi.fn(control.removeSkill),
    mcpServers: vi.fn(control.mcpServers),
    importMcpServers: vi.fn(control.importMcpServers),
    removeMcpServer: vi.fn(control.removeMcpServer),
  }
  const { base } = await setup({ ...control, ...methods })
  const routes: Array<[string, string, unknown, keyof typeof methods]> = [
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
    const response = await fetch(base + route, {
      method,
      headers: headers({ 'content-type': 'application/json' }),
      body: body ? JSON.stringify(body) : undefined,
    })
    expect(response.status, route).toBe(method === 'DELETE' ? 204 : 200)
    expect(methods[name]).toHaveBeenCalledOnce()
  }
  expect(methods.removeSubscription).toHaveBeenCalledWith('codex', 'default')
  for (const route of ['/v1/subscriptions/bogus/default', '/v1/subscriptions/codex/bad'])
    expect((await fetch(base + route, { method: 'DELETE', headers: headers() })).status).toBe(400)
})

it('dispatches login routes and rejects Grok browser before starting a provider', async () => {
  const methods = {
    startLogin: vi.fn(control.startLogin),
    login: vi.fn(control.login),
    loginCallback: vi.fn(control.loginCallback),
    submitLoginCode: vi.fn(control.submitLoginCode),
    cancelLogin: vi.fn(control.cancelLogin),
  }
  const { base } = await setup({ ...control, ...methods })
  const request = (method: string, route: string, body?: unknown) =>
    fetch(base + route, {
      method,
      headers: headers({ 'content-type': 'application/json' }),
      body: body ? JSON.stringify(body) : undefined,
    })
  expect((await request('POST', '/v1/logins', { kind: 'codex', method: 'device', slot: 'auto' })).status).toBe(200)
  expect(methods.startLogin).toHaveBeenCalledWith({ kind: 'codex', method: 'device', slot: 'auto' })
  expect((await request('GET', '/v1/logins/login-1')).status).toBe(200)
  expect(methods.login).toHaveBeenCalledWith('login-1')
  expect((await request('POST', '/v1/logins/login-1/callback', { path: '/callback', query: 'code=a' })).status).toBe(
    200
  )
  expect(methods.loginCallback).toHaveBeenCalledWith('login-1', { path: '/callback', query: 'code=a' })
  expect((await request('POST', '/v1/logins/login-1/code', { code: 'synthetic' })).status).toBe(200)
  expect(methods.submitLoginCode).toHaveBeenCalledWith('login-1', 'synthetic')
  expect((await request('DELETE', '/v1/logins/login-1')).status).toBe(204)
  expect(methods.cancelLogin).toHaveBeenCalledWith('login-1')
  expect((await request('POST', '/v1/logins', { kind: 'grok', method: 'browser' })).status).toBe(400)
  expect(methods.startLogin).toHaveBeenCalledOnce()
})
