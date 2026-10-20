import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HostFilesRoutes } from '../../src/main/fleet/instance/host-files-http'
import type { EditorRoutes } from '../../src/main/fleet/instance/server'
import { resolveHostFilesEndpoint } from '../../src/main/host-transfers/endpoint'
import { PeerHosting } from '../../src/main/peer/hosting'
import type { PeerIdentity } from '../../src/main/peer/identity'
import { beginPairing, completePairing, savePairedHost } from '../../src/main/peer/pairing-client'
import type { PairingPrompt } from '../../src/main/peer/pairing-host'
import { PeerHosts } from '../../src/main/peer/peer-hosts'
import { issueToken, PeerStore } from '../../src/main/peer/store'
import { HostRegistry } from '../../src/main/remote-host/client/host-registry'
import { IpcHandlerTable } from '../../src/main/remote-host/ipc-handler-table'
import { peerHostId } from '../../src/shared/peer'
import type { RemoteHostInfo } from '../../src/shared/remote-bridge'
import { memoryPeerStorage, testIdentity } from './peer-helpers'

const STAT = { path: '/Users/a/notes.md', name: 'notes.md', size: 5, modifiedAt: 1, identity: '1:2:3' }
const VERSION = '1.2.3'

const closers: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close()
})

/** One computer of the owner: its profile's store, its IPC handlers, and the sharing of its desktop. */
function computer(identity: PeerIdentity, name: string) {
  const store = new PeerStore(memoryPeerStorage())
  const table = new IpcHandlerTable()
  const prompts: PairingPrompt[] = []
  const stat = vi.fn(async () => STAT)
  const hostInfo: RemoteHostInfo = {
    os: 'mac',
    hostName: name,
    homeDir: `/Users/${name}`,
    roots: [`/Users/${name}`],
    desktopEffects: false,
    editor: true,
    browser: true,
    computer: false,
    folderTransfers: true,
  }
  const hosting = new PeerHosting({
    storage: memoryPeerStorage(),
    identity: () => identity,
    store,
    appVersion: VERSION,
    os: 'mac',
    hub: { table, appVersion: VERSION, hostInfo: () => hostInfo, log: vi.fn() },
    hostFiles: { stat, sweep: vi.fn(async () => undefined) } as unknown as HostFilesRoutes & {
      sweep(): Promise<unknown>
    },
    editor: { request: vi.fn(), upgrade: vi.fn(), closeAll: vi.fn() } as unknown as EditorRoutes & {
      closeAll(): void
    },
    holdAwake: () => () => undefined,
    localAddresses: () => ['127.0.0.1'],
    onPrompt: (prompt) => prompts.push(prompt),
    onChange: vi.fn(),
    bind: { host: '127.0.0.1', port: 0 },
  })
  closers.push(() => hosting.stop())
  return { identity, name, store, table, prompts, stat, hosting }
}

/** The hosts of this computer's windows: no server, only the computers it paired with. */
function registryOf(store: PeerStore, name: string) {
  const registry = new HostRegistry({
    servers: { list: () => [], onChange: () => () => undefined },
    appVersion: VERSION,
    local: { os: 'mac', homeDir: `/Users/${name}` },
    client: () => ({ deviceName: name, os: 'mac', locale: 'pt-BR' }),
    openSocket: () => {
      throw new Error('No server')
    },
    direct: null,
    peers: new PeerHosts({ store }),
    onChanged: vi.fn(),
    onEvent: vi.fn(),
    timings: { retryBaseMs: 50, retryMaxMs: 100 },
  })
  registry.start()
  closers.push(() => registry.stop())
  return registry
}

const noFleet = () => null

describe('two computers of the owner', () => {
  it('pair once, use each other, and stop when one removes the other', async () => {
    const a = computer(testIdentity('A'), 'a')
    const b = computer(testIdentity('B'), 'b')
    a.table.record('chat:echo', 'invoke', (_event, value: unknown) => value)
    await a.hosting.setEnabled(true)
    // B shares its desktop too, so it can tell A where to reach it when they pair.
    await b.hosting.setEnabled(true)

    // B asks A to pair; the owner reads the code on A and types it on B.
    const client = { identity: b.identity, appVersion: VERSION, os: 'mac' as const }
    const started = await beginPairing(client, { host: '127.0.0.1', port: a.hosting.listeningPort() ?? 0 })
    const code = a.prompts.at(-1)?.code ?? ''
    expect(code).toMatch(/^\d{6}$/)
    const grant = { token: issueToken(), port: b.hosting.listeningPort(), addresses: ['127.0.0.1'] }
    const hostGrant = await completePairing(client, started, code, grant)
    expect(savePairedHost(b.store, started, hostGrant, grant.token, Date.now())).toBe(true)
    expect(a.store.get(b.identity.deviceId)?.fingerprint).toBe(b.identity.fingerprint)
    expect(b.store.get(a.identity.deviceId)?.fingerprint).toBe(a.identity.fingerprint)

    // B's windows list A and use it.
    const onB = registryOf(b.store, 'b')
    const hostA = peerHostId(a.identity.deviceId)
    expect(onB.list().map((host) => host.id)).toEqual(['local', hostA])
    await vi.waitFor(() => expect(onB.list()[1].state).toBe('online'), { timeout: 5_000 })
    const toA = onB.use(hostA, 5, () => ({ role: 'main' }))
    await expect(toA.invoke(5, 'chat:echo', ['olá'])).resolves.toBe('olá')
    expect(a.hosting.connected()).toEqual([b.identity.deviceId])

    // Its files travel over the certificate pinned at pairing.
    const files = resolveHostFilesEndpoint(hostA, { registry: onB, fleet: noFleet })
    await expect(files.json('hostFileStat', { body: { path: STAT.path } })).resolves.toEqual(STAT)
    expect(a.stat).toHaveBeenCalledWith({ path: STAT.path })

    // And the other way round, with the token B gave A.
    const onA = registryOf(a.store, 'a')
    const hostB = peerHostId(b.identity.deviceId)
    await vi.waitFor(() => expect(onA.list().find((host) => host.id === hostB)?.state).toBe('online'), {
      timeout: 5_000,
    })
    expect(b.hosting.connected()).toEqual([a.identity.deviceId])

    // A removes B: B's bridge closes, and A refuses it from then on.
    a.store.remove(b.identity.deviceId)
    await vi.waitFor(() => expect(onB.list()[1]).toMatchObject({ state: 'offline', peer: { problem: 'removed' } }), {
      timeout: 5_000,
    })
    expect(a.hosting.connected()).toEqual([])
  })
})
