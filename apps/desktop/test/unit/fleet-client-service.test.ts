import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const state = vi.hoisted(() => ({
  settings: new Map<string, string>(),
  secure: new Map<string, string>(),
  secureAvailable: true,
  features: undefined as string[] | undefined,
  events: [] as {
    onConnected: () => Promise<void>
    onEvent: (event: unknown) => void
    options: { desktopBridge?: boolean } | undefined
  }[],
  broadcasts: [] as { channel: string; payload: unknown }[],
  download: vi.fn(),
  reveal: vi.fn(),
}))
vi.mock('electron', async (original) => ({
  ...(await original<typeof import('electron')>()),
  shell: { showItemInFolder: state.reveal },
}))
vi.mock('../../src/main/fleet/client/downloads', () => ({ saveFleetFile: state.download }))
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
    constructor(
      _api: unknown,
      onEvent: (event: unknown) => void,
      _onState: unknown,
      onConnected: () => Promise<void>,
      _pause?: unknown,
      _heartbeat?: unknown,
      options?: { desktopBridge?: boolean }
    ) {
      state.events.push({ onConnected, onEvent, options })
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
  state.download.mockReset()
  state.reveal.mockReset()
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
  it('restores existing downloads across service restarts and isolates paired gateways', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'fleet-history-'))
    try {
      const firstPath = join(directory, 'report.pdf')
      const secondPath = join(directory, 'report (1).pdf')
      await writeFile(firstPath, 'first')
      await writeFile(secondPath, 'second')
      const service = new FleetClientService()
      Object.assign(service, {
        api: { call: vi.fn(async () => ({ capabilities: ['files'] })) },
        connection: { features: ['files'], deviceId: 'device-1' },
      })
      state.download.mockResolvedValueOnce(firstPath).mockResolvedValueOnce(secondPath)
      const first = await service.downloadFile('bot', 'f-file')
      const second = await service.downloadFile('bot', 'f-file')
      expect(second).not.toBe(first)
      await expect(service.revealDownload(firstPath)).rejects.toThrow('FLEET_LOCAL_DOWNLOAD_MISSING')
      await expect(service.revealDownload('550e8400-e29b-41d4-a716-446655440000')).rejects.toThrow()
      expect(state.reveal).not.toHaveBeenCalled()
      service.stop()
      const restarted = new FleetClientService()
      Object.assign(restarted, { connection: { deviceId: 'device-1' } })
      expect(await restarted.getDownload('bot', 'f-file')).toBe(second)
      expect(await restarted.getDownload('other-bot', 'f-file')).toBeNull()
      await restarted.revealDownload(first)
      await restarted.revealDownload(second)
      expect(state.reveal.mock.calls).toEqual([[firstPath], [secondPath]])
      Object.assign(restarted, { connection: { deviceId: 'another-gateway-device' } })
      expect(await restarted.getDownload('bot', 'f-file')).toBeNull()
      Object.assign(restarted, { connection: { deviceId: 'device-1' } })
      await rm(secondPath)
      expect(await restarted.getDownload('bot', 'f-file')).toBe(first)
      await rm(firstPath)
      expect(await restarted.getDownload('bot', 'f-file')).toBeNull()
      await expect(restarted.revealDownload(second)).rejects.toThrow('FLEET_LOCAL_DOWNLOAD_MISSING')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
  it('cancels active file transfers when this connection is stopped', async () => {
    const service = new FleetClientService()
    Object.assign(service, {
      api: { call: vi.fn(async () => ({ capabilities: ['files'] })) },
      connection: { features: ['files'], deviceId: 'device-1' },
    })
    state.download.mockImplementation(
      (_api, _botId, _fileId, { signal }: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    )
    const saving = service.downloadFile('bot', 'f-file')
    await vi.waitFor(() => expect(state.download).toHaveBeenCalledOnce())
    service.stop()
    await expect(saving).rejects.toThrow()
    expect(state.download.mock.calls[0][3].signal.aborted).toBe(true)
  })

  it('never starts saving a file if the connection changed during metadata checks', async () => {
    const service = new FleetClientService()
    let finish!: (value: { capabilities: string[] }) => void
    Object.assign(service, {
      api: {
        call: () =>
          new Promise((resolve) => {
            finish = resolve
          }),
      },
      connection: { features: ['files'], deviceId: 'device-1' },
    })
    const saving = service.downloadFile('bot', 'f-file')
    service.stop()
    finish({ capabilities: ['files'] })
    await expect(saving).rejects.toThrow()
    expect(state.download).not.toHaveBeenCalled()
  })
  it('hands desktop calls to the bridge only, announces it on the stream, and ends its access when unpairing', async () => {
    const bridge = {
      handle: vi.fn(() => true),
      connected: vi.fn(async () => {}),
      unpaired: vi.fn(async () => {}),
      stop: vi.fn(),
    }
    const service = new FleetClientService()
    service.desktopBridge = bridge
    await service.connect({ url: 'http://127.0.0.1:7443', code: 'abcd-efgh' })
    expect(state.events[0].options).toEqual({ desktopBridge: true })
    await state.events[0].onConnected()
    expect(bridge.connected).toHaveBeenCalled()
    const call = {
      type: 'desktop.call',
      at: '2026-10-05T10:00:00.000Z',
      callId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
      botId: 'scout',
      desktopId: 'dsk_0123456789abcdefABCD',
      op: 'listWorkspaces',
      input: {},
      expiresAt: '2026-10-05T10:00:25.000Z',
    }
    state.broadcasts.length = 0
    state.events[0].onEvent(call)
    expect(bridge.handle).toHaveBeenLastCalledWith(call)
    // No window ever sees a call.
    expect(state.broadcasts.filter((event) => event.channel === 'fleet:event')).toEqual([])
    const links = { type: 'desktop_link.updated', at: call.at, botId: 'scout', links: [] }
    state.events[0].onEvent(links)
    expect(bridge.handle).toHaveBeenLastCalledWith(links)
    expect(state.broadcasts.filter((event) => event.channel === 'fleet:event').map((event) => event.payload)).toEqual([
      links,
    ])
    await service.disconnect()
    expect(bridge.unpaired).toHaveBeenCalledWith('device-1')
    expect(bridge.stop).toHaveBeenCalled()

    // Without a bridge this Mac never says it takes desktop calls.
    const plain = new FleetClientService()
    await plain.connect({ url: 'http://127.0.0.1:7443', code: 'abcd-efgh' })
    expect(state.events.at(-1)?.options).toEqual({ desktopBridge: false })
  })
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
