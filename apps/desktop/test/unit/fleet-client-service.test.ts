import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  settings: new Map<string, string>(),
  secure: new Map<string, string>(),
  secureAvailable: true,
  features: undefined as string[] | undefined,
  events: [] as {
    onConnected: () => Promise<void>
    onEvent: (event: unknown) => void
  }[],
  broadcasts: [] as { channel: string; payload: unknown }[],
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
  state.features = undefined
  state.secureAvailable = true
  state.events.length = 0
  state.broadcasts.length = 0
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
          features: state.features,
          gatewayVersion: '1',
          botImage: 'bot',
          botImageVersion: null,
        })
      if (path === '/v1/pair') return response({ deviceId: 'device-1', token: 'secret' })
      if (path === '/v1/host') return response(host)
      if (path === '/v1/bots') return response({ bots: [] })
      if (path === '/v1/environments') return response({ environments: [] })
      if (path === '/v1/inbox') return response({ items: [] })
      if (path === '/v1/peer-messages') return response({ messages: [] })
      if (path === '/v1/devices/self') return new Response(null, { status: 204 })
      throw new Error('Unexpected route ' + path)
    })
  )
})
describe('fleet client service', () => {
  it('refreshes advertised features on connect and every reconnect, defaulting absent metadata to empty', async () => {
    state.features = ['provisioning']
    const service = new FleetClientService()
    await service.connect({ url: 'http://127.0.0.1:7443', code: 'abcd-efgh' })
    expect(service.getConnection().features).toEqual(['provisioning'])
    state.features = undefined
    await state.events[0].onConnected()
    expect(service.getConnection().features).toEqual([])
    state.features = ['provisioning']
    await state.events[0].onConnected()
    expect(service.getConnection().features).toEqual(['provisioning'])
    await service.disconnect()
    expect(service.getConnection().features).toEqual([])
  })
  it('pairs, securely stores credentials, refreshes without fetching past activity, and forgets it all', async () => {
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
    // Only live activity reaches the Mac; the history of what it missed is not fetched.
    const paths = vi.mocked(fetch).mock.calls.map(([url]) => new URL(String(url)).pathname)
    expect(paths).not.toContain('/v1/activity')
    // What older versions kept to summarize the time away is cleared with the rest.
    state.settings.set('fleet.lastActivitySeq', '12')
    state.settings.set('fleet.lastSeenAt', '1700000000000')
    await service.disconnect()
    expect(service.getConnection().deviceId).toBeNull()
    expect(readFleetSettings().token).toBeNull()
    expect([state.settings.get('fleet.lastActivitySeq'), state.settings.get('fleet.lastSeenAt')]).toEqual(['', ''])
  })

  it('drops an archived bot from the snapshot whatever the event order', async () => {
    const service = new FleetClientService()
    await service.connect({ url: 'http://127.0.0.1:7443', code: 'ABCDEFGH' })
    await state.events[0].onConnected()
    const bot = { id: 'scout', name: 'Scout', lifecycle: 'running' }
    const at = '2026-01-01T00:00:00Z'
    state.events[0].onEvent({ type: 'bot.updated', at, bot })
    expect(service.getSnapshot().bots.map((item) => item.id)).toEqual(['scout'])
    state.events[0].onEvent({ type: 'bot.updated', at, bot: { ...bot, lifecycle: 'archived' } })
    expect(service.getSnapshot().bots).toEqual([])
    state.events[0].onEvent({ type: 'bot.updated', at, bot: { ...bot, lifecycle: 'creating' } })
    expect(service.getSnapshot().bots.map((item) => item.id)).toEqual(['scout'])
    service.stop()
  })

  it('sounds for live bot activity the owner is waiting on', async () => {
    const service = new FleetClientService()
    const alerts: string[] = []
    service.onAlert = (botId, alert) => alerts.push(botId + ':' + alert)
    await service.connect({ url: 'http://127.0.0.1:7443', code: 'ABCDEFGH' })
    await state.events[0].onConnected()
    const at = '2026-01-01T00:00:00Z'
    const entry = (
      seq: number,
      kind: 'bot_started' | 'turn_completed' | 'turn_failed' | 'needs_you',
      data: Record<string, string> = {},
      botId: string | null = 'scout'
    ) => ({ seq, at, botId, kind, summary: null, data })
    const live = [
      entry(3, 'turn_completed', { source: 'owner' }),
      entry(4, 'turn_failed', { source: 'continuation' }, 'orders'),
      // Routines and peer messages end silently; what waits for the owner sounds whoever started it.
      entry(5, 'turn_completed', { source: 'routine' }),
      entry(6, 'turn_failed', { source: 'peer' }),
      entry(7, 'needs_you', {}, 'ads'),
      // A gateway that does not say who started a turn still sounds.
      entry(8, 'turn_failed', {}, 'crm'),
      entry(9, 'bot_started'),
      entry(10, 'turn_completed', { source: 'owner' }, null),
    ]
    for (const item of live) state.events[0].onEvent({ type: 'activity', at, entry: item })
    expect(alerts).toEqual(['scout:ready', 'orders:error', 'ads:permission', 'crm:error'])
    // A failing sound does not keep the event from the window.
    service.onAlert = () => {
      throw new Error('Synthetic sound failure')
    }
    state.broadcasts.length = 0
    state.events[0].onEvent({ type: 'activity', at, entry: entry(11, 'needs_you') })
    expect(state.broadcasts.map((item) => item.channel)).toEqual(['fleet:event'])
    service.stop()
  })

  it('reconnects with the stored credentials after an app restart', async () => {
    const first = new FleetClientService()
    await first.connect({ url: 'http://127.0.0.1:7443', code: 'ABCDEFGH' })
    await state.events[0].onConnected()
    first.stop()
    const restarted = new FleetClientService()
    restarted.start()
    expect(restarted.getConnection()).toMatchObject({ deviceId: 'device-1', state: 'connecting' })
    await state.events[1].onConnected()
    expect(restarted.getSnapshot().host?.hostname).toBe('fleet-host')
    restarted.stop()
  })

  it('moves a paired connection to another loopback port, keeping its device and token', async () => {
    const service = new FleetClientService()
    await service.connect({ url: 'http://127.0.0.1:7443', code: 'ABCDEFGH', deviceName: 'Mac' })
    const before = state.events.length
    service.retarget('http://127.0.0.1:7471')
    expect(readFleetSettings()).toMatchObject({
      url: 'http://127.0.0.1:7471',
      deviceId: 'device-1',
      token: 'secret',
      tokenPersistence: 'secure',
    })
    expect(service.getConnection()).toMatchObject({ url: 'http://127.0.0.1:7471', deviceId: 'device-1' })
    // A new event stream to the new address, with the same credentials.
    expect(state.events.length).toBe(before + 1)
    await state.events.at(-1)!.onConnected()
    const hosts = vi
      .mocked(fetch)
      .mock.calls.map(([url]) => new URL(String(url)).host)
      .slice(-3)
    expect(hosts.every((host) => host === '127.0.0.1:7471')).toBe(true)
    expect(() => service.retarget('http://example.com')).toThrow()
    expect(readFleetSettings().url).toBe('http://127.0.0.1:7471')
    service.stop()
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
