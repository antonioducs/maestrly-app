import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcRenderer, shell, type WebContents } from 'electron'
import type {
  FleetBot,
  FleetBotAccounts,
  FleetEnvironment,
  FleetHostInfo,
  FleetLoginAttempt,
  FleetGatewayEvent,
  FleetResources,
  FleetTranscriptItem,
} from '@maestrly/bot-fleet-protocol'
import type { IpcRegistrar } from '../../src/main/ipc-registrar'
import type { FleetClientService as FleetClientServiceType } from '../../src/main/fleet/client/service'

type Options = { params?: Record<string, string>; body?: unknown; query?: Record<string, unknown> }
const features = vi.hoisted(() => ({ list: [] as string[] }))
const mocks = vi.hoisted(() => ({
  settings: new Map<string, string>(),
  events: [] as { onConnected: () => Promise<void>; onEvent: (event: unknown) => void }[],
  call: vi.fn(async (_key: string, _options?: Options): Promise<unknown> => undefined),
  openScreen: vi.fn(
    async (_owner: unknown, _target: unknown, _mode: string): Promise<unknown> => ({ channelId: 'c1' })
  ),
  relayStart: vi.fn(),
}))
vi.mock('../../src/main/store', () => ({
  getAppSetting: (key: string) => mocks.settings.get(key) ?? null,
  setAppSetting: (key: string, value: string) => {
    mocks.settings.set(key, value)
  },
}))
vi.mock('../../src/main/secure-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/secure-store')>()),
  isSecureStorageAvailable: () => true,
  secureGet: () => null,
  secureSet: () => true,
  secureRemove: () => true,
}))
vi.mock('../../src/main/window-ipc', () => ({ broadcast: () => {} }))
vi.mock('../../src/main/fleet/client/events', () => ({
  FleetEvents: class {
    constructor(_api: unknown, onEvent: (event: unknown) => void, _onState: unknown, onConnected: () => Promise<void>) {
      mocks.events.push({ onConnected, onEvent })
    }
    start() {}
    stop() {}
  },
}))
vi.mock('../../src/main/fleet/client/provisioning/login-relay', () => ({ LoginRelay: { start: mocks.relayStart } }))
vi.mock('../../src/main/fleet/client/servers', () => {
  const client = {
    serverId: 'aaaaaaaa-0000-4000-8000-000000000001',
    start: vi.fn(),
    stop: vi.fn(),
    call: mocks.call,
    hasFeature: (feature: string) => features.list.includes(feature),
    getImage: vi.fn(),
    screens: { openScreen: mocks.openScreen, send: vi.fn(), close: vi.fn() },
    idempotencyKey: () => '550e8400-e29b-41d4-a716-446655440000',
  }
  return {
    fleetServers: {
      start: vi.fn(),
      stop: vi.fn(),
      list: () => [],
      require: (serverId: string) => {
        if (serverId !== client.serverId) throw new Error('FLEET_SERVER_UNKNOWN')
        return client
      },
    },
  }
})

import { FleetClientService } from '../../src/main/fleet/client/service'
import { FleetApiClient, FleetClientError } from '../../src/main/fleet/client/api'
import { registerFleetClientIpc } from '../../src/main/fleet/client/ipc'
import { FleetScreenBridge } from '../../src/main/fleet/client/screen-bridge'
import { GATEWAY_RESTART_TO_OPEN_SCREEN, GATEWAY_SCREEN_CONTROLLED } from '../../src/main/fleet/client/targets'
import {
  botLoginStatus,
  cancelBotLogin,
  disposeBotLogins,
  startBotLogin,
} from '../../src/main/fleet/client/provisioning/logins'
import {
  FLEET_ENVIRONMENTS_UNSUPPORTED,
  FLEET_UPDATES_UNSUPPORTED,
  FLEET_RUNTIME_UPDATES_UNSUPPORTED,
  FLEET_SCREEN_CONFLICT,
  FLEET_SCREEN_RESTART_REQUIRED,
  FLEET_SCREEN_UPDATE_REQUIRED,
  FLEET_BOT_MOVE_UNSUPPORTED,
  fleetTargetKey,
} from '../../src/shared/fleet-targets'
import { fleetReducer, initialFleetState, type FleetState } from '../../src/renderer/lib/fleet/state'
import {
  botEnvironments,
  groupBotsByEnvironment,
  isWorkspacesEnvironment,
  workspacesEnvironments,
} from '../../src/renderer/lib/fleet/selectors'
import { memorySegments, outOfMemory, shownSwapBytes } from '../../src/renderer/lib/fleet/format'
import {
  environmentJoinAvailability,
  environmentProvisioningKey,
  provisioningAvailability,
  provisioningTargetForBot,
} from '../../src/renderer/lib/fleet/provisioning'
import {
  isEnvironmentUpdatesUnsupported,
  isEnvironmentsUnsupported,
  isScreenConflict,
} from '../../src/renderer/lib/fleet/errors'
import { FleetScreenChannel, type ScreenApi } from '../../src/renderer/lib/fleet/screen-channel'
import type { FleetController } from '../../src/renderer/lib/fleet/use-fleet'
import { fleetApi } from '../../src/preload/api-fleet'
import type { FleetServerId } from '../../src/shared/fleet-servers'
import { FleetMediaCache } from '../../src/main/fleet/client/media-cache'
import { FleetMediaUrls } from '../../src/main/fleet/client/media-protocol'

const SERVER = 'aaaaaaaa-0000-4000-8000-000000000001' as FleetServerId

const at = '2026-09-26T00:00:00.000Z'
const KEY = '550e8400-e29b-41d4-a716-446655440000'
function environment(id: string, name = id, patch: Partial<FleetEnvironment> = {}): FleetEnvironment {
  return {
    id,
    name,
    kind: 'bots',
    lifecycle: 'running',
    setup: { step: 'ready', error: null, errorMessage: null },
    resources: {
      memoryBytes: null,
      memoryLimitBytes: null,
      cpuPercent: null,
      startedAt: null,
      swapBytes: null,
      oomKills: null,
      limitOoms: null,
    },
    memoryLimitBytes: null,
    cpuLimit: null,
    idleStopMinutes: null,
    tint: null,
    isolation: null,
    compaction: null,
    appVersion: '1.0.0',
    capabilities: ['provisioning', 'environments'],
    update: null,
    runtimes: null,
    botIds: [],
    createdAt: at,
    updatedAt: at,
    ...patch,
  }
}
function bot(id: string, patch: Partial<FleetBot> = {}): FleetBot {
  return {
    id,
    name: id,
    tint: '#123456',
    lifecycle: 'running',
    status: 'idle',
    capabilities: [],
    environmentId: null,
    accounts: { connected: false, providers: [] },
    resources: { memoryBytes: null, memoryLimitBytes: null, cpuPercent: null, startedAt: null },
    ...patch,
  } as FleetBot
}
function json(data: unknown): Response {
  return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } })
}
function register() {
  process.env.MAESTRLY_BOT_MODE = '1'
  const reads = new Map<string, (...args: unknown[]) => unknown>()
  const mutations = new Map<string, (...args: unknown[]) => unknown>()
  registerFleetClientIpc({
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => reads.set(channel, fn),
    mhandle: (channel: string, fn: (...args: unknown[]) => unknown) => mutations.set(channel, fn),
    on: () => {},
    mon: () => {},
  } as unknown as IpcRegistrar)
  const run = (map: typeof reads, channel: string, args: unknown[]) => {
    const handler = map.get(channel)
    if (!handler) throw new Error('Missing handler ' + channel)
    return handler({ sender: {} }, ...args)
  }
  return {
    reads,
    mutations,
    read: (channel: string, ...args: unknown[]) => run(reads, channel, args),
    mutate: (channel: string, ...args: unknown[]) => run(mutations, channel, args),
  }
}
const calls = () => mocks.call.mock.calls.map(([key, options]) => (options === undefined ? [key] : [key, options]))

beforeEach(() => {
  features.list = []
  mocks.settings.clear()
  mocks.events.length = 0
  mocks.call.mockReset()
  mocks.call.mockResolvedValue(undefined)
  mocks.openScreen.mockReset()
  mocks.openScreen.mockResolvedValue({ channelId: 'c1' })
  mocks.relayStart.mockReset()
})
afterEach(async () => {
  delete process.env.MAESTRLY_BOT_MODE
  vi.unstubAllGlobals()
  await disposeBotLogins()
})

describe('environments in the Mac snapshot', () => {
  const host: FleetHostInfo = {
    hostname: 'fleet-host',
    os: 'Linux',
    kernel: '6',
    arch: 'x64',
    cpus: 4,
    cpuPercent: null,
    memory: { totalBytes: 100, usedBytes: 20, botsBytes: 10, swap: null },
    disk: { totalBytes: 100, usedBytes: 20 },
    uptimeSeconds: 100,
    gatewayVersion: '1',
    botImage: 'bot',
    botImageVersion: null,
    dockerVersion: null,
  }
  /** A client of a paired server, connecting with its stored token as it does at start. */
  function startedClient(): FleetClientService {
    const service = new FleetClientService({
      serverId: SERVER,
      credentials: () => ({
        url: 'http://127.0.0.1:7443',
        deviceId: 'device-1',
        deviceName: 'Mac',
        token: 'synthetic-token',
        persistence: 'secure',
      }),
      media: new FleetMediaCache({ root: () => '/nonexistent/fleet-media-cache' }),
      mediaUrls: new FleetMediaUrls(),
    })
    service.start()
    return service
  }
  function stubGateway(meta: { features: string[] }) {
    const paths: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const path = new URL(url).pathname
        paths.push(path)
        if (path === '/v1/meta')
          return json({
            protocol: 1,
            features: meta.features,
            gatewayVersion: '1',
            botImage: 'bot',
            botImageVersion: null,
          })
        if (path === '/v1/pair') return json({ deviceId: 'device-1', token: 'synthetic-token' })
        if (path === '/v1/host') return json(host)
        if (path === '/v1/bots') return json({ bots: [] })
        if (path === '/v1/environments')
          return json({
            environments: [environment('work', 'Work'), environment('old', 'Old', { lifecycle: 'archived' })],
          })
        if (path === '/v1/inbox') return json({ items: [] })
        if (path === '/v1/peer-messages') return json({ messages: [] })
        throw new Error('Unexpected route ' + path)
      })
    )
    return paths
  }

  it('lists environments only from gateways that advertise them and keeps an empty list for older ones', async () => {
    const meta = { features: ['provisioning'] }
    const paths = stubGateway(meta)
    const service = startedClient()
    await mocks.events[0].onConnected()
    expect(service.hasFeature('environments')).toBe(false)
    expect(service.getSnapshot().environments).toEqual([])
    expect(paths).not.toContain('/v1/environments')
    meta.features = ['provisioning', 'environments']
    await mocks.events[0].onConnected()
    expect(service.hasFeature('environments')).toBe(true)
    expect(service.getSnapshot().environments.map((item) => item.id)).toEqual(['work'])
    service.stop()
  })

  it('applies environment events and never keeps an archived or removed environment or its bots', async () => {
    stubGateway({ features: ['environments'] })
    const service = startedClient()
    await mocks.events[0].onConnected()
    const emit = mocks.events[0].onEvent
    emit({ type: 'environment.updated', at, environment: environment('home', 'Home', { botIds: ['scout'] }) })
    emit({ type: 'bot.updated', at, bot: bot('scout', { environmentId: 'home' }) })
    emit({ type: 'bot.updated', at, bot: bot('coder', { environmentId: 'work' }) })
    emit({ type: 'environment.updated', at, environment: environment('home', 'House', { botIds: ['scout'] }) })
    expect(service.getSnapshot().environments.map((item) => [item.id, item.name])).toEqual([
      ['work', 'Work'],
      ['home', 'House'],
    ])
    emit({ type: 'environment.updated', at, environment: environment('home', 'House', { lifecycle: 'archived' }) })
    expect(service.getSnapshot().environments.map((item) => item.id)).toEqual(['work'])
    expect(service.getSnapshot().bots.map((item) => item.id)).toEqual(['coder'])
    emit({ type: 'environment.removed', at, environmentId: 'work' })
    expect(service.getSnapshot().environments).toEqual([])
    expect(service.getSnapshot().bots).toEqual([])
    service.stop()
  })

  it('gives environment sign-ins and skill installs the same longer deadlines as bot ones', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 204 }))
    )
    const api = new FleetApiClient('http://127.0.0.1:7443', 'synthetic-token')
    try {
      await api
        .call('environmentLoginStart', { params: { eid: 'work' }, body: { kind: 'codex', method: 'browser' } })
        .catch(() => {})
      await api
        .call('environmentSkillInstall', {
          params: { eid: 'work' },
          body: { name: 'review', files: [{ path: 'SKILL.md', data: '', executable: false }] },
        })
        .catch(() => {})
      await api.call('environmentSkillsList', { params: { eid: 'work' } }).catch(() => {})
      expect(timeout.mock.calls.map(([ms]) => ms)).toEqual([35_000, 65_000, 15_000])
    } finally {
      timeout.mockRestore()
    }
  })
})

describe('environment IPC', () => {
  it('guards environment mutations as trusted calls and validates them before dispatch', async () => {
    features.list = ['environments']
    const ipc = register()
    for (const channel of [
      'fleet:environmentAction',
      'fleet:patchEnvironment',
      'fleet:restoreArchivedEnvironment',
      'fleet:deleteArchivedEnvironment',
      'fleet:environmentUiOpen',
    ]) {
      expect(ipc.mutations.has(channel)).toBe(true)
      expect(ipc.reads.has(channel)).toBe(false)
    }
    expect(ipc.reads.has('fleet:listArchivedEnvironments')).toBe(true)
    expect(ipc.reads.has('fleet:environmentSelections')).toBe(true)
    expect(ipc.mutations.has('fleet:environmentSelections')).toBe(false)
    expect(() => ipc.read('fleet:environmentSelections', SERVER, '../work')).toThrow()
    expect(() => ipc.mutate('fleet:patchEnvironment', SERVER, 'work', { compaction: { modelId: 'x' } })).toThrow()
    expect(() => ipc.mutate('fleet:environmentAction', SERVER, '../work', 'restart')).toThrow()
    expect(() => ipc.mutate('fleet:environmentAction', SERVER, 'work', 'pause')).toThrow()
    expect(() => ipc.mutate('fleet:patchEnvironment', SERVER, 'work', {})).toThrow()
    expect(() => ipc.mutate('fleet:patchEnvironment', SERVER, 'work', { memoryLimitBytes: 1024 })).toThrow()
    expect(() => ipc.mutate('fleet:patchEnvironment', SERVER, 'work', { name: '' })).toThrow()
    expect(() => ipc.mutate('fleet:environmentUiOpen', SERVER, 'work', 'terminal')).toThrow()
    expect(() => ipc.mutate('fleet:restoreArchivedEnvironment', SERVER, undefined)).toThrow()
    expect(() => ipc.mutate('fleet:deleteArchivedEnvironment', SERVER, 'Work!')).toThrow()
    expect(mocks.call).not.toHaveBeenCalled()
    await ipc.mutate('fleet:environmentAction', SERVER, 'work', 'restart')
    await ipc.mutate('fleet:environmentAction', SERVER, 'work', 'archive')
    await ipc.mutate('fleet:patchEnvironment', SERVER, 'work', { name: 'Work', memoryLimitBytes: 8 * 1024 ** 3 })
    await ipc.mutate('fleet:patchEnvironment', SERVER, 'work', { memoryLimitBytes: null })
    await ipc.read('fleet:listArchivedEnvironments', SERVER)
    await ipc.mutate('fleet:restoreArchivedEnvironment', SERVER, 'work')
    await ipc.mutate('fleet:deleteArchivedEnvironment', SERVER, 'work')
    await ipc.mutate('fleet:environmentUiOpen', SERVER, 'work', 'accounts')
    await ipc.read('fleet:environmentSelections', SERVER, 'work')
    await ipc.mutate('fleet:patchEnvironment', SERVER, 'work', { compaction: null })
    expect(calls()).toEqual([
      ['environmentRestart', { params: { eid: 'work' } }],
      ['environmentArchive', { params: { eid: 'work' } }],
      ['environmentPatch', { params: { eid: 'work' }, body: { name: 'Work', memoryLimitBytes: 8 * 1024 ** 3 } }],
      ['environmentPatch', { params: { eid: 'work' }, body: { memoryLimitBytes: null } }],
      ['archivedEnvironmentsList'],
      ['archivedEnvironmentRestore', { params: { eid: 'work' } }],
      ['archivedEnvironmentDelete', { params: { eid: 'work' } }],
      ['environmentUiOpen', { params: { eid: 'work' }, body: { target: 'accounts' } }],
      ['environmentSelections', { params: { eid: 'work' } }],
      ['environmentPatch', { params: { eid: 'work' }, body: { compaction: null } }],
    ])
  })

  it('schedules, forces and cancels environment updates only on gateways that schedule them', async () => {
    features.list = ['environments']
    const ipc = register()
    for (const channel of ['fleet:environmentUpdate', 'fleet:environmentUpdateCancel']) {
      expect(ipc.mutations.has(channel)).toBe(true)
      expect(ipc.reads.has(channel)).toBe(false)
    }
    // Environments alone are not enough: an older gateway has no update routes.
    expect(() => ipc.mutate('fleet:environmentUpdate', SERVER, 'work', 'idle')).toThrow(FLEET_UPDATES_UNSUPPORTED)
    expect(() => ipc.mutate('fleet:environmentUpdateCancel', SERVER, 'work')).toThrow(FLEET_UPDATES_UNSUPPORTED)
    features.list = ['environments', 'environment-updates']
    expect(() => ipc.mutate('fleet:environmentUpdate', SERVER, 'work', 'later')).toThrow()
    expect(() => ipc.mutate('fleet:environmentUpdate', SERVER, '../work', 'idle')).toThrow()
    expect(() => ipc.mutate('fleet:environmentUpdateCancel', SERVER, 'Work!')).toThrow()
    expect(mocks.call).not.toHaveBeenCalled()
    await ipc.mutate('fleet:environmentUpdate', SERVER, 'acme', 'idle')
    await ipc.mutate('fleet:environmentUpdate', SERVER, 'acme', 'now')
    await ipc.mutate('fleet:environmentUpdateCancel', SERVER, 'acme')
    expect(calls()).toEqual([
      ['environmentUpdate', { params: { eid: 'acme' }, body: { when: 'idle' } }],
      ['environmentUpdate', { params: { eid: 'acme' }, body: { when: 'now' } }],
      ['environmentUpdateCancel', { params: { eid: 'acme' } }],
    ])
    expect(isEnvironmentUpdatesUnsupported(new Error('Error: ' + FLEET_UPDATES_UNSUPPORTED))).toBe(true)
  })

  it('checks environment runtimes only on gateways that relay them', async () => {
    features.list = ['environments', 'environment-updates']
    const ipc = register()
    expect(ipc.mutations.has('fleet:environmentRuntimesCheck')).toBe(true)
    expect(ipc.reads.has('fleet:environmentRuntimesCheck')).toBe(false)
    expect(() => ipc.mutate('fleet:environmentRuntimesCheck', SERVER, 'work')).toThrow(
      FLEET_RUNTIME_UPDATES_UNSUPPORTED
    )
    features.list = ['environments', 'runtime-updates']
    expect(() => ipc.mutate('fleet:environmentRuntimesCheck', SERVER, '../work')).toThrow()
    expect(mocks.call).not.toHaveBeenCalled()
    await ipc.mutate('fleet:environmentRuntimesCheck', SERVER, 'acme')
    expect(calls()).toEqual([['environmentRuntimesCheck', { params: { eid: 'acme' } }]])
  })

  it('gives an update done now the lifecycle deadline, and a scheduled one too', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 204 }))
    )
    const api = new FleetApiClient('http://127.0.0.1:7443', 'synthetic-token')
    try {
      await api.call('environmentUpdate', { params: { eid: 'work' }, body: { when: 'now' } }).catch(() => {})
      await api.call('environmentUpdateCancel', { params: { eid: 'work' } }).catch(() => {})
      expect(timeout.mock.calls.map(([ms]) => ms)).toEqual([300_000, 15_000])
    } finally {
      timeout.mockRestore()
    }
  })

  it('refuses environment calls on a gateway without environments and lists no archived ones there', async () => {
    features.list = ['provisioning']
    const ipc = register()
    const refused: [string, ...unknown[]][] = [
      ['fleet:environmentAction', 'work', 'start'],
      ['fleet:patchEnvironment', 'work', { name: 'Work' }],
      ['fleet:restoreArchivedEnvironment', 'work'],
      ['fleet:deleteArchivedEnvironment', 'work'],
      ['fleet:environmentUiOpen', 'work', 'main'],
    ]
    for (const [channel, ...args] of refused)
      expect(() => ipc.mutate(channel, SERVER, ...args)).toThrow(FLEET_ENVIRONMENTS_UNSUPPORTED)
    expect(() => ipc.read('fleet:environmentSelections', SERVER, 'work')).toThrow(FLEET_ENVIRONMENTS_UNSUPPORTED)
    await expect(ipc.read('fleet:listArchivedEnvironments', SERVER)).resolves.toEqual({ environments: [] })
    expect(mocks.call).not.toHaveBeenCalled()
  })

  it('creates a bot in an existing or a new environment only on gateways that have environments', async () => {
    const base = { name: 'Scout', instructions: '', ceiling: 'ask', talksTo: [] }
    const ipc = register()
    expect(() => ipc.mutate('fleet:createBot', SERVER, { ...base, environmentId: 'work' })).toThrow(
      FLEET_ENVIRONMENTS_UNSUPPORTED
    )
    expect(() => ipc.mutate('fleet:createBot', SERVER, { ...base, environment: { name: 'Work' } })).toThrow(
      FLEET_ENVIRONMENTS_UNSUPPORTED
    )
    features.list = ['environments']
    expect(() =>
      ipc.mutate('fleet:createBot', SERVER, { ...base, environmentId: 'work', environment: { name: 'Work' } })
    ).toThrow()
    expect(() => ipc.mutate('fleet:createBot', SERVER, { ...base, environmentId: '../work' })).toThrow()
    expect(() =>
      ipc.mutate('fleet:createBot', SERVER, { ...base, environment: { name: 'Work', memoryLimitBytes: 1024 } })
    ).toThrow()
    expect(mocks.call).not.toHaveBeenCalled()
    await ipc.mutate('fleet:createBot', SERVER, { ...base, environmentId: 'work' })
    await ipc.mutate('fleet:createBot', SERVER, { ...base, environment: { name: 'Work' } })
    await ipc.mutate('fleet:createBot', SERVER, base)
    expect(calls()).toEqual([
      ['botsCreate', { body: { ...base, environmentId: 'work', idempotencyKey: KEY } }],
      ['botsCreate', { body: { ...base, environment: { name: 'Work', memoryLimitBytes: null }, idempotencyKey: KEY } }],
      ['botsCreate', { body: { ...base, idempotencyKey: KEY } }],
    ])
  })

  it('moves a bot only through a gateway that moves bots, to an existing environment or a named new one', async () => {
    const ipc = register()
    expect(() => ipc.mutate('fleet:moveBot', SERVER, 'scout', { environmentId: 'home' })).toThrow(
      FLEET_BOT_MOVE_UNSUPPORTED
    )
    expect(() => ipc.read('fleet:botMove', SERVER, 'scout')).toThrow(FLEET_BOT_MOVE_UNSUPPORTED)
    features.list = ['environments', 'bot-move']
    for (const input of [
      {},
      { environmentId: 'home', newEnvironment: { name: 'Lab' } },
      { environmentId: '../home' },
      { newEnvironment: { name: '' } },
      { environmentId: 'home', slot: 2 },
    ])
      expect(() => ipc.mutate('fleet:moveBot', SERVER, 'scout', input), JSON.stringify(input)).toThrow()
    expect(() => ipc.mutate('fleet:moveBot', SERVER, '../scout', { environmentId: 'home' })).toThrow()
    expect(mocks.call).not.toHaveBeenCalled()
    await ipc.mutate('fleet:moveBot', SERVER, 'scout', { environmentId: 'home' })
    await ipc.mutate('fleet:moveBot', SERVER, 'scout', { newEnvironment: { name: 'Lab' } })
    await ipc.read('fleet:botMove', SERVER, 'scout')
    expect(calls()).toEqual([
      ['botMove', { params: { id: 'scout' }, body: { environmentId: 'home', idempotencyKey: KEY } }],
      ['botMove', { params: { id: 'scout' }, body: { newEnvironment: { name: 'Lab' }, idempotencyKey: KEY } }],
      ['botMoveGet', { params: { id: 'scout' } }],
    ])
  })

  it('sends owner memory scopes only to gateways that have environments', async () => {
    const ipc = register()
    expect(() =>
      ipc.mutate('fleet:ownerMemoryCreate', SERVER, { content: 'Uses the staging VPN.', environmentId: 'work' })
    ).toThrow(FLEET_ENVIRONMENTS_UNSUPPORTED)
    expect(() => ipc.mutate('fleet:ownerMemoryUpdate', SERVER, 'm1', { environmentId: 'work' })).toThrow(
      FLEET_ENVIRONMENTS_UNSUPPORTED
    )
    expect(() => ipc.mutate('fleet:ownerMemoryUpdate', SERVER, 'm1', { environmentId: null })).toThrow(
      FLEET_ENVIRONMENTS_UNSUPPORTED
    )
    await ipc.mutate('fleet:ownerMemoryCreate', SERVER, { content: 'Prefers short answers.' })
    features.list = ['environments']
    expect(() =>
      ipc.mutate('fleet:ownerMemoryCreate', SERVER, { content: 'Uses the VPN.', environmentId: 'Work' })
    ).toThrow()
    await ipc.mutate('fleet:ownerMemoryCreate', SERVER, { content: 'Uses the staging VPN.', environmentId: 'work' })
    await ipc.mutate('fleet:ownerMemoryUpdate', SERVER, 'm1', { environmentId: null })
    await ipc.mutate('fleet:ownerMemoryUpdate', SERVER, 'm2', { content: 'Deploys on Fridays.', environmentId: 'work' })
    expect(calls()).toEqual([
      ['ownerMemoryCreate', { body: { content: 'Prefers short answers.', environmentId: null, idempotencyKey: KEY } }],
      ['ownerMemoryCreate', { body: { content: 'Uses the staging VPN.', environmentId: 'work', idempotencyKey: KEY } }],
      ['ownerMemoryPatch', { params: { mid: 'm1' }, body: { environmentId: null } }],
      ['ownerMemoryPatch', { params: { mid: 'm2' }, body: { content: 'Deploys on Fridays.', environmentId: 'work' } }],
    ])
  })

  it('provisions an environment through its routes and a bot or bare bot id through the bot routes', async () => {
    features.list = ['environments']
    const ipc = register()
    mocks.call.mockImplementation(async (key: string) =>
      key.endsWith('AccountsList')
        ? {
            apiKeys: [
              {
                providerId: 'p1',
                name: 'Synthetic',
                kind: 'openai',
                baseURL: 'https://synthetic-user:synthetic-password@example.test/v1?token=synthetic-secret',
                keyHint: null,
              },
            ],
            subscriptions: [],
          }
        : undefined
    )
    for (const target of [{ environmentId: 'work' }, { botId: 'scout' }, 'scout']) {
      const accounts = (await ipc.read('fleet:bot:accounts', SERVER, target)) as FleetBotAccounts
      expect(accounts.apiKeys[0].baseURL).toBe('https://example.test/v1')
      expect(JSON.stringify(accounts)).not.toContain('synthetic-secret')
    }
    const work = { environmentId: 'work' }
    await ipc.read('fleet:bot:skills', SERVER, work)
    await ipc.read('fleet:bot:mcp-servers', SERVER, work)
    await ipc.mutate('fleet:bot:skill-remove', SERVER, work, 'review')
    await ipc.mutate('fleet:bot:mcp-remove', SERVER, work, 'm1')
    await ipc.mutate('fleet:bot:subscription-remove', SERVER, work, 'codex', 'default')
    await ipc.mutate('fleet:add-api-key-account', SERVER, work, {
      kind: 'openai',
      name: 'Synthetic',
      key: 'synthetic-api-secret',
      baseURL: null,
    })
    await ipc.mutate('fleet:remove-account', SERVER, work, 'p1')
    await ipc.mutate('fleet:bot:skill-remove', SERVER, { botId: 'scout' }, 'review')
    await ipc.mutate('fleet:remove-account', SERVER, 'scout', 'p1')
    expect(mocks.call.mock.calls.map(([key, options]) => [key, options?.params])).toEqual([
      ['environmentAccountsList', { eid: 'work' }],
      ['botAccountsList', { id: 'scout' }],
      ['botAccountsList', { id: 'scout' }],
      ['environmentSkillsList', { eid: 'work' }],
      ['environmentMcpServersList', { eid: 'work' }],
      ['environmentSkillRemove', { eid: 'work', name: 'review' }],
      ['environmentMcpServerRemove', { eid: 'work', sid: 'm1' }],
      ['environmentSubscriptionRemove', { eid: 'work', kind: 'codex', slot: 'default' }],
      ['environmentApiKeyAccountAdd', { eid: 'work' }],
      ['environmentAccountRemove', { eid: 'work', providerId: 'p1' }],
      ['botSkillRemove', { id: 'scout', name: 'review' }],
      ['botAccountRemove', { id: 'scout', providerId: 'p1' }],
    ])
  })

  it('rejects malformed provisioning targets, and environment targets on older gateways, before dispatch', async () => {
    const ipc = register()
    const work = { environmentId: 'work' }
    const selection = { apiKeyIds: [], copyIds: [], skillNames: ['review'], mcpServerIds: [] }
    expect(() => ipc.mutate('fleet:bot:skill-remove', SERVER, work, 'review')).toThrow(FLEET_ENVIRONMENTS_UNSUPPORTED)
    expect(() => ipc.mutate('fleet:login:start', SERVER, work, { kind: 'codex', method: 'browser' })).toThrow(
      FLEET_ENVIRONMENTS_UNSUPPORTED
    )
    expect(() => ipc.mutate('fleet:provisioning:import', SERVER, work, selection)).toThrow(
      FLEET_ENVIRONMENTS_UNSUPPORTED
    )
    expect(() => ipc.read('fleet:bot:skills', SERVER, work)).toThrow(FLEET_ENVIRONMENTS_UNSUPPORTED)
    await expect(Promise.resolve().then(() => ipc.read('fleet:bot:accounts', SERVER, work))).rejects.toThrow(
      FLEET_ENVIRONMENTS_UNSUPPORTED
    )
    features.list = ['environments']
    for (const target of [
      { environmentId: 'work', botId: 'scout' },
      { environmentId: '../work' },
      { botId: 'scout', surface: 'apps' },
      { id: 'scout' },
      42,
      null,
    ]) {
      expect(() => ipc.mutate('fleet:bot:skill-remove', SERVER, target, 'review')).toThrow()
      expect(() => ipc.mutate('fleet:login:cancel', SERVER, target, 'l1')).toThrow()
      expect(() =>
        ipc.mutate('fleet:add-api-key-account', SERVER, target, { kind: 'openai', name: 'A', key: 'k', baseURL: null })
      ).toThrow()
    }
    expect(mocks.call).not.toHaveBeenCalled()
  })

  it('opens bot areas and the environment screen, and needs a gateway that streams them as video', async () => {
    const ipc = register()
    // A gateway from before video screens opens none, not even a bot's browser area.
    for (const features_ of [[], ['environments']]) {
      features.list = features_
      for (const target of ['scout', { botId: 'scout', surface: 'apps' }, { environmentId: 'work' }])
        expect(() => ipc.mutate('fleet:screenOpen', SERVER, target, 'view')).toThrow(FLEET_SCREEN_UPDATE_REQUIRED)
    }
    expect(mocks.openScreen).not.toHaveBeenCalled()
    features.list = ['environments', 'video-screens']
    // A bare bot id is that bot's browser area, as the views from before environments open it.
    await ipc.mutate('fleet:screenOpen', SERVER, 'scout', 'view')
    await ipc.mutate('fleet:screenOpen', SERVER, { botId: 'scout', surface: 'browser' }, 'control')
    await ipc.mutate('fleet:screenOpen', SERVER, { botId: 'scout', surface: 'apps' }, 'control')
    await ipc.mutate('fleet:screenOpen', SERVER, { environmentId: 'work' }, 'control')
    for (const [target, mode] of [
      [{ botId: 'scout', surface: 'desktop' }, 'view'],
      [{ botId: 'scout' }, 'view'],
      [{ environmentId: 'work', surface: 'apps' }, 'view'],
      [{ environmentId: 'work' }, 'drive'],
      ['../scout', 'view'],
    ])
      expect(() => ipc.mutate('fleet:screenOpen', SERVER, target, mode)).toThrow()
    expect(mocks.openScreen.mock.calls.map(([, target, mode]) => [target, mode])).toEqual([
      [{ botId: 'scout', surface: 'browser' }, 'view'],
      [{ botId: 'scout', surface: 'browser' }, 'control'],
      [{ botId: 'scout', surface: 'apps' }, 'control'],
      [{ environmentId: 'work' }, 'control'],
    ])
  })

  it("opens a workspaces conversation's computer and browser tile, and refuses malformed targets", async () => {
    const ipc = register()
    const conversationId = '3f2b5c1e-8a4d-4f6b-9c2e-1a2b3c4d5e6f'
    features.list = ['environments']
    expect(() =>
      ipc.mutate('fleet:screenOpen', SERVER, { environmentId: 'workspaces', conversationId, surface: 'apps' }, 'view')
    ).toThrow(FLEET_SCREEN_UPDATE_REQUIRED)
    features.list = ['environments', 'video-screens']
    await ipc.mutate(
      'fleet:screenOpen',
      SERVER,
      { environmentId: 'workspaces', conversationId, surface: 'apps' },
      'control'
    )
    await ipc.mutate(
      'fleet:screenOpen',
      SERVER,
      { environmentId: 'workspaces', conversationId, surface: 'browser' },
      'view'
    )
    for (const target of [
      { environmentId: 'workspaces', conversationId: 'ação', surface: 'apps' },
      { environmentId: 'workspaces', conversationId, surface: 'desktop' },
      { environmentId: 'workspaces', conversationId, surface: 'apps', extra: 1 },
      { environmentId: 'Work Space', conversationId, surface: 'apps' },
    ])
      expect(() => ipc.mutate('fleet:screenOpen', SERVER, target, 'view')).toThrow()
    expect(mocks.openScreen.mock.calls.map(([, target, mode]) => [target, mode])).toEqual([
      [{ environmentId: 'workspaces', conversationId, surface: 'apps' }, 'control'],
      [{ environmentId: 'workspaces', conversationId, surface: 'browser' }, 'view'],
    ])
  })

  it('asks for an update of a gateway that does not know conversation screens', async () => {
    features.list = ['environments', 'video-screens']
    const ipc = register()
    const target = { environmentId: 'workspaces', conversationId: 'c-1', surface: 'apps' }
    mocks.openScreen.mockRejectedValueOnce(new FleetClientError('NOT_FOUND', 404, 'Route not found'))
    await expect(ipc.mutate('fleet:screenOpen', SERVER, target, 'view')).rejects.toThrow(FLEET_SCREEN_UPDATE_REQUIRED)
    mocks.openScreen.mockRejectedValueOnce(new FleetClientError('CONFLICT', 409, GATEWAY_RESTART_TO_OPEN_SCREEN))
    await expect(ipc.mutate('fleet:screenOpen', SERVER, target, 'view')).rejects.toThrow(FLEET_SCREEN_RESTART_REQUIRED)
    // A missing environment is not an old gateway, nor is a bot's missing route.
    mocks.openScreen.mockRejectedValueOnce(new FleetClientError('NOT_FOUND', 404, 'Environment not found'))
    await expect(ipc.mutate('fleet:screenOpen', SERVER, target, 'view')).rejects.toThrow('Environment not found')
    mocks.openScreen.mockRejectedValueOnce(new FleetClientError('NOT_FOUND', 404, 'Route not found'))
    await expect(ipc.mutate('fleet:screenOpen', SERVER, { botId: 'scout', surface: 'apps' }, 'view')).rejects.toThrow(
      'Route not found'
    )
  })

  it('marks a screen conflict so the view can tell that the environment display is in use', async () => {
    features.list = ['environments', 'video-screens']
    const ipc = register()
    mocks.openScreen.mockRejectedValueOnce(new FleetClientError('CONFLICT', 409, GATEWAY_SCREEN_CONTROLLED))
    await expect(ipc.mutate('fleet:screenOpen', SERVER, { environmentId: 'work' }, 'control')).rejects.toThrow(
      FLEET_SCREEN_CONFLICT
    )
    // An environment on an image from before environments refuses with 409 too: that is no conflict.
    mocks.openScreen.mockRejectedValueOnce(new FleetClientError('CONFLICT', 409, GATEWAY_RESTART_TO_OPEN_SCREEN))
    await expect(ipc.mutate('fleet:screenOpen', SERVER, { botId: 'scout', surface: 'apps' }, 'view')).rejects.toThrow(
      FLEET_SCREEN_RESTART_REQUIRED
    )
    mocks.openScreen.mockRejectedValueOnce(new FleetClientError('FORBIDDEN', 403, 'Takeover required for control'))
    await expect(
      ipc.mutate('fleet:screenOpen', SERVER, { botId: 'scout', surface: 'apps' }, 'control')
    ).rejects.toThrow('Takeover required for control')
  })
})

describe('environment sign-ins', () => {
  const open = vi.spyOn(shell, 'openExternal')
  function attempt(kind: 'codex' | 'claude', loginId = 'l1'): FleetLoginAttempt {
    const port = kind === 'codex' ? 1455 : 23456
    const path = kind === 'codex' ? '/auth/callback' : '/callback'
    return {
      loginId,
      kind,
      accountId: null,
      method: 'browser',
      state: 'pending',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      browser: {
        authUrl:
          (kind === 'codex' ? 'https://auth.openai.com/authorize' : 'https://claude.ai/oauth/authorize') +
          '?redirect_uri=' +
          encodeURIComponent('http://localhost:' + port + path),
        callback: { port, path },
      },
      device: null,
      manual: null,
      account: null,
      error: null,
    }
  }
  function fleet(call: (...args: never[]) => unknown): FleetClientServiceType {
    return {
      call,
      hasFeature: (feature: string) => features.list.includes(feature),
    } as unknown as FleetClientServiceType
  }
  beforeEach(() => {
    open.mockReset()
    open.mockResolvedValue()
    mocks.relayStart.mockResolvedValue({ close: vi.fn(async () => {}) })
  })

  it('signs in on an environment through its routes and relays the provider callback there', async () => {
    features.list = ['environments']
    const value = attempt('claude')
    const call = vi
      .fn()
      .mockResolvedValueOnce(value)
      .mockResolvedValueOnce({ status: 200, location: null, contentType: null, body: '' })
      .mockResolvedValueOnce({ ...value, state: 'completed' })
    const close = vi.fn(async () => {})
    mocks.relayStart.mockResolvedValueOnce({ close })
    const service = fleet(call)
    await startBotLogin(service, { environmentId: 'work' }, { kind: 'claude', method: 'browser', slot: 'auto' })
    expect(call).toHaveBeenNthCalledWith(1, 'environmentLoginStart', {
      params: { eid: 'work' },
      body: { kind: 'claude', method: 'browser', slot: 'auto' },
    })
    expect(open).toHaveBeenCalledWith(value.browser!.authUrl)
    await mocks.relayStart.mock.calls[0][0].forward('code=synthetic')
    expect(call).toHaveBeenNthCalledWith(2, 'environmentLoginCallback', {
      params: { eid: 'work', lid: 'l1' },
      body: { path: '/callback', query: 'code=synthetic' },
    })
    await botLoginStatus(service, { environmentId: 'work' }, 'l1')
    expect(call).toHaveBeenNthCalledWith(3, 'environmentLoginGet', { params: { eid: 'work', lid: 'l1' } })
    expect(close).toHaveBeenCalledOnce()
  })

  it('keeps the sign-ins of an environment and a bot with the same id and login id apart', async () => {
    features.list = ['environments']
    const environmentRelay = vi.fn(async () => {})
    const botRelay = vi.fn(async () => {})
    mocks.relayStart.mockResolvedValueOnce({ close: environmentRelay }).mockResolvedValueOnce({ close: botRelay })
    const call = vi.fn(async (key: string) => (key.endsWith('LoginStart') ? attempt('claude') : undefined))
    const service = fleet(call)
    const request = { kind: 'claude', method: 'browser', slot: 'auto' } as const
    await startBotLogin(service, { environmentId: 'scout' }, request)
    await startBotLogin(service, { botId: 'scout' }, request)
    await cancelBotLogin(service, { environmentId: 'scout' }, 'l1')
    expect(call).toHaveBeenLastCalledWith('environmentLoginCancel', { params: { eid: 'scout', lid: 'l1' } })
    expect(environmentRelay).toHaveBeenCalled()
    expect(botRelay).not.toHaveBeenCalled()
    await cancelBotLogin(service, 'scout', 'l1')
    expect(call).toHaveBeenLastCalledWith('botLoginCancel', { params: { id: 'scout', lid: 'l1' } })
    expect(botRelay).toHaveBeenCalled()
  })

  it('serializes Codex browser sign-ins across environments and bots on the one Mac port', async () => {
    features.list = ['environments']
    const call = vi.fn(async (key: string) => (key.endsWith('LoginStart') ? attempt('codex') : undefined))
    const service = fleet(call)
    const request = { kind: 'codex', method: 'browser', slot: 'auto' } as const
    await startBotLogin(service, { botId: 'scout' }, request)
    const second = startBotLogin(service, { environmentId: 'work' }, request)
    await Promise.resolve()
    await Promise.resolve()
    expect(call).toHaveBeenCalledOnce()
    await cancelBotLogin(service, { botId: 'scout' }, 'l1')
    await second
    expect(call.mock.calls.map(([key]) => key)).toEqual(['botLoginStart', 'botLoginCancel', 'environmentLoginStart'])
  })

  it('refuses an environment sign-in on an older gateway without calling it or opening a page', async () => {
    const call = vi.fn()
    await expect(
      startBotLogin(fleet(call), { environmentId: 'work' }, { kind: 'codex', method: 'browser', slot: 'auto' })
    ).rejects.toThrow(FLEET_ENVIRONMENTS_UNSUPPORTED)
    expect(call).not.toHaveBeenCalled()
    expect(open).not.toHaveBeenCalled()
    expect(mocks.relayStart).not.toHaveBeenCalled()
  })
})

describe('environment screens', () => {
  class FakeSocket extends EventTarget {
    binaryType = 'blob'
    readyState = 0
    send(): void {}
    close(): void {}
  }
  class Owner extends EventEmitter {
    isDestroyed(): boolean {
      return false
    }
    send(): void {}
  }
  it('asks the gateway for the ticket of the chosen screen', async () => {
    const call = vi.fn(async (_key: string, _options: Options) => ({
      ticket: 'synthetic-ticket',
      path: '/v1/screen?ticket=synthetic-ticket',
      expiresAt: at,
    }))
    const api = { origin: 'https://fleet.example', call } as unknown as FleetApiClient
    const bridge = new FleetScreenBridge(
      () => api,
      () => new FakeSocket() as unknown as WebSocket
    )
    const owner = new Owner() as unknown as WebContents
    await bridge.openScreen(owner, 'scout', 'view')
    await bridge.openScreen(owner, { botId: 'scout', surface: 'apps' }, 'control')
    await bridge.openScreen(owner, { environmentId: 'work' }, 'control')
    await bridge.openScreen(owner, { environmentId: 'workspaces', conversationId: 'c-1', surface: 'browser' }, 'view')
    expect(call.mock.calls).toEqual([
      ['botScreenTicket', { params: { id: 'scout' }, body: { mode: 'view', surface: 'browser' } }],
      ['botScreenTicket', { params: { id: 'scout' }, body: { mode: 'control', surface: 'apps' } }],
      ['environmentScreenTicket', { params: { eid: 'work' }, body: { mode: 'control' } }],
      [
        'conversationScreenTicket',
        { params: { eid: 'workspaces', cid: 'c-1' }, body: { mode: 'view', surface: 'browser' } },
      ],
    ])
    bridge.closeAll()
  })

  it('opens a renderer screen channel for any target', async () => {
    vi.stubGlobal('WebSocket', { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 })
    const api = {
      fleetScreenOpen: vi.fn(async (_serverId: FleetServerId, _target: unknown, _mode: string) => ({
        channelId: 'c1',
      })),
      fleetScreenSend: vi.fn(async () => {}),
      fleetScreenClose: vi.fn(async () => {}),
      onFleetScreenState: vi.fn(() => vi.fn()),
      onFleetScreenData: vi.fn(() => vi.fn()),
    } satisfies ScreenApi
    await FleetScreenChannel.open(api, SERVER, { environmentId: 'work' }, 'control')
    await FleetScreenChannel.open(api, SERVER, { botId: 'scout', surface: 'apps' }, 'view')
    await FleetScreenChannel.open(api, SERVER, 'scout', 'view')
    expect(api.fleetScreenOpen.mock.calls).toEqual([
      [SERVER, { environmentId: 'work' }, 'control'],
      [SERVER, { botId: 'scout', surface: 'apps' }, 'view'],
      [SERVER, 'scout', 'view'],
    ])
  })
})

describe('environments in the renderer state', () => {
  const apply = (state: FleetState, ...values: FleetGatewayEvent[]) =>
    values.reduce((current, value) => fleetReducer(current, { type: 'event', value }), state)
  const user = (id: string): FleetTranscriptItem => ({
    kind: 'user',
    id,
    at,
    text: id,
    source: 'owner',
    queued: false,
    memories: [],
    images: [],
  })

  it('starts without environments and accepts snapshots from senders that predate them', () => {
    expect(initialFleetState.snapshot.environments).toEqual([])
    const state = fleetReducer(initialFleetState, {
      type: 'snapshot',
      value: { host: null, bots: [bot('scout')], inbox: [], peerMessages: [] },
    })
    expect(state.snapshot.environments).toEqual([])
    expect(state.snapshot.bots.map((item) => item.id)).toEqual(['scout'])
  })

  it('keeps environments sorted by name and never lists an archived one or its bots', () => {
    const state = apply(
      initialFleetState,
      { type: 'environment.updated', at, environment: environment('personal', 'Personal') },
      { type: 'environment.updated', at, environment: environment('work', 'Acme') },
      { type: 'environment.updated', at, environment: environment('home', 'Acme') },
      { type: 'bot.updated', at, bot: bot('scout', { environmentId: 'work' }) },
      { type: 'bot.updated', at, bot: bot('lone') },
      { type: 'environment.updated', at, environment: environment('personal', 'Zeta') }
    )
    expect(state.snapshot.environments.map((item) => [item.id, item.name])).toEqual([
      ['home', 'Acme'],
      ['work', 'Acme'],
      ['personal', 'Zeta'],
    ])
    const archived = apply(state, {
      type: 'environment.updated',
      at,
      environment: environment('work', 'Acme', { lifecycle: 'archived' }),
    })
    expect(archived.snapshot.environments.map((item) => item.id)).toEqual(['home', 'personal'])
    expect(archived.snapshot.bots.map((item) => item.id)).toEqual(['lone'])
  })

  it('drops a removed environment with its bots, their inbox items and transcripts', () => {
    let state = apply(
      initialFleetState,
      { type: 'environment.updated', at, environment: environment('work', 'Work') },
      { type: 'bot.updated', at, bot: bot('scout', { environmentId: 'work' }) },
      { type: 'bot.updated', at, bot: bot('coder', { environmentId: 'home' }) },
      {
        type: 'inbox.updated',
        at,
        items: ['scout', 'coder'].map((botId) => ({
          botId,
          interaction: { kind: 'help' as const, id: 'h-' + botId, at, reason: 'Sign in', itemId: 'i-' + botId },
        })),
      }
    )
    for (const botId of ['scout', 'coder'])
      state = fleetReducer(state, {
        type: 'transcript.page',
        botId,
        page: { items: [user('m-' + botId)], before: null },
        older: false,
      })
    state = apply(state, { type: 'environment.removed', at, environmentId: 'work' })
    expect(state.snapshot.environments).toEqual([])
    expect(state.snapshot.bots.map((item) => item.id)).toEqual(['coder'])
    expect(state.snapshot.inbox.map((item) => item.botId)).toEqual(['coder'])
    expect(Object.keys(state.transcripts)).toEqual(['coder'])
  })

  it('groups bots under their environments by name and leaves bots of older gateways ungrouped', () => {
    const grouped = groupBotsByEnvironment(
      [environment('work', 'Work'), environment('home', 'Home'), environment('lab', 'Home')],
      [
        bot('writer', { name: 'Writer', environmentId: 'work' }),
        bot('coder', { name: 'Coder', environmentId: 'work' }),
        bot('lone', { name: 'Lone' }),
        bot('stray', { name: 'Stray', environmentId: 'gone' }),
        bot('alpha', { name: 'Alpha' }),
      ]
    )
    expect(grouped.groups.map((group) => [group.environment.id, group.bots.map((item) => item.id)])).toEqual([
      ['home', []],
      ['lab', []],
      ['work', ['coder', 'writer']],
    ])
    expect(grouped.ungrouped.map((item) => item.id)).toEqual(['alpha', 'lone', 'stray'])
    expect(groupBotsByEnvironment([], [bot('b', { name: 'B' }), bot('a', { name: 'A' })])).toEqual({
      groups: [],
      ungrouped: [bot('a', { name: 'A' }), bot('b', { name: 'B' })],
    })
  })
})

describe('workspaces environment', () => {
  const host = environment('workspaces', 'Workspaces', { kind: 'workspaces' })

  it('is shown apart from the environments bots run in', () => {
    const all = [environment('work', 'Work'), host, environment('home', 'Home')]
    expect(isWorkspacesEnvironment(host)).toBe(true)
    expect(botEnvironments(all).map((item) => item.id)).toEqual(['work', 'home'])
    // Several, one per scope, by name.
    const company = environment('company', 'Company', { kind: 'workspaces' })
    expect(workspacesEnvironments([...all, company])).toEqual([company, host])
    expect(workspacesEnvironments([environment('work')])).toEqual([])
    // Bot lists never offer it: not as a group, and not as a place a bot could be listed under.
    const grouped = groupBotsByEnvironment(all, [bot('coder', { environmentId: 'work' })])
    expect(grouped.groups.map((group) => group.environment.id)).toEqual(['home', 'work'])
  })

  it('is created as one environment of its own kind, on a server that can host it', async () => {
    const { mutate } = register()
    features.list = ['environments']
    expect(() => mutate('fleet:createWorkspaces', SERVER)).toThrow('Update the server to run workspaces on it.')
    expect(mocks.call).not.toHaveBeenCalled()

    features.list = ['environments', 'workspaces-host']
    mocks.call.mockResolvedValueOnce(host)
    expect(await mutate('fleet:createWorkspaces', SERVER)).toBe(host)
    expect(calls()).toEqual([
      [
        'environmentsCreate',
        { body: { name: 'Workspaces', memoryLimitBytes: null, kind: 'workspaces', idempotencyKey: KEY } },
      ],
    ])
  })

  it('is created with its name, color, limits and idle stop on a server with scopes, and only the name otherwise', async () => {
    const { mutate } = register()
    const input = { name: 'Company A', tint: '#4c9a87', memoryLimitBytes: null, cpuLimit: 2, idleStopMinutes: 60 }
    features.list = ['environments', 'workspaces-host']
    mocks.call.mockResolvedValue(host)
    await mutate('fleet:createWorkspaces', SERVER, input)
    features.list = ['environments', 'workspaces-host', 'workspaces-environments']
    await mutate('fleet:createWorkspaces', SERVER, input)
    expect(calls()).toEqual([
      [
        'environmentsCreate',
        { body: { name: 'Company A', memoryLimitBytes: null, kind: 'workspaces', idempotencyKey: KEY } },
      ],
      [
        'environmentsCreate',
        {
          body: {
            name: 'Company A',
            memoryLimitBytes: null,
            kind: 'workspaces',
            cpuLimit: 2,
            idleStopMinutes: 60,
            tint: '#4c9a87',
            idempotencyKey: KEY,
          },
        },
      ],
    ])
    for (const bad of [
      { name: '' },
      { name: 'X', cpuLimit: 0.3 },
      { name: 'X', idleStopMinutes: 5 },
      { name: 'X', root: '/' },
    ])
      expect(() => mutate('fleet:createWorkspaces', SERVER, bad), JSON.stringify(bad)).toThrow()
  })

  it('changes the settings of scopes only on a server that has them', async () => {
    const { mutate } = register()
    features.list = ['environments', 'workspaces-host']
    for (const patch of [{ cpuLimit: 2 }, { idleStopMinutes: 60 }, { tint: '#4c9a87' }, { hostFolder: 'own' }])
      expect(() => mutate('fleet:patchEnvironment', SERVER, 'work', patch), JSON.stringify(patch)).toThrow(
        'FLEET_SCOPES_UNSUPPORTED'
      )
    expect(mocks.call).not.toHaveBeenCalled()
    features.list = ['environments', 'workspaces-host', 'workspaces-environments']
    mocks.call.mockResolvedValue(host)
    await mutate('fleet:patchEnvironment', SERVER, 'work', { hostFolder: 'own' })
    expect(calls()).toEqual([['environmentPatch', { params: { eid: 'work' }, body: { hostFolder: 'own' } }]])
  })

  it('reaches its IPC channel from the preload', async () => {
    const invoke = vi.spyOn(ipcRenderer, 'invoke').mockResolvedValue(host)
    expect(await fleetApi.fleetCreateWorkspaces(SERVER)).toBe(host)
    expect(invoke).toHaveBeenCalledWith('fleet:createWorkspaces', SERVER)
    expect(await fleetApi.fleetCreateWorkspaces(SERVER, { name: 'Personal' })).toBe(host)
    expect(invoke).toHaveBeenLastCalledWith('fleet:createWorkspaces', SERVER, { name: 'Personal' })
    invoke.mockRestore()
  })
})

describe('environment memory', () => {
  const host = {
    memory: { totalBytes: 8 * 1024 ** 3, usedBytes: 5 * 1024 ** 3, botsBytes: 3 * 1024 ** 3 },
  } as FleetHostInfo
  const resources = (gib: number) => ({
    memoryBytes: gib * 1024 ** 3,
    memoryLimitBytes: null,
    cpuPercent: null,
    startedAt: null,
    swapBytes: null,
    oomKills: null,
    limitOoms: null,
  })

  it('shows one segment per environment without counting its bots again', () => {
    const segments = memorySegments(
      host,
      [
        bot('solo', { environmentId: 'home', tint: '#aa0000', resources: resources(1) }),
        bot('writer', { name: 'Writer', environmentId: 'work', tint: '#00bb00' }),
        bot('coder', { name: 'Coder', environmentId: 'work', tint: '#0000cc' }),
        bot('legacy', { tint: '#dddddd', resources: resources(0.5) }),
      ],
      [
        environment('work', 'Work', { resources: resources(2) }),
        environment('home', 'Home', { resources: resources(1) }),
      ]
    )
    expect(segments.map((segment) => [segment.kind, segment.id, segment.name, segment.fraction, segment.tint])).toEqual(
      [
        ['environment', 'work', 'Work', 0.25, '#0000cc'],
        ['environment', 'home', 'Home', 0.125, '#aa0000'],
        ['bot', 'legacy', 'legacy', 0.0625, '#dddddd'],
        ['system', 'system', '', 0.1875, 'var(--muted-foreground)'],
      ]
    )
  })

  it("colors an environment with the color chosen for it, before its bots' and for one with none", () => {
    const segments = memorySegments(
      host,
      [bot('writer', { environmentId: 'work', tint: '#00bb00' })],
      [
        environment('work', 'Work', { tint: '#4c9a87', resources: resources(1) }),
        environment('personal', 'Personal', { kind: 'workspaces', tint: '#c29a43', resources: resources(1) }),
      ]
    )
    expect(segments.slice(0, 2).map((segment) => [segment.id, segment.tint])).toEqual([
      ['work', '#4c9a87'],
      ['personal', '#c29a43'],
    ])
  })

  it('keeps one segment per bot for gateways without environments', () => {
    expect(
      memorySegments(host, [bot('scout', { resources: resources(2) })]).map((segment) => [segment.id, segment.fraction])
    ).toEqual([
      ['scout', 0.25],
      ['system', 0.375],
    ])
  })

  it("shows the swap the server keeps compressed in memory apart from the system's", () => {
    const swapped = (compressedGib: number) =>
      ({
        memory: {
          ...host.memory,
          swap: { totalBytes: 8 * 1024 ** 3, usedBytes: 4 * 1024 ** 3, compressedBytes: compressedGib * 1024 ** 3 },
        },
      }) as FleetHostInfo
    const environments = [environment('work', 'Work', { resources: resources(2) })]
    expect(
      memorySegments(swapped(1), [], environments).map((segment) => [segment.kind, segment.bytes / 1024 ** 3])
    ).toEqual([
      ['environment', 2],
      ['swap', 1],
      ['system', 2],
    ])
    // It never takes more than the memory no container counts, and none is shown without any.
    expect(
      memorySegments(swapped(9), [], environments).map((segment) => [segment.kind, segment.bytes / 1024 ** 3])
    ).toEqual([
      ['environment', 2],
      ['swap', 3],
      ['system', 0],
    ])
    expect(memorySegments(swapped(0), [], environments).map((segment) => segment.kind)).toEqual([
      'environment',
      'system',
    ])
  })

  it('shows what an environment swapped and why the kernel ended its processes', () => {
    const measured = (patch: Partial<FleetResources>) => ({ ...resources(1), ...patch })
    expect(shownSwapBytes(measured({ swapBytes: 2 * 1024 ** 3 }))).toBe(2 * 1024 ** 3)
    // Too little to show as GB, or not measured (an older gateway sends none).
    expect(shownSwapBytes(measured({ swapBytes: 1024 ** 2 }))).toBeNull()
    expect(shownSwapBytes(measured({ swapBytes: null }))).toBeNull()
    expect(shownSwapBytes({ ...resources(1), swapBytes: undefined } as unknown as FleetResources)).toBeNull()
    expect(outOfMemory(measured({ oomKills: 0, limitOoms: 0 }))).toBeNull()
    expect(outOfMemory(measured({ oomKills: null }))).toBeNull()
    expect(outOfMemory(measured({ oomKills: 17, limitOoms: 0 }))).toEqual({ kills: 17, cause: 'server' })
    expect(outOfMemory(measured({ oomKills: 3, limitOoms: 2 }))).toEqual({ kills: 3, cause: 'limit' })
  })
})

describe('environment provisioning in the renderer', () => {
  const controller = (features: string[], environments: FleetEnvironment[] = []) =>
    ({ state: { connection: { features }, snapshot: { environments } } }) as unknown as FleetController

  it('checks the capabilities of the Maestrly that holds the shared accounts', () => {
    const old = environment('work', 'Work', { capabilities: [] })
    const fleet = controller(['provisioning', 'environments'], [old])
    expect(provisioningAvailability(controller([], [old]), old)).toBe('update-server')
    expect(provisioningAvailability(fleet, old)).toBe('restart-environment')
    expect(provisioningAvailability(fleet, environment('work', 'Work', { capabilities: ['provisioning'] }))).toBe(
      'ready'
    )
    expect(
      provisioningAvailability(fleet, environment('work', 'Work', { lifecycle: 'stopped', capabilities: [] }))
    ).toBe('ready')
    expect(
      provisioningAvailability(fleet, bot('scout', { environmentId: 'work', capabilities: ['provisioning'] }))
    ).toBe('restart-bot')
    expect(provisioningAvailability(fleet, bot('lone', { capabilities: ['provisioning'] }))).toBe('ready')
  })

  it('offers joining an environment only when the gateway, its room and its Maestrly allow it', () => {
    const fleet = controller(['provisioning', 'environments'])
    expect(environmentJoinAvailability(controller(['provisioning']), environment('work'))).toBe('update-server')
    expect(
      environmentJoinAvailability(
        fleet,
        environment('work', 'Work', { botIds: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] })
      )
    ).toBe('full')
    expect(
      environmentJoinAvailability(fleet, environment('work', 'Work', { capabilities: ['provisioning'], botIds: ['a'] }))
    ).toBe('restart-environment')
    expect(environmentJoinAvailability(fleet, environment('work', 'Work', { botIds: ['a'] }))).toBe('ready')
  })

  it('provisions a bot through its environment only on gateways that have environments', () => {
    const shared = bot('scout', { environmentId: 'work' })
    expect(provisioningTargetForBot(controller(['environments']), shared)).toEqual({ environmentId: 'work' })
    expect(provisioningTargetForBot(controller([]), shared)).toEqual({ botId: 'scout' })
    expect(provisioningTargetForBot(controller(['environments']), bot('lone'))).toEqual({ botId: 'lone' })
  })

  it('refreshes shared lists when accounts or the runtime change, not on resource samples', () => {
    const work = environment('work', 'Work', { botIds: ['a', 'b'] })
    const bots = [
      bot('b', { environmentId: 'work', accounts: { connected: true, providers: [{ id: 'p2', label: 'P2' }] } }),
      bot('a', { environmentId: 'work' }),
      bot('other', { environmentId: 'home', accounts: { connected: true, providers: [{ id: 'p9', label: 'P9' }] } }),
    ]
    const key = environmentProvisioningKey(work, bots)
    const busy = bots.map((item) => ({ ...item, status: 'working' as const }))
    const sampled: FleetEnvironment = { ...work, resources: { ...work.resources, memoryBytes: 42, cpuPercent: 7 } }
    expect(environmentProvisioningKey(sampled, busy)).toBe(key)
    expect(environmentProvisioningKey(work, [...bots].reverse())).toBe(key)
    expect(environmentProvisioningKey(work, bots.slice(0, 2))).toBe(key)
    expect(environmentProvisioningKey({ ...work, lifecycle: 'restarting' }, bots)).not.toBe(key)
    expect(environmentProvisioningKey({ ...work, capabilities: ['provisioning'] }, bots)).not.toBe(key)
    expect(
      environmentProvisioningKey(work, [bots[0], { ...bots[1], accounts: { connected: true, providers: [] } }])
    ).not.toBe(key)
  })

  it('keys targets by kind so an environment and a bot with the same id never collide', () => {
    expect(fleetTargetKey({ environmentId: 'scout' })).not.toBe(fleetTargetKey({ botId: 'scout' }))
    expect(fleetTargetKey('scout')).toBe(fleetTargetKey({ botId: 'scout' }))
  })

  it('recognizes the markers the main process raises across IPC', () => {
    const wrap = (marker: string) => new Error("Error invoking remote method 'fleet:screenOpen': Error: " + marker)
    expect(isEnvironmentsUnsupported(wrap(FLEET_ENVIRONMENTS_UNSUPPORTED))).toBe(true)
    expect(isScreenConflict(wrap(FLEET_SCREEN_CONFLICT))).toBe(true)
    expect(isScreenConflict(wrap(FLEET_ENVIRONMENTS_UNSUPPORTED))).toBe(false)
    expect(isEnvironmentsUnsupported(new Error('Gateway unavailable'))).toBe(false)
  })
})

describe('environment preload API', () => {
  it('forwards environment calls and targets to their channels in order', async () => {
    const invoke = vi.spyOn(ipcRenderer, 'invoke').mockResolvedValue(undefined)
    try {
      await fleetApi.fleetEnvironmentAction(SERVER, 'work', 'restart')
      await fleetApi.fleetPatchEnvironment(SERVER, 'work', { memoryLimitBytes: null })
      await fleetApi.fleetListArchivedEnvironments(SERVER)
      await fleetApi.fleetRestoreArchivedEnvironment(SERVER, 'work')
      await fleetApi.fleetDeleteArchivedEnvironment(SERVER, 'work')
      await fleetApi.fleetEnvironmentUiOpen(SERVER, 'work', 'skills')
      await fleetApi.fleetEnvironmentSelections(SERVER, 'work')
      await fleetApi.fleetScreenOpen(SERVER, { environmentId: 'work' }, 'control')
      await fleetApi.fleetBotSkills(SERVER, { environmentId: 'work' })
      await fleetApi.fleetLoginCancel(SERVER, { environmentId: 'work' }, 'l1')
      await fleetApi.fleetCreateBot(SERVER, {
        name: 'Scout',
        instructions: '',
        ceiling: 'ask',
        talksTo: [],
        environment: { name: 'Work' },
      })
      await fleetApi.fleetOwnerMemoryCreate(SERVER, { content: 'Uses the staging VPN.', environmentId: 'work' })
      await fleetApi.fleetEnvironmentUpdate(SERVER, 'work', 'idle')
      await fleetApi.fleetEnvironmentUpdateCancel(SERVER, 'work')
      await fleetApi.fleetEnvironmentRuntimesCheck(SERVER, 'work')
      expect(invoke.mock.calls).toEqual([
        ['fleet:environmentAction', SERVER, 'work', 'restart'],
        ['fleet:patchEnvironment', SERVER, 'work', { memoryLimitBytes: null }],
        ['fleet:listArchivedEnvironments', SERVER],
        ['fleet:restoreArchivedEnvironment', SERVER, 'work'],
        ['fleet:deleteArchivedEnvironment', SERVER, 'work'],
        ['fleet:environmentUiOpen', SERVER, 'work', 'skills'],
        ['fleet:environmentSelections', SERVER, 'work'],
        ['fleet:screenOpen', SERVER, { environmentId: 'work' }, 'control'],
        ['fleet:bot:skills', SERVER, { environmentId: 'work' }],
        ['fleet:login:cancel', SERVER, { environmentId: 'work' }, 'l1'],
        [
          'fleet:createBot',
          SERVER,
          { name: 'Scout', instructions: '', ceiling: 'ask', talksTo: [], environment: { name: 'Work' } },
        ],
        ['fleet:ownerMemoryCreate', SERVER, { content: 'Uses the staging VPN.', environmentId: 'work' }],
        ['fleet:environmentUpdate', SERVER, 'work', 'idle'],
        ['fleet:environmentUpdateCancel', SERVER, 'work'],
        ['fleet:environmentRuntimesCheck', SERVER, 'work'],
      ])
    } finally {
      invoke.mockRestore()
    }
  })
})
