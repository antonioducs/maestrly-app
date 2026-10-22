import { once } from 'node:events'
import type { IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'
import { FLEET_PROTOCOL_HEADER, FLEET_PROTOCOL_VERSION } from '@maestrly/bot-fleet-protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'
import type { HostFilesRoutes } from '../../src/main/fleet/instance/host-files-http'
import { peerRequest, pinnedTls } from '../../src/main/peer/http'
import { HostPairings } from '../../src/main/peer/pairing-host'
import { createPeerServer } from '../../src/main/peer/server'
import { issueToken, newPeerRecord, PeerStore } from '../../src/main/peer/store'
import { memoryPeerStorage, testIdentity } from './peer-helpers'

const A = testIdentity('A')
const B = testIdentity('B')
const C = testIdentity('C')
const PROTOCOL = { [FLEET_PROTOCOL_HEADER]: String(FLEET_PROTOCOL_VERSION) }
const STAT = { path: '/home/a/x.txt', name: 'x.txt', size: 1, modifiedAt: 2, identity: '1:2:3' }

let server: ReturnType<typeof createPeerServer>
let port = 0
let store: PeerStore
let tokenB = ''
let tags: string[]
let hostFiles: { stat: ReturnType<typeof vi.fn> }
const wss = new WebSocketServer({ noServer: true })

beforeEach(async () => {
  store = new PeerStore(memoryPeerStorage())
  tokenB = issueToken()
  store.save(
    newPeerRecord({
      deviceId: B.deviceId,
      name: 'B',
      os: 'mac',
      certPem: B.certPem,
      port: 7690,
      addresses: [],
      issuedToken: tokenB,
      hosting: true,
      now: Date.now(),
    }),
    'token-a-uses-to-reach-b-0123456789abcdef'
  )
  tags = []
  hostFiles = { stat: vi.fn(async () => STAT) }
  server = createPeerServer({
    identity: A,
    appVersion: '1.2.3',
    os: 'linux',
    store,
    pairings: new HostPairings({
      identity: () => A,
      appVersion: '1.2.3',
      now: Date.now,
      onPrompt: () => undefined,
      onPaired: () => ({ token: issueToken(), port: 7690, addresses: [] }),
    }),
    bridge: {
      handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer, tag: string) {
        tags.push(tag)
        wss.handleUpgrade(request, socket, head, (ws) => ws.close(1000, 'done'))
      },
    },
    hostFiles: hostFiles as unknown as HostFilesRoutes,
    editor: null,
    now: Date.now,
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  port = (server.address() as AddressInfo).port
})

afterEach(async () => {
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
})

const address = () => ({ host: '127.0.0.1', port })
const pairingRequest = (identity = C) => ({
  deviceId: identity.deviceId,
  name: 'C',
  os: 'win',
  appVersion: '1.2.3',
  certificate: identity.certPem,
})

function upgrade(headers: Record<string, string>): Promise<{ opened: boolean; status: number | null }> {
  return new Promise((resolve) => {
    const socket = new WebSocket(`wss://127.0.0.1:${port}/v1/bridge`, { headers, ...pinnedTls(A.certPem) })
    socket.on('open', () => {
      resolve({ opened: true, status: null })
      socket.close()
    })
    socket.on('unexpected-response', (_request, response) => {
      resolve({ opened: false, status: response.statusCode ?? null })
      response.resume()
      socket.terminate()
    })
    socket.on('error', () => undefined)
  })
}

describe('peer server', () => {
  it('says who it is', async () => {
    const hello = await peerRequest(address(), 'GET', '/v1/peer/hello', { pin: A.certPem })
    expect(hello.status).toBe(200)
    expect(hello.body).toEqual({
      deviceId: A.deviceId,
      name: 'A',
      os: 'linux',
      appVersion: '1.2.3',
      fingerprint: A.fingerprint,
      pairing: true,
    })
  })

  it('refuses requests from web pages', async () => {
    const response = await peerRequest(address(), 'GET', '/v1/peer/hello', {
      pin: A.certPem,
      headers: { origin: 'https://example.com' },
    })
    expect(response.status).toBe(403)
  })

  it('starts one pairing at a time', async () => {
    const first = await peerRequest<{ pairingId: string; expiresAt: number }>(address(), 'POST', '/v1/peer/pairings', {
      pin: A.certPem,
      body: pairingRequest(),
    })
    expect(first.status).toBe(200)
    expect(first.body.pairingId).toMatch(/^[0-9a-f-]{36}$/)
    const second = await peerRequest(address(), 'POST', '/v1/peer/pairings', { pin: A.certPem, body: pairingRequest() })
    expect(second.status).toBe(409)
    expect(second.body).toMatchObject({ code: 'busy' })
  })

  it('lets a paired computer forget this one', async () => {
    const anonymous = await peerRequest(address(), 'DELETE', '/v1/peer/self', { pin: A.certPem })
    expect(anonymous.status).toBe(401)
    const removed = await peerRequest(address(), 'DELETE', '/v1/peer/self', {
      pin: A.certPem,
      headers: { authorization: `Bearer ${tokenB}` },
    })
    expect(removed.status).toBe(204)
    expect(store.get(B.deviceId)).toBeNull()
  })

  it('serves host files to a paired computer of the same protocol', async () => {
    const auth = { authorization: `Bearer ${tokenB}` }
    const stat = await peerRequest(address(), 'POST', '/v1/host-files/stat', {
      pin: A.certPem,
      headers: { ...auth, ...PROTOCOL },
      body: { path: '/home/a/x.txt' },
    })
    expect(stat.status).toBe(200)
    expect(stat.body).toEqual(STAT)
    expect(hostFiles.stat).toHaveBeenCalledWith({ path: '/home/a/x.txt' })
    expect(store.get(B.deviceId)?.addresses).toEqual(['127.0.0.1'])
    const noProtocol = await peerRequest(address(), 'POST', '/v1/host-files/stat', {
      pin: A.certPem,
      headers: auth,
      body: { path: '/home/a/x.txt' },
    })
    expect(noProtocol.status).toBe(426)
    const wrong = await peerRequest(address(), 'POST', '/v1/host-files/stat', {
      pin: A.certPem,
      headers: { authorization: 'Bearer wrong', ...PROTOCOL },
      body: { path: '/home/a/x.txt' },
    })
    expect(wrong.status).toBe(401)
  })

  it('hands the bridge of a paired computer to the hub with its device id', async () => {
    await expect(upgrade({ authorization: `Bearer ${tokenB}`, ...PROTOCOL })).resolves.toEqual({
      opened: true,
      status: null,
    })
    expect(tags).toEqual([B.deviceId])
    await expect(upgrade(PROTOCOL)).resolves.toEqual({ opened: false, status: 401 })
    expect(tags).toEqual([B.deviceId])
  })

  it('serves nothing else', async () => {
    const response = await peerRequest(address(), 'GET', '/v1/health', {
      pin: A.certPem,
      headers: { authorization: `Bearer ${tokenB}`, ...PROTOCOL },
    })
    expect(response.status).toBe(404)
  })
})
