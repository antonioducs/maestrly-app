import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
  class FakeWebContents {
    destroyed = false
    listeners = new Map<string, Array<(...args: unknown[]) => void>>()
    loadURL = vi.fn(async () => undefined)
    close = vi.fn(() => {
      this.destroyed = true
      for (const listener of [...(this.listeners.get('destroyed') ?? [])]) listener()
    })
    isDestroyed(): boolean {
      return this.destroyed
    }
    isFocused(): boolean {
      return true
    }
    on(event: string, listener: (...args: unknown[]) => void): this {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener])
      return this
    }
    once(event: string, listener: (...args: unknown[]) => void): this {
      return this.on(event, listener)
    }
  }
  class FakeWebContentsView {
    webContents = new FakeWebContents()
    setBackgroundColor = vi.fn()
    setBounds = vi.fn()
    constructor(readonly options: { webPreferences: { partition: string } }) {
      views.push(this)
    }
  }
  const views: FakeWebContentsView[] = []
  return { views, WebContentsView: FakeWebContentsView, navigation: vi.fn() }
})

vi.mock('electron', () => ({ WebContentsView: h.WebContentsView, session: { fromPartition: vi.fn() } }))
vi.mock('../../src/main/i18n', () => ({
  tMain: vi.fn(() => (key: string) => key),
  getMainLocale: vi.fn(() => 'en'),
}))
vi.mock('../../src/main/hotkeys', () => ({ attachHotkeyCapture: vi.fn() }))
vi.mock('../../src/main/mouse-navigation', () => ({ attachMacMouseNavigation: h.navigation }))
vi.mock('../../src/main/vscode/vscode-navigation', () => ({ requestVSCodeNavigation: vi.fn() }))
vi.mock('../../src/main/drawer/layout', () => ({ applyLayout: vi.fn() }))
vi.mock('../../src/main/performance/resource-governor', () => ({
  registerThrottleTarget: vi.fn(),
  resourceNeedsFullSpeed: vi.fn(() => false),
  unregisterThrottleTarget: vi.fn(),
}))
vi.mock('../../src/main/performance/metrics', () => ({
  registerPerformanceWebContents: vi.fn(),
  unregisterPerformanceWebContents: vi.fn(),
}))
vi.mock('../../src/main/vscode/vscode-memory', () => ({
  hasVSCodeBridgeInFlight: vi.fn(() => false),
  onVSCodeBridgeIdle: vi.fn(() => () => {}),
  requestVSCodeMemorySnapshot: vi.fn(async () => null),
}))
vi.mock('../../src/main/vscode/vscode-server', () => ({
  isVSCodeServerRunning: vi.fn(() => true),
  stopVSCodeServer: vi.fn(),
}))
vi.mock('../../src/main/store', () => ({ getConversation: vi.fn(() => undefined) }))

import { EditorUnavailable } from '../../src/main/remote-host/client/editor-proxy'
import { remoteEditorPartition } from '../../src/main/remote-host/client/editor'
import {
  type RemoteVSCodeDeps,
  loadRemoteVSCode,
  remoteEditorUrl,
  remoteVSCodeHandlers,
  restartRemoteVSCode,
} from '../../src/main/drawer/remote-vscode'
import { drawers, getDrawer, initDrawer } from '../../src/main/drawer/state'
import { loadVSCode, navigateFocusedVSCode, setRemoteVSCodeHandlers } from '../../src/main/drawer/vscode'
import { VSCODE_VIEW_COLD_TTL_MS } from '../../src/main/performance/policy'
import { disposeMemoryReclaimer } from '../../src/main/performance/memory-reclaimer'
import { requestVSCodeMemorySnapshot } from '../../src/main/vscode/vscode-memory'

const HOST = 'server-1/workspaces'
const KEY = `${HOST}#conv-1`
const ORIGIN = 'http://127.0.0.1:41234'

type Answers = Record<string, (...args: unknown[]) => unknown>

function deps(
  answers: Answers,
  proxy: () => Promise<{ origin(): string; access: string }> = async () => ({
    origin: () => ORIGIN,
    access: 'access-1',
  })
) {
  const call = vi.fn(async (_hostId: string, channel: string, ...args: unknown[]) => {
    const answer = answers[channel]
    if (!answer) throw new Error('unexpected ' + channel)
    return answer(...args)
  })
  const setAccessCookie = vi.fn(async () => undefined)
  const value: RemoteVSCodeDeps = {
    editors: { proxy: vi.fn(proxy), call: call as RemoteVSCodeDeps['editors']['call'] },
    settingsJson: async () => '{}',
    pollMs: 1,
    readyTimeoutMs: 5_000,
    setAccessCookie,
  }
  return { value, call, setAccessCookie }
}

/** What a view shows: the editor's URL, or the key of its loading or error page. */
function shown(convKey = KEY): string {
  const view = drawers.get(convKey)?.vscodeView
  const calls = view ? vi.mocked(view.webContents.loadURL).mock.calls : []
  const url = String(calls.at(-1)?.[0] ?? '')
  if (!url.startsWith('data:')) return url
  return /drawerLoading\.(\w+)Title/.exec(decodeURIComponent(url))?.[1] ?? 'page'
}

beforeEach(() => {
  h.views.length = 0
  drawers.clear()
  initDrawer({ contentView: { addChildView: vi.fn(), removeChildView: vi.fn() } } as never)
})
afterEach(() => {
  disposeMemoryReclaimer()
  drawers.clear()
  setRemoteVSCodeHandlers(null)
  vi.useRealTimers()
})

describe("a remote host's editor in the drawer", () => {
  it("opens the host's folder at this computer's origin for the host, in the host's own session", async () => {
    const d = deps({ 'editor:open': () => ({ folder: '/srv/maestrly/app', phase: 'ready' }) })
    await loadRemoteVSCode(KEY, d.value)
    expect(d.call).toHaveBeenCalledWith(HOST, 'editor:open', 'conv-1')
    expect(d.setAccessCookie).toHaveBeenCalledWith(remoteEditorPartition(HOST), ORIGIN, 'access-1')
    expect(shown()).toBe(`${ORIGIN}/?folder=%2Fsrv%2Fmaestrly%2Fapp`)
    expect(h.views[0].options.webPreferences.partition).toBe(remoteEditorPartition(HOST))
    expect(remoteEditorPartition(HOST)).not.toBe('persist:vscode-drawer')
  })

  it('shows the download and the start on the host, then the editor', async () => {
    const phases = ['downloading', 'starting', 'ready']
    const seen: string[] = []
    const d = deps({
      'editor:open': () => ({ folder: '/srv/app', phase: 'downloading' }),
      'editor:status': () => {
        seen.push(shown())
        return phases.shift()
      },
    })
    await loadRemoteVSCode(KEY, d.value)
    expect(seen).toEqual(['remoteDownloading', 'remoteDownloading', 'remoteStarting'])
    expect(shown()).toBe(`${ORIGIN}/?folder=%2Fsrv%2Fapp`)
  })

  it('says why the editor cannot be opened', async () => {
    const cases: Array<[() => Promise<never>, string]> = [
      [() => Promise.reject(new EditorUnavailable('gateway-update-required')), 'remoteGatewayUpdate'],
      [() => Promise.reject(new EditorUnavailable('offline')), 'remoteOffline'],
      [() => Promise.reject(new EditorUnavailable('unauthorized')), 'remoteUnauthorized'],
    ]
    for (const [proxy, page] of cases) {
      await loadRemoteVSCode(KEY, deps({}, proxy).value)
      expect(shown()).toBe(page)
    }
    await loadRemoteVSCode(
      KEY,
      deps({
        'editor:open': () => {
          throw Object.assign(new Error('Unknown channel'), { code: 'unknown-channel' })
        },
      }).value
    )
    expect(shown()).toBe('remoteHostUpdate')
    await loadRemoteVSCode(KEY, deps({ 'editor:open': () => ({ folder: '/srv/app', phase: 'error' }) }).value)
    expect(shown()).toBe('remoteFailed')
    await loadRemoteVSCode(
      KEY,
      deps({ 'editor:open': () => ({ folder: '/srv/app', phase: 'starting' }), 'editor:status': () => 'error' }).value
    )
    expect(shown()).toBe('remoteFailed')
  })

  it('asks the host once while an opening is under way', async () => {
    const d = deps({ 'editor:open': () => ({ folder: '/srv/app', phase: 'ready' }) })
    await Promise.all([loadRemoteVSCode(KEY, d.value), loadRemoteVSCode(KEY, d.value)])
    expect(d.call).toHaveBeenCalledTimes(1)
  })

  it("restarts one host's editor and reopens only that host's views", async () => {
    const other = 'server-2/workspaces#conv-9'
    const opened = deps({ 'editor:open': () => ({ folder: '/srv/app', phase: 'ready' }) })
    await loadRemoteVSCode(KEY, opened.value)
    await loadRemoteVSCode(other, opened.value)
    loadVSCode('local-conv', 'http://127.0.0.1:8930/?tkn=t&folder=%2Fwork')
    const localView = drawers.get('local-conv')!.vscodeView!
    vi.mocked(localView.webContents.loadURL).mockClear()
    const otherView = drawers.get(other)!.vscodeView!
    vi.mocked(otherView.webContents.loadURL).mockClear()

    const restarted = deps({ 'editor:restart': () => undefined }, async () => ({
      origin: () => 'http://127.0.0.1:50000',
      access: 'access-2',
    }))
    await restartRemoteVSCode(KEY, restarted.value)
    expect(restarted.call).toHaveBeenCalledWith(HOST, 'editor:restart')
    expect(shown()).toBe('http://127.0.0.1:50000/?folder=%2Fsrv%2Fapp')
    expect(localView.webContents.loadURL).not.toHaveBeenCalled()
    expect(otherView.webContents.loadURL).not.toHaveBeenCalled()

    await restartRemoteVSCode(
      KEY,
      deps({
        'editor:restart': () => {
          throw Object.assign(new Error('lost'), { code: 'connection-lost' })
        },
      }).value
    )
    expect(shown()).toBe('remoteOffline')
  })

  it('moves the editor through its history and asks the host what closing it would lose', async () => {
    const snapshot = { dirtyDocuments: 2, debugActive: false, operationInFlight: false, lastActivityAt: 1 }
    const d = deps({ 'editor:navigate': () => undefined, 'editor:snapshot': () => snapshot })
    const handlers = remoteVSCodeHandlers(d.value)
    await handlers.navigate(KEY, 'back')
    expect(d.call).toHaveBeenCalledWith(HOST, 'editor:navigate', 'conv-1', 'back')
    await expect(handlers.snapshot(KEY)).resolves.toEqual(snapshot)
    const silent = remoteVSCodeHandlers(deps({}).value)
    await expect(silent.snapshot(KEY)).resolves.toBeNull()
  })

  it('routes the keyboard and mouse history of a remote view to its host, and keeps it while it has unsaved files', async () => {
    vi.useFakeTimers()
    const handlers = { navigate: vi.fn(async () => undefined), snapshot: vi.fn(async () => null) }
    setRemoteVSCodeHandlers(handlers)
    await loadRemoteVSCode(KEY, deps({ 'editor:open': () => ({ folder: '/srv/app', phase: 'ready' }) }).value)
    expect(navigateFocusedVSCode(KEY, 'forward')).toBe(true)
    expect(handlers.navigate).toHaveBeenCalledWith(KEY, 'forward')
    const mouse = h.navigation.mock.calls.at(-1)?.[1] as (direction: string) => void
    mouse('back')
    expect(handlers.navigate).toHaveBeenCalledWith(KEY, 'back')

    // A cold hidden view is closed only when its host says it holds nothing to lose; silence keeps it.
    await vi.advanceTimersByTimeAsync(VSCODE_VIEW_COLD_TTL_MS + 1)
    expect(handlers.snapshot).toHaveBeenCalledWith(KEY)
    expect(requestVSCodeMemorySnapshot).not.toHaveBeenCalled()
    expect(getDrawer(KEY).vscodeView).not.toBeNull()
  })

  it('builds the editor address of a folder', () => {
    expect(remoteEditorUrl('http://127.0.0.1:1', '/a b')).toBe('http://127.0.0.1:1/?folder=%2Fa+b')
    expect(remoteEditorUrl('http://127.0.0.1:1', '')).toBe('http://127.0.0.1:1/')
  })
})
