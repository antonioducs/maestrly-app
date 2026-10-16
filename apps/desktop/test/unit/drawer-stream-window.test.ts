import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
  class FakeContentView {
    children: unknown[] = []
    addChildView(view: unknown): void {
      this.children = this.children.filter((child) => child !== view)
      this.children.push(view)
    }
    removeChildView(view: unknown): void {
      this.children = this.children.filter((child) => child !== view)
    }
  }
  class FakeWindow {
    static created: FakeWindow[] = []
    contentView = new FakeContentView()
    destroyed = false
    shown = false
    ignoresMouse = false
    alwaysOnTop = false
    readonly setAlwaysOnTop = vi.fn((flag: boolean) => {
      this.alwaysOnTop = flag
    })
    position: [number, number]
    contentSize: [number, number]
    listeners = new Map<string, () => void>()
    constructor(readonly options: Record<string, unknown> = {}) {
      this.contentSize = [Number(options.width ?? 0), Number(options.height ?? 0)]
      this.position = [Number(options.x ?? 0), Number(options.y ?? 0)]
      FakeWindow.created.push(this)
    }
    isAlwaysOnTop(): boolean {
      return this.alwaysOnTop
    }
    getPosition(): [number, number] {
      return this.position
    }
    setPosition(x: number, y: number): void {
      this.position = [x, y]
    }
    isDestroyed(): boolean {
      return this.destroyed
    }
    destroy(): void {
      this.destroyed = true
      this.listeners.get('closed')?.()
    }
    once(event: string, listener: () => void): this {
      this.listeners.set(event, listener)
      return this
    }
    showInactive(): void {
      this.shown = true
    }
    setIgnoreMouseEvents(ignore: boolean): void {
      this.ignoresMouse = ignore
    }
    getContentSize(): [number, number] {
      return this.contentSize
    }
    setContentSize(width: number, height: number): void {
      this.contentSize = [width, height]
    }
  }
  class FakeView {
    bounds = { x: 0, y: 0, width: 0, height: 0 }
    webContents = {
      isDestroyed: () => false,
      invalidate: vi.fn(),
      getBackgroundThrottling: () => true,
      setBackgroundThrottling: vi.fn(),
    }
    setBounds(bounds: { x: number; y: number; width: number; height: number }): void {
      this.bounds = bounds
    }
  }
  return { FakeWindow, FakeView, performance: vi.fn() }
})

vi.mock('electron', () => ({ BrowserWindow: h.FakeWindow }))
vi.mock('../../src/main/drawer/performance', () => ({ setDrawerPlacementPerformance: h.performance }))
vi.mock('../../src/main/drawer/layout', async () => {
  const state = await import('../../src/main/drawer/state')
  return {
    setPlacement: (convId: string, tab: 'browser', placement: string) => {
      const placements = state.placementByConv.get(convId) ?? new Map()
      if (placement === 'slot') placements.delete(tab)
      else placements.set(tab, placement as 'stream')
      state.placementByConv.set(convId, placements)
    },
  }
})

import { fleetEnvironmentTile } from '@maestrly/bot-fleet-protocol'
import { setConversationScreen, setConversationTile, setPresentedBrowserSize } from '../../src/main/conversation-screen'
import {
  OFFSCREEN,
  drawers,
  getDrawer,
  getPlacement,
  initDrawer,
  placementByConv,
  streamWinByConv,
} from '../../src/main/drawer/state'
import {
  disposeStreamWindow,
  handOverStreamWindow,
  onStreamWindowClosed,
  presentBrowserForStream,
  releaseBrowserStream,
  streamWindowOf,
} from '../../src/main/drawer/stream-window'

type Window = InstanceType<typeof h.FakeWindow>
type View = InstanceType<typeof h.FakeView>

let main: Window

function browserWith(convId: string, count: number): View[] {
  const drawer = getDrawer(convId)
  const views = Array.from({ length: count }, () => new h.FakeView())
  views.forEach((view, index) => {
    drawer.browserTabs.push({
      id: `${convId}:b${index + 1}`,
      view: view as never,
      url: 'https://example.com',
      title: '',
    })
    main.contentView.addChildView(view)
  })
  drawer.activeBrowserId = `${convId}:b2`
  return views
}

beforeEach(() => {
  h.FakeWindow.created = []
  main = new h.FakeWindow()
  initDrawer(main as never)
  h.performance.mockClear()
})

afterEach(() => {
  for (const convId of ['tiled', 'computer']) {
    setConversationTile(convId, null)
    setConversationScreen(convId, null)
    setPresentedBrowserSize(convId, null)
  }
  for (const convId of [...streamWinByConv.keys()]) disposeStreamWindow(convId)
  drawers.clear()
  placementByConv.clear()
})

describe('stream window', () => {
  it('presents every tab of the conversation in a shown window that ignores the mouse', () => {
    const [first, second] = browserWith('conv-1', 2)
    const size = presentBrowserForStream('conv-1', { width: 900, height: 600 })

    expect(size).toEqual({ width: 900, height: 600 })
    const host = streamWindowOf('conv-1') as unknown as Window
    expect(host).toBeTruthy()
    expect(host.shown).toBe(true)
    expect(host.ignoresMouse).toBe(true)
    expect(host.options).toMatchObject({ show: false, frame: false, focusable: false, skipTaskbar: true })
    expect(main.contentView.children).toEqual([])
    expect(host.contentView.children).toEqual([first, second])
    expect(getPlacement('conv-1', 'browser')).toBe('stream')
    expect(second.bounds).toEqual({ x: 0, y: 0, width: 900, height: 600 })
    expect(first.bounds).toEqual(OFFSCREEN)
    expect(second.webContents.invalidate).toHaveBeenCalled()
    expect(h.performance).toHaveBeenLastCalledWith('conv-1', 'browser', 'stream', true)
  })

  it('keeps the presented size within the presented browser limits and resizes in place', () => {
    browserWith('conv-2', 2)
    expect(presentBrowserForStream('conv-2', { width: 100, height: 100 })).toEqual({ width: 480, height: 320 })
    const host = streamWindowOf('conv-2')
    expect(presentBrowserForStream('conv-2', { width: 5000, height: Number.NaN })).toEqual({
      width: 1280,
      height: 640,
    })
    expect(streamWindowOf('conv-2')).toBe(host)
    expect(h.FakeWindow.created).toHaveLength(2)
  })

  it('offsets the windows of conversations watched at the same time', () => {
    browserWith('conv-a', 2)
    browserWith('conv-b', 2)
    presentBrowserForStream('conv-a', { width: 800, height: 600 })
    presentBrowserForStream('conv-b', { width: 800, height: 600 })
    const [a, b] = [streamWindowOf('conv-a'), streamWindowOf('conv-b')] as unknown as Window[]
    expect([a.options.x, b.options.x]).toEqual([0, 32])
  })

  it('moves the tabs back offscreen in the main window when released', () => {
    const [first, second] = browserWith('conv-3', 2)
    presentBrowserForStream('conv-3', { width: 800, height: 600 })
    const host = streamWindowOf('conv-3') as unknown as Window
    const closed = vi.fn()
    const off = onStreamWindowClosed(closed)

    releaseBrowserStream('conv-3')
    off()

    expect(host.destroyed).toBe(true)
    expect(streamWindowOf('conv-3')).toBeNull()
    expect(main.contentView.children).toEqual([first, second])
    expect(second.bounds).toEqual(OFFSCREEN)
    expect(getPlacement('conv-3', 'browser')).toBe('slot')
    expect(closed).toHaveBeenCalledWith('conv-3')
    expect(h.performance).toHaveBeenLastCalledWith('conv-3', 'browser', 'stream', false)
  })

  it('refuses a browser that another placement shows', () => {
    browserWith('conv-4', 2)
    placementByConv.set('conv-4', new Map([['browser', 'floating']]))
    expect(() => presentBrowserForStream('conv-4', { width: 800, height: 600 })).toThrow(/elsewhere/)
    expect(h.FakeWindow.created).toHaveLength(1)
  })

  it('returns the views to the main window when the stream window closes by itself', () => {
    const [first, second] = browserWith('conv-5', 2)
    presentBrowserForStream('conv-5', { width: 800, height: 600 })
    const host = streamWindowOf('conv-5') as unknown as Window
    host.destroy()
    expect(main.contentView.children).toEqual([first, second])
    expect(getPlacement('conv-5', 'browser')).toBe('slot')
  })
})

describe('stream window of a workspaces conversation', () => {
  it('puts the window in the tile the conversation holds, above other windows, and moves it as the tile changes', () => {
    browserWith('tiled', 2)
    setConversationTile('tiled', fleetEnvironmentTile(2))
    presentBrowserForStream('tiled', { width: 900, height: 640 })
    const host = streamWindowOf('tiled') as unknown as Window
    expect([host.options.x, host.options.y]).toEqual([2560, 0])
    expect(host.setAlwaysOnTop).toHaveBeenCalledWith(true)
    setConversationTile('tiled', null)
    presentBrowserForStream('tiled', { width: 900, height: 640 })
    expect(host.position).toEqual([0, 0])
    expect(host.alwaysOnTop).toBe(false)
    setConversationTile('tiled', fleetEnvironmentTile(5))
    presentBrowserForStream('tiled', { width: 900, height: 640 })
    expect(host.position).toEqual([2560, 800])
    expect(host.alwaysOnTop).toBe(true)
    expect(h.FakeWindow.created).toHaveLength(2)
  })

  it('cascades a window without a tile and keeps it at its place', () => {
    browserWith('conv-c', 2)
    presentBrowserForStream('conv-c', { width: 800, height: 600 })
    const host = streamWindowOf('conv-c') as unknown as Window
    presentBrowserForStream('conv-c', { width: 700, height: 500 })
    expect(host.setAlwaysOnTop).not.toHaveBeenCalled()
    expect(host.position).toEqual([0, 0])
  })

  it("makes no window while the conversation's computer presents its browser", () => {
    browserWith('computer', 2)
    placementByConv.set('computer', new Map([['browser', 'floating']]))
    setConversationScreen('computer', {
      display: ':10',
      width: 1280,
      height: 800,
      windowArea: fleetEnvironmentTile(1),
    })
    expect(presentBrowserForStream('computer', { width: 900, height: 640 })).toEqual({ width: 900, height: 640 })
    setPresentedBrowserSize('computer', { width: 1120, height: 640 })
    expect(presentBrowserForStream('computer', { width: 900, height: 640 })).toEqual({ width: 1120, height: 640 })
    expect(h.FakeWindow.created).toHaveLength(1)
  })

  it('hands the browser over to another window without ending its stream', () => {
    const [first, second] = browserWith('conv-h', 2)
    presentBrowserForStream('conv-h', { width: 800, height: 600 })
    const host = streamWindowOf('conv-h') as unknown as Window
    const closed = vi.fn()
    const off = onStreamWindowClosed(closed)
    handOverStreamWindow('conv-h')
    off()
    expect(closed).not.toHaveBeenCalled()
    expect(host.destroyed).toBe(true)
    expect(streamWindowOf('conv-h')).toBeNull()
    expect(main.contentView.children).toEqual([first, second])
    expect(getPlacement('conv-h', 'browser')).toBe('slot')
  })
})
