import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HostFilesRoutes } from '../../src/main/fleet/instance/host-files-http'
import type { EditorRoutes } from '../../src/main/fleet/instance/server'
import { PeerController } from '../../src/main/peer/controller'
import { PeerHosting } from '../../src/main/peer/hosting'
import type { PeerIdentity } from '../../src/main/peer/identity'
import { PeerStore } from '../../src/main/peer/store'
import { IpcHandlerTable } from '../../src/main/remote-host/ipc-handler-table'
import { PEER_CODE_TTL_MS, type PeerPairingPromptView } from '../../src/shared/peer'
import { memoryPeerStorage, testIdentity } from './peer-helpers'

const VERSION = '1.2.3'
const T0 = 1_800_000_000_000

const closers: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close()
})

/** One computer of the owner, as Settings → Computers drives it: its store, its sharing, and its controller. */
function computer(identity: PeerIdentity, options: { version?: string; available?: boolean } = {}) {
  const store = new PeerStore(memoryPeerStorage())
  const onChange = vi.fn()
  const onPrompt = vi.fn<(prompt: PeerPairingPromptView) => void>()
  const version = options.version ?? VERSION
  let name = identity.name
  let controller: PeerController | null = null
  const hosting = new PeerHosting({
    storage: memoryPeerStorage(),
    identity: () => identity,
    store,
    appVersion: version,
    os: 'mac',
    hub: {
      table: new IpcHandlerTable(),
      appVersion: version,
      hostInfo: () => ({
        os: 'mac',
        hostName: name,
        homeDir: '/Users/me',
        roots: ['/Users/me'],
        desktopEffects: false,
        editor: false,
        browser: false,
        computer: false,
        folderTransfers: false,
      }),
      log: vi.fn(),
    },
    hostFiles: { sweep: vi.fn(async () => undefined) } as unknown as HostFilesRoutes & { sweep(): Promise<unknown> },
    editor: { request: vi.fn(), upgrade: vi.fn(), closeAll: vi.fn() } as unknown as EditorRoutes & {
      closeAll(): void
    },
    holdAwake: () => () => undefined,
    localAddresses: () => ['127.0.0.1'],
    onPrompt: (prompt) => controller?.receivePrompt(prompt),
    onChange,
    bind: { host: '127.0.0.1', port: 0 },
  })
  closers.push(() => hosting.stop())
  controller = new PeerController({
    available: () => options.available ?? true,
    name: () => name,
    identity: () => (options.available === false ? null : identity),
    rename: (next) => {
      if (!next.trim()) return false
      name = next.trim()
      return true
    },
    store,
    hosting: () => hosting,
    appVersion: version,
    os: 'mac',
    localAddresses: () => ['127.0.0.1'],
    onChange,
    onPrompt,
    now: () => T0,
  })
  const address = () => `127.0.0.1:${hosting.listeningPort()}`
  return { identity, store, hosting, controller, onChange, onPrompt, address }
}

/** The code A shows while B waits for it. */
function shownCode(on: ReturnType<typeof computer>): string {
  const prompt = on.controller.overview().prompt
  expect(prompt?.outcome).toBe('waiting')
  return prompt?.code ?? ''
}

describe('Settings → Computers', () => {
  it('pairs two computers with the code one shows and the other types, both ways', async () => {
    const a = computer(testIdentity('A'))
    const b = computer(testIdentity('B'))
    await a.controller.setHosting(true)
    await b.controller.setHosting(true)

    const started = await b.controller.connectStart(a.address())
    expect(started).toEqual({
      ok: true,
      pairingId: expect.any(String),
      name: 'A',
      os: 'mac',
      expiresAt: T0 + PEER_CODE_TTL_MS,
    })
    // A tells an owner looking elsewhere, and shows the code in its window only.
    expect(a.onPrompt).toHaveBeenCalledWith(expect.objectContaining({ name: 'B', outcome: 'waiting' }))
    const code = shownCode(a)
    expect(code).toMatch(/^\d{6}$/)

    if (!started.ok) throw new Error('not started')
    await expect(b.controller.connectCode(started.pairingId, code)).resolves.toEqual({
      ok: true,
      deviceId: a.identity.deviceId,
      name: 'A',
    })
    expect(b.controller.overview().computers).toEqual([
      expect.objectContaining({ deviceId: a.identity.deviceId, name: 'A', address: a.address(), connectedSince: null }),
    ])
    expect(a.controller.overview().computers).toEqual([
      expect.objectContaining({ deviceId: b.identity.deviceId, name: 'B' }),
    ])
    // B shares itself, so A records where to reach it back.
    expect(a.store.get(b.identity.deviceId)?.hosting).toBe(true)

    // A says how it ended until the owner closes that.
    expect(a.controller.overview().prompt).toMatchObject({ outcome: 'paired' })
    a.controller.dismissPrompt(started.pairingId)
    expect(a.controller.overview().prompt).toBeNull()
  })

  it('records a computer that does not share itself as one that only uses this one', async () => {
    const a = computer(testIdentity('A'))
    const b = computer(testIdentity('B'))
    await a.controller.setHosting(true)
    const started = await b.controller.connectStart(a.address())
    if (!started.ok) throw new Error('not started')
    await expect(b.controller.connectCode(started.pairingId, shownCode(a))).resolves.toMatchObject({ ok: true })
    expect(a.store.get(b.identity.deviceId)?.hosting).toBe(false)
    expect(b.store.get(a.identity.deviceId)?.hosting).toBe(true)
  })

  it('allows one try per code: a wrong code ends the pairing on both sides', async () => {
    const a = computer(testIdentity('A'))
    const b = computer(testIdentity('B'))
    await a.controller.setHosting(true)
    const started = await b.controller.connectStart(a.address())
    if (!started.ok) throw new Error('not started')
    const code = shownCode(a)
    const wrong = code === '000000' ? '111111' : '000000'
    await expect(b.controller.connectCode(started.pairingId, wrong)).resolves.toEqual({ ok: false, error: 'mismatch' })
    await vi.waitFor(() => expect(a.controller.overview().prompt).toMatchObject({ outcome: 'mismatch' }))
    // The right code no longer helps: a new one is asked for.
    await expect(b.controller.connectCode(started.pairingId, code)).resolves.toEqual({ ok: false, error: 'expired' })
    expect(a.store.list()).toEqual([])
    expect(b.store.list()).toEqual([])
  })

  it('closes the dialog on the other computer when the owner cancels on either side', async () => {
    const a = computer(testIdentity('A'))
    const b = computer(testIdentity('B'))
    await a.controller.setHosting(true)

    const first = await b.controller.connectStart(a.address())
    if (!first.ok) throw new Error('not started')
    b.controller.connectCancel(first.pairingId)
    await vi.waitFor(() => expect(a.controller.overview().prompt).toMatchObject({ outcome: 'cancelled' }))
    a.controller.dismissPrompt(first.pairingId)

    const second = await b.controller.connectStart(a.address())
    if (!second.ok) throw new Error('not started')
    const code = shownCode(a)
    a.controller.cancelPrompt(second.pairingId)
    expect(a.controller.overview().prompt).toBeNull()
    await expect(b.controller.connectCode(second.pairingId, code)).resolves.toMatchObject({ ok: false })
    expect(b.store.list()).toEqual([])
  })

  it('says why a computer cannot be paired', async () => {
    const a = computer(testIdentity('A'))
    const b = computer(testIdentity('B'))
    const older = computer(testIdentity('C'), { version: '1.0.0' })
    const keyless = computer(testIdentity('D'), { available: false })
    await expect(b.controller.connectStart('not an address!')).resolves.toEqual({ ok: false, error: 'address' })
    await expect(keyless.controller.connectStart('127.0.0.1')).resolves.toEqual({ ok: false, error: 'unavailable' })
    // Not sharing itself: nothing answers there.
    await expect(b.controller.connectStart('127.0.0.1:1')).resolves.toEqual({ ok: false, error: 'unreachable' })
    await a.controller.setHosting(true)
    await expect(a.controller.connectStart(a.address())).resolves.toEqual({ ok: false, error: 'self' })
    await expect(older.controller.connectStart(a.address())).resolves.toEqual({ ok: false, error: 'version' })
    await expect(b.controller.connectCode('unknown', '123456')).resolves.toEqual({ ok: false, error: 'expired' })
    const started = await b.controller.connectStart(a.address())
    if (!started.ok) throw new Error('not started')
    await expect(b.controller.connectCode(started.pairingId, '12ab56')).resolves.toEqual({
      ok: false,
      error: 'invalid',
    })
  })

  it('removes a paired computer on both sides', async () => {
    const a = computer(testIdentity('A'))
    const b = computer(testIdentity('B'))
    await a.controller.setHosting(true)
    await b.controller.setHosting(true)
    const started = await b.controller.connectStart(a.address())
    if (!started.ok) throw new Error('not started')
    await b.controller.connectCode(started.pairingId, shownCode(a))

    expect(b.controller.remove(a.identity.deviceId).computers).toEqual([])
    // A forgets B too, asked over its pinned certificate with B's token.
    await vi.waitFor(() => expect(a.store.list()).toEqual([]))
  })

  it('shares this computer, renames it, and shows where it can be reached', async () => {
    const a = computer(testIdentity('A'))
    expect(a.controller.overview()).toMatchObject({
      available: true,
      name: 'A',
      hosting: false,
      port: null,
      addresses: [],
      hostingError: null,
      computers: [],
      prompt: null,
    })
    const shared = await a.controller.setHosting(true)
    expect(shared).toMatchObject({ hosting: true, port: a.hosting.listeningPort(), addresses: ['127.0.0.1'] })
    a.onChange.mockClear()
    expect(a.controller.rename('  Studio  ').name).toBe('Studio')
    expect(a.onChange).toHaveBeenCalled()
    a.onChange.mockClear()
    expect(a.controller.rename('   ').name).toBe('Studio')
    expect(a.onChange).not.toHaveBeenCalled()
    expect(await a.controller.setHosting(false)).toMatchObject({ hosting: false, port: null, addresses: [] })
  })
})
