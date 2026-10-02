import { ArtifactHostError, type ArtifactAdmin, callAdmin, ADMIN_METHODS } from '@maestrly/artifact-host'
import { expect, it, vi } from 'vitest'
import { ServerArtifacts } from '../../src/main/artifacts/server-artifacts'
import { createFleetAdmin } from '../../src/main/artifacts/sources'
import type { FleetClientService, FleetConnectionView } from '../../src/main/fleet/client/service'
function fixture(options: { viewerPort?: () => number | null } = {}) {
  const connection: FleetConnectionView = {
    state: 'connected',
    features: ['artifacts'],
    deviceId: 'dev-1',
    url: 'http://127.0.0.1:7443',
    hostname: 'server',
    error: null,
    tokenPersistence: 'secure',
  }
  const host = {
    settings: { enabled: true, publicAddress: '', ownerName: 'Owner', linkExpiryDays: 7, quotaGb: 2 },
    status: { state: 'running', problem: null, artifactCount: 1, storageBytes: 30, quotaBytes: 2 ** 31 },
  }
  const call = vi.fn(async (): Promise<unknown> => host)
  const fleet = {
    call,
    hasFeature: (f: string) => connection.features.includes(f),
    getConnection: () => connection,
  } as unknown as Pick<FleetClientService, 'call' | 'hasFeature' | 'getConnection'>
  return {
    connection,
    host,
    call,
    server: new ServerArtifacts({ fleet, viewerPort: options.viewerPort ?? (() => 4011) }),
  }
}
const GATEWAY_VIEWER = 'artifacts-gateway-viewer'
it('discovers hosting and provides no source when disabled or unsupported', async () => {
  const h = fixture()
  expect(h.server.source()).toBeNull()
  expect(await h.server.refresh()).toMatchObject({ state: 'ready', canOpen: true })
  expect(h.server.source()?.viewerBase()).toBe('http://127.0.0.1:4011')
  h.host.settings.enabled = false
  expect(await h.server.refresh()).toEqual({ state: 'off', canMove: false })
  expect(h.server.source()).toBeNull()
  expect(h.server.unavailable()).toMatchObject({ details: { reason: 'server_off' } })
  h.connection.features = []
  expect(await h.server.refresh()).toEqual({ state: 'unsupported' })
  h.connection.deviceId = null
  expect(await h.server.refresh()).toEqual({ state: 'absent' })
})
it('invalidates a source when the connection or device changes', async () => {
  const h = fixture()
  await h.server.refresh()
  const source = h.server.source()!
  h.connection.state = 'reconnecting'
  await expect(source.admin()).rejects.toMatchObject({ code: 'host_unavailable' })
  h.connection.state = 'connected'
  h.connection.deviceId = 'dev-2'
  expect(h.server.host()).toBeNull()
  await expect(source.admin()).rejects.toMatchObject({ code: 'host_unavailable' })
})
it('discards an in-flight response from a previous pairing', async () => {
  const h = fixture()
  let resolve!: (value: typeof h.host) => void
  h.call.mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r
      })
  )
  const waiting = h.server.refresh()
  h.connection.deviceId = 'dev-2'
  resolve(h.host)
  await waiting
  expect(h.server.host()).toBeNull()
  expect(h.server.source()).toBeNull()
})
it('reports a failed host without claiming it is off or offering its admin', async () => {
  const h = fixture()
  Object.assign(h.host.status, { state: 'error', problem: 'port_in_use' })
  expect(await h.server.refresh()).toMatchObject({ state: 'ready', canOpen: false, problem: 'port_in_use' })
  expect(h.server.source()).toBeNull()
})
it('routes binary uploads separately and preserves errors through JSON', async () => {
  const calls: string[] = []
  const local = {
    setThumbnail: vi.fn(async () => {}),
    get: vi.fn(async () => {
      throw new ArtifactHostError('not_found', 'Gone')
    }),
  } as unknown as ArtifactAdmin
  const fleet = {
    call: async (key: string, opts: { body: { method: string; args: unknown[] } }) => {
      calls.push(key)
      const call = JSON.parse(JSON.stringify(opts.body))
      return JSON.parse(JSON.stringify(await callAdmin(local, call.method, call.args, { allowed: ADMIN_METHODS })))
    },
  } as unknown as Pick<FleetClientService, 'call'>
  const admin = createFleetAdmin(fleet)
  const bytes = new Uint8Array([0, 255, 1])
  await admin.setThumbnail('AAAAAAAAAAAAAAAAAAAAAA', 1, bytes)
  expect(local.setThumbnail).toHaveBeenCalledWith('AAAAAAAAAAAAAAAAAAAAAA', 1, bytes)
  await expect(admin.get('AAAAAAAAAAAAAAAAAAAAAA')).rejects.toMatchObject({ code: 'not_found' })
  expect(calls).toEqual(['artifactUpload', 'artifactAdmin'])
  const offline = createFleetAdmin({
    call: async () => {
      throw Error('Offline')
    },
  } as unknown as Pick<FleetClientService, 'call'>)
  await expect(offline.get('AAAAAAAAAAAAAAAAAAAAAA')).rejects.toMatchObject({
    details: { reason: 'server_unreachable' },
  })
})

it('rechecks pairing on every call from an already acquired admin', async () => {
  const h = fixture()
  await h.server.refresh()
  const admin = await h.server.source()!.admin()
  h.call.mockClear()
  h.connection.deviceId = 'dev-2'
  await expect(admin.get('AAAAAAAAAAAAAAAAAAAAAA')).rejects.toMatchObject({ code: 'host_unavailable' })
  expect(h.call).not.toHaveBeenCalled()
})
it('refuses a remote admin result after its pairing was replaced', async () => {
  const h = fixture()
  await h.server.refresh()
  const admin = await h.server.source()!.admin()
  let resolve!: (value: unknown) => void
  h.call.mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r
      })
  )
  const getting = admin.get('AAAAAAAAAAAAAAAAAAAAAA')
  h.connection.deviceId = 'dev-2'
  resolve({ ok: true, value: null })
  await expect(getting).rejects.toMatchObject({ code: 'host_unavailable' })
})

it('keeps newer settings when an older refresh finishes after a settings update', async () => {
  const h = fixture()
  let resolve!: (value: unknown) => void
  h.call.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r
      })
  )
  const refresh = h.server.refresh()
  await h.server.update({ enabled: true })
  resolve({ ...h.host, settings: { ...h.host.settings, enabled: false } })
  await refresh
  expect(h.server.host()?.settings.enabled).toBe(true)
  expect(h.server.status().state).toBe('ready')
})

it('opens artifacts through the paired gateway when it serves the viewer', async () => {
  const h = fixture()
  h.connection.features = ['artifacts', GATEWAY_VIEWER]
  expect(await h.server.refresh()).toMatchObject({ state: 'ready', canOpen: true })
  // The gateway's own port wins over the separate artifact port, even while that one is available.
  expect(h.server.source()?.viewerBase()).toBe('http://127.0.0.1:7443')
  expect(h.server.source()?.publicBase()).toBeNull()
  h.host.settings.publicAddress = 'https://bots.example.ts.net'
  await h.server.refresh()
  expect(h.server.source()?.viewerBase()).toBe('http://127.0.0.1:7443')
  expect(h.server.source()?.publicBase()).toBe('https://bots.example.ts.net')
})

it('follows an SSH tunnel to the gateway without the separate artifact tunnel', async () => {
  let viewerPort: number | null = 53_111
  const h = fixture({ viewerPort: () => viewerPort })
  h.connection.features = ['artifacts', GATEWAY_VIEWER]
  h.connection.url = 'http://127.0.0.1:52000'
  viewerPort = null
  expect(await h.server.refresh()).toMatchObject({ state: 'ready', canOpen: true })
  expect(h.server.source()?.viewerBase()).toBe('http://127.0.0.1:52000')
})

it('uses an HTTPS gateway only at the address its artifact host accepts', async () => {
  const h = fixture({ viewerPort: () => null })
  h.connection.features = ['artifacts', GATEWAY_VIEWER]
  h.connection.url = 'https://bots.example.ts.net'
  // Without a public address the host would refuse that Host, so nothing can be opened.
  expect(await h.server.refresh()).toMatchObject({ state: 'ready', canOpen: false })
  expect(h.server.source()?.viewerBase()).toBeNull()
  h.host.settings.publicAddress = 'https://bots.example.ts.net'
  expect(await h.server.refresh()).toMatchObject({ state: 'ready', canOpen: true })
  expect(h.server.source()?.viewerBase()).toBe('https://bots.example.ts.net')
  h.host.settings.publicAddress = 'https://artifacts.example.ts.net'
  await h.server.refresh()
  expect(h.server.source()?.viewerBase()).toBe('https://artifacts.example.ts.net')
})

it('keeps the separate artifact port for a gateway that does not serve the viewer', async () => {
  let viewerPort: number | null = 4011
  const h = fixture({ viewerPort: () => viewerPort })
  await h.server.refresh()
  expect(h.server.source()?.viewerBase()).toBe('http://127.0.0.1:4011')
  viewerPort = null
  h.host.settings.publicAddress = 'https://bots.example.ts.net'
  await h.server.refresh()
  expect(h.server.source()?.viewerBase()).toBe('https://bots.example.ts.net')
  h.host.settings.publicAddress = ''
  expect(await h.server.refresh()).toMatchObject({ state: 'ready', canOpen: false })
})

it('offers no gateway viewer while hosting is off, unreachable, or paired elsewhere', async () => {
  const h = fixture()
  h.connection.features = ['artifacts', GATEWAY_VIEWER]
  await h.server.refresh()
  const source = h.server.source()!
  expect(source.viewerBase()).toBe('http://127.0.0.1:7443')
  h.connection.deviceId = 'dev-2'
  expect(source.viewerBase()).toBeNull()
  h.connection.deviceId = 'dev-1'
  h.host.settings.enabled = false
  await h.server.refresh()
  expect(h.server.source()).toBeNull()
  h.host.settings.enabled = true
  h.call.mockRejectedValueOnce(new Error('Offline'))
  expect(await h.server.refresh()).toEqual({ state: 'unreachable' })
  expect(h.server.source()).toBeNull()
})

it('explains why the server cannot host, and whether it accepts moved artifacts', async () => {
  const h = fixture()
  await h.server.refresh()
  expect(h.server.unavailable()).toBeNull()
  expect(h.server.status()).toMatchObject({ state: 'ready', canMove: false })
  h.connection.features = ['artifacts', 'artifacts-transfer']
  expect(await h.server.refresh()).toMatchObject({ state: 'ready', canMove: true })
  h.call.mockRejectedValueOnce(new Error('Offline'))
  await h.server.refresh()
  expect(h.server.unavailable()).toMatchObject({ details: { reason: 'server_unreachable' } })
  h.connection.features = []
  await h.server.refresh()
  expect(h.server.unavailable()).toMatchObject({ details: { reason: 'server_unsupported' } })
  h.connection.deviceId = null
  await h.server.refresh()
  expect(h.server.unavailable()).toMatchObject({ code: 'host_unavailable', details: { reason: 'server_absent' } })
})
