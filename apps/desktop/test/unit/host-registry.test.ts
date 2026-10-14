import { EventEmitter } from 'node:events'
import type { FleetEnvironment } from '@maestrly/bot-fleet-protocol'
import { describe, expect, it, vi } from 'vitest'
import { encodeBridgeFrame } from '../../src/main/remote-host/bridge-codec'
import type { BridgeClientSocket } from '../../src/main/remote-host/client/host-connection'
import { DIRECT_HOST_ID, HostRegistry, parseDirectHost } from '../../src/main/remote-host/client/host-registry'
import type { HostView } from '../../src/shared/hosts'
import type { BridgeClientFrame, BridgeHostFrame } from '../../src/shared/remote-bridge'

const SERVER = '3f0c7a52-7d0e-4c55-9a53-0e6f4d1d2a10'
const HOST = `${SERVER}/workspaces`

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

function setup(options: { direct?: boolean } = {}) {
  const fleet = {
    connection: { url: null as string | null, hostname: null as string | null },
    environments: [] as FleetEnvironment[],
    listeners: new Set<() => void>(),
    tickets: [] as string[],
    ticketPath: '/v1/bridge?ticket=abc_DEF-123',
    change(patch: { url?: string | null; hostname?: string | null; environments?: FleetEnvironment[] }) {
      if ('url' in patch) this.connection.url = patch.url ?? null
      if ('hostname' in patch) this.connection.hostname = patch.hostname ?? null
      if (patch.environments) this.environments = patch.environments
      for (const listener of [...this.listeners]) listener()
    },
  }
  const sockets: FakeSocket[] = []
  const changes: HostView[][] = []
  const events: unknown[][] = []
  const registry = new HostRegistry({
    fleet: {
      getConnection: () => fleet.connection,
      getSnapshot: () => ({ environments: fleet.environments }),
      onChange: (listener) => {
        fleet.listeners.add(listener)
        return () => void fleet.listeners.delete(listener)
      },
      bridgeTicket: async (environmentId) => {
        fleet.tickets.push(environmentId)
        return { path: fleet.ticketPath }
      },
    },
    serverId: () => SERVER,
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
    onChanged: (hosts) => changes.push(hosts),
    onEvent: (...args) => events.push(args),
    timings: { retryBaseMs: 5, retryMaxMs: 5 },
  })
  registry.start()
  const remote = () => registry.list().find((host) => host.id === HOST)
  return { fleet, sockets, changes, events, registry, remote }
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
        tint: null,
        state: 'online',
        epoch: 0,
        os: 'mac',
        homeDir: '/Users/me',
        desktopEffects: true,
        editor: true,
        browser: true,
        environment: null,
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
      tint: null,
      state: 'online',
      epoch: 1,
      os: 'linux',
      homeDir: '/home/bot',
      desktopEffects: false,
      editor: false,
      browser: false,
      environment: { id: 'workspaces', lifecycle: 'running', updateAvailable: false },
      hostVersion: null,
    })
    expect(h.changes.at(-1)).toEqual(h.registry.list())
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
