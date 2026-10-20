import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/unused' } }))
vi.mock('../../src/main/window-ipc', () => ({ broadcast: vi.fn() }))

import type { FleetServerRecord, TokenPersistence } from '../../src/main/fleet/client/settings'
import type { FleetClientDeps, FleetClientService } from '../../src/main/fleet/client/service'
import { FleetServers } from '../../src/main/fleet/client/servers'
import {
  FLEET_SERVER_ALREADY_PAIRED,
  FLEET_SERVER_UNKNOWN,
  type FleetConnectionView,
  type FleetServerId,
} from '../../src/shared/fleet-servers'

const A = 'aaaaaaaa-0000-4000-8000-000000000001' as FleetServerId
const B = 'bbbbbbbb-0000-4000-8000-000000000002' as FleetServerId
const NEW = 'cccccccc-0000-4000-8000-000000000003' as FleetServerId

/** A client that records what the registry asks of it, with a connection the test sets. */
class FakeClient {
  readonly calls: string[] = []
  connection: FleetConnectionView
  private readonly listeners = new Set<() => void>()
  constructor(readonly deps: FleetClientDeps) {
    this.connection = {
      features: [],
      state: 'unconfigured',
      deviceId: null,
      url: null,
      hostname: null,
      error: null,
      tokenPersistence: 'secure',
    }
  }
  get serverId() {
    return this.deps.serverId
  }
  start() {
    this.calls.push('start')
    const credentials = this.deps.credentials()
    this.connection = { ...this.connection, url: credentials?.url ?? null, deviceId: credentials?.deviceId ?? null }
  }
  stop() {
    this.calls.push('stop')
  }
  restart(features?: string[]) {
    this.calls.push(features ? `restart:${features.join(',')}` : 'restart')
    this.start()
  }
  async unpair() {
    this.calls.push('unpair')
  }
  getConnection() {
    return this.connection
  }
  onChange(listener: () => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  emitChange() {
    for (const listener of this.listeners) listener()
  }
}

function setup(records: FleetServerRecord[] = []) {
  const store = { records: [...records], tokens: new Map<FleetServerId, string>() }
  const ids = [NEW]
  const clients: FakeClient[] = []
  const emitted: Array<{ channel: string; payload: unknown }> = []
  const migrate = vi.fn()
  const pair = vi.fn(async (input: { url: string; code: string; deviceName: string }) => ({
    origin: input.url,
    deviceId: 'device-new',
    deviceName: input.deviceName,
    token: 'token-new',
    features: ['phones'],
  }))
  const purgeScope = vi.fn(async () => {})
  let installed: FleetServerId | null = null
  const servers = new FleetServers({
    records: {
      migrate,
      read: () => store.records.map((record) => ({ ...record })),
      write: (record) => {
        const at = store.records.findIndex((item) => item.id === record.id)
        if (at < 0) store.records.push(record)
        else store.records[at] = record
      },
      delete: (id) => {
        store.records = store.records.filter((record) => record.id !== id)
        store.tokens.delete(id)
      },
      token: (id) => ({ token: store.tokens.get(id) ?? null, persistence: 'secure' as TokenPersistence }),
      saveToken: (id, token) => {
        store.tokens.set(id, token)
        return 'secure'
      },
      newId: () => ids.shift() ?? (`dddddddd-0000-4000-8000-00000000000${clients.length}` as FleetServerId),
    },
    pair,
    createClient: (deps) => {
      const client = new FakeClient(deps)
      clients.push(client)
      return client as unknown as FleetClientService
    },
    installedServerId: () => installed,
    emit: (channel, payload) => emitted.push({ channel, payload }),
    hostname: () => 'Laptop',
    now: () => '2026-10-19T00:00:00.000Z',
    media: { purgeScope } as never,
  })
  return {
    servers,
    store,
    clients,
    emitted,
    migrate,
    pair,
    purgeScope,
    install: (id: FleetServerId | null) => {
      installed = id
    },
  }
}
const record = (id: FleetServerId, url: string, deviceId = `device-${id.slice(0, 1)}`): FleetServerRecord => ({
  id,
  url,
  deviceId,
  deviceName: 'Mac',
  pairedAt: '2026-10-01T00:00:00.000Z',
})

describe('fleet servers', () => {
  let h: ReturnType<typeof setup>
  beforeEach(() => {
    h = setup([record(A, 'http://127.0.0.1:7443'), record(B, 'https://vps.example')])
  })

  it('starts one client per record, in order, each set up before it starts', () => {
    const setupOrder: string[] = []
    h.servers.setupClients((client) =>
      setupOrder.push(`${client.serverId}:${(client as unknown as FakeClient).calls.length}`)
    )
    h.servers.start()
    h.servers.start()
    expect(h.migrate).toHaveBeenCalledOnce()
    expect(h.servers.clients().map((client) => client.serverId)).toEqual([A, B])
    // Set up with no call made yet: before `start`.
    expect(setupOrder).toEqual([`${A}:0`, `${B}:0`])
    expect(h.clients.map((client) => client.calls)).toEqual([['start'], ['start']])
    const late: string[] = []
    h.servers.setupClients((client) => late.push(client.serverId))
    expect(late).toEqual([A, B])
  })

  it('pairs a new server, and refuses an address that is already paired', async () => {
    h.servers.start()
    await expect(h.servers.pair({ url: 'http://127.0.0.1:7443', code: 'ABCD-EFGH' })).rejects.toThrow(
      FLEET_SERVER_ALREADY_PAIRED
    )
    expect(h.pair).not.toHaveBeenCalled()
    const view = await h.servers.pair({ url: 'https://other.example', code: 'ABCD-EFGH' })
    expect(h.pair).toHaveBeenCalledWith({ url: 'https://other.example', code: 'ABCD-EFGH', deviceName: 'Laptop' })
    expect(view.id).toBe(NEW)
    expect(h.store.tokens.get(NEW)).toBe('token-new')
    expect(h.store.records.at(-1)).toEqual({
      id: NEW,
      url: 'https://other.example',
      deviceId: 'device-new',
      deviceName: 'Laptop',
      pairedAt: '2026-10-19T00:00:00.000Z',
    })
    expect(h.clients.at(-1)?.calls).toEqual(['restart:phones', 'start'])
    const last = h.emitted.filter((item) => item.channel === 'fleet:servers').at(-1)!
    expect((last.payload as Array<{ id: string }>).map((item) => item.id)).toEqual([A, B, NEW])
  })

  it('pairs a server again under its id at the same address, and forgets the old device', async () => {
    h.servers.start()
    const view = await h.servers.pair({ url: 'https://vps.example', code: 'ABCD-EFGH', deviceName: 'Mac' }, B)
    expect(view.id).toBe(B)
    expect(h.clients[1].calls).toEqual(['start', 'stop', 'restart:phones', 'start'])
    expect(h.purgeScope).toHaveBeenCalledWith('device-b')
    expect(h.store.records.find((item) => item.id === B)).toMatchObject({
      deviceId: 'device-new',
      pairedAt: '2026-10-01T00:00:00.000Z',
    })
    expect(h.store.tokens.get(B)).toBe('token-new')
  })

  it('pairs another address as a new server and removes the old one', async () => {
    h.servers.start()
    const view = await h.servers.pair({ url: 'https://new-vps.example', code: 'ABCD-EFGH' }, B)
    expect(view.id).toBe(NEW)
    expect(h.clients[1].calls).toContain('unpair')
    expect(h.servers.clients().map((client) => client.serverId)).toEqual([A, NEW])
    expect(h.store.records.map((item) => item.id)).toEqual([A, NEW])
  })

  it('moves a server to another address and restarts only its client', () => {
    h.servers.start()
    h.servers.retarget(A, 'http://127.0.0.1:7471')
    expect(h.store.records[0].url).toBe('http://127.0.0.1:7471')
    expect(h.clients[0].calls).toEqual(['start', 'restart', 'start'])
    expect(h.clients[1].calls).toEqual(['start'])
    expect(() => h.servers.retarget(A, 'http://example.com')).toThrow()
  })

  it('removes a server: it leaves the server, and its record and client are gone', async () => {
    h.servers.start()
    await h.servers.remove(A)
    expect(h.clients[0].calls).toContain('unpair')
    expect(h.store.records.map((item) => item.id)).toEqual([B])
    expect(h.servers.get(A)).toBeNull()
    const last = h.emitted.filter((item) => item.channel === 'fleet:servers').at(-1)!
    expect((last.payload as Array<{ id: string }>).map((item) => item.id)).toEqual([B])
  })

  it('keeps a server listed, unpaired, until what its removal waits on ends', async () => {
    h.servers.start()
    const seen: { calls: string[]; listed: boolean }[] = []
    await h.servers.remove(A, async () => {
      seen.push({ calls: [...h.clients[0].calls], listed: h.servers.get(A) !== null })
    })
    expect(seen).toEqual([{ calls: expect.arrayContaining(['unpair']), listed: true }])
    expect(h.servers.get(A)).toBeNull()
    // It leaves even when what it waited on failed.
    await expect(
      h.servers.remove(B, async () => {
        throw new Error('unreachable')
      })
    ).rejects.toThrow('unreachable')
    expect(h.servers.get(B)).toBeNull()
    expect(h.store.records).toEqual([])
  })

  it('refuses a server it does not know', () => {
    h.servers.start()
    expect(() => h.servers.require('eeeeeeee-0000-4000-8000-000000000009' as FleetServerId)).toThrow(
      FLEET_SERVER_UNKNOWN
    )
  })

  it('marks the installed server, defaults to it, and lists again only when the list changes', () => {
    h.servers.start()
    expect(h.servers.default()?.serverId).toBe(A)
    h.install(B)
    expect(h.servers.list().map((item) => [item.id, item.installed])).toEqual([
      [A, false],
      [B, true],
    ])
    expect(h.servers.default()?.serverId).toBe(B)
    const listed = () => h.emitted.filter((item) => item.channel === 'fleet:servers').length
    const before = listed()
    h.clients[0].emitChange()
    expect(listed()).toBe(before + 1)
    h.clients[0].emitChange()
    expect(listed()).toBe(before + 1)
    h.clients[0].connection = { ...h.clients[0].connection, state: 'connected' }
    h.clients[0].emitChange()
    expect(listed()).toBe(before + 2)
  })
})
