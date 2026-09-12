import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
  class FakeWebContents {
    destroyed = false
    listeners = new Map<string, Array<(...args: unknown[]) => void>>()
    loadURL = vi.fn(async () => undefined)
    loadFile = vi.fn(async () => undefined)
    setBackgroundThrottling = vi.fn()
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
      this.listeners.set(
        event,
        (this.listeners.get(event) ?? []).filter((candidate) => candidate !== listener)
      )
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
  return { views, WebContentsView: TrackedWebContentsView, fullSpeed: false }
})

vi.mock('electron', () => ({ WebContentsView: h.WebContentsView }))
vi.mock('../../src/main/window-ipc', () => ({
  registerPanelTarget: vi.fn(),
  sendToPanel: vi.fn(),
  unregisterPanelTarget: vi.fn(),
  preparePanelMemoryEviction: vi.fn(async () => ({ ok: true })),
}))
vi.mock('../../src/main/hotkeys', () => ({ attachHotkeyCapture: vi.fn() }))
vi.mock('../../src/main/terminal-hotkeys', () => ({ attachTerminalHotkeyCapture: vi.fn() }))
vi.mock('../../src/main/drawer/layout', () => ({ applyLayout: vi.fn() }))
vi.mock('../../src/main/performance/resource-governor', () => ({
  registerThrottleTarget: vi.fn(),
  resourceNeedsFullSpeed: vi.fn(() => h.fullSpeed),
  unregisterThrottleTarget: vi.fn(),
}))

import {
  disposePanelEviction,
  ensurePanelView,
  PANEL_COLD_RETRY_MS,
  PANEL_COLD_TTL_MS,
  scheduleColdPanelEviction,
} from '../../src/main/drawer/panels'
import {
  drawers,
  getDrawer,
  initDrawer,
  placementByConv,
  setActiveConvId,
  setSlot,
  setSuppressed,
  setVisibleKind,
} from '../../src/main/drawer/state'
import { preparePanelMemoryEviction, registerPanelTarget, unregisterPanelTarget } from '../../src/main/window-ipc'
import { unregisterThrottleTarget } from '../../src/main/performance/resource-governor'
import { disposeMemoryReclaimer } from '../../src/main/performance/memory-reclaimer'
import { preparePlanPanelMemoryEviction } from '../../src/renderer/lib/panel-memory-eviction'

describe('cold eviction of rehydratable panels', () => {
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
    h.fullSpeed = false
    drawers.clear()
    placementByConv.clear()
    setActiveConvId(null)
    setVisibleKind(null)
    setSlot(null)
    setSuppressed(false)
    initDrawer(mainWindow as never)
    process.env.ELECTRON_RENDERER_URL = 'http://renderer.test'
  })

  afterEach(() => {
    disposePanelEviction()
    disposeMemoryReclaimer()
    drawers.clear()
    placementByConv.clear()
    vi.useRealTimers()
    delete process.env.ELECTRON_RENDERER_URL
  })

  it('evicts reclaimable panels after TTL once prepare succeeds', async () => {
    const drawer = getDrawer('cold-safe')
    ensurePanelView(drawer, 'cold-safe', 'terminal')
    ensurePanelView(drawer, 'cold-safe', 'review')
    ensurePanelView(drawer, 'cold-safe', 'notes')
    ensurePanelView(drawer, 'cold-safe', 'plan')

    await vi.advanceTimersByTimeAsync(PANEL_COLD_TTL_MS)

    expect(drawer.panelViews.has('terminal')).toBe(false)
    expect(drawer.panelViews.has('review')).toBe(false)
    expect(drawer.panelViews.has('notes')).toBe(false)
    expect(drawer.panelViews.has('plan')).toBe(false)
    expect(preparePanelMemoryEviction).toHaveBeenCalled()
    expect(unregisterPanelTarget).toHaveBeenCalled()
    expect(unregisterThrottleTarget).toHaveBeenCalledWith('panel', 'cold-safe', 'terminal')
    expect(unregisterThrottleTarget).toHaveBeenCalledWith('panel', 'cold-safe', 'review')
  })

  it('keeps an unsafe panel when prepare fails closed', async () => {
    vi.mocked(preparePanelMemoryEviction).mockResolvedValueOnce({ ok: false, reason: 'unsafe' })
    const drawer = getDrawer('unsafe-notes')
    ensurePanelView(drawer, 'unsafe-notes', 'notes')
    await vi.advanceTimersByTimeAsync(PANEL_COLD_TTL_MS)
    expect(drawer.panelViews.has('notes')).toBe(true)
  })

  it('blocks cold eviction during inline comments and resumes persistence after save/cancel', () => {
    const persistDraft = vi.fn()
    let editingLine: number | null = 12

    expect(preparePlanPanelMemoryEviction(false, editingLine, persistDraft)).toEqual({
      safe: false,
      reason: 'inline-comment-editing',
    })
    expect(persistDraft).not.toHaveBeenCalled()

    // Both save and cancel close the editor in panel state.
    editingLine = null
    expect(preparePlanPanelMemoryEviction(false, editingLine, persistDraft)).toEqual({ safe: true })
    expect(persistDraft).toHaveBeenCalledOnce()
  })

  it('protects visibility, placement outside the slot, popups, and full-speed mode', async () => {
    const visibleDrawer = getDrawer('visible')
    setActiveConvId('visible')
    setVisibleKind('terminal')
    ensurePanelView(visibleDrawer, 'visible', 'terminal')

    const floatingDrawer = getDrawer('floating')
    placementByConv.set('floating', new Map([['review', 'floating']]))
    ensurePanelView(floatingDrawer, 'floating', 'review')

    const popupDrawer = getDrawer('popup')
    placementByConv.set('popup', new Map([['notes', 'popup']]))
    ensurePanelView(popupDrawer, 'popup', 'terminal')

    const fullSpeedDrawer = getDrawer('full-speed')
    h.fullSpeed = true
    ensurePanelView(fullSpeedDrawer, 'full-speed', 'review')

    await vi.advanceTimersByTimeAsync(PANEL_COLD_TTL_MS)

    expect(visibleDrawer.panelViews.has('terminal')).toBe(true)
    expect(floatingDrawer.panelViews.has('review')).toBe(true)
    expect(popupDrawer.panelViews.has('terminal')).toBe(true)
    expect(fullSpeedDrawer.panelViews.has('review')).toBe(true)

    // Once the protections are removed, the TTL starts at the transition to inactivity.
    setVisibleKind(null)
    placementByConv.delete('floating')
    placementByConv.delete('popup')
    h.fullSpeed = false
    scheduleColdPanelEviction()
    await vi.advanceTimersByTimeAsync(PANEL_COLD_TTL_MS - PANEL_COLD_RETRY_MS)
    expect(visibleDrawer.panelViews.has('terminal')).toBe(true)
    await vi.advanceTimersByTimeAsync(PANEL_COLD_RETRY_MS)
    expect(visibleDrawer.panelViews.has('terminal')).toBe(false)
  })

  it('rematerializes the surface after cold eviction without recreating the main state', async () => {
    const drawer = getDrawer('rematerialize')
    const first = ensurePanelView(drawer, 'rematerialize', 'review')

    await vi.advanceTimersByTimeAsync(PANEL_COLD_TTL_MS)
    expect(drawer.panelViews.has('review')).toBe(false)
    expect(first.webContents.isDestroyed()).toBe(true)

    const second = ensurePanelView(drawer, 'rematerialize', 'review')

    expect(second).not.toBe(first)
    expect(drawer.panelViews.get('review')).toBe(second)
    expect(h.views).toHaveLength(2)
    expect(mainWindow.contentView.addChildView).toHaveBeenCalledTimes(2)
    expect(vi.mocked(registerPanelTarget)).toHaveBeenCalledTimes(2)
  })

  it('rechecks protected panels on the short retry agenda instead of evicting them', async () => {
    const drawer = getDrawer('retry')
    setActiveConvId('retry')
    setVisibleKind('review')
    ensurePanelView(drawer, 'retry', 'review')

    await vi.advanceTimersByTimeAsync(PANEL_COLD_RETRY_MS)
    expect(drawer.panelViews.has('review')).toBe(true)
    await vi.advanceTimersByTimeAsync(PANEL_COLD_TTL_MS - PANEL_COLD_RETRY_MS)
    expect(drawer.panelViews.has('review')).toBe(true)
  })
})
