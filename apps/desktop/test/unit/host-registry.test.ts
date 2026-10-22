import { EventEmitter } from 'node:events'
import type { FleetEnvironment } from '@maestrly/bot-fleet-protocol'
import { describe, expect, it, vi } from 'vitest'
import { encodeBridgeFrame } from '../../src/main/remote-host/bridge-codec'
import type { BridgeClientSocket } from '../../src/main/remote-host/client/host-connection'
import { DIRECT_HOST_ID, HostRegistry, parseDirectHost } from '../../src/main/remote-host/client/host-registry'
import type { PeerRecord } from '../../src/main/peer/schemas'
import { issueToken, newPeerRecord } from '../../src/main/peer/store'
import type { FleetServerId } from '../../src/shared/fleet-servers'
import type { HostView } from '../../src/shared/hosts'
import { type PeerProblem, peerHostId } from '../../src/shared/peer'
import type { BridgeClientFrame, BridgeHostFrame } from '../../src/shared/remote-bridge'
import { testIdentity } from './peer-helpers'

const SERVER = '3f0c7a52-7d0e-4c55-9a53-0e6f4d1d2a10'
const HOST = `${SERVER}/workspaces`
const SERVER_B = '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'

/** A bridge socket whose host end the test plays. */
class FakeSocket extends EventEmitter {
  sent: BridgeClientFrame[] = []
  closed = false
  constructor(readonly url: string) {
    super()
  }
  addEventListener(type: string, listener: (event: unknown) => void) {
    this.on(type, listener)
  }
  send(text: string) {
    this.sent.push(JSON.parse(text) as BridgeClientFrame)
  }
  close() {
    this.closed = true
  }
  answer(frame: BridgeHostFrame) {
    this.emit('message', { data: encodeBridgeFrame(frame) })
  }
  /** Opens and welcomes, as a host of the same version does. */
  welcome() {
    this.emit('open', {})
    this.answer({
      t: 'welcome',
      protocol: 1,
      appVersion: '1.2.3',
      host: {
        os: 'linux',
        hostName: 'vps',
        homeDir: '/home/bot',
        roots: ['/home/bot'],
        desktopEffects: false,
        editor: false,
        browser: false,
        computer: false,
        folderTransfers: false,
      },
    })
  }
}

const environment = (patch: Partial<FleetEnvironment> = {}): FleetEnvironment =>
  ({
    id: 'workspaces',
    name: 'Workspaces',
    kind: 'workspaces',
    lifecycle: 'running',
    update: { available: false, pendingSince: null },
    botIds: [],
    ...patch,
  }) as FleetEnvironment

/** Paired computers as the registry reads them: records, their problems, and the sockets their bridges open. */
function fakePeers(records: PeerRecord[]) {
  const listeners = new Set<() => void>()
  const problems = new Map<string, PeerProblem>()
  const connects: string[] = []
  const sockets: FakeSocket[] = []
  return {
    records,
    problems,
    connects,
    sockets,
    list: () => records,
    problem: (deviceId: string) => problems.get(deviceId) ?? null,
    held: (deviceId: string) => ['removed', 'disconnected'].includes(problems.get(deviceId) ?? ''),
    retry(deviceId: string) {
      problems.delete(deviceId)
      this.change()
    },
    onChange: (listener: () => void) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    connect: async (deviceId: string) => {
      connects.push(deviceId)
      const socket = new FakeSocket(`peer:${deviceId}`)
      sockets.push(socket)
      return socket as unknown as BridgeClientSocket
    },
    endpoint: (deviceId: string) => ({
      origin: `https://${deviceId}.local:7690`,
      headers: () => ({ Authorization: 'Bearer t' }),
      certPem: 'pem',
    }),
    change() {
      for (const listener of [...listeners]) listener()
    },
  }
}

/** A paired server the test plays: where it is, its environments, and the tickets this computer asked for. */
function fakeServer(id: string, listeners: Set<() => void>, deviceName: string | null = null) {
  return {
    id: id as FleetServerId,
    deviceName,
    connection: { url: null as string | null, hostname: null as string | null },
    environments: [] as FleetEnvironment[],
    tickets: [] as string[],
    ticketPath: '/v1/bridge?ticket=abc_DEF-123',
    change(patch: { url?: string | null; hostname?: string | null; environments?: FleetEnvironment[] }) {
      if ('url' in patch) this.connection.url = patch.url ?? null
      if ('hostname' in patch) this.connection.hostname = patch.hostname ?? null
      if (patch.environments) this.environments = patch.environments
      for (const listener of [...listeners]) listener()
    },
  }
}

function setup(options: { direct?: boolean; peers?: ReturnType<typeof fakePeers> } = {}) {
  const listeners = new Set<() => void>()
  const fleet = fakeServer(SERVER, listeners)
  const paired = [fleet]
  const servers = {
    paired,
    add(server: ReturnType<typeof fakeServer>) {
      paired.push(server)
      for (const listener of [...listeners]) listener()
    },
    remove(id: string) {
      paired.splice(
        paired.findIndex((server) => server.id === id),
        1
      )
      for (const listener of [...listeners]) listener()
    },
  }
  const sockets: FakeSocket[] = []
  const changes: HostView[][] = []
  const events: unknown[][] = []
  const registry = new HostRegistry({
    servers: {
      list: () =>
        paired.map((server) => ({
          id: server.id,
          getConnection: () => server.connection,
          getSnapshot: () => ({ environments: server.environments }),
          bridgeTicket: async (environmentId: string) => {
            server.tickets.push(environmentId)
            return { path: server.ticketPath }
          },
          deviceName: () => server.deviceName,
        })),
      onChange: (listener) => {
        listeners.add(listener)
        return () => void listeners.delete(listener)
      },
    },
    appVersion: '1.2.3',
    local: { os: 'mac', homeDir: '/Users/me' },
    client: () => ({ deviceName: 'Laptop', os: 'mac', locale: 'en' }),
    openSocket: (url) => {
      const socket = new FakeSocket(url)
      sockets.push(socket)
      return socket as unknown as BridgeClientSocket
    },
    direct: options.direct
      ? {
          host: { origin: 'http://127.0.0.1:7680', token: 'ctl' },
          openSocket: (host) => {
            const socket = new FakeSocket(host.origin)
            sockets.push(socket)
            return socket as unknown as BridgeClientSocket
          },
        }
      : null,
    peers: options.peers ?? null,
    onChanged: (hosts) => changes.push(hosts),
    onEvent: (...args) => events.push(args),
    timings: { retryBaseMs: 5, retryMaxMs: 5 },
  })
  registry.start()
  const remote = () => registry.list().find((host) => host.id === HOST)
  return { fleet, servers, listeners, sockets, changes, events, registry, remote }
}
const paired = { url: 'http://127.0.0.1:7443', hostname: 'vps-1' }

describe('host registry', () => {
  it('lists this computer alone without a server', () => {
    const h = setup()
    expect(h.registry.list()).toEqual([
      {
        id: 'local',
        remote: false,
        label: '',
        server: '',
        serverId: null,
        tint: null,
        state: 'online',
        epoch: 0,
        os: 'mac',
        homeDir: '/Users/me',
        desktopEffects: true,
        editor: true,
        browser: true,
        computer: false,
        folderTransfers: false,
        environment: null,
        peer: null,
        hostVersion: null,
      },
    ])
    // A server with bots only adds no host.
    h.fleet.change({ ...paired, environments: [environment({ id: 'team', kind: 'bots' })] })
    expect(h.registry.list()).toHaveLength(1)
    expect(h.sockets).toEqual([])
  })

  it('reaches the workspaces environment of the paired server through a bridge ticket', async () => {
    const h = setup()
    h.fleet.change({ ...paired, environments: [environment()] })
    expect(h.remote()).toMatchObject({
      remote: true,
      label: 'Workspaces',
      server: 'vps-1',
      state: 'connecting',
      epoch: 0,
      os: 'linux',
    })
    await vi.waitFor(() => expect(h.sockets).toHaveLength(1))
    expect(h.fleet.tickets).toEqual(['workspaces'])
    expect(h.sockets[0].url).toBe('ws://127.0.0.1:7443/v1/bridge?ticket=abc_DEF-123')
    h.sockets[0].welcome()
    expect(h.sockets[0].sent[0]).toEqual({
      t: 'hello',
      protocol: 1,
      appVersion: '1.2.3',
      client: { deviceName: 'Laptop', os: 'mac', locale: 'en' },
    })
    expect(h.remote()).toEqual({
      id: HOST,
      remote: true,
      label: 'Workspaces',
      server: 'vps-1',
      serverId: SERVER,
      tint: null,
      state: 'online',
      epoch: 1,
      os: 'linux',
      homeDir: '/home/bot',
      desktopEffects: false,
      editor: false,
      browser: false,
      computer: false,
      folderTransfers: false,
      environment: { id: 'workspaces', lifecycle: 'running', updateAvailable: false },
      peer: null,
      hostVersion: null,
    })
    expect(h.changes.at(-1)).toEqual(h.registry.list())
  })

  it('offers a Computer tab and folder transfers only for a host that says it has them', async () => {
    const welcome = (host: Record<string, unknown>) =>
      ({
        t: 'welcome',
        protocol: 1,
        appVersion: '1.2.3',
        host: {
          os: 'linux',
          hostName: 'vps',
          homeDir: '/home/bot',
          roots: ['/home/bot'],
          desktopEffects: false,
          editor: true,
          browser: true,
          ...host,
        },
      }) as BridgeHostFrame
    const current = setup()
    current.fleet.change({ ...paired, environments: [environment()] })
    await vi.waitFor(() => expect(current.sockets).toHaveLength(1))
    current.sockets[0].emit('open', {})
    current.sockets[0].answer(welcome({ computer: true, folderTransfers: true }))
    expect(current.remote()?.computer).toBe(true)
    expect(current.remote()?.folderTransfers).toBe(true)
    expect(current.registry.list()[0].computer).toBe(false)

    // A host from before computers, or from before folder transfers, does not say.
    const older = setup()
    older.fleet.change({ ...paired, environments: [environment()] })
    await vi.waitFor(() => expect(older.sockets).toHaveLength(1))
    older.sockets[0].emit('open', {})
    older.sockets[0].answer(welcome({}))
    expect(older.remote()).toMatchObject({ state: 'online', computer: false, folderTransfers: false })
  })

  it('uses a secure socket for a server reached over HTTPS and refuses a ticket path it does not expect', async () => {
    const secure = setup()
    secure.fleet.change({ url: 'https://vps.tailnet.ts.net', environments: [environment()] })
    await vi.waitFor(() => expect(secure.sockets).toHaveLength(1))
    expect(secure.sockets[0].url).toBe('wss://vps.tailnet.ts.net/v1/bridge?ticket=abc_DEF-123')

    const forged = setup()
    forged.fleet.ticketPath = '//evil.example/v1/bridge?ticket=abc'
    forged.fleet.change({ ...paired, environments: [environment()] })
    await vi.waitFor(() => expect(forged.remote()?.state).toBe('reconnecting'))
    expect(forged.sockets).toEqual([])
  })

  it('keeps a host that does not run listed as offline, and dials it once it runs', async () => {
    const h = setup()
    h.fleet.change({
      ...paired,
      environments: [environment({ lifecycle: 'stopped', update: { available: true, pendingSince: null } })],
    })
    expect(h.remote()).toMatchObject({
      state: 'offline',
      environment: { id: 'workspaces', lifecycle: 'stopped', updateAvailable: true },
    })
    expect(h.fleet.tickets).toEqual([])

    h.fleet.change({ environments: [environment({ lifecycle: 'starting' })] })
    expect(h.remote()).toMatchObject({ state: 'offline', environment: { lifecycle: 'starting' } })
    h.fleet.change({ environments: [environment()] })
    await vi.waitFor(() => expect(h.sockets).toHaveLength(1))
    h.sockets[0].welcome()
    expect(h.remote()?.state).toBe('online')

    // Restarted: its bridge is closed and dialed again when it runs, and the epoch tells the window to load again.
    h.fleet.change({ environments: [environment({ lifecycle: 'restarting' })] })
    expect(h.sockets[0].closed).toBe(true)
    expect(h.remote()).toMatchObject({ state: 'offline', epoch: 1 })
    h.fleet.change({ environments: [environment()] })
    await vi.waitFor(() => expect(h.sockets).toHaveLength(2))
    h.sockets[1].welcome()
    expect(h.remote()).toMatchObject({ state: 'online', epoch: 2 })
  })

  it('forgets the host with its environment or its server', async () => {
    const h = setup()
    h.fleet.change({ ...paired, environments: [environment()] })
    await vi.waitFor(() => expect(h.sockets).toHaveLength(1))
    h.sockets[0].welcome()
    h.fleet.change({ environments: [] })
    expect(h.registry.list().map((host) => host.id)).toEqual(['local'])
    expect(h.sockets[0].closed).toBe(true)
    expect(h.registry.get(HOST)).toBeNull()

    h.fleet.change({ environments: [environment()] })
    await vi.waitFor(() => expect(h.sockets).toHaveLength(2))
    h.fleet.change({ url: null })
    expect(h.registry.list().map((host) => host.id)).toEqual(['local'])
  })

  it('makes a renderer an origin of a host on its first call, once, and hands it the host’s pushes', async () => {
    const h = setup()
    h.fleet.change({ ...paired, environments: [environment()] })
    await vi.waitFor(() => expect(h.sockets).toHaveLength(1))
    const [socket] = h.sockets
    socket.welcome()
    const role = vi.fn(() => ({ role: 'main' as const }))
    const connection = h.registry.use(HOST, 12, role)
    expect(h.registry.use(HOST, 12, role)).toBe(connection)
    expect(role).toHaveBeenCalledTimes(1)
    expect(socket.sent.filter((frame) => frame.t === 'open')).toEqual([{ t: 'open', origin: 12, role: 'main' }])
    expect(() => h.registry.use('other/host', 12, role)).toThrow('Unknown host')
    expect(() => h.registry.use('local', 12, role)).toThrow('Unknown host')

    socket.answer({ t: 'event', origin: 12, channel: 'agent:status', args: [{ id: 'c' }] })
    socket.answer({ t: 'event', origin: 13, channel: 'agent:status', args: [{ id: 'c' }] })
    expect(h.events).toEqual([[HOST, 12, 'agent:status', [{ id: 'c' }]]])

    h.registry.closeOrigin(12)
    expect(socket.sent.at(-1)).toEqual({ t: 'close', origin: 12 })
    socket.answer({ t: 'event', origin: 12, channel: 'agent:status', args: [{ id: 'c' }] })
    expect(h.events).toHaveLength(1)
  })

  it('tells the windows only when what they show of a host changed', async () => {
    const h = setup()
    h.fleet.change({ ...paired, environments: [environment()] })
    const count = h.changes.length
    h.fleet.change({})
    h.fleet.change({ environments: [environment()] })
    expect(h.changes).toHaveLength(count)
    h.fleet.change({ hostname: 'renamed' })
    expect(h.changes.at(-1)?.[1]).toMatchObject({ label: 'Workspaces', server: 'renamed' })
    h.fleet.change({ environments: [environment({ name: 'Personal', tint: '#4c9a87' })] })
    expect(h.changes.at(-1)?.[1]).toMatchObject({ label: 'Personal', tint: '#4c9a87' })
  })

  it('lists one host per workspaces environment, each named and colored after it, and dials each one', async () => {
    const h = setup()
    h.fleet.change({
      ...paired,
      environments: [
        environment({ id: 'personal', name: 'Personal', tint: '#4c9a87' }),
        environment({ id: 'team', kind: 'bots', name: 'Team' }),
        environment({ id: 'company-a', name: 'Company A' }),
      ],
    })
    expect(h.registry.list().map((host) => [host.id, host.label, host.server, host.tint])).toEqual([
      ['local', '', '', null],
      [`${SERVER}/personal`, 'Personal', 'vps-1', '#4c9a87'],
      [`${SERVER}/company-a`, 'Company A', 'vps-1', null],
    ])
    await vi.waitFor(() => expect(h.sockets).toHaveLength(2))
    expect(h.fleet.tickets.sort()).toEqual(['company-a', 'personal'])
    // Archiving one leaves the others connected.
    h.fleet.change({ environments: [environment({ id: 'personal', name: 'Personal', tint: '#4c9a87' })] })
    expect(h.registry.list().map((host) => host.id)).toEqual(['local', `${SERVER}/personal`])
    expect(h.sockets.filter((socket) => socket.closed)).toHaveLength(1)
  })

  it('lists the workspaces hosts of every paired server, each dialed through its own server', async () => {
    const h = setup()
    const other = fakeServer(SERVER_B, h.listeners, 'Work laptop')
    h.servers.add(other)
    h.fleet.change({ ...paired, environments: [environment({ id: 'personal', name: 'Personal' })] })
    other.change({
      url: 'https://vps-2.example',
      hostname: 'vps-2',
      environments: [environment({ id: 'personal', name: 'Personal' })],
    })
    // Two servers may name their environments alike: the server tells their hosts apart.
    expect(h.registry.list().map((host) => [host.id, host.serverId, host.server])).toEqual([
      ['local', null, ''],
      [`${SERVER}/personal`, SERVER, 'vps-1'],
      [`${SERVER_B}/personal`, SERVER_B, 'vps-2'],
    ])
    await vi.waitFor(() => expect(h.sockets).toHaveLength(2))
    expect(h.fleet.tickets).toEqual(['personal'])
    expect(other.tickets).toEqual(['personal'])
    expect(h.sockets.map((socket) => socket.url).sort()).toEqual([
      'ws://127.0.0.1:7443/v1/bridge?ticket=abc_DEF-123',
      'wss://vps-2.example/v1/bridge?ticket=abc_DEF-123',
    ])
    // Each host sees this computer under the name it has on that host's server.
    const second = h.sockets.find((socket) => socket.url.startsWith('wss://vps-2.example'))!
    second.welcome()
    expect(second.sent[0]).toMatchObject({ t: 'hello', client: { deviceName: 'Work laptop' } })
    // A server that leaves takes its hosts only.
    h.servers.remove(SERVER_B)
    expect(second.closed).toBe(true)
    expect(h.registry.list().map((host) => host.id)).toEqual(['local', `${SERVER}/personal`])
  })

  it('lists no host for a server that is not paired any more, and none of its kind for the development host', () => {
    const h = setup({ direct: true })
    const unpaired = fakeServer(SERVER_B, h.listeners)
    h.servers.add(unpaired)
    unpaired.change({ environments: [environment()] })
    expect(h.registry.list().map((host) => [host.id, host.serverId])).toEqual([
      ['local', null],
      ['direct/host', null],
    ])
  })

  it('reaches a development host directly, beside the server’s', async () => {
    const h = setup({ direct: true })
    expect(h.registry.list().map((host) => [host.id, host.label, host.state])).toEqual([
      ['local', '', 'online'],
      [DIRECT_HOST_ID, '127.0.0.1:7680', 'connecting'],
    ])
    await vi.waitFor(() => expect(h.sockets).toHaveLength(1))
    h.sockets[0].welcome()
    // The server's changes leave it alone.
    h.fleet.change({ ...paired, environments: [] })
    expect(h.registry.get(DIRECT_HOST_ID)?.snapshot().state).toBe('online')
    h.registry.stop()
    expect(h.sockets[0].closed).toBe(true)
  })

  it('reads a development host only where it is allowed', () => {
    expect(parseDirectHost('http://ctl-token_1@127.0.0.1:7680', true)).toEqual({
      origin: 'http://127.0.0.1:7680',
      token: 'ctl-token_1',
    })
    expect(parseDirectHost('http://ctl@127.0.0.1:7680', false)).toBeNull()
    expect(parseDirectHost(undefined, true)).toBeNull()
    expect(parseDirectHost('http://127.0.0.1:7680', true)).toBeNull()
    expect(parseDirectHost('file://ctl@host/x', true)).toBeNull()
    expect(parseDirectHost('not a url', true)).toBeNull()
  })
})

describe('host registry with paired computers', () => {
  const B = testIdentity('B')
  const PEER = peerHostId(B.deviceId)
  const record = (): PeerRecord =>
    newPeerRecord({
      deviceId: B.deviceId,
      name: 'MacBook B',
      os: 'mac',
      certPem: B.certPem,
      port: 7690,
      addresses: ['10.0.0.5'],
      issuedToken: issueToken(),
      hosting: true,
      now: 1,
    })

  it('lists paired computers after this one and before the server, and dials them', async () => {
    const peers = fakePeers([record()])
    const h = setup({ peers })
    h.fleet.change({ ...paired, environments: [environment()] })
    expect(h.registry.list().map((host) => host.id)).toEqual(['local', PEER, HOST])
    expect(h.registry.list()[1]).toMatchObject({
      id: PEER,
      remote: true,
      label: 'MacBook B',
      server: '',
      serverId: null,
      environment: null,
      peer: { deviceId: B.deviceId, problem: null },
      state: 'connecting',
    })
    await vi.waitFor(() => expect(peers.connects).toEqual([B.deviceId]))
    await vi.waitFor(() => expect(peers.sockets).toHaveLength(1))
    peers.sockets[0].welcome()
    expect(h.registry.list()[1]).toMatchObject({ state: 'online', epoch: 1 })
    expect(h.registry.peerEndpoint(PEER)?.origin).toBe(`https://${B.deviceId}.local:7690`)
    expect(h.registry.peerEndpoint(HOST)).toBeNull()
    expect(h.registry.list()[0].peer).toBeNull()
    expect(h.registry.list()[2].peer).toBeNull()
  })

  it('drops a computer that is no longer paired', async () => {
    const peers = fakePeers([record()])
    const h = setup({ peers })
    await vi.waitFor(() => expect(peers.sockets).toHaveLength(1))
    peers.records.splice(0)
    peers.change()
    expect(h.registry.list().map((host) => host.id)).toEqual(['local'])
    expect(peers.sockets[0].closed).toBe(true)
    expect(h.registry.peerEndpoint(PEER)).toBeNull()
  })

  it('stops dialing a computer that removed this one', async () => {
    const peers = fakePeers([record()])
    const h = setup({ peers })
    await vi.waitFor(() => expect(peers.sockets).toHaveLength(1))
    peers.problems.set(B.deviceId, 'removed')
    peers.change()
    expect(h.registry.list()[1]).toMatchObject({ state: 'offline', peer: { problem: 'removed' } })
    expect(peers.sockets[0].closed).toBe(true)
  })

  it('dials a computer that disconnected this one again once the owner asks', async () => {
    const peers = fakePeers([record()])
    const h = setup({ peers })
    await vi.waitFor(() => expect(peers.sockets).toHaveLength(1))
    peers.problems.set(B.deviceId, 'disconnected')
    peers.change()
    expect(peers.sockets[0].closed).toBe(true)
    expect(h.registry.list()[1]).toMatchObject({ state: 'offline', peer: { problem: 'disconnected' } })
    h.registry.retry(PEER)
    expect(peers.problems.has(B.deviceId)).toBe(false)
    await vi.waitFor(() => expect(peers.sockets).toHaveLength(2))
    peers.sockets[1].welcome()
    expect(h.registry.list()[1]).toMatchObject({ state: 'online', peer: { problem: null } })
  })

  it('lists a computer that only uses this one once it shares itself', async () => {
    const peers = fakePeers([{ ...record(), hosting: false }])
    const h = setup({ peers })
    expect(h.registry.list().map((host) => host.id)).toEqual(['local'])
    // Still dialed: the computer may have started sharing itself since the pairing.
    await vi.waitFor(() => expect(peers.sockets).toHaveLength(1))
    peers.sockets[0].welcome()
    expect(h.registry.list().map((host) => host.id)).toEqual(['local', PEER])
  })

  it('keeps paired computers when the server changes', async () => {
    const peers = fakePeers([record()])
    const h = setup({ peers })
    h.fleet.change({ ...paired, environments: [environment()] })
    h.fleet.change({ environments: [] })
    expect(h.registry.list().map((host) => host.id)).toEqual(['local', PEER])
  })
})
