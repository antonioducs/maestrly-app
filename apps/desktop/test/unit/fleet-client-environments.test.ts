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
vi.mock('../../src/main/fleet/client/service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/fleet/client/service')>()
  return {
    ...actual,
    fleetClientService: {
      start: vi.fn(),
      stop: vi.fn(),
      call: mocks.call,
      hasFeature: (feature: string) => features.list.includes(feature),
      getImage: vi.fn(),
      screens: { openScreen: mocks.openScreen, send: vi.fn(), close: vi.fn() },
      idempotencyKey: () => '550e8400-e29b-41d4-a716-446655440000',
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
  FLEET_SCREEN_CONFLICT,
  FLEET_SCREEN_RESTART_REQUIRED,
  fleetTargetKey,
} from '../../src/shared/fleet-targets'
import { fleetReducer, initialFleetState, type FleetState } from '../../src/renderer/lib/fleet/state'
import { groupBotsByEnvironment } from '../../src/renderer/lib/fleet/selectors'
import { memorySegments } from '../../src/renderer/lib/fleet/format'
import {
  environmentJoinAvailability,
  environmentProvisioningKey,
  provisioningAvailability,
  provisioningTargetForBot,
} from '../../src/renderer/lib/fleet/provisioning'
import { isEnvironmentsUnsupported, isScreenConflict } from '../../src/renderer/lib/fleet/errors'
import { FleetScreenChannel, type ScreenApi } from '../../src/renderer/lib/fleet/screen-channel'
import type { FleetController } from '../../src/renderer/lib/fleet/use-fleet'
import { fleetApi } from '../../src/preload/api-fleet'

const at = '2026-09-26T00:00:00.000Z'
const KEY = '550e8400-e29b-41d4-a716-446655440000'
function environment(id: string, name = id, patch: Partial<FleetEnvironment> = {}): FleetEnvironment {
  return {
    id,
    name,
    lifecycle: 'running',
    setup: { step: 'ready', error: null, errorMessage: null },
    resources: { memoryBytes: null, memoryLimitBytes: null, cpuPercent: null, startedAt: null },
    memoryLimitBytes: null,
    compaction: null,
    appVersion: '1.0.0',
    capabilities: ['provisioning', 'environments'],
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
    memory: { totalBytes: 100, usedBytes: 20, botsBytes: 10 },
    disk: { totalBytes: 100, usedBytes: 20 },
    uptimeSeconds: 100,
    gatewayVersion: '1',
    botImage: 'bot',
    botImageVersion: null,
    dockerVersion: null,
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
        if (path === '/v1/activity') return json({ entries: [], lastSeq: 0 })
        throw new Error('Unexpected route ' + path)
      })
    )
    return paths
  }

  it('lists environments only from gateways that advertise them and keeps an empty list for older ones', async () => {
    const meta = { features: ['provisioning'] }
    const paths = stubGateway(meta)
    const service = new FleetClientService()
    await service.connect({ url: 'http://127.0.0.1:7443', code: 'ABCDEFGH' })
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
    const service = new FleetClientService()
    await service.connect({ url: 'http://127.0.0.1:7443', code: 'ABCDEFGH' })
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
    expect(() => ipc.mutate('fleet:environmentAction', '../work', 'restart')).toThrow()
    expect(() => ipc.mutate('fleet:environmentAction', 'work', 'pause')).toThrow()
    expect(() => ipc.mutate('fleet:patchEnvironment', 'work', {})).toThrow()
    expect(() => ipc.mutate('fleet:patchEnvironment', 'work', { memoryLimitBytes: 1024 })).toThrow()
    expect(() => ipc.mutate('fleet:patchEnvironment', 'work', { name: '' })).toThrow()
    expect(() => ipc.mutate('fleet:environmentUiOpen', 'work', 'terminal')).toThrow()
    expect(() => ipc.mutate('fleet:restoreArchivedEnvironment', undefined)).toThrow()
    expect(() => ipc.mutate('fleet:deleteArchivedEnvironment', 'Work!')).toThrow()
    expect(mocks.call).not.toHaveBeenCalled()
    await ipc.mutate('fleet:environmentAction', 'work', 'restart')
    await ipc.mutate('fleet:environmentAction', 'work', 'archive')
    await ipc.mutate('fleet:patchEnvironment', 'work', { name: 'Work', memoryLimitBytes: 8 * 1024 ** 3 })
    await ipc.mutate('fleet:patchEnvironment', 'work', { memoryLimitBytes: null })
    await ipc.read('fleet:listArchivedEnvironments')
    await ipc.mutate('fleet:restoreArchivedEnvironment', 'work')
    await ipc.mutate('fleet:deleteArchivedEnvironment', 'work')
    await ipc.mutate('fleet:environmentUiOpen', 'work', 'accounts')
    expect(calls()).toEqual([
      ['environmentRestart', { params: { eid: 'work' } }],
      ['environmentArchive', { params: { eid: 'work' } }],
      ['environmentPatch', { params: { eid: 'work' }, body: { name: 'Work', memoryLimitBytes: 8 * 1024 ** 3 } }],
      ['environmentPatch', { params: { eid: 'work' }, body: { memoryLimitBytes: null } }],
      ['archivedEnvironmentsList'],
      ['archivedEnvironmentRestore', { params: { eid: 'work' } }],
      ['archivedEnvironmentDelete', { params: { eid: 'work' } }],
      ['environmentUiOpen', { params: { eid: 'work' }, body: { target: 'accounts' } }],
    ])
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
      expect(() => ipc.mutate(channel, ...args)).toThrow(FLEET_ENVIRONMENTS_UNSUPPORTED)
    await expect(ipc.read('fleet:listArchivedEnvironments')).resolves.toEqual({ environments: [] })
    expect(mocks.call).not.toHaveBeenCalled()
  })

  it('creates a bot in an existing or a new environment only on gateways that have environments', async () => {
    const base = { name: 'Scout', instructions: '', ceiling: 'ask', talksTo: [] }
    const ipc = register()
    expect(() => ipc.mutate('fleet:createBot', { ...base, environmentId: 'work' })).toThrow(
      FLEET_ENVIRONMENTS_UNSUPPORTED
    )
    expect(() => ipc.mutate('fleet:createBot', { ...base, environment: { name: 'Work' } })).toThrow(
      FLEET_ENVIRONMENTS_UNSUPPORTED
    )
    features.list = ['environments']
    expect(() =>
      ipc.mutate('fleet:createBot', { ...base, environmentId: 'work', environment: { name: 'Work' } })
    ).toThrow()
    expect(() => ipc.mutate('fleet:createBot', { ...base, environmentId: '../work' })).toThrow()
    expect(() =>
      ipc.mutate('fleet:createBot', { ...base, environment: { name: 'Work', memoryLimitBytes: 1024 } })
    ).toThrow()
    expect(mocks.call).not.toHaveBeenCalled()
    await ipc.mutate('fleet:createBot', { ...base, environmentId: 'work' })
    await ipc.mutate('fleet:createBot', { ...base, environment: { name: 'Work' } })
    await ipc.mutate('fleet:createBot', base)
    expect(calls()).toEqual([
      ['botsCreate', { body: { ...base, environmentId: 'work', idempotencyKey: KEY } }],
      ['botsCreate', { body: { ...base, environment: { name: 'Work', memoryLimitBytes: null }, idempotencyKey: KEY } }],
      ['botsCreate', { body: { ...base, idempotencyKey: KEY } }],
    ])
  })

  it('sends owner memory scopes only to gateways that have environments', async () => {
    const ipc = register()
    expect(() =>
      ipc.mutate('fleet:ownerMemoryCreate', { content: 'Uses the staging VPN.', environmentId: 'work' })
    ).toThrow(FLEET_ENVIRONMENTS_UNSUPPORTED)
    expect(() => ipc.mutate('fleet:ownerMemoryUpdate', 'm1', { environmentId: 'work' })).toThrow(
      FLEET_ENVIRONMENTS_UNSUPPORTED
    )
    expect(() => ipc.mutate('fleet:ownerMemoryUpdate', 'm1', { environmentId: null })).toThrow(
      FLEET_ENVIRONMENTS_UNSUPPORTED
    )
    await ipc.mutate('fleet:ownerMemoryCreate', { content: 'Prefers short answers.' })
    features.list = ['environments']
    expect(() => ipc.mutate('fleet:ownerMemoryCreate', { content: 'Uses the VPN.', environmentId: 'Work' })).toThrow()
    await ipc.mutate('fleet:ownerMemoryCreate', { content: 'Uses the staging VPN.', environmentId: 'work' })
    await ipc.mutate('fleet:ownerMemoryUpdate', 'm1', { environmentId: null })
    await ipc.mutate('fleet:ownerMemoryUpdate', 'm2', { content: 'Deploys on Fridays.', environmentId: 'work' })
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
      const accounts = (await ipc.read('fleet:bot:accounts', target)) as FleetBotAccounts
      expect(accounts.apiKeys[0].baseURL).toBe('https://example.test/v1')
      expect(JSON.stringify(accounts)).not.toContain('synthetic-secret')
    }
    const work = { environmentId: 'work' }
    await ipc.read('fleet:bot:skills', work)
    await ipc.read('fleet:bot:mcp-servers', work)
    await ipc.mutate('fleet:bot:skill-remove', work, 'review')
    await ipc.mutate('fleet:bot:mcp-remove', work, 'm1')
    await ipc.mutate('fleet:bot:subscription-remove', work, 'codex', 'default')
    await ipc.mutate('fleet:add-api-key-account', work, {
      kind: 'openai',
      name: 'Synthetic',
      key: 'synthetic-api-secret',
      baseURL: null,
    })
    await ipc.mutate('fleet:remove-account', work, 'p1')
    await ipc.mutate('fleet:bot:skill-remove', { botId: 'scout' }, 'review')
    await ipc.mutate('fleet:remove-account', 'scout', 'p1')
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
    expect(() => ipc.mutate('fleet:bot:skill-remove', work, 'review')).toThrow(FLEET_ENVIRONMENTS_UNSUPPORTED)
    expect(() => ipc.mutate('fleet:login:start', work, { kind: 'codex', method: 'browser' })).toThrow(
      FLEET_ENVIRONMENTS_UNSUPPORTED
    )
    expect(() => ipc.mutate('fleet:provisioning:import', work, selection)).toThrow(FLEET_ENVIRONMENTS_UNSUPPORTED)
    expect(() => ipc.read('fleet:bot:skills', work)).toThrow(FLEET_ENVIRONMENTS_UNSUPPORTED)
    await expect(Promise.resolve().then(() => ipc.read('fleet:bot:accounts', work))).rejects.toThrow(
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
      expect(() => ipc.mutate('fleet:bot:skill-remove', target, 'review')).toThrow()
      expect(() => ipc.mutate('fleet:login:cancel', target, 'l1')).toThrow()
      expect(() =>
        ipc.mutate('fleet:add-api-key-account', target, { kind: 'openai', name: 'A', key: 'k', baseURL: null })
      ).toThrow()
    }
    expect(mocks.call).not.toHaveBeenCalled()
  })

  it('opens bot areas and the environment screen, keeping older gateways and views on the browser area', async () => {
    const ipc = register()
    await ipc.mutate('fleet:screenOpen', 'scout', 'view')
    await ipc.mutate('fleet:screenOpen', { botId: 'scout', surface: 'browser' }, 'control')
    expect(() => ipc.mutate('fleet:screenOpen', { botId: 'scout', surface: 'apps' }, 'view')).toThrow(
      FLEET_ENVIRONMENTS_UNSUPPORTED
    )
    expect(() => ipc.mutate('fleet:screenOpen', { environmentId: 'work' }, 'view')).toThrow(
      FLEET_ENVIRONMENTS_UNSUPPORTED
    )
    features.list = ['environments']
    await ipc.mutate('fleet:screenOpen', { botId: 'scout', surface: 'apps' }, 'control')
    await ipc.mutate('fleet:screenOpen', { environmentId: 'work' }, 'control')
    for (const [target, mode] of [
      [{ botId: 'scout', surface: 'desktop' }, 'view'],
      [{ botId: 'scout' }, 'view'],
      [{ environmentId: 'work', surface: 'apps' }, 'view'],
      [{ environmentId: 'work' }, 'drive'],
      ['../scout', 'view'],
    ])
      expect(() => ipc.mutate('fleet:screenOpen', target, mode)).toThrow()
    expect(mocks.openScreen.mock.calls.map(([, target, mode]) => [target, mode])).toEqual([
      [{ botId: 'scout', surface: 'browser' }, 'view'],
      [{ botId: 'scout', surface: 'browser' }, 'control'],
      [{ botId: 'scout', surface: 'apps' }, 'control'],
      [{ environmentId: 'work' }, 'control'],
    ])
  })

  it('marks a screen conflict so the view can tell that the environment display is in use', async () => {
    features.list = ['environments']
    const ipc = register()
    mocks.openScreen.mockRejectedValueOnce(new FleetClientError('CONFLICT', 409, GATEWAY_SCREEN_CONTROLLED))
    await expect(ipc.mutate('fleet:screenOpen', { environmentId: 'work' }, 'control')).rejects.toThrow(
      FLEET_SCREEN_CONFLICT
    )
    // An environment on an image from before environments refuses with 409 too: that is no conflict.
    mocks.openScreen.mockRejectedValueOnce(new FleetClientError('CONFLICT', 409, GATEWAY_RESTART_TO_OPEN_SCREEN))
    await expect(ipc.mutate('fleet:screenOpen', { botId: 'scout', surface: 'apps' }, 'view')).rejects.toThrow(
      FLEET_SCREEN_RESTART_REQUIRED
    )
    mocks.openScreen.mockRejectedValueOnce(new FleetClientError('FORBIDDEN', 403, 'Takeover required for control'))
    await expect(ipc.mutate('fleet:screenOpen', { botId: 'scout', surface: 'apps' }, 'control')).rejects.toThrow(
      'Takeover required for control'
    )
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
    expect(call.mock.calls).toEqual([
      ['botScreenTicket', { params: { id: 'scout' }, body: { mode: 'view', surface: 'browser' } }],
      ['botScreenTicket', { params: { id: 'scout' }, body: { mode: 'control', surface: 'apps' } }],
      ['environmentScreenTicket', { params: { eid: 'work' }, body: { mode: 'control' } }],
    ])
    bridge.closeAll()
  })

  it('opens a renderer screen channel for any target', async () => {
    vi.stubGlobal('WebSocket', { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 })
    const api = {
      fleetScreenOpen: vi.fn(async (_target: unknown, _mode: string) => ({ channelId: 'c1' })),
      fleetScreenSend: vi.fn(async () => {}),
      fleetScreenClose: vi.fn(async () => {}),
      onFleetScreenState: vi.fn(() => vi.fn()),
      onFleetScreenData: vi.fn(() => vi.fn()),
    } satisfies ScreenApi
    await FleetScreenChannel.open(api, { environmentId: 'work' }, 'control')
    await FleetScreenChannel.open(api, { botId: 'scout', surface: 'apps' }, 'view')
    await FleetScreenChannel.open(api, 'scout', 'view')
    expect(api.fleetScreenOpen.mock.calls).toEqual([
      [{ environmentId: 'work' }, 'control'],
      [{ botId: 'scout', surface: 'apps' }, 'view'],
      ['scout', 'view'],
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

describe('environment memory', () => {
  const host = {
    memory: { totalBytes: 8 * 1024 ** 3, usedBytes: 5 * 1024 ** 3, botsBytes: 3 * 1024 ** 3 },
  } as FleetHostInfo
  const resources = (gib: number) => ({
    memoryBytes: gib * 1024 ** 3,
    memoryLimitBytes: null,
    cpuPercent: null,
    startedAt: null,
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

  it('keeps one segment per bot for gateways without environments', () => {
    expect(
      memorySegments(host, [bot('scout', { resources: resources(2) })]).map((segment) => [segment.id, segment.fraction])
    ).toEqual([
      ['scout', 0.25],
      ['system', 0.375],
    ])
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
      await fleetApi.fleetEnvironmentAction('work', 'restart')
      await fleetApi.fleetPatchEnvironment('work', { memoryLimitBytes: null })
      await fleetApi.fleetListArchivedEnvironments()
      await fleetApi.fleetRestoreArchivedEnvironment('work')
      await fleetApi.fleetDeleteArchivedEnvironment('work')
      await fleetApi.fleetEnvironmentUiOpen('work', 'skills')
      await fleetApi.fleetScreenOpen({ environmentId: 'work' }, 'control')
      await fleetApi.fleetBotSkills({ environmentId: 'work' })
      await fleetApi.fleetLoginCancel({ environmentId: 'work' }, 'l1')
      await fleetApi.fleetCreateBot({
        name: 'Scout',
        instructions: '',
        ceiling: 'ask',
        talksTo: [],
        environment: { name: 'Work' },
      })
      await fleetApi.fleetOwnerMemoryCreate({ content: 'Uses the staging VPN.', environmentId: 'work' })
      expect(invoke.mock.calls).toEqual([
        ['fleet:environmentAction', 'work', 'restart'],
        ['fleet:patchEnvironment', 'work', { memoryLimitBytes: null }],
        ['fleet:listArchivedEnvironments'],
        ['fleet:restoreArchivedEnvironment', 'work'],
        ['fleet:deleteArchivedEnvironment', 'work'],
        ['fleet:environmentUiOpen', 'work', 'skills'],
        ['fleet:screenOpen', { environmentId: 'work' }, 'control'],
        ['fleet:bot:skills', { environmentId: 'work' }],
        ['fleet:login:cancel', { environmentId: 'work' }, 'l1'],
        [
          'fleet:createBot',
          { name: 'Scout', instructions: '', ceiling: 'ask', talksTo: [], environment: { name: 'Work' } },
        ],
        ['fleet:ownerMemoryCreate', { content: 'Uses the staging VPN.', environmentId: 'work' }],
      ])
    } finally {
      invoke.mockRestore()
    }
  })
})
