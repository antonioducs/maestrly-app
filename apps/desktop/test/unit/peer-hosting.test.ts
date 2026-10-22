import { createServer, type Server } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FLEET_PROTOCOL_HEADER, FLEET_PROTOCOL_VERSION } from '@maestrly/bot-fleet-protocol'
import { WebSocket } from 'ws'
import type { HostFilesRoutes } from '../../src/main/fleet/instance/host-files-http'
import type { EditorRoutes } from '../../src/main/fleet/instance/server'
import { PeerHosting } from '../../src/main/peer/hosting'
import { peerRequest, pinnedTls } from '../../src/main/peer/http'
import type { PeerIdentity } from '../../src/main/peer/identity'
import { issueToken, newPeerRecord, PeerStore } from '../../src/main/peer/store'
import type { BridgeClientSocket } from '../../src/main/remote-host/client/host-connection'
import { HostConnection } from '../../src/main/remote-host/client/host-connection'
import { IpcHandlerTable } from '../../src/main/remote-host/ipc-handler-table'
import { REMOTE_BRIDGE_CLOSE, type RemoteHostInfo } from '../../src/shared/remote-bridge'
import { memoryPeerStorage, testIdentity } from './peer-helpers'

const A = testIdentity('A')
const B = testIdentity('B')
const hostInfo: RemoteHostInfo = {
  os: 'mac',
  hostName: 'macbook-a',
  homeDir: '/Users/a',
  roots: ['/Users/a'],
  desktopEffects: false,
  editor: true,
  browser: true,
  computer: false,
  folderTransfers: true,
}

const closers: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close()
})

function setup(identity: () => PeerIdentity | null = () => A) {
  const storage = memoryPeerStorage()
  const store = new PeerStore(storage)
  const table = new IpcHandlerTable()
  table.record('test:echo', 'invoke', (_event, value: unknown) => value)
  const holds: string[] = []
  const release = vi.fn()
  const editor = { request: vi.fn(), upgrade: vi.fn(), closeAll: vi.fn() }
  const hostFiles = { sweep: vi.fn(async () => undefined) }
  const hosting = new PeerHosting({
    storage,
    identity,
    store,
    appVersion: '1.2.3',
    os: 'mac',
    hub: { table, appVersion: '1.2.3', hostInfo: () => hostInfo, log: vi.fn() },
    hostFiles: hostFiles as unknown as HostFilesRoutes & { sweep(): Promise<unknown> },
    editor: editor as unknown as EditorRoutes & { closeAll(): void },
    holdAwake: (key) => {
      holds.push(key)
      return release
    },
    localAddresses: () => ['127.0.0.1'],
    onPrompt: vi.fn(),
    onChange: vi.fn(),
    bind: { host: '127.0.0.1', port: 0 },
  })
  closers.push(() => hosting.stop())
  return { storage, store, hosting, holds, release, editor, hostFiles }
}

/** Pairs B in A's store as a pairing would, and returns the token B presents. */
function pairB(store: PeerStore): string {
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
      hosting: true,
      now: Date.now(),
    }),
    'token-a-uses-to-reach-b-0123456789abcdef'
  )
  return token
}

/** A port another program holds while the test runs; `free` releases it at once, for a port nobody holds. */
async function heldPort(free = false): Promise<number> {
  const server: Server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  const release = () => new Promise<void>((resolve) => server.close(() => resolve()))
  if (free) await release()
  else closers.push(release)
  return port
}

function connect(port: number | (() => number), token: string, closes: Array<[number, string]> = []) {
  const connection = new HostConnection({
    connect: async () => {
      const at = typeof port === 'number' ? port : port()
      const socket = new WebSocket(`wss://127.0.0.1:${at}/v1/bridge`, {
        headers: { [FLEET_PROTOCOL_HEADER]: String(FLEET_PROTOCOL_VERSION), Authorization: `Bearer ${token}` },
        ...pinnedTls(A.certPem),
      })
      socket.on('close', (code, reason) => closes.push([code, String(reason)]))
      return socket as unknown as BridgeClientSocket
    },
    appVersion: '1.2.3',
    client: () => ({ deviceName: 'B', os: 'mac', locale: 'en' }),
    onChange: () => undefined,
    onEvent: () => undefined,
    timings: { retryBaseMs: 50, retryMaxMs: 100, welcomeTimeoutMs: 2_000 },
  })
  closers.push(() => connection.stop())
  return connection
}

describe('PeerHosting', () => {
  it('stays closed until the owner turns it on', async () => {
    const h = setup()
    expect(h.hosting.enabled()).toBe(false)
    await h.hosting.start()
    expect(h.hosting.listeningPort()).toBeNull()
  })

  it('opens the peer server when turned on', async () => {
    const h = setup()
    await expect(h.hosting.setEnabled(true)).resolves.toBe('ok')
    expect(h.storage.get('peer.hosting')).toBe('1')
    const port = h.hosting.listeningPort()
    expect(port).toEqual(expect.any(Number))
    const hello = await peerRequest({ host: '127.0.0.1', port: port ?? 0 }, 'GET', '/v1/peer/hello', { pin: A.certPem })
    expect(hello.body).toMatchObject({ deviceId: A.deviceId, os: 'mac', pairing: true })
    expect(h.hostFiles.sweep).toHaveBeenCalled()
  })

  it('cannot host without a keyring', async () => {
    const h = setup(() => null)
    await expect(h.hosting.setEnabled(true)).resolves.toBe('keyring-unavailable')
    expect(h.hosting.enabled()).toBe(false)
    expect(h.hosting.listeningPort()).toBeNull()
  })

  it('lets a paired computer use it, keeps awake meanwhile, and cuts it off once removed', async () => {
    const h = setup()
    const token = pairB(h.store)
    await h.hosting.setEnabled(true)
    const connection = connect(h.hosting.listeningPort() ?? 0, token)
    connection.start()
    await vi.waitFor(() => expect(connection.snapshot().state).toBe('online'))
    connection.openOrigin(5, { role: 'main' })
    await expect(connection.invoke(5, 'test:echo', ['hi'])).resolves.toBe('hi')
    expect(h.hosting.connected()).toEqual([B.deviceId])
    expect(h.holds).toEqual(['peer-sessions'])
    h.store.remove(B.deviceId)
    await vi.waitFor(() => expect(h.hosting.connected()).toEqual([]))
    expect(h.release).toHaveBeenCalled()
    expect(h.editor.closeAll).toHaveBeenCalled()
  })

  it('moves to a chosen port, used exactly, and tells the computers using it where it went', async () => {
    const h = setup()
    const token = pairB(h.store)
    await h.hosting.setEnabled(true)
    const before = h.hosting.listeningPort() ?? 0
    const closes: Array<[number, string]> = []
    let dialed = before
    const connection = connect(() => dialed, token, closes)
    connection.start()
    await vi.waitFor(() => expect(connection.snapshot().state).toBe('online'))

    const chosen = await heldPort(true)
    await expect(h.hosting.setPort(chosen)).resolves.toBeNull()
    expect(h.hosting.chosenPort()).toBe(chosen)
    expect(h.hosting.listeningPort()).toBe(chosen)
    expect(h.storage.get('peer.port')).toBe(String(chosen))
    // B's session closes with the new port, which B dials next.
    await vi.waitFor(() => expect(closes).toContainEqual([REMOTE_BRIDGE_CLOSE.moved, String(chosen)]))
    dialed = chosen
    await vi.waitFor(() => expect(connection.snapshot().state).toBe('online'))
    expect(h.hosting.connected()).toEqual([B.deviceId])
    await expect(
      peerRequest({ host: '127.0.0.1', port: before }, 'GET', '/v1/peer/hello', { pin: A.certPem })
    ).rejects.toThrow()
    const hello = await peerRequest({ host: '127.0.0.1', port: chosen }, 'GET', '/v1/peer/hello', { pin: A.certPem })
    expect(hello.status).toBe(200)

    // Back to the default: here, a port the system chooses.
    await expect(h.hosting.setPort(null)).resolves.toBeNull()
    expect(h.hosting.chosenPort()).toBeNull()
    expect(h.storage.get('peer.port')).toBe('')
    expect(h.hosting.listeningPort()).not.toBe(chosen)
  })

  it('stays where it is when the chosen port is taken or out of range', async () => {
    const h = setup()
    const token = pairB(h.store)
    await h.hosting.setEnabled(true)
    const before = h.hosting.listeningPort()
    const closes: Array<[number, string]> = []
    const connection = connect(before ?? 0, token, closes)
    connection.start()
    await vi.waitFor(() => expect(connection.snapshot().state).toBe('online'))
    h.storage.values.delete('peer.port')

    await expect(h.hosting.setPort(await heldPort())).resolves.toBe('in-use')
    await expect(h.hosting.setPort(80)).resolves.toBe('invalid')
    await expect(h.hosting.setPort(70_000)).resolves.toBe('invalid')
    await expect(h.hosting.setPort(7690.5)).resolves.toBe('invalid')
    expect(h.hosting.listeningPort()).toBe(before)
    expect(h.hosting.chosenPort()).toBeNull()
    expect(h.storage.values.has('peer.port')).toBe(false)
    expect(closes).toEqual([])
    expect(connection.snapshot().state).toBe('online')
  })

  it('keeps a port chosen while off, and listens there once turned on', async () => {
    const h = setup()
    const chosen = await heldPort(true)
    await expect(h.hosting.setPort(chosen)).resolves.toBeNull()
    expect(h.hosting.listeningPort()).toBeNull()
    await h.hosting.setEnabled(true)
    expect(h.hosting.listeningPort()).toBe(chosen)
  })

  it('starts sharing again on a free port after the chosen one was taken at startup', async () => {
    const h = setup()
    h.storage.set('peer.port', String(await heldPort()))
    h.storage.set('peer.hosting', '1')
    await h.hosting.start()
    expect(h.hosting.listeningPort()).toBeNull()
    expect(h.hosting.error()).toMatch(/EADDRINUSE/)
    const free = await heldPort(true)
    await expect(h.hosting.setPort(free)).resolves.toBeNull()
    expect(h.hosting.listeningPort()).toBe(free)
    expect(h.hosting.error()).toBeNull()
    expect(h.hostFiles.sweep).toHaveBeenCalled()
  })

  it('closes the peer server when turned off', async () => {
    const h = setup()
    await h.hosting.setEnabled(true)
    const port = h.hosting.listeningPort() ?? 0
    await expect(h.hosting.setEnabled(false)).resolves.toBe('ok')
    expect(h.storage.get('peer.hosting')).toBe('')
    expect(h.hosting.listeningPort()).toBeNull()
    await expect(
      peerRequest({ host: '127.0.0.1', port }, 'GET', '/v1/peer/hello', { pin: A.certPem })
    ).rejects.toThrow()
  })
})
