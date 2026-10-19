import { once } from 'node:events'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { FLEET_HOST_FILE_ERRORS, FLEET_HOST_FILE_GATEWAY_ERRORS } from '@maestrly/bot-fleet-protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HostFilesRoutes } from '../../src/main/fleet/instance/host-files-http'
import {
  classifyTransferError,
  HostFilesHttpError,
  resolveHostFilesEndpoint,
  TransferFailure,
  TransientFailure,
} from '../../src/main/host-transfers/endpoint'
import type { HostPairings } from '../../src/main/peer/pairing-host'
import { createPeerServer } from '../../src/main/peer/server'
import { issueToken, newPeerRecord, PeerStore } from '../../src/main/peer/store'
import type { HostView } from '../../src/shared/hosts'
import { memoryPeerStorage, testIdentity } from './peer-helpers'

const servers: Array<http.Server | ReturnType<typeof createPeerServer>> = []
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
})

type Seen = { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }
async function stub(answer: (seen: Seen) => { status: number; body: unknown }) {
  const seen: Seen[] = []
  const server = http.createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    const request = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body }
    seen.push(request)
    const { status, body: reply } = answer(request)
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(reply))
  })
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen }
}

const STAT = { path: '/srv/a.csv', name: 'a.csv', size: 3, modifiedAt: 1, identity: '3:1:2' }
const host = (id: string, lifecycle: string): HostView =>
  ({ id, remote: true, environment: { id: 'workspaces', lifecycle, updateAvailable: false } }) as HostView
const client = (origin: string, features: string[] = ['host-files'], token = 'device') => ({
  hostFilesAccess: () => ({ origin, headers: { 'X-Maestrly-Fleet-Protocol': '1', Authorization: `Bearer ${token}` } }),
  hasFeature: (feature: string) => features.includes(feature),
})
/** The paired servers: `server-1` alone, reached at `origin`. */
const fleet = (origin: string, features: string[] = ['host-files']) => {
  const server = client(origin, features)
  return (serverId: string) => (serverId === 'server-1' ? server : null)
}
const registry = (hosts: HostView[], direct: { origin: string; token: string } | null = null) => ({
  list: () => hosts,
  directHost: () => direct,
})
const failureOf = (run: () => unknown) => {
  try {
    run()
    return null
  } catch (error) {
    return error
  }
}

describe('host files endpoint', () => {
  it("reaches a server's workspaces through the gateway, with this device's credentials", async () => {
    const gateway = await stub(() => ({ status: 200, body: STAT }))
    const endpoint = resolveHostFilesEndpoint('server-1/workspaces', {
      registry: registry([host('server-1/workspaces', 'running')]),
      fleet: fleet(gateway.origin),
    })
    expect(await endpoint.json('hostFileStat', { body: { path: '/srv/a.csv' } })).toEqual(STAT)
    expect(gateway.seen[0]).toMatchObject({
      method: 'POST',
      url: '/v1/environments/workspaces/host-files/stat',
      body: JSON.stringify({ path: '/srv/a.csv' }),
    })
    expect(gateway.seen[0].headers.authorization).toBe('Bearer device')
    expect(gateway.seen[0].headers['x-maestrly-fleet-protocol']).toBe('1')
  })

  it("reaches each host through its own server's gateway and device", async () => {
    const one = await stub(() => ({ status: 200, body: STAT }))
    const two = await stub(() => ({ status: 200, body: STAT }))
    const servers = { 'server-1': client(one.origin), 'server-2': client(two.origin, ['host-files'], 'device-2') }
    const deps = {
      registry: registry([host('server-1/workspaces', 'running'), host('server-2/workspaces', 'running')]),
      fleet: (serverId: string) => servers[serverId as keyof typeof servers] ?? null,
    }
    await resolveHostFilesEndpoint('server-2/workspaces', deps).json('hostFileStat', { body: { path: '/srv/a' } })
    expect(one.seen).toEqual([])
    expect(two.seen[0].headers.authorization).toBe('Bearer device-2')
    const unpaired = failureOf(() =>
      resolveHostFilesEndpoint('server-3/workspaces', {
        ...deps,
        registry: registry([host('server-3/workspaces', 'running')]),
      })
    )
    expect((unpaired as TransferFailure).reason).toBe('unknown-host')
  })

  it('sends the folder routes only through a gateway that passes them', async () => {
    const gateway = await stub(() => ({ status: 200, body: { archiveId: 'a'.repeat(32) } }))
    const through = (features: string[]) =>
      resolveHostFilesEndpoint('server-1/workspaces', {
        registry: registry([host('server-1/workspaces', 'running')]),
        fleet: fleet(gateway.origin, features),
      })
    const begin = { body: { path: '/srv/site' } }
    const old = await through(['host-files'])
      .json('hostFileArchiveBegin', begin)
      .catch((error) => error)
    expect((old as TransferFailure).reason).toBe('gateway-update-required')
    expect(gateway.seen).toEqual([])
    expect(await through(['host-files', 'host-files-folders']).json('hostFileArchiveBegin', begin)).toEqual({
      archiveId: 'a'.repeat(32),
    })
    expect(gateway.seen[0]).toMatchObject({ method: 'POST', url: '/v1/environments/workspaces/host-files/archives' })
  })

  it('reaches the development host straight at its control server', async () => {
    const direct = await stub(() => ({ status: 200, body: STAT }))
    const endpoint = resolveHostFilesEndpoint('direct/host', {
      registry: registry([], { origin: direct.origin, token: 'host-token' }),
      fleet: fleet('http://unused.invalid'),
    })
    await endpoint.json('hostFileStat', { body: { path: '/srv/a.csv' } })
    expect(direct.seen[0].url).toBe('/v1/host-files/stat')
    expect(direct.seen[0].headers.authorization).toBe('Bearer host-token')
  })

  it("tells a host's refusal by its reason, and a lost network as transient", async () => {
    const refusing = await stub(() => ({
      status: 409,
      body: { code: 'CONFLICT', message: FLEET_HOST_FILE_ERRORS.changed },
    }))
    const endpoint = resolveHostFilesEndpoint('direct/host', {
      registry: registry([], { origin: refusing.origin, token: 't' }),
      fleet: fleet(''),
    })
    const refused = await endpoint.json('hostFileStat', { body: { path: '/srv/a' } }).catch((error) => error)
    expect(refused).toBeInstanceOf(HostFilesHttpError)
    expect((refused as HostFilesHttpError).reason).toBe('changed')
    const unreachable = resolveHostFilesEndpoint('direct/host', {
      registry: registry([], { origin: 'http://127.0.0.1:1', token: 't' }),
      fleet: fleet(''),
    })
    expect(await unreachable.json('hostFileStat', { body: { path: '/srv/a' } }).catch((error) => error)).toBeInstanceOf(
      TransientFailure
    )
  })

  it('says why a host cannot be reached for files', () => {
    const unknown = failureOf(() =>
      resolveHostFilesEndpoint('server-1/gone', { registry: registry([]), fleet: fleet('') })
    )
    expect(unknown).toBeInstanceOf(TransferFailure)
    expect((unknown as TransferFailure).reason).toBe('unknown-host')
    expect(
      failureOf(() =>
        resolveHostFilesEndpoint('server-1/workspaces', {
          registry: registry([host('server-1/workspaces', 'stopped')]),
          fleet: fleet(''),
        })
      )
    ).toBeInstanceOf(TransientFailure)
    const old = failureOf(() =>
      resolveHostFilesEndpoint('server-1/workspaces', {
        registry: registry([host('server-1/workspaces', 'running')]),
        fleet: fleet('', []),
      })
    )
    expect((old as TransferFailure).reason).toBe('gateway-update-required')
    expect(
      (
        failureOf(() =>
          resolveHostFilesEndpoint('local', { registry: registry([]), fleet: fleet('') })
        ) as TransferFailure
      ).reason
    ).toBe('unknown-host')
  })

  it('classifies what stops a transfer', () => {
    const http = (status: number, code: string, message: string) => new HostFilesHttpError(status, code, message)
    expect(classifyTransferError(http(409, 'CONFLICT', FLEET_HOST_FILE_GATEWAY_ERRORS.updateHost))).toMatchObject({
      transient: false,
      reason: 'host-update-required',
    })
    for (const error of [
      http(409, 'CONFLICT', FLEET_HOST_FILE_GATEWAY_ERRORS.notRunning),
      http(503, 'INSTANCE_UNAVAILABLE', 'down'),
      new TypeError('fetch failed'),
      Object.assign(new Error('reset'), { code: 'ECONNRESET' }),
      new TransientFailure('offline'),
    ])
      expect(classifyTransferError(error).transient).toBe(true)
    expect(classifyTransferError(Object.assign(new Error('full'), { code: 'ENOSPC' }))).toMatchObject({
      transient: false,
      reason: 'disk-full',
    })
    expect(classifyTransferError(http(401, 'UNAUTHORIZED', 'no')).reason).toBe('unauthorized')
    expect(classifyTransferError(http(404, 'NOT_FOUND', 'Route not found.')).reason).toBe('host-update-required')
    for (const reason of ['digest-mismatch', 'chunk-mismatch', 'unknown-upload'] as const)
      expect(classifyTransferError(http(409, 'CONFLICT', FLEET_HOST_FILE_ERRORS[reason]))).toMatchObject({
        transient: false,
        reason: 'verification-failed',
      })
    expect(classifyTransferError(http(409, 'CONFLICT', FLEET_HOST_FILE_ERRORS.exists)).reason).toBe('exists')
    expect(classifyTransferError(http(409, 'CONFLICT', FLEET_HOST_FILE_ERRORS['unsafe-archive'])).reason).toBe(
      'unsafe-archive'
    )
    expect(classifyTransferError(http(404, 'NOT_FOUND', FLEET_HOST_FILE_ERRORS['archive-expired'])).reason).toBe(
      'archive-expired'
    )
    expect(classifyTransferError(http(409, 'CONFLICT', FLEET_HOST_FILE_ERRORS['no-space']))).toMatchObject({
      transient: false,
      reason: 'host-full',
    })
    expect(classifyTransferError(new TransferFailure('local-missing')).reason).toBe('local-missing')
    expect(classifyTransferError(new Error('odd'))).toEqual({ transient: false, reason: 'unknown', message: 'odd' })
  })
})

describe("a paired computer's files", () => {
  const A = testIdentity('A')
  const B = testIdentity('B')
  const PEER = `peer/${A.deviceId}`

  async function peerServer() {
    const store = new PeerStore(memoryPeerStorage())
    const token = issueToken()
    store.save(
      newPeerRecord({
        deviceId: B.deviceId,
        name: 'B',
        os: 'mac',
        certPem: B.certPem,
        port: 7690,
        addresses: [],
        issuedToken: token,
        now: Date.now(),
      }),
      issueToken()
    )
    const stat = vi.fn(async () => STAT)
    const server = createPeerServer({
      identity: A,
      appVersion: '1.2.3',
      os: 'mac',
      store,
      pairings: {
        accepting: () => false,
        request: vi.fn(),
        exchange: vi.fn(),
        confirm: vi.fn(),
        abort: vi.fn(),
      } as unknown as HostPairings,
      bridge: { handleUpgrade: (_request, socket) => socket.destroy() },
      hostFiles: { stat } as unknown as HostFilesRoutes,
      editor: null,
      now: Date.now,
    })
    servers.push(server)
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const port = (server.address() as AddressInfo).port
    return {
      stat,
      endpoint: {
        origin: `https://127.0.0.1:${port}`,
        headers: () => ({ 'X-Maestrly-Fleet-Protocol': '1', Authorization: `Bearer ${token}` }),
        certPem: A.certPem,
      },
    }
  }

  it('moves over the certificate pinned at pairing', async () => {
    const peer = await peerServer()
    const endpoint = resolveHostFilesEndpoint(PEER, {
      registry: { list: () => [], directHost: () => null, peerEndpoint: () => peer.endpoint },
      fleet: fleet('https://gateway.invalid'),
    })
    await expect(endpoint.json('hostFileStat', { body: { path: '/srv/a.csv' } })).resolves.toEqual(STAT)
    expect(peer.stat).toHaveBeenCalledWith({ path: '/srv/a.csv' })
    const impostor = resolveHostFilesEndpoint(PEER, {
      registry: {
        list: () => [],
        directHost: () => null,
        peerEndpoint: () => ({ ...peer.endpoint, certPem: B.certPem }),
      },
      fleet: fleet('https://gateway.invalid'),
    })
    await expect(impostor.json('hostFileStat', { body: { path: '/srv/a.csv' } })).rejects.toBeInstanceOf(
      TransientFailure
    )
  })

  it('is unknown while the computer is not paired', () => {
    const run = () =>
      resolveHostFilesEndpoint(PEER, {
        registry: { list: () => [], directHost: () => null, peerEndpoint: () => null },
        fleet: fleet('https://gateway.invalid'),
      })
    expect(failureOf(run)).toBeInstanceOf(TransferFailure)
    expect(failureOf(run)).toMatchObject({ reason: 'unknown-host' })
  })
})
