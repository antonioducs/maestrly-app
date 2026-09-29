import { describe, expect, it } from 'vitest'
import type { FleetBot, FleetEnvironment, FleetHostInfo } from '@maestrly/bot-fleet-protocol'
import type { FleetConnectionView, FleetSnapshot } from '../../src/preload/api-fleet'
import type { FleetInstallRecord, FleetInstallerJob, FleetInstallerStatus } from '../../src/shared/fleet-installer'
import {
  botUpdateSummary,
  environmentUpdateState,
  serverUpdate,
  updateBlockers,
} from '../../src/renderer/lib/fleet/updates'

const at = '2026-09-29T10:00:00.000Z'
const record = (patch: Partial<FleetInstallRecord> = {}): FleetInstallRecord => ({
  mode: 'local',
  version: '0.9.3',
  port: 7450,
  allowPrivateNetwork: false,
  remote: null,
  installedAt: at,
  ...patch,
})
const installer = (patch: Partial<FleetInstallerStatus> = {}): FleetInstallerStatus => ({
  record: record(),
  appVersion: '0.9.4',
  update: 'available',
  tunnel: 'off',
  keyPersistence: null,
  job: null,
  ...patch,
})
const host = (gatewayVersion: string, botImageVersion: string | null = null) =>
  ({ gatewayVersion, botImageVersion }) as FleetHostInfo
const environment = (id: string, patch: Partial<FleetEnvironment> = {}): FleetEnvironment => ({
  id,
  name: 'Environment ' + id,
  lifecycle: 'running',
  setup: { step: 'ready', error: null, errorMessage: null },
  resources: { memoryBytes: null, memoryLimitBytes: null, cpuPercent: null, startedAt: null },
  memoryLimitBytes: null,
  compaction: null,
  appVersion: '0.9.3',
  capabilities: ['environments'],
  update: { available: false, pendingSince: null },
  botIds: [],
  createdAt: at,
  updatedAt: at,
  ...patch,
})
const bot = (name: string, status: FleetBot['status'], environmentId = 'work') =>
  ({ id: name.toLowerCase(), name, status, environmentId }) as FleetBot
const connection = (patch: Partial<FleetConnectionView> = {}): FleetConnectionView => ({
  features: ['environments', 'environment-updates'],
  state: 'connected',
  deviceId: 'device-1',
  url: 'http://127.0.0.1:7450',
  hostname: 'server',
  error: null,
  tokenPersistence: 'secure',
  ...patch,
})
const snapshot = (patch: Partial<FleetSnapshot> = {}): FleetSnapshot => ({
  host: host('0.9.3'),
  bots: [],
  environments: [],
  inbox: [],
  peerMessages: [],
  ...patch,
})
const job = (kind: 'update' | 'private-network'): FleetInstallerJob => ({
  id: 'job',
  kind,
  mode: 'local',
  steps: [],
  state: 'running',
  error: null,
  startedAt: at,
  hostKey: null,
})

describe('the bot server update', () => {
  it('offers an update for a server this app installed that is older than the app', () => {
    expect(serverUpdate(installer(), host('0.9.3'))).toBe('update')
    expect(serverUpdate(installer(), null)).toBe('update')
  })

  it('never offers to move back a server the gateway reports as newer, whatever was recorded', () => {
    expect(serverUpdate(installer(), host('0.9.9'))).toBe('newer')
    expect(serverUpdate(installer({ record: record({ version: '0.9.4' }) }), host('0.9.4'))).toBe('current')
    // Not a release version: the recorded one counts.
    expect(serverUpdate(installer(), host('test'))).toBe('update')
  })

  it('tells about a server this app did not install when its gateway is older than the app', () => {
    expect(serverUpdate(installer({ record: null }), host('0.9.3'))).toBe('behind')
    expect(serverUpdate(installer({ record: null }), host('0.9.4'))).toBe('current')
    expect(serverUpdate(installer({ record: null }), host('0.1.0-dev'))).toBe('behind')
    expect(serverUpdate(installer({ record: null }), host('local'))).toBe('current')
    expect(serverUpdate(installer({ record: null }), null)).toBe('current')
    expect(serverUpdate(null, host('0.9.3'))).toBe('current')
  })
})

describe('an environment update', () => {
  it('follows what the gateway reports', () => {
    const available = { available: true, pendingSince: null }
    expect(environmentUpdateState(environment('a', { update: available }), null)).toBe('available')
    expect(environmentUpdateState(environment('a', { update: { available: true, pendingSince: at } }), null)).toBe(
      'pending'
    )
    expect(environmentUpdateState(environment('a'), null)).toBe('current')
    for (const lifecycle of ['stopped', 'failed'] as const)
      expect(environmentUpdateState(environment('a', { lifecycle, update: available }), null)).toBe('next-start')
    expect(environmentUpdateState(environment('a', { lifecycle: 'restarting', update: available }), null)).toBe(
      'current'
    )
  })

  it('compares versions on a gateway that does not report updates', () => {
    const older = environment('a', { update: null, appVersion: '0.9.3' })
    expect(environmentUpdateState(older, host('0.9.4', '0.9.4'))).toBe('available')
    expect(environmentUpdateState({ ...older, lifecycle: 'stopped' }, host('0.9.4', '0.9.4'))).toBe('next-start')
    expect(environmentUpdateState(older, host('0.9.4', '0.9.3'))).toBe('current')
    expect(environmentUpdateState(older, host('0.9.4', null))).toBe('current')
  })

  it('waits for the bots that work, wait for their owner or whose screen the owner controls', () => {
    const bots = [
      bot('Ana', 'working'),
      bot('Bob', 'waiting'),
      bot('Cleo', 'human'),
      bot('Dan', 'idle'),
      bot('Eve', 'paused'),
      bot('Fay', 'working', 'home'),
    ]
    expect(updateBlockers(environment('work'), bots).map((item) => item.name)).toEqual(['Ana', 'Bob', 'Cleo'])
    expect(updateBlockers(environment('none'), bots)).toEqual([])
  })
})

describe('the bot update summary', () => {
  const available = environment('work', { update: { available: true, pendingSince: null } })

  it('offers one click when the server or an environment can be updated', () => {
    const server = botUpdateSummary({ installer: installer(), connection: connection(), snapshot: snapshot() })
    expect(server).toEqual({
      server: 'update',
      environments: {},
      available: true,
      pending: false,
      canUpdate: true,
      targetVersion: '0.9.4',
    })
    const environments = botUpdateSummary({
      installer: installer({ record: record({ version: '0.9.4' }) }),
      connection: connection(),
      snapshot: snapshot({ host: host('0.9.4', '0.9.4'), environments: [available] }),
    })
    expect(environments).toMatchObject({
      server: 'current',
      environments: { work: 'available' },
      available: true,
      canUpdate: true,
      targetVersion: '0.9.4',
    })
    const nothing = botUpdateSummary({
      installer: installer({ record: record({ version: '0.9.4' }) }),
      connection: connection(),
      snapshot: snapshot({ host: host('0.9.4'), environments: [environment('work')] }),
    })
    expect(nothing).toMatchObject({ available: false, pending: false, canUpdate: false })
  })

  it('offers no click while disconnected, busy, unreachable, or for environments the gateway cannot schedule', () => {
    const input = { installer: installer(), connection: connection(), snapshot: snapshot() }
    expect(botUpdateSummary({ ...input, connection: connection({ state: 'reconnecting' }) }).canUpdate).toBe(false)
    expect(botUpdateSummary({ ...input, installer: installer({ job: job('private-network') }) }).canUpdate).toBe(false)
    const remote = installer({
      record: record({
        mode: 'remote',
        remote: { host: 'vps', port: 22, username: 'root', hostKey: 'SHA256:x', keyTag: 'k' },
      }),
      tunnel: 'reconnecting',
    })
    expect(botUpdateSummary({ ...input, installer: remote }).canUpdate).toBe(false)
    expect(botUpdateSummary({ ...input, installer: { ...remote, tunnel: 'connected' } }).canUpdate).toBe(true)
    // An older gateway: environments keep their own Update button, the banner offers nothing.
    const legacy = botUpdateSummary({
      installer: installer({ record: null }),
      connection: connection({ features: ['environments'] }),
      snapshot: snapshot({
        host: host('0.9.4', '0.9.4'),
        environments: [environment('work', { update: null, appVersion: '0.9.3' })],
      }),
    })
    expect(legacy).toMatchObject({ environments: { work: 'available' }, available: true, canUpdate: false })
  })

  it('shows progress while the server updates or an environment waits for its bots', () => {
    const updating = botUpdateSummary({
      installer: installer({ job: job('update') }),
      connection: connection(),
      snapshot: snapshot(),
    })
    expect(updating).toMatchObject({ pending: true, canUpdate: false })
    const waiting = botUpdateSummary({
      installer: installer({ record: record({ version: '0.9.4' }) }),
      connection: connection(),
      snapshot: snapshot({
        host: host('0.9.4'),
        environments: [environment('work', { update: { available: true, pendingSince: at } })],
      }),
    })
    expect(waiting).toMatchObject({ environments: { work: 'pending' }, pending: true, available: false })
  })

  it('reports a server this app cannot update without offering to update it', () => {
    const behind = botUpdateSummary({
      installer: installer({ record: null }),
      connection: connection(),
      snapshot: snapshot({ host: host('0.9.3') }),
    })
    expect(behind).toMatchObject({ server: 'behind', available: true, canUpdate: false })
  })
})
