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
