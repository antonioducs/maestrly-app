import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HostFilesRoutes } from '../../src/main/fleet/instance/host-files-http'
import type { EditorRoutes } from '../../src/main/fleet/instance/server'
import { PeerUnreachable } from '../../src/main/peer/dial'
import { PeerHosting } from '../../src/main/peer/hosting'
import { PeerHosts } from '../../src/main/peer/peer-hosts'
import { issueToken, newPeerRecord, PeerStore } from '../../src/main/peer/store'
import { IpcHandlerTable } from '../../src/main/remote-host/ipc-handler-table'
import type { RemoteHostInfo } from '../../src/shared/remote-bridge'
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

/** A hosting A with B paired, and B's store holding A, as two paired computers have them. */
async function pairedComputers() {
  const storeA = new PeerStore(memoryPeerStorage())
  const storeB = new PeerStore(memoryPeerStorage())
  const hosting = new PeerHosting({
    storage: memoryPeerStorage(),
    identity: () => A,
    store: storeA,
    appVersion: '1.2.3',
    os: 'mac',
    hub: { table: new IpcHandlerTable(), appVersion: '1.2.3', hostInfo: () => hostInfo, log: vi.fn() },
    hostFiles: { sweep: vi.fn(async () => undefined) } as unknown as HostFilesRoutes & { sweep(): Promise<unknown> },
    editor: { request: vi.fn(), upgrade: vi.fn(), closeAll: vi.fn() } as unknown as EditorRoutes & {
      closeAll(): void
    },
    holdAwake: () => () => undefined,
    localAddresses: () => ['127.0.0.1'],
    onPrompt: vi.fn(),
    onChange: vi.fn(),
    bind: { host: '127.0.0.1', port: 0 },
  })
  closers.push(() => hosting.stop())
  await hosting.setEnabled(true)
  const port = hosting.listeningPort() ?? 0
  const tokenFromA = issueToken()
  const now = Date.now()
  storeA.save(
    newPeerRecord({
      deviceId: B.deviceId,
      name: 'B',
      os: 'mac',
      certPem: B.certPem,
      port: 7690,
      addresses: [],
      issuedToken: tokenFromA,
      now,
    }),
    issueToken()
  )
  storeB.save(
    newPeerRecord({
      deviceId: A.deviceId,
      name: 'A',
      os: 'mac',
      certPem: A.certPem,
      port,
      addresses: ['10.255.255.1', '127.0.0.1'],
      issuedToken: issueToken(),
      now: now - 120_000,
    }),
    tokenFromA
  )
  return { storeA, storeB, port, tokenFromA }
}

function opened(socket: unknown): Promise<'open' | 'closed'> {
  const ws = socket as { addEventListener(type: string, listener: () => void): void }
  return new Promise((resolve) => {
    ws.addEventListener('open', () => resolve('open'))
    ws.addEventListener('close', () => resolve('closed'))
  })
}

describe('PeerHosts', () => {
  it('opens the bridge of a paired computer at the address that answers', async () => {
    const c = await pairedComputers()
    const peers = new PeerHosts({ store: c.storeB, reach: async () => '127.0.0.1' })
    const socket = await peers.connect(A.deviceId)
    closers.push(() => socket.close())
    await expect(opened(socket)).resolves.toBe('open')
    expect(c.storeB.get(A.deviceId)?.addresses[0]).toBe('127.0.0.1')
    const endpoint = peers.endpoint(A.deviceId)
    expect(endpoint?.origin).toBe(`https://127.0.0.1:${c.port}`)
    expect(endpoint?.headers().Authorization).toBe(`Bearer ${c.tokenFromA}`)
    expect(endpoint?.certPem).toBe(A.certPem)
    expect(peers.problem(A.deviceId)).toBeNull()
  })

  it('says when the computer removed this one', async () => {
    const c = await pairedComputers()
    const peers = new PeerHosts({ store: c.storeB, reach: async () => '127.0.0.1' })
    const changed = vi.fn()
    peers.onChange(changed)
    c.storeA.remove(B.deviceId)
    const socket = await peers.connect(A.deviceId)
    await expect(opened(socket)).resolves.toBe('closed')
    await vi.waitFor(() => expect(peers.problem(A.deviceId)).toBe('removed'))
    expect(changed).toHaveBeenCalled()
  })

  it('says why a computer is out of reach, and forgets it once it answers', async () => {
    const c = await pairedComputers()
    let reach: () => Promise<string> = async () => {
      throw new PeerUnreachable(true, false)
    }
    const peers = new PeerHosts({ store: c.storeB, reach: () => reach() })
    await expect(peers.connect(A.deviceId)).rejects.toBeInstanceOf(PeerUnreachable)
    expect(peers.problem(A.deviceId)).toBe('not-hosting')
    reach = async () => {
      throw new PeerUnreachable(false, true)
    }
    await expect(peers.connect(A.deviceId)).rejects.toBeInstanceOf(PeerUnreachable)
    expect(peers.problem(A.deviceId)).toBe('identity-changed')
    reach = async () => '127.0.0.1'
    const socket = await peers.connect(A.deviceId)
    closers.push(() => socket.close())
    await expect(opened(socket)).resolves.toBe('open')
    expect(peers.problem(A.deviceId)).toBeNull()
  })

  it('reaches a paired computer with the real dialer', async () => {
    const c = await pairedComputers()
    const peers = new PeerHosts({ store: c.storeB })
    const socket = await peers.connect(A.deviceId)
    closers.push(() => socket.close())
    await expect(opened(socket)).resolves.toBe('open')
  })
})
