import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const state = vi.hoisted(() => ({
  settings: new Map<string, string>(),
  secure: new Map<string, string>(),
  secureAvailable: true,
  features: undefined as string[] | undefined,
  gatewayId: undefined as string | undefined,
  events: [] as {
    onConnected: () => Promise<void>
    onEvent: (event: unknown) => void
    onState: (state: string, error: string | null) => void
    stop: ReturnType<typeof vi.fn>
    options: { desktopBridge?: boolean; runners?: boolean } | undefined
  }[],
  broadcasts: [] as { channel: string; payload: unknown }[],
  download: vi.fn(),
  reveal: vi.fn(),
  userData: '',
  progress: [] as unknown[],
}))
vi.mock('electron', async (original) => ({
  ...(await original<typeof import('electron')>()),
  app: { getPath: () => state.userData },
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
      onState: (state: string, error: string | null) => void,
      onConnected: () => Promise<void>,
      _pause?: unknown,
      _heartbeat?: unknown,
      options?: { desktopBridge?: boolean; runners?: boolean }
    ) {
      state.events.push({ onConnected, onEvent, onState, stop: this.stop, options })
    }
    start() {}
    stop = vi.fn()
  },
}))

import { FleetClientService } from '../../src/main/fleet/client/service'
import { FleetClientError } from '../../src/main/fleet/client/api'
import { FleetMediaCache } from '../../src/main/fleet/client/media-cache'
import { FleetMediaUrls, parseFleetMediaUrl } from '../../src/main/fleet/client/media-protocol'
import { pairWithGateway } from '../../src/main/fleet/client/pairing'
import type { TokenPersistence } from '../../src/main/fleet/client/settings'
import type { FleetServerId } from '../../src/shared/fleet-servers'

const SERVER = 'aaaaaaaa-0000-4000-8000-000000000001' as FleetServerId
const OTHER_SERVER = 'bbbbbbbb-0000-4000-8000-000000000002' as FleetServerId
type Credentials = {
  url: string
  deviceId: string
  deviceName: string
  token: string | null
  persistence: TokenPersistence
}
/** A client of one paired server; its credentials can change between starts, as the registry changes them. */
function makeClient(
  options: {
    serverId?: FleetServerId
    credentials?: Partial<Credentials>
    media?: FleetMediaCache
    mediaUrls?: FleetMediaUrls
    onGatewayId?: (gatewayId: string) => void
  } = {}
) {
  const credentials: Credentials = {
    url: 'http://127.0.0.1:7443',
    deviceId: 'device-1',
    deviceName: 'Mac',
    token: 'secret',
    persistence: 'secure',
    ...options.credentials,
  }
  const service = new FleetClientService({
    serverId: options.serverId ?? SERVER,
    credentials: () => credentials,
    media:
      options.media ??
      new FleetMediaCache({
        root: () => join(state.userData, 'fleet-media-cache'),
        onProgress: (progress) => state.progress.push(progress),
      }),
    mediaUrls: options.mediaUrls ?? new FleetMediaUrls(),
    onGatewayId: options.onGatewayId,
  })
  return Object.assign(service, { credentials })
}

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
  state.gatewayId = undefined
  state.secureAvailable = true
  state.events.length = 0
  state.broadcasts.length = 0
  state.progress.length = 0
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
          serverId: state.gatewayId,
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
      const service = makeClient()
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
      const restarted = makeClient()
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
    const service = makeClient()
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

  it('names prepared videos with capability URLs, plays cached ones offline and forgets a removed bot', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'fleet-media-service-'))
    try {
      const bytes = Buffer.from('synthetic video bytes')
      const ref = { id: 'f-clip', name: 'clip.mp4', mediaType: 'video/mp4', byteSize: bytes.length }
      const openFile = vi.fn(async () => ({ ref, response: new Response(new Uint8Array(bytes)) }))
      state.userData = directory
      const service = makeClient()
      Object.assign(service, {
        api: { openFile },
        connection: { features: ['files'], deviceId: 'device-1' },
      })
      const url = await service.prepareMedia('bot', 'f-clip')
      const request = parseFleetMediaUrl(url)!
      expect(request).toMatchObject({ botId: 'bot', fileId: 'f-clip' })
      // The cache names the pairing the video came through; the registry turns it into the server for the windows.
      expect(state.progress.at(-1)).toEqual({
        scope: 'device-1',
        botId: 'bot',
        fileId: 'f-clip',
        received: bytes.length,
        total: bytes.length,
      })
      expect(request.serverId).toBe(SERVER)
      expect(await service.mediaEntry({ ...request, serverId: OTHER_SERVER })).toBeNull()
      expect(await service.mediaEntry({ ...request, capability: '0'.repeat(32) })).toBeNull()
      expect(await service.mediaEntry({ ...request, fileId: 'f-other' })).toBeNull()
      // Offline, a cached copy still plays.
      Object.assign(service, { api: null })
      expect(await service.mediaEntry(request)).toMatchObject({ ref, mediaType: 'video/mp4' })
      expect(openFile).toHaveBeenCalledTimes(1)
      // Another pairing cannot use this URL.
      Object.assign(service, { connection: { features: ['files'], deviceId: 'device-2' } })
      expect(await service.mediaEntry(request)).toBeNull()
      Object.assign(service, { connection: { features: [], deviceId: 'device-1' }, api: { openFile } })
      await expect(service.prepareMedia('bot', 'f-new')).rejects.toThrow('FLEET_FILES_UNSUPPORTED')
      Object.assign(service, { connection: { features: ['files'], deviceId: 'device-1' } })
      // A file the bot no longer has is a 404 for the player, not a failure.
      const urls = (service as unknown as { mediaUrls: { url: (...ids: string[]) => string } }).mediaUrls
      const missing = parseFleetMediaUrl(urls.url(SERVER, 'device-1', 'bot', 'f-gone'))!
      openFile.mockRejectedValueOnce(new FleetClientError('NOT_FOUND', 404, 'gone'))
      expect(await service.mediaEntry(missing)).toBeNull()
      openFile.mockRejectedValueOnce(new FleetClientError('INTERNAL', 500, 'down'))
      await expect(service.mediaEntry(missing)).rejects.toThrow('down')
      const cached = async () =>
        (await readdir(join(directory, 'fleet-media-cache'))).filter((name) => name.endsWith('.media'))
      expect(await cached()).toHaveLength(1)
      ;(service as unknown as { applyEvent: (event: unknown) => void }).applyEvent({
        type: 'bot.removed',
        botId: 'bot',
      })
      await vi.waitFor(async () => expect(await cached()).toEqual([]))
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('runs one transfer per file, reports its progress to every window, and names the bot in its notice', async () => {
    const service = makeClient()
    const settled = vi.fn()
    service.onDownloadSettled = settled
    Object.assign(service, {
      api: { call: vi.fn(async () => ({ capabilities: ['files'] })) },
      connection: { features: ['files'], deviceId: 'device-1' },
      snapshot: { bots: [{ id: 'bot', name: 'Scout' }] },
    })
    let finish!: (path: string) => void
    state.download.mockImplementation(
      (_api, _botId, _fileId, options: { onProgress: (progress: unknown) => void }) =>
        new Promise((resolve) => {
          options.onProgress({ name: 'big.zip', receivedBytes: 0, totalBytes: 2048 })
          finish = resolve
        })
    )
    const first = service.downloadFile('bot', 'f-file')
    // Leaving the chat and coming back asks again: it joins the running transfer.
    const second = service.downloadFile('bot', 'f-file')
    await vi.waitFor(() => expect(state.download).toHaveBeenCalledOnce())
    expect(service.getActiveDownload('bot', 'f-file')).toMatchObject({ receivedBytes: 0, totalBytes: 2048 })
    const progress = state.broadcasts.filter((event) => event.channel === 'fleet:download')
    expect(progress.at(-1)?.payload).toMatchObject({
      serverId: service.serverId,
      event: { type: 'progress', botId: 'bot', fileId: 'f-file', totalBytes: 2048 },
    })
    finish('/downloads/big.zip')
    const receipt = await first
    expect(await second).toBe(receipt)
    expect(service.getActiveDownload('bot', 'f-file')).toBeNull()
    expect(state.broadcasts.at(-1)).toEqual({
      channel: 'fleet:download',
      payload: { serverId: service.serverId, event: { type: 'saved', botId: 'bot', fileId: 'f-file', receipt } },
    })
    expect(settled).toHaveBeenCalledExactlyOnceWith(
      service.serverId,
      expect.objectContaining({ outcome: 'saved', name: 'big.zip', path: '/downloads/big.zip', receipt }),
      'Scout'
    )
  })

  it('cancels one transfer on request and marks a file the gateway no longer has', async () => {
    const service = makeClient()
    const settled = vi.fn()
    service.onDownloadSettled = settled
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
    service.cancelDownload('bot', 'f-file')
    await expect(saving).rejects.toThrow('FLEET_DOWNLOAD_CANCELED')
    expect(state.broadcasts.at(-1)?.payload).toEqual({
      serverId: service.serverId,
      event: { type: 'canceled', botId: 'bot', fileId: 'f-file' },
    })
    expect(settled).not.toHaveBeenCalled()
    state.download.mockRejectedValueOnce(new FleetClientError('NOT_FOUND', 404, 'File expired'))
    await expect(service.downloadFile('bot', 'f-file')).rejects.toThrow('FLEET_FILE_NOT_FOUND')
    expect(settled).toHaveBeenCalledExactlyOnceWith(
      service.serverId,
      expect.objectContaining({ outcome: 'failed', error: 'FLEET_FILE_NOT_FOUND' }),
      null
    )
  })

  it('never starts saving a file if the connection changed during metadata checks', async () => {
    const service = makeClient()
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
    const service = makeClient()
    service.desktopBridge = bridge
    service.start()
    expect(state.events[0].options).toEqual({ desktopBridge: true, runners: false })
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
      { serverId: SERVER, event: links },
    ])
    await service.unpair()
    expect(bridge.unpaired).toHaveBeenCalledWith('device-1')
    expect(bridge.stop).toHaveBeenCalled()

    // Without a bridge this Mac never says it takes desktop calls.
    const plain = makeClient()
    plain.start()
    expect(state.events.at(-1)?.options).toEqual({ desktopBridge: false, runners: false })
  })
  it('runs jobs for bots over the stream while the runner wants them, and shows no window the runner’s events', async () => {
    let enabled = false
    const runner = {
      wants: vi.fn(() => enabled && service.hasFeature('runners')),
      connected: vi.fn(async () => {}),
      disconnected: vi.fn(),
      handle: vi.fn(() => true),
      unpaired: vi.fn(async () => {}),
    }
    const service = makeClient()
    service.runnerHost = runner
    // The server announces runners only once the stream is open.
    state.features = ['runners']
    enabled = true
    service.start()
    expect(state.events).toHaveLength(1)
    expect(state.events[0].options).toEqual({ desktopBridge: false, runners: false })

    // Now it is known: the stream is replaced by one that takes jobs, before anything else is read.
    await state.events[0].onConnected()
    expect(state.events).toHaveLength(2)
    expect(state.events[0].stop).toHaveBeenCalled()
    expect(state.events[1].options).toEqual({ desktopBridge: false, runners: true })
    expect(runner.connected).not.toHaveBeenCalled()
    expect(vi.mocked(fetch).mock.calls.map(([url]) => new URL(String(url)).pathname)).not.toContain('/v1/bots')

    // The new stream is the one that reports. The old one's callbacks no longer count.
    await state.events[1].onConnected()
    expect(state.events).toHaveLength(2)
    expect(runner.connected).toHaveBeenCalledTimes(1)
    state.events[0].onEvent({ type: 'hello', at: '2026-10-29T10:00:00.000Z', lastActivitySeq: 0 })
    expect(runner.handle).not.toHaveBeenCalled()

    const at = '2026-10-29T10:00:00.000Z'
    const events = [
      { type: 'runner.cancel', at, jobId: 'job_AAAAAAAAAAAAAAAA0001' },
      { type: 'runner_link.updated', at, botId: 'scout', links: [] },
    ]
    state.broadcasts.length = 0
    for (const event of events) {
      state.events[1].onEvent(event)
      expect(runner.handle).toHaveBeenLastCalledWith(event)
    }
    expect(state.broadcasts.filter((broadcast) => broadcast.channel === 'fleet:event')).toEqual([])

    // A stream that is not open holds no jobs.
    runner.disconnected.mockClear()
    state.events[1].onState('reconnecting', 'down')
    expect(runner.disconnected).toHaveBeenCalledTimes(1)
    state.events[1].onState('connected', null)
    expect(runner.disconnected).toHaveBeenCalledTimes(1)

    // Turning the runner off opens the stream again without asking for jobs.
    enabled = false
    expect(service.syncRunnerStream()).toBe(true)
    expect(state.events).toHaveLength(3)
    expect(state.events[1].stop).toHaveBeenCalled()
    expect(state.events[2].options).toEqual({ desktopBridge: false, runners: false })
    // Nothing to change when the stream already matches.
    expect(service.syncRunnerStream()).toBe(false)
    expect(state.events).toHaveLength(3)
    await state.events[2].onConnected()
    expect(runner.connected).toHaveBeenCalledTimes(1)

    await service.unpair()
    expect(runner.unpaired).toHaveBeenCalledTimes(1)
  })

  it('opens no new stream for the runner while the server was never reached or refuses this computer', async () => {
    let wants = false
    const runner = {
      wants: vi.fn(() => wants),
      connected: vi.fn(async () => {}),
      disconnected: vi.fn(),
      handle: vi.fn(() => true),
      unpaired: vi.fn(async () => {}),
    }
    const unconfigured = makeClient({ credentials: { token: null } })
    unconfigured.runnerHost = runner
    unconfigured.start()
    wants = true
    expect(unconfigured.syncRunnerStream()).toBe(false)
    expect(state.events).toHaveLength(0)

    wants = false
    for (const refusal of ['unauthorized', 'incompatible']) {
      state.events.length = 0
      const refused = makeClient()
      refused.runnerHost = runner
      refused.start()
      expect(state.events[0].options?.runners).toBe(false)
      state.events[0].onState(refusal, 'refused')
      wants = true
      expect(refused.syncRunnerStream()).toBe(false)
      expect(state.events).toHaveLength(1)
      wants = false
    }
  })

  it('takes the features the gateway advertised while pairing, then reads them on every reconnect', async () => {
    state.features = ['provisioning']
    const service = makeClient()
    service.start()
    expect(service.getConnection().features).toEqual([])
    service.restart(['provisioning'])
    expect(service.getConnection().features).toEqual(['provisioning'])
    state.features = undefined
    await state.events.at(-1)!.onConnected()
    expect(service.getConnection().features).toEqual([])
    state.features = ['provisioning']
    await state.events.at(-1)!.onConnected()
    expect(service.getConnection().features).toEqual(['provisioning'])
    await service.unpair()
    expect(service.getConnection().features).toEqual([])
  })
  it('passes on the installation id the gateway announces when it connects', async () => {
    const announced: string[] = []
    const service = makeClient({ onGatewayId: (gatewayId) => announced.push(gatewayId) })
    service.start()
    await state.events.at(-1)!.onConnected()
    expect(announced).toEqual([])
    state.gatewayId = '11111111-2222-4333-8444-555555555555'
    await state.events.at(-1)!.onConnected()
    expect(announced).toEqual(['11111111-2222-4333-8444-555555555555'])
  })
  it('pairs as a computer, and refuses unsafe addresses before calling the gateway', async () => {
    await expect(
      pairWithGateway({ url: 'http://example.com', code: 'ABCDEFGH', deviceName: 'Mac' })
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(vi.mocked(fetch)).not.toHaveBeenCalled()
    state.features = ['phones']
    const paired = await pairWithGateway({ url: 'http://127.0.0.1:7443/', code: 'abcd-efgh', deviceName: 'Mac' })
    expect(paired).toEqual({
      origin: 'http://127.0.0.1:7443',
      deviceId: 'device-1',
      deviceName: 'Mac',
      token: 'secret',
      features: ['phones'],
      gatewayId: null,
    })
    // The computer says what it is, so the server's list of devices can tell it from a phone.
    const pairing = vi.mocked(fetch).mock.calls.find(([url]) => new URL(String(url)).pathname === '/v1/pair')
    expect(JSON.parse(String(pairing?.[1]?.body))).toEqual({
      code: 'ABCDEFGH',
      deviceName: 'Mac',
      client: {
        kind: 'computer',
        platform: process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux',
      },
    })
    // An installation it refuses is refused before its code is spent.
    state.gatewayId = '11111111-2222-4333-8444-555555555555'
    vi.mocked(fetch).mockClear()
    const accept = vi.fn(() => {
      throw new Error('FLEET_SERVER_ALREADY_PAIRED')
    })
    await expect(
      pairWithGateway({ url: 'http://127.0.0.1:7443/', code: 'abcd-efgh', deviceName: 'Mac', accept })
    ).rejects.toThrow('FLEET_SERVER_ALREADY_PAIRED')
    expect(accept).toHaveBeenCalledWith('11111111-2222-4333-8444-555555555555')
    const paths = vi.mocked(fetch).mock.calls.map(([url]) => new URL(String(url)).pathname)
    expect(paths).toEqual(['/v1/meta'])
  })
  it('connects with its stored credentials, refreshes without fetching past activity, and leaves the server', async () => {
    const service = makeClient()
    service.start()
    expect(service.getConnection()).toMatchObject({ deviceId: 'device-1', state: 'connecting' })
    expect(state.broadcasts.find((event) => event.channel === 'fleet:connection')?.payload).toEqual({
      serverId: SERVER,
      connection: expect.objectContaining({ deviceId: 'device-1', state: 'connecting' }),
    })
    await state.events[0].onConnected()
    expect(service.getSnapshot().host?.hostname).toBe('fleet-host')
    // Only live activity reaches the Mac; the history of what it missed is not fetched.
    const paths = vi.mocked(fetch).mock.calls.map(([url]) => new URL(String(url)).pathname)
    expect(paths).not.toContain('/v1/activity')
    await service.unpair()
    expect(paths.concat(vi.mocked(fetch).mock.calls.map(([url]) => new URL(String(url)).pathname))).toContain(
      '/v1/devices/self'
    )
    expect(service.getConnection()).toMatchObject({ deviceId: null, state: 'unconfigured', url: null })
    expect(state.broadcasts.filter((item) => item.channel === 'fleet:connection').at(-1)?.payload).toEqual({
      serverId: SERVER,
      connection: expect.objectContaining({ state: 'unconfigured' }),
    })
  })

  it('waits to be paired again when its token was kept for an earlier session only', () => {
    const service = makeClient({ credentials: { token: null, persistence: 'memory' } })
    service.start()
    expect(service.getConnection()).toMatchObject({
      state: 'unconfigured',
      url: 'http://127.0.0.1:7443',
      deviceId: 'device-1',
      tokenPersistence: 'memory',
    })
    expect(state.events).toEqual([])
  })

  it("deletes only its own pairing's videos when it leaves its server", async () => {
    const directory = await mkdtemp(join(tmpdir(), 'fleet-media-scopes-'))
    try {
      state.userData = directory
      const media = new FleetMediaCache({ root: () => join(directory, 'fleet-media-cache') })
      const mediaUrls = new FleetMediaUrls()
      const bytes = Buffer.from('synthetic video bytes')
      const ref = { id: 'f-clip', name: 'clip.mp4', mediaType: 'video/mp4', byteSize: bytes.length }
      const openFile = vi.fn(async () => ({ ref, response: new Response(new Uint8Array(bytes)) }))
      const first = makeClient({ media, mediaUrls })
      const second = makeClient({ serverId: OTHER_SERVER, media, mediaUrls })
      Object.assign(first, { api: { openFile }, connection: { features: ['files'], deviceId: 'device-1' } })
      Object.assign(second, { api: { openFile }, connection: { features: ['files'], deviceId: 'device-2' } })
      await first.prepareMedia('bot', 'f-clip')
      await second.prepareMedia('bot', 'f-clip')
      const cached = async () =>
        (await readdir(join(directory, 'fleet-media-cache'))).filter((name) => name.endsWith('.media'))
      expect(await cached()).toHaveLength(2)
      Object.assign(first, { api: { openFile, call: vi.fn(async () => undefined) } })
      await first.unpair()
      expect(await cached()).toHaveLength(1)
      const kept = parseFleetMediaUrl(await second.prepareMedia('bot', 'f-clip'))!
      Object.assign(second, { api: null })
      expect(await second.mediaEntry(kept)).toMatchObject({ ref })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('drops an archived bot from the snapshot whatever the event order', async () => {
    const service = makeClient()
    service.start()
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

  it('sounds for live bot activity the owner is waiting on, and hands every live entry on', async () => {
    const service = makeClient()
    const alerts: string[] = []
    const seen: number[] = []
    service.onAlert = (botId, alert) => alerts.push(botId + ':' + alert)
    service.onLiveEvent = (entry) => seen.push(entry.seq)
    service.start()
    await state.events[0].onConnected()
    const at = '2026-01-01T00:00:00Z'
    const entry = (
      seq: number,
      kind: 'bot_started' | 'turn_completed' | 'turn_failed' | 'needs_you',
      data: Record<string, string | boolean> = {},
      botId: string | null = 'scout'
    ) => ({ seq, at, botId, kind, summary: null, data })
    const live = [
      entry(3, 'turn_completed', { source: 'owner' }),
      entry(4, 'turn_failed', { source: 'continuation' }, 'orders'),
      // A routine run sounds as the bot's settings say; peer messages end silently; what waits for the owner sounds
      // whoever started it.
      entry(5, 'turn_completed', { source: 'routine', alert: true }, 'digest'),
      entry(6, 'turn_completed', { source: 'routine', alert: false }),
      entry(7, 'turn_failed', { source: 'peer' }),
      entry(8, 'needs_you', {}, 'ads'),
      // A gateway that does not say who started a turn still sounds.
      entry(9, 'turn_failed', {}, 'crm'),
      entry(10, 'bot_started'),
      entry(11, 'turn_completed', { source: 'owner' }, null),
    ]
    for (const item of live) state.events[0].onEvent({ type: 'activity', at, entry: item })
    expect(alerts).toEqual(['scout:ready', 'orders:error', 'digest:ready', 'ads:permission', 'crm:error'])
    expect(seen).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11])
    // A failing sound or notice does not keep the event from the window.
    service.onAlert = () => {
      throw new Error('Synthetic sound failure')
    }
    service.onLiveEvent = () => {
      throw new Error('Synthetic notice failure')
    }
    state.broadcasts.length = 0
    state.events[0].onEvent({ type: 'activity', at, entry: entry(12, 'needs_you') })
    expect(state.broadcasts.map((item) => item.channel)).toEqual(['fleet:event'])
    service.stop()
  })

  it('reconnects at the address its credentials name now, keeping its device and token', async () => {
    const service = makeClient()
    service.start()
    const before = state.events.length
    service.credentials.url = 'http://127.0.0.1:7471'
    service.restart()
    expect(service.getConnection()).toMatchObject({ url: 'http://127.0.0.1:7471', deviceId: 'device-1' })
    // A new event stream to the new address, with the same credentials.
    expect(state.events.length).toBe(before + 1)
    await state.events.at(-1)!.onConnected()
    const hosts = vi
      .mocked(fetch)
      .mock.calls.map(([url]) => new URL(String(url)).host)
      .slice(-3)
    expect(hosts.every((host) => host === '127.0.0.1:7471')).toBe(true)
    service.stop()
  })

  it('keeps how its token is stored in its connection', () => {
    const service = makeClient({ credentials: { persistence: 'memory' } })
    service.start()
    expect(service.getConnection().tokenPersistence).toBe('memory')
    service.stop()
  })
})
