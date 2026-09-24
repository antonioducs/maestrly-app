import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  settings: new Map<string, string>(),
  secure: new Map<string, string>(),
  secureAvailable: true,
  events: [] as {
    onConnected: () => Promise<void>
    onEvent: (event: unknown) => void
  }[],
  broadcasts: [] as { channel: string; payload: unknown }[],
  activity: [] as {
    seq: number
    at: string
    botId: null
    kind: 'bot_started'
    summary: null
    data: Record<string, never>
  }[],
}))
vi.mock('../../src/main/store', () => ({
  getAppSetting: (key: string) => state.settings.get(key) ?? null,
  setAppSetting: (key: string, value: string) => {
    state.settings.set(key, value)
  },
}))
vi.mock('../../src/main/secure-store', () => ({
  isSecureStorageAvailable: () => state.secureAvailable,
  secureGet: (key: string) => (state.secureAvailable ? (state.secure.get(key) ?? null) : null),
  secureSet: (key: string, value: string) => {
    if (!state.secureAvailable) return false
    state.secure.set(key, value)
    return true
  },
  secureRemove: (key: string) => {
    state.secure.delete(key)
    return true
  },
}))
vi.mock('../../src/main/window-ipc', () => ({
  broadcast: (channel: string, payload: unknown) => {
    state.broadcasts.push({ channel, payload })
  },
}))
vi.mock('../../src/main/fleet/client/events', () => ({
  FleetEvents: class {
    constructor(_api: unknown, onEvent: (event: unknown) => void, _onState: unknown, onConnected: () => Promise<void>) {
      state.events.push({ onConnected, onEvent })
    }
    start() {}
    stop() {}
  },
}))

import { FleetClientService } from '../../src/main/fleet/client/service'
import { readFleetSettings } from '../../src/main/fleet/client/settings'

const host = {
  hostname: 'fleet-host',
  os: 'Linux',
  kernel: '6',
  arch: 'x64',
  cpus: 4,
  cpuPercent: null,
  memory: { totalBytes: 100, usedBytes: 20, botsBytes: 10 },
  disk: { totalBytes: 100, usedBytes: 20 },
  uptimeSeconds: 100,
  gatewayVersion: '1',
  botImage: 'bot',
  botImageVersion: null,
  dockerVersion: null,
}
function response(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}
beforeEach(() => {
  state.settings.clear()
  state.secure.clear()
  state.secureAvailable = true
  state.events.length = 0
  state.broadcasts.length = 0
  state.activity.length = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname
      if (init.headers instanceof Headers) {
        expect(init.headers.get('X-Maestrly-Fleet-Protocol')).toBe('1')
      }
      if (path === '/v1/meta')
        return response({
          protocol: 1,
          gatewayVersion: '1',
          botImage: 'bot',
          botImageVersion: null,
        })
      if (path === '/v1/pair') return response({ deviceId: 'device-1', token: 'secret' })
      if (path === '/v1/host') return response(host)
      if (path === '/v1/bots') return response({ bots: [] })
      if (path === '/v1/inbox') return response({ items: [] })
      if (path === '/v1/peer-messages') return response({ messages: [] })
      if (path === '/v1/activity') {
        const after = Number(new URL(url).searchParams.get('after'))
        return response({
          entries: state.activity.filter((item) => item.seq > after),
          lastSeq: state.activity.at(-1)?.seq ?? 0,
        })
      }
      if (path === '/v1/devices/self') return new Response(null, { status: 204 })
      throw new Error('Unexpected route ' + path)
    })
  )
})
describe('fleet client service', () => {
  it('pairs, securely stores credentials, skips the first digest, then persists an acknowledged digest', async () => {
    state.activity.push({
      seq: 1,
      at: '2026-01-01T00:00:00Z',
      botId: null,
      kind: 'bot_started',
      summary: null,
      data: {},
    })
    const service = new FleetClientService()
    await service.connect({
      url: 'http://127.0.0.1:7443',
      code: 'abcd-efgh',
      deviceName: 'Mac',
    })
    expect(service.getConnection().deviceId).toBe('device-1')
    expect(state.broadcasts.find((event) => event.channel === 'fleet:connection')?.payload).toMatchObject({
      deviceId: 'device-1',
    })
    expect(readFleetSettings()).toMatchObject({
      url: 'http://127.0.0.1:7443',
      deviceId: 'device-1',
      token: 'secret',
      tokenPersistence: 'secure',
    })
    await state.events[0].onConnected()
    expect(service.getSnapshot().host?.hostname).toBe('fleet-host')
    expect(service.getDigest()).toBeNull()
    expect(readFleetSettings().lastActivitySeq).toBe(1)
    state.activity.push({
      seq: 2,
      at: '2026-01-01T00:01:00Z',
      botId: null,
      kind: 'bot_started',
      summary: null,
      data: {},
    })
    await state.events[0].onConnected()
    expect(service.getDigest()?.entries.map((item) => item.seq)).toEqual([2])
    service.ackDigest(2)
    expect(readFleetSettings().lastActivitySeq).toBe(2)
    expect(service.getDigest()).toBeNull()
    await service.disconnect()
    expect(service.getConnection().deviceId).toBeNull()
    expect(readFleetSettings().token).toBeNull()
  })

  it('restores digest elapsed time after an app restart', async () => {
    const first = new FleetClientService()
    await first.connect({ url: 'http://127.0.0.1:7443', code: 'ABCDEFGH' })
    await state.events[0].onConnected()
    first.stop()
    state.settings.set('fleet.lastSeenAt', String(Date.now() - 60_000))
    state.activity.push({
      seq: 1,
      at: '2026-01-01T00:00:00Z',
      botId: null,
      kind: 'bot_started',
      summary: null,
      data: {},
    })
    const restarted = new FleetClientService()
    restarted.start()
    expect(restarted.getConnection().deviceId).toBe('device-1')
    await state.events[1].onConnected()
    expect(restarted.getDigest()?.awayMs).toBeGreaterThanOrEqual(59_000)
    restarted.stop()
  })

  it('keeps token in memory when secure storage is unavailable', async () => {
    state.secureAvailable = false
    const service = new FleetClientService()
    const view = await service.connect({
      url: 'http://127.0.0.1:7443',
      code: 'ABCDEFGH',
    })
    expect(view.tokenPersistence).toBe('memory')
    expect(readFleetSettings().token).toBe('secret')
    expect(state.secure.size).toBe(0)
    service.stop()
  })

  it('rejects unsafe URLs before calling the gateway', async () => {
    const service = new FleetClientService()
    await expect(service.connect({ url: 'http://example.com', code: 'ABCDEFGH' })).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    })
    expect(vi.mocked(fetch)).not.toHaveBeenCalled()
  })
})
