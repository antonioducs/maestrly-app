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
    on(event: string, listener: (...args: unknown[]) => void): this {
      const listeners = this.listeners.get(event) ?? []
      listeners.push(listener)
      this.listeners.set(event, listeners)
      return this
    }
    once(event: string, listener: (...args: unknown[]) => void): this {
      const wrapped = (...args: unknown[]) => {
        this.removeListener(event, wrapped)
        listener(...args)
      }
      return this.on(event, wrapped)
    }
    removeListener(event: string, listener: (...args: unknown[]) => void): this {
      this.listeners.set(event, (this.listeners.get(event) ?? []).filter((candidate) => candidate !== listener))
      return this
    }
  }

  class FakeWebContentsView {
    webContents = new FakeWebContents()
    setBackgroundColor = vi.fn()
    setBounds = vi.fn()
  }

  const views: FakeWebContentsView[] = []
  class TrackedWebContentsView extends FakeWebContentsView {
    constructor() {
      super()
      views.push(this)
    }
  }
  return { views, WebContentsView: TrackedWebContentsView }
})

vi.mock('electron', () => ({ WebContentsView: h.WebContentsView }))
vi.mock('../../src/main/i18n', () => ({
  tMain: vi.fn(() => vi.fn(() => '')),
  getMainLocale: vi.fn(() => 'pt-BR'),
}))
vi.mock('../../src/main/hotkeys', () => ({ attachHotkeyCapture: vi.fn() }))
vi.mock('../../src/main/mouse-navigation', () => ({ attachMacMouseNavigation: vi.fn() }))
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
  isVSCodeServerRunning: vi.fn(() => false),
  stopVSCodeServer: vi.fn(),
}))
vi.mock('../../src/main/store', () => ({ getConversation: vi.fn(() => undefined) }))

import {
  closeVSCodeView,
  isVSCodeShowing,
  loadVSCode,
  noteVSCodeSurfaceVisibility,
} from '../../src/main/drawer/vscode'
import { drawers, getDrawer, initDrawer, setActiveConvId, setSlot, setVisibleKind } from '../../src/main/drawer/state'
import { getConversation } from '../../src/main/store'
import { requestVSCodeMemorySnapshot } from '../../src/main/vscode/vscode-memory'
import { VSCODE_VIEW_COLD_TTL_MS } from '../../src/main/performance/policy'
import { disposeMemoryReclaimer, runMemoryReclaim } from '../../src/main/performance/memory-reclaimer'

describe('VS Code cold eviction: rematerialization always loads content', () => {
  const mainWindow = {
    contentView: {
      addChildView: vi.fn(),
      removeChildView: vi.fn(),
    },
  }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    h.views.length = 0
    drawers.clear()
    setActiveConvId(null)
    setVisibleKind(null)
    setSlot(null)
    vi.mocked(getConversation).mockReturnValue(undefined)
    vi.mocked(requestVSCodeMemorySnapshot).mockResolvedValue(null)
    initDrawer(mainWindow as never)
  })

  afterEach(() => {
    disposeMemoryReclaimer()
    drawers.clear()
    setActiveConvId(null)
    setVisibleKind(null)
    setSlot(null)
    vi.useRealTimers()
  })

  it('reopens with a fresh load after cold eviction (blank-view regression)', () => {
    const convId = 'cold-evict'
    const url = 'http://vscode.test/?folder=%2Fwork'
    const d = getDrawer(convId)

    loadVSCode(convId, url)
    const first = d.vscodeView!
    expect(first.webContents.loadURL).toHaveBeenCalledWith(url)
    expect(isVSCodeShowing(convId, url)).toBe(true)

    closeVSCodeView(convId) // Cold eviction closes the view, leaving the vscodeRequestedUrl guard stale.
    expect(d.vscodeView).toBeNull()
    expect(isVSCodeShowing(convId, url)).toBe(false)
    expect(first.webContents.isDestroyed()).toBe(true)

    loadVSCode(convId, url) // reopen
    const second = d.vscodeView!
    expect(second).not.toBe(first)
    // Regression: the stale guard previously made loadVSCode skip loadURL, leaving the new renderer blank.
    expect(second.webContents.loadURL).toHaveBeenCalledWith(url)
    expect(isVSCodeShowing(convId, url)).toBe(true)
  })

  it('does not reload a live view already targeting the same URL; tab switching only repositions it', () => {
    const convId = 'warm'
    const url = 'http://vscode.test/?folder=%2Fwork'
    const d = getDrawer(convId)

    loadVSCode(convId, url)
    const view = d.vscodeView!
    vi.mocked(view.webContents.loadURL).mockClear()

    loadVSCode(convId, url)
    expect(d.vscodeView).toBe(view)
    expect(view.webContents.loadURL).not.toHaveBeenCalled()
    expect(isVSCodeShowing(convId, url)).toBe(true)
  })

  it('rematerializes with a load when the renderer dies outside closeVSCodeView (out-of-band destruction)', () => {
    const convId = 'crash'
    const url = 'http://vscode.test/?folder=%2Fwork'
    const d = getDrawer(convId)

    loadVSCode(convId, url)
    d.vscodeView!.webContents.close() // Crash clears vscodeView through the destroyed handler, leaving a stale guard.
    expect(d.vscodeView).toBeNull()
    expect(isVSCodeShowing(convId, url)).toBe(false)

    loadVSCode(convId, url)
    expect(d.vscodeView!.webContents.loadURL).toHaveBeenCalledWith(url)
  })

  it('does not query the sidecar for an already expired visible view', async () => {
    const convId = 'visible-expired'
    const url = 'http://vscode.test/?folder=%2Fwork'
    vi.mocked(getConversation).mockReturnValue({ cwd: '/work' } as never)
    setActiveConvId(convId)
    setVisibleKind('vscode')
    setSlot({ x: 0, y: 0, width: 800, height: 600 })

    loadVSCode(convId, url)
    noteVSCodeSurfaceVisibility(convId) // baseline: shown
    await vi.advanceTimersByTimeAsync(VSCODE_VIEW_COLD_TTL_MS)
    vi.mocked(requestVSCodeMemorySnapshot).mockClear()

    await runMemoryReclaim('normal')

    expect(getDrawer(convId).vscodeView).not.toBeNull()
    expect(requestVSCodeMemorySnapshot).not.toHaveBeenCalled()
  })

  it('restarts the TTL when the surface changes from visible to hidden', async () => {
    const convId = 'visible-hide'
    const url = 'http://vscode.test/?folder=%2Fwork'
    vi.mocked(getConversation).mockReturnValue({ cwd: '/work' } as never)
    vi.mocked(requestVSCodeMemorySnapshot).mockResolvedValue({
      dirtyDocuments: 0,
      debugActive: false,
      operationInFlight: false,
      lastActivityAt: Date.now(),
    })
    setActiveConvId(convId)
    setVisibleKind('vscode')
    setSlot({ x: 0, y: 0, width: 800, height: 600 })

    loadVSCode(convId, url)
    noteVSCodeSurfaceVisibility(convId) // baseline: shown
    await vi.advanceTimersByTimeAsync(VSCODE_VIEW_COLD_TTL_MS + 1)

    setActiveConvId('other-conv')
    noteVSCodeSurfaceVisibility(convId) // shown → hidden: fresh warm epoch
    expect(getDrawer(convId).vscodeView).not.toBeNull()

    await vi.advanceTimersByTimeAsync(VSCODE_VIEW_COLD_TTL_MS - 1)
    expect(getDrawer(convId).vscodeView).not.toBeNull()
    await vi.advanceTimersByTimeAsync(1)
    expect(getDrawer(convId).vscodeView).toBeNull()
  })

  it('queries the snapshot before evicting an eligible hidden view', async () => {
    const convId = 'hidden-eligible'
    const url = 'http://vscode.test/?folder=%2Fwork'
    vi.mocked(getConversation).mockReturnValue({ cwd: '/work' } as never)
    vi.mocked(requestVSCodeMemorySnapshot).mockResolvedValue({
      dirtyDocuments: 0,
      debugActive: false,
      operationInFlight: false,
      lastActivityAt: Date.now(),
    })

    loadVSCode(convId, url)
    await vi.advanceTimersByTimeAsync(VSCODE_VIEW_COLD_TTL_MS)

    expect(requestVSCodeMemorySnapshot).toHaveBeenCalledWith('/work')
    expect(getDrawer(convId).vscodeView).toBeNull()
  })
})
