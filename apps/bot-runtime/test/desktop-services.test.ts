import { randomUUID } from 'node:crypto'
import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { DesktopServices } from '../src/desktop/services.js'
import type { VncTransmitter } from '../src/desktop/vnc-server.js'
import type { X11Connection } from '../src/desktop/x11.js'
import type { BrowserSession } from '../src/tools/browser.js'
import { FileService, digest } from '../src/files/service.js'
import type { AdminRequest, AgentRequest } from '../src/desktop/service-protocol.js'
import { FakeX11 } from './fake-x11.js'
import { temporary } from './helpers.js'

function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
let requestId = 0
const agent = (op: AgentRequest['op'], params: Record<string, unknown> = {}) => ({ id: requestId++, op, params }) as AgentRequest
const admin = (op: AdminRequest['op'], params: Record<string, unknown> = {}) => ({ id: requestId++, op, params }) as AdminRequest
async function fixture(options: { supervised?: boolean } = {}) {
  const state = await temporary()
  const files = new FileService(join(state, 'workspace'))
  await files.init()
  const navigation = { gate: deferred(), started: 0, finished: 0 }
  const browser = {
    desktop: { width: 1280, height: 800, display: ':10', generation: async () => 'gen-1', environment: () => ({}), ensure: async () => {}, close: async () => {} },
    navigate: vi.fn(async (url: string) => {
      navigation.started++
      await navigation.gate.promise
      navigation.finished++
      return { url }
    }),
    snapshot: vi.fn(async () => ({ url: 'file:///x', title: 't', text: '', interactive: [] })),
    click: vi.fn(async () => {}),
    type: vi.fn(async () => {}),
    key: vi.fn(async () => {}),
    screenshot: vi.fn(async (observationId: string, hooks: { emit: (event: unknown) => void }) => {
      const path = `.maestrly/screens/${observationId}.png`
      await mkdir(join(files.workspace, '.maestrly/screens'), { recursive: true })
      await writeFile(join(files.workspace, path), 'png')
      hooks.emit({ kind: 'file.produced', summary: 's', detail: { path, name: `${observationId}.png` } })
      return { bytes: Buffer.from('png'), path }
    }),
    listDownloads: () => [],
    close: async () => {},
  } as unknown as BrowserSession
  const transmitter = { acquire: vi.fn(async () => '/run/x'), release: vi.fn(), probe: vi.fn(async () => ({ version: '1.13.1', parameters: [], clipboard: 'absent' })), running: false, close: vi.fn(async () => {}) }
  const proxy = { updatePolicy: vi.fn() }
  const x11 = new FakeX11()
  const invalidate = vi.fn()
  const services = new DesktopServices({
    files,
    browser,
    transmitter: transmitter as unknown as VncTransmitter,
    proxy,
    openX11: async () => x11 as unknown as X11Connection,
    invalidate,
    supervised: options.supervised ?? true,
    captureDesktop: (async (_desktop: unknown, _files: unknown, observationId: string, hooks: { emit: (event: unknown) => void }) => {
      const path = `.maestrly/screens/${observationId}.png`
      await mkdir(join(files.workspace, '.maestrly/screens'), { recursive: true })
      await writeFile(join(files.workspace, path), 'desktop')
      hooks.emit({ kind: 'file.produced', summary: 'c', detail: { path, name: `${observationId}.png` } })
      return { bytes: Buffer.from('desktop'), path, generation: 'gen-1', width: 1280, height: 800 }
    }) as never,
  })
  return { services, browser, navigation, transmitter, proxy, x11, invalidate, files }
}
it('automation is refused until the supervisor opens the gate, and a closed gate refuses new work', async () => {
  const f = await fixture()
  await expect(f.services.agent(agent('browser.snapshot'))).rejects.toMatchObject({ code: 'BOT_PAUSED_BY_USER' })
  await f.services.admin(admin('gate', { epoch: 0, allowed: true }))
  await expect(f.services.agent(agent('browser.snapshot'))).resolves.toMatchObject({ title: 't' })
  await f.services.admin(admin('gate', { epoch: 1, allowed: false }))
  await expect(f.services.agent(agent('browser.snapshot'))).rejects.toMatchObject({ code: 'BOT_PAUSED_BY_USER' })
  await expect(f.services.admin(admin('gate', { epoch: 0, allowed: true }))).rejects.toMatchObject({ code: 'STALE_DESKTOP' })
  // Policy and inspection are not actions on the desktop and stay available.
  await f.services.agent(agent('network.policy', { network: { mode: 'offline', domains: [], revision: 2 } }))
  expect(f.proxy.updatePolicy).toHaveBeenCalledWith({ mode: 'offline', domains: [], revision: 2 })
})
it('quiesce drains work already started and only then allows human control', async () => {
  const f = await fixture()
  await f.services.admin(admin('gate', { epoch: 0, allowed: true }))
  const running = f.services.agent(agent('browser.navigate', { url: 'https://example.com' }))
  await vi.waitFor(() => expect(f.navigation.started).toBe(1))
  const drained = f.services.admin(admin('quiesce', { epoch: 1, timeoutMs: 5_000 }))
  await expect(f.services.agent(agent('browser.snapshot'))).rejects.toMatchObject({ code: 'BOT_PAUSED_BY_USER' })
  await expect(f.services.admin(admin('human.enable', { epoch: 1 }))).rejects.toMatchObject({ code: 'HANDOFF_UNCERTAIN' })
  let settled = false
  void drained.then(() => {
    settled = true
  })
  await new Promise((resolve) => setTimeout(resolve, 30))
  expect(settled).toBe(false)
  f.navigation.gate.resolve()
  await running
  await expect(drained).resolves.toMatchObject({ drained: true, epoch: 1 })
  expect(f.navigation.finished).toBe(1)
  await expect(f.services.admin(admin('human.enable', { epoch: 1 }))).resolves.toMatchObject({ enabled: true, epoch: 1 })
  // The gate cannot reopen for automation while a person is in control.
  await expect(f.services.admin(admin('gate', { epoch: 1, allowed: true }))).rejects.toMatchObject({ code: 'CONTROL_BUSY' })
})
it('an automation action that does not finish in time makes the handoff uncertain', async () => {
  const f = await fixture()
  await f.services.admin(admin('gate', { epoch: 0, allowed: true }))
  void f.services.agent(agent('browser.navigate', { url: 'https://slow.example' })).catch(() => {})
  await vi.waitFor(() => expect(f.navigation.started).toBe(1))
  await expect(f.services.admin(admin('quiesce', { epoch: 1, timeoutMs: 100 }))).rejects.toMatchObject({ code: 'HANDOFF_UNCERTAIN' })
  await expect(f.services.admin(admin('human.enable', { epoch: 1 }))).rejects.toMatchObject({ code: 'HANDOFF_UNCERTAIN' })
  f.navigation.gate.resolve()
})
it('human input requires the enabled epoch; disabling releases every pressed key and button', async () => {
  const f = await fixture()
  await f.services.admin(admin('quiesce', { epoch: 3, timeoutMs: 1_000 }))
  await expect(f.services.admin(admin('human.input', { epoch: 3, events: [{ kind: 'pointer', x: 1, y: 1 }] }))).rejects.toMatchObject({ code: 'CONTROL_EXPIRED' })
  await f.services.admin(admin('human.enable', { epoch: 3 }))
  await expect(f.services.admin(admin('human.input', { epoch: 2, events: [{ kind: 'pointer', x: 1, y: 1 }] }))).rejects.toMatchObject({ code: 'CONTROL_EXPIRED' })
  await f.services.admin(admin('human.input', {
    epoch: 3,
    events: [{ kind: 'key', code: 'KeyA', keysym: 0x61, down: true }, { kind: 'button', button: 'left', down: true, x: 10, y: 10 }],
  }))
  expect(f.services.humanState.pressed).toBe(2)
  await f.services.admin(admin('human.disable', { epoch: 4 }))
  expect(f.services.humanState).toMatchObject({ enabled: false, pressed: 0 })
  expect(f.x11.released()).toEqual(expect.arrayContaining(['key:10', 'button:1']))
  await expect(f.services.admin(admin('human.input', { epoch: 3, events: [{ kind: 'pointer', x: 1, y: 1 }] }))).rejects.toMatchObject({ code: 'CONTROL_EXPIRED' })
})
it('viewers share one on-demand transmitter and are bounded; captures need a closed gate', async () => {
  const f = await fixture()
  const grants = Array.from({ length: 5 }, () => randomUUID())
  for (const grantId of grants.slice(0, 4)) await f.services.admin(admin('viewer.open', { grantId }))
  await f.services.admin(admin('viewer.open', { grantId: grants[0] }))
  expect(f.transmitter.acquire).toHaveBeenCalledTimes(4)
  await expect(f.services.admin(admin('viewer.open', { grantId: grants[4] }))).rejects.toMatchObject({ code: 'VIEWER_LIMIT' })
  await f.services.admin(admin('viewer.close', { grantId: grants[0] }))
  await f.services.admin(admin('viewer.close', { grantId: grants[0] }))
  expect(f.transmitter.release).toHaveBeenCalledTimes(1)
  await f.services.admin(admin('gate', { epoch: 0, allowed: true }))
  await expect(f.services.admin(admin('capture', { observationId: randomUUID() }))).rejects.toMatchObject({ code: 'BOT_PAUSED_BY_USER' })
  await f.services.admin(admin('gate', { epoch: 1, allowed: false }))
  const observationId = randomUUID()
  const file = await f.services.admin(admin('capture', { observationId }))
  expect(file).toMatchObject({ path: `.maestrly/screens/${observationId}.png`, digest: digest('desktop'), desktopGeneration: 'gen-1', width: 1280, height: 800 })
  await f.services.admin(admin('reset'))
  expect(f.invalidate).toHaveBeenCalled()
})
it('capabilities are advertised only for a supervised socket with a verified screen server and XTEST', async () => {
  expect((await (await fixture({ supervised: false })).services.inspect()).capabilities).toEqual([])
  const f = await fixture()
  expect((await f.services.inspect()).capabilities).toEqual(['desktop.live.v1', 'desktop.handoff.v1'])
  const broken = await fixture()
  broken.transmitter.probe.mockRejectedValue(Object.assign(new Error('x'), { code: 'DESKTOP_UPDATE_REQUIRED' }))
  expect((await broken.services.inspect()).capabilities).toEqual([])
})
