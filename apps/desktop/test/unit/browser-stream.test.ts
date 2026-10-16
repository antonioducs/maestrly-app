import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
  const { EventEmitter } = require('node:events') as typeof import('node:events')
  class FakeDebugger extends EventEmitter {
    commands: Array<[string, Record<string, unknown> | undefined]> = []
    sendCommand = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      this.commands.push([method, params])
      return {}
    })
    sent(method: string) {
      return this.commands.filter(([name]) => name === method).map(([, params]) => params)
    }
  }
  class FakeWebContents extends EventEmitter {
    debugger = new FakeDebugger()
    destroyed = false
    zoom = 1
    url = 'https://example.com/'
    title = 'Example'
    invalidate = vi.fn()
    copy = vi.fn()
    cut = vi.fn()
    paste = vi.fn()
    selectAll = vi.fn()
    undo = vi.fn()
    redo = vi.fn()
    isDestroyed() {
      return this.destroyed
    }
    getZoomFactor() {
      return this.zoom
    }
    getURL() {
      return this.url
    }
    getTitle() {
      return this.title
    }
  }
  const clipboardState = { text: '' }
  const browserListeners = { state: new Set<(convId: string) => void>(), popups: new Set<(convId: string) => void>() }
  const views = {
    page: null as null | { webContents: FakeWebContents; getBounds(): Rect },
    popups: [] as unknown[],
  }
  type Rect = { x: number; y: number; width: number; height: number }
  /** The window that holds the browser on the host's display, and the page's place in it. */
  const host = {
    content: { x: 0, y: 0, width: 800, height: 600 } as Rect,
    page: { x: 0, y: 0, width: 800, height: 600 } as Rect,
    window: { isDestroyed: () => false, getContentBounds: () => host.content },
  }
  const computers = {
    value: null as null | { leaseTile: ReturnType<typeof vi.fn> },
  }
  return {
    host,
    computers,
    FakeWebContents,
    clipboardState,
    browserListeners,
    views,
    remoteSenders: new Set<unknown>(),
    serverMode: { value: true },
    present: vi.fn((_convId: string, size: { width: number; height: number }) => ({
      width: Math.min(1280, Math.max(480, size.width)),
      height: Math.min(800, Math.max(320, size.height)),
    })),
    release: vi.fn(),
    control: {
      dispatchPresentedKey: vi.fn(async () => undefined),
      dispatchPresentedMouse: vi.fn(async () => undefined),
      ensureBrowserDebugger: vi.fn(async () => undefined),
      insertPresentedText: vi.fn(async () => undefined),
      setPresentedFocusEmulation: vi.fn(async () => undefined),
    },
    page: {
      interceptSelects: vi.fn(() => vi.fn()),
      chooseSelectOption: vi.fn(async () => true),
      readPageSelection: vi.fn(async () => ''),
    },
  }
})

vi.mock('electron', () => ({
  clipboard: {
    readText: async () => h.clipboardState.text,
    writeText: async (text: string) => {
      h.clipboardState.text = text
    },
    write: async (items: Array<{ items: Record<string, string> }>) => {
      h.clipboardState.text = items[0].items['text/plain']
    },
  },
  ClipboardItem: class {
    constructor(readonly items: Record<string, string>) {}
  },
}))
vi.mock('../../src/main/browser-control', () => h.control)
vi.mock('../../src/main/remote-ui-targets', () => ({
  isRemoteUiTarget: (value: unknown) => h.remoteSenders.has(value),
}))
vi.mock('../../src/main/remote-host/server/config', () => ({ isServerMode: () => h.serverMode.value }))
vi.mock('../../src/main/store', () => ({ getConversation: (id: string) => (id.startsWith('conv') ? { id } : null) }))
vi.mock('../../src/main/drawer/browser', () => ({
  ensureBrowser: vi.fn(),
  onBrowserStateChange: (listener: (convId: string) => void) => h.browserListeners.state.add(listener),
  onBrowserPopupsChange: (listener: (convId: string) => void) => h.browserListeners.popups.add(listener),
  presentedBrowserViews: () => ({ chrome: null, page: h.views.page, popups: h.views.popups }),
}))
vi.mock('../../src/main/drawer/browser-stream-page', () => h.page)
vi.mock('../../src/main/drawer/stream-window', () => ({
  browserHostWindow: () => h.host.window,
  onStreamWindowClosed: vi.fn(),
  presentBrowserForStream: h.present,
  releaseBrowserStream: h.release,
}))
vi.mock('../../src/main/remote-host/server/computers-registry', () => ({ serverComputers: () => h.computers.value }))

import { fleetEnvironmentTile } from '@maestrly/bot-fleet-protocol'
import { setConversationTile } from '../../src/main/conversation-screen'
import {
  STREAM_RELEASE_GRACE_MS,
  acknowledgeBrowserFrame,
  chooseBrowserStreamOption,
  copyBrowserStream,
  inputBrowserStream,
  pasteBrowserStream,
  resetBrowserStreamsForTest,
  resizeBrowserStream,
  setBrowserStreamTransport,
  startBrowserStream,
  stopBrowserStream,
} from '../../src/main/drawer/browser-stream'

type WebContents = InstanceType<typeof h.FakeWebContents>

class Viewer extends EventEmitter {
  static next = -1000
  readonly id = Viewer.next--
  destroyed = false
  send = vi.fn()
  isDestroyed() {
    return this.destroyed
  }
  events(channel: string) {
    return this.send.mock.calls.filter(([name]) => name === channel).map(([, payload]) => payload)
  }
  gone() {
    this.destroyed = true
    this.emit('destroyed')
  }
}

const settle = async () => {
  for (let i = 0; i < 6; i++) await new Promise((resolve) => setImmediate(resolve))
}

function viewer(): Viewer {
  const sender = new Viewer()
  h.remoteSenders.add(sender)
  return sender
}

function frame(wc: WebContents, sessionId = 1, width = 800, height = 600) {
  wc.debugger.emit('message', {}, 'Page.screencastFrame', {
    data: '/9j/AAAA',
    sessionId,
    metadata: { deviceWidth: width, deviceHeight: height },
  })
}

let tab: WebContents

beforeEach(() => {
  tab = new h.FakeWebContents()
  h.views.page = { webContents: tab, getBounds: () => h.host.page }
  h.views.popups = []
  h.serverMode.value = true
  h.clipboardState.text = ''
})

afterEach(() => {
  resetBrowserStreamsForTest()
  h.computers.value = null
  for (const convId of ['conv-1', 'conv-2']) setConversationTile(convId, null)
  h.remoteSenders.clear()
  vi.clearAllMocks()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

async function started(convId = 'conv-1', sender = viewer()) {
  const { streamId } = startBrowserStream(sender, convId, 800, 600)
  await settle()
  return { sender, streamId }
}

describe('remote browser stream', () => {
  it('serves only renderers of another computer on a workspaces host', () => {
    expect(() => startBrowserStream({ id: 1 }, 'conv-1', 800, 600)).toThrow(/remote viewers/)
    const sender = viewer()
    h.serverMode.value = false
    expect(() => startBrowserStream(sender, 'conv-1', 800, 600)).toThrow(/remote viewers/)
    h.serverMode.value = true
    expect(() => startBrowserStream(sender, 'not-a-conversation', 800, 600)).toThrow(/Unknown conversation/)
    expect(h.present).not.toHaveBeenCalled()
  })

  it('announces the source, then streams JPEG frames at the size of the surface', async () => {
    const { sender, streamId } = await started()
    expect(streamId).toMatch(/^[A-Za-z0-9_-]{16,64}$/)
    expect(h.present).toHaveBeenCalledWith('conv-1', { width: 800, height: 600 })
    expect(sender.events('drawer:browser-stream-source')).toEqual([
      { convId: 'conv-1', streamId, source: 1, kind: 'tab', popup: null },
    ])
    expect(tab.debugger.sent('Page.startScreencast')).toEqual([
      { format: 'jpeg', quality: 70, maxWidth: 800, maxHeight: 600, everyNthFrame: 1 },
    ])
    expect(tab.debugger.sent('Page.setInterceptFileChooserDialog')).toEqual([{ enabled: true }])
    expect(h.page.interceptSelects).toHaveBeenCalledWith(tab, expect.any(Function))
    expect(tab.invalidate).toHaveBeenCalled()

    frame(tab, 7)
    expect(sender.events('drawer:browser-frame')).toEqual([
      { convId: 'conv-1', streamId, source: 1, seq: 1, width: 800, height: 600, data: '/9j/AAAA' },
    ])
  })

  it('keeps two frames on their way and acknowledges each to Chromium only once the window has', async () => {
    const { sender, streamId } = await started()
    frame(tab, 4)
    frame(tab, 4)
    frame(tab, 4)
    expect(sender.events('drawer:browser-frame')).toHaveLength(2)
    expect(tab.debugger.sent('Page.screencastFrameAck')).toEqual([])

    acknowledgeBrowserFrame(sender, 'conv-1', streamId, 1)
    expect(tab.debugger.sent('Page.screencastFrameAck')).toEqual([{ sessionId: 4 }])
    // The frame held back goes once there is room for it.
    expect(sender.events('drawer:browser-frame').map((item: any) => item.seq)).toEqual([1, 2, 3])

    // Unknown, repeated or foreign acknowledgements change nothing.
    acknowledgeBrowserFrame(sender, 'conv-1', streamId, 1)
    acknowledgeBrowserFrame(viewer(), 'conv-1', streamId, 2)
    acknowledgeBrowserFrame(sender, 'conv-1', 'x'.repeat(20), 2)
    expect(tab.debugger.sent('Page.screencastFrameAck')).toHaveLength(1)
  })

  it('lowers the quality when acknowledgements are slow, and restores it when they are fast again', async () => {
    let now = 1_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const { sender, streamId } = await started()
    for (let seq = 1; seq <= 8; seq++) {
      frame(tab, 1)
      now += 400
      acknowledgeBrowserFrame(sender, 'conv-1', streamId, seq)
    }
    await settle()
    expect(tab.debugger.sent('Page.startScreencast').at(-1)).toMatchObject({ quality: 50, maxWidth: 800 })

    now += 6_000
    for (let seq = 9; seq <= 16; seq++) {
      frame(tab, 1)
      now += 20
      acknowledgeBrowserFrame(sender, 'conv-1', streamId, seq)
    }
    await settle()
    expect(tab.debugger.sent('Page.startScreencast').at(-1)).toMatchObject({ quality: 70 })
  })

  it('switches to a sign-in window above the browser and back', async () => {
    const { sender, streamId } = await started()
    frame(tab, 3)
    const popupContents = new h.FakeWebContents()
    popupContents.url = 'https://accounts.example.com/signin'
    popupContents.title = 'Sign in'
    const popup = { isDestroyed: () => false, webContents: popupContents, close: vi.fn() }
    h.views.popups = [popup]
    for (const listener of h.browserListeners.popups) listener('conv-1')
    await settle()

    expect(tab.debugger.sent('Page.stopScreencast').length).toBeGreaterThan(0)
    expect(sender.events('drawer:browser-stream-source').at(-1)).toEqual({
      convId: 'conv-1',
      streamId,
      source: 2,
      kind: 'popup',
      popup: { url: 'https://accounts.example.com/signin', title: 'Sign in' },
    })
    expect(popupContents.debugger.sent('Page.startScreencast')).toHaveLength(1)
    // The frame of the tab was on its way: its acknowledgement does not reach the popup's session.
    acknowledgeBrowserFrame(sender, 'conv-1', streamId, 1)
    expect(popupContents.debugger.sent('Page.screencastFrameAck')).toEqual([])

    h.views.popups = []
    for (const listener of h.browserListeners.popups) listener('conv-1')
    await settle()
    expect(sender.events('drawer:browser-stream-source').at(-1)).toMatchObject({ source: 3, kind: 'tab' })
  })

  it('tells the previous viewer when another one takes the browser over', async () => {
    const first = await started()
    const second = await started('conv-1', viewer())
    expect(first.sender.events('drawer:browser-stream-ended')).toEqual([
      { convId: 'conv-1', streamId: first.streamId, reason: 'taken-over' },
    ])
    frame(tab, 2)
    expect(first.sender.events('drawer:browser-frame')).toEqual([])
    expect(second.sender.events('drawer:browser-frame')).toHaveLength(1)
    inputBrowserStream(first.sender, 'conv-1', first.streamId, { type: 'text', text: 'ignored' })
    await settle()
    expect(h.control.insertPresentedText).not.toHaveBeenCalled()
  })

  it('sends input to the page in its CSS pixels, in order', async () => {
    const { sender, streamId } = await started()
    tab.zoom = 2
    inputBrowserStream(sender, 'conv-1', streamId, {
      type: 'mouse',
      action: 'down',
      x: 200,
      y: 100,
      button: 'left',
      buttons: 1,
      clickCount: 1,
      modifiers: 0,
    })
    inputBrowserStream(sender, 'conv-1', streamId, {
      type: 'key',
      action: 'down',
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      modifiers: 0,
      location: 0,
      autoRepeat: false,
      text: '\r',
    })
    inputBrowserStream(sender, 'conv-1', streamId, { type: 'text', text: 'é' })
    inputBrowserStream(sender, 'conv-1', streamId, { type: 'edit', command: 'selectAll' })
    inputBrowserStream(sender, 'conv-1', streamId, { type: 'eval', code: '1' })
    await settle()
    expect(h.control.dispatchPresentedMouse).toHaveBeenCalledWith(tab, {
      type: 'mousePressed',
      x: 100,
      y: 50,
      button: 'left',
      buttons: 1,
      clickCount: 1,
      modifiers: 0,
    })
    expect(h.control.dispatchPresentedKey).toHaveBeenCalledWith(tab, {
      type: 'keyDown',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
      modifiers: 0,
      text: '\r',
      unmodifiedText: '\r',
    })
    expect(h.control.insertPresentedText).toHaveBeenCalledWith(tab, 'é')
    expect(tab.selectAll).toHaveBeenCalled()
    const order = [
      h.control.dispatchPresentedMouse.mock.invocationCallOrder[0],
      h.control.dispatchPresentedKey.mock.invocationCallOrder[0],
      h.control.insertPresentedText.mock.invocationCallOrder[0],
    ]
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  it('copies through the page and falls back to its selection when nothing reached the clipboard', async () => {
    const { sender, streamId } = await started()
    tab.copy.mockImplementation(() => {
      h.clipboardState.text = 'copied by the page'
    })
    await expect(copyBrowserStream(sender, 'conv-1', streamId, false)).resolves.toBe('copied by the page')

    tab.cut.mockImplementation(() => {})
    h.page.readPageSelection.mockResolvedValueOnce('selected text')
    await expect(copyBrowserStream(sender, 'conv-1', streamId, true)).resolves.toBe('selected text')
    expect(tab.cut).toHaveBeenCalled()
    await expect(copyBrowserStream(viewer(), 'conv-1', streamId, false)).resolves.toBeNull()
  })

  it('pastes the viewer clipboard through the page', async () => {
    const { sender, streamId } = await started()
    pasteBrowserStream(sender, 'conv-1', streamId, { text: 'pasted', html: '<b>pasted</b>' })
    await vi.waitFor(() => expect(tab.paste).toHaveBeenCalled())
    expect(h.clipboardState.text).toBe('pasted')
    pasteBrowserStream(sender, 'conv-1', streamId, { text: 7 })
    await settle()
    expect(tab.paste).toHaveBeenCalledTimes(1)
  })

  it("relays the page's lists to the viewer and its choice back, and reports refused file choosers", async () => {
    const { sender, streamId } = await started()
    tab.zoom = 1.5
    const onRequest = (h.page.interceptSelects.mock.calls[0] as unknown[])[1] as (request: unknown) => void
    onRequest({
      requestId: '3:1',
      options: [{ label: 'Alpha', disabled: false, group: null }],
      selectedIndex: 0,
      rect: { x: 10, y: 20, width: 100, height: 30 },
    })
    expect(sender.events('drawer:browser-select')).toEqual([
      {
        convId: 'conv-1',
        streamId,
        source: 1,
        requestId: '3:1',
        options: [{ label: 'Alpha', disabled: false, group: null }],
        selectedIndex: 0,
        rect: { x: 15, y: 30, width: 150, height: 45 },
      },
    ])
    chooseBrowserStreamOption(sender, 'conv-1', streamId, '3:1', 0)
    chooseBrowserStreamOption(sender, 'conv-1', streamId, '3:1', -1)
    chooseBrowserStreamOption(viewer(), 'conv-1', streamId, '3:1', 0)
    await settle()
    expect(h.page.chooseSelectOption).toHaveBeenCalledTimes(1)
    expect(h.page.chooseSelectOption).toHaveBeenCalledWith(tab, '3:1', 0)

    tab.debugger.emit('message', {}, 'Page.fileChooserOpened', { mode: 'selectSingle' })
    expect(sender.events('drawer:browser-stream-notice')).toEqual([
      { convId: 'conv-1', streamId, notice: 'file-chooser' },
    ])
  })

  it('keeps the page presented for a grace period after the viewer leaves', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { sender, streamId } = await started()
    stopBrowserStream(sender, 'conv-1', streamId)
    expect(tab.debugger.sent('Page.stopScreencast').length).toBeGreaterThan(0)
    vi.advanceTimersByTime(STREAM_RELEASE_GRACE_MS - 1)
    expect(h.release).not.toHaveBeenCalled()
    // A viewer that comes back in time keeps the window.
    await started('conv-1', sender)
    vi.advanceTimersByTime(STREAM_RELEASE_GRACE_MS)
    expect(h.release).not.toHaveBeenCalled()

    sender.gone()
    vi.advanceTimersByTime(STREAM_RELEASE_GRACE_MS)
    expect(h.release).toHaveBeenCalledWith('conv-1')
  })
})

describe('remote browser stream over video', () => {
  const tile = fleetEnvironmentTile(1)
  /** A host with computers whose pool has a tile for the conversation, or none when `free` is false. */
  function computers(free = true) {
    const release = vi.fn((convId: string) => setConversationTile(convId, null))
    const leaseTile = vi.fn((convId: string) => {
      if (!free) return null
      // As the host's placement does: the browser's window moves to the tile.
      setConversationTile(convId, tile)
      return { tile, release: () => release(convId) }
    })
    h.computers.value = { leaseTile }
    return { leaseTile, release }
  }
  /** The browser's window at the tile's top left, its page filling it. */
  function inTile(width: number, height: number, top = 0) {
    h.host.content = { x: tile.x, y: tile.y, width, height: height + top }
    h.host.page = { x: 0, y: top, width, height }
  }
  async function startVideo(sender = viewer(), options: unknown = { video: true }) {
    const answer = startBrowserStream(sender, 'conv-1', 900, 640, options)
    await settle()
    return { sender, ...answer }
  }

  it('streams no frames and tells the window where the page is in its tile', async () => {
    const pool = computers()
    inTile(900, 640)
    const { sender, streamId, transport } = await startVideo()
    expect(transport).toBe('video')
    expect(pool.leaseTile).toHaveBeenCalledWith('conv-1')
    expect(tab.debugger.sent('Page.startScreencast')).toEqual([])
    expect(tab.invalidate).toHaveBeenCalled()
    expect(sender.events('drawer:browser-stream-area')).toEqual([
      { convId: 'conv-1', streamId, area: { x: 0, y: 0, width: 900, height: 640 } },
    ])
    // A resize moves the page; its place goes to the window once.
    inTile(700, 500)
    resizeBrowserStream(sender, 'conv-1', streamId, 700, 500)
    resizeBrowserStream(sender, 'conv-1', streamId, 700, 500)
    expect(sender.events('drawer:browser-stream-area').map((event) => (event as { area: unknown }).area)).toEqual([
      { x: 0, y: 0, width: 900, height: 640 },
      { x: 0, y: 0, width: 700, height: 500 },
    ])
    expect(tab.debugger.sent('Page.startScreencast')).toEqual([])
  })

  it("follows the computer's window: the page under its address bar, and a sign-in window above it", async () => {
    computers()
    // The computer's desktop presents the browser at its own size, its address bar above the page.
    inTile(1120, 600, 40)
    const { sender } = await startVideo()
    expect(sender.events('drawer:browser-stream-area').at(-1)).toMatchObject({
      area: { x: 0, y: 40, width: 1120, height: 600 },
    })
    const popupContents = new h.FakeWebContents()
    const popup = {
      isDestroyed: () => false,
      webContents: popupContents,
      close: vi.fn(),
      getContentBounds: () => ({ x: tile.x + 200, y: tile.y + 100, width: 500, height: 600 }),
    }
    h.views.popups = [popup]
    for (const listener of h.browserListeners.popups) listener('conv-1')
    await settle()
    expect(sender.events('drawer:browser-stream-area').at(-1)).toMatchObject({
      area: { x: 200, y: 100, width: 500, height: 600 },
    })
  })

  it('streams frames without a free tile, to a window that does not play video, and when the window asks', async () => {
    computers(false)
    expect((await startVideo()).transport).toBe('jpeg')
    expect(tab.debugger.sent('Page.startScreencast')).toHaveLength(1)
    resetBrowserStreamsForTest()

    const pool = computers()
    const plain = await startVideo(viewer(), null)
    expect(plain.transport).toBe('jpeg')
    expect(pool.leaseTile).not.toHaveBeenCalled()
    resetBrowserStreamsForTest()

    inTile(900, 640)
    const { sender, streamId } = await startVideo()
    const before = tab.debugger.sent('Page.startScreencast').length
    setBrowserStreamTransport(sender, 'conv-1', streamId, 'video')
    await settle()
    expect(tab.debugger.sent('Page.startScreencast')).toHaveLength(before)
    setBrowserStreamTransport(sender, 'conv-1', streamId, 'jpeg')
    await settle()
    expect(pool.release).toHaveBeenCalledTimes(1)
    expect(tab.debugger.sent('Page.startScreencast')).toHaveLength(before + 1)
    // Once on frames, the stream tells the window nothing more about the tile.
    const areas = sender.events('drawer:browser-stream-area').length
    resizeBrowserStream(sender, 'conv-1', streamId, 700, 500)
    expect(sender.events('drawer:browser-stream-area')).toHaveLength(areas)
  })

  it('keeps the tile through the grace after the viewer leaves, and gives it to a viewer that takes over', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const pool = computers()
    inTile(900, 640)
    const first = await startVideo()
    stopBrowserStream(first.sender, 'conv-1', first.streamId)
    vi.advanceTimersByTime(STREAM_RELEASE_GRACE_MS - 1)
    expect(pool.release).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(pool.release).toHaveBeenCalledTimes(1)

    // Another device that plays video takes the tile over; one that does not gives it back at once.
    const second = await startVideo()
    expect(pool.leaseTile).toHaveBeenCalledTimes(2)
    const third = await startVideo(viewer())
    expect(third.transport).toBe('video')
    expect(pool.leaseTile).toHaveBeenCalledTimes(2)
    expect(second.sender.events('drawer:browser-stream-ended')).toEqual([
      { convId: 'conv-1', streamId: second.streamId, reason: 'taken-over' },
    ])
    await startVideo(viewer(), {})
    expect(pool.release).toHaveBeenCalledTimes(2)
  })
})
