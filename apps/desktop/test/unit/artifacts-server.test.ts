import { ArtifactHostError, type ArtifactAdmin, callAdmin, ADMIN_METHODS } from '@maestrly/artifact-host'
import { expect, it, vi } from 'vitest'
import { ServerArtifacts } from '../../src/main/artifacts/server-artifacts'
import { createFleetAdmin } from '../../src/main/artifacts/sources'
import type { FleetClientService, FleetConnectionView } from '../../src/main/fleet/client/service'
function fixture() {
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
  const call = vi.fn(async () => host)
  const fleet = {
    call,
    hasFeature: (f: string) => connection.features.includes(f),
    getConnection: () => connection,
  } as unknown as Pick<FleetClientService, 'call' | 'hasFeature' | 'getConnection'>
  return { connection, host, call, server: new ServerArtifacts({ fleet, viewerPort: () => 4011 }) }
}
it('discovers hosting and provides no source when disabled or unsupported', async () => {
  const h = fixture()
  expect(h.server.source()).toBeNull()
  expect(await h.server.refresh()).toMatchObject({ state: 'ready', canOpen: true })
  expect(h.server.source()?.viewerBase()).toBe('http://127.0.0.1:4011')
  h.host.settings.enabled = false
  expect(await h.server.refresh()).toEqual({ state: 'off' })
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
