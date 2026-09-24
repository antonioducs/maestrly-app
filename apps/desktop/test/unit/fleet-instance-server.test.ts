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
const control: InstanceControl = {
  health: () => ({ ok: true, appVersion: '1.0.0', protocol: 1, ready: true }),
  status: () => status,
  profile: async () => status,
  selections: async () => ({ options: [], current: null }),
  addApiKeyAccount: async () => ({ providerId: 'prov_test' }),
  removeAccount: async () => {},
  transcript: () => ({ items: [], before: null }),
  input: async () => ({ inputId: 'input', itemId: 'input:input', queued: true }),
  deleteInput: async () => {},
  cancel: async () => {},
  resolve: async () => {},
  hold: async () => ({ state: 'held', reason: 'takeover', since: new Date().toISOString(), interruptedTurn: false }),
  release: async () => ({ state: 'none', reason: null, since: null, interruptedTurn: false }),
  open: async () => {},
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
    events.publish({ type: 'turn.finished', outcome: 'completed', summary: 'Hello' })
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
