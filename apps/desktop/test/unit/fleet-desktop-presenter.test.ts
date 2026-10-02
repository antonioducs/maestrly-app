import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import {
  BrowserPresenter,
  type BrowserPresenterDeps,
  type PresentedMouseEvent,
  type PresenterGeometry,
} from '../../src/main/fleet/instance/desktop/browser-presenter'
import type { HitWindow } from '../../src/main/fleet/instance/desktop/hit-test'
import type { EditCommand, PresentedKeyEvent } from '../../src/main/fleet/instance/desktop/keymap'
import { BotDesktopService, type PresenterLink } from '../../src/main/fleet/instance/desktop/desktop-service'
import { encodeText } from '../../src/main/fleet/instance/desktop/socket-protocol'

const ORIGIN = { x: 2560, y: 0 }
const CONTROL = 4
const SHIFT = 1

/** A presenter connection the test plays: lines it sent, and lines it receives. */
function fakeLink() {
  const sent: string[][] = []
  let lineListener: (fields: string[]) => void = () => {}
  let closeListener: () => void = () => {}
  const link: PresenterLink = {
    send: (fields) => {
      sent.push([...fields])
    },
    onLine: (listener) => {
      lineListener = listener
    },
    onClose: (listener) => {
      closeListener = listener
    },
    close: vi.fn(() => closeListener()),
  }
  return {
    link,
    sent,
    receive: (...fields: Array<string | number>) => lineListener(fields.map(String)),
    lastOf: (kind: string) => sent.filter((fields) => fields[0] === kind).at(-1),
  }
}

type Target = 'chrome' | 'page' | 'popup' | 'strip' | 'popup-window'

/** The browser window at the tile origin: tabs and address bar above the page; a sign-in popup over it. */
function browserWindows(withPopup = false): HitWindow<Target>[] {
  const browser: HitWindow<Target> = {
    kind: 'browser',
    id: 1,
    frame: { x: ORIGIN.x, y: ORIGIN.y, width: 1120, height: 672 },
    content: { x: ORIGIN.x, y: ORIGIN.y, width: 1120, height: 672 },
    views: [
      { target: 'chrome', bounds: { x: ORIGIN.x, y: ORIGIN.y, width: 1120, height: 78 } },
      { target: 'page', bounds: { x: ORIGIN.x, y: ORIGIN.y + 78, width: 1120, height: 594 } },
    ],
    windowTarget: 'strip',
  }
  const popup: HitWindow<Target> = {
    kind: 'popup',
    id: 2,
    frame: { x: ORIGIN.x + 300, y: ORIGIN.y + 100, width: 502, height: 425 },
    content: { x: ORIGIN.x + 301, y: ORIGIN.y + 120, width: 500, height: 400 },
    views: [],
    windowTarget: 'popup',
  }
  return withPopup ? [popup, browser] : [browser]
}

function setup(options: { popup?: boolean; geometry?: PresenterGeometry | null } = {}) {
  const mouse: Array<[Target, PresentedMouseEvent]> = []
  const keys: Array<[Target, PresentedKeyEvent]> = []
  const edits: Array<[Target, EditCommand]> = []
  const order: string[] = []
  const saved: PresenterGeometry[] = []
  let clipboard = ''
  let windows = browserWindows(options.popup)
  const deps: BrowserPresenterDeps<Target> = {
    windows: () => windows,
    origin: () => ORIGIN,
    resize: vi.fn((size) => ({ width: Math.min(size.width, 1280), height: Math.min(size.height, 800) })),
    mouse: async (target, event) => {
      mouse.push([target, event])
    },
    key: async (target, event) => {
      keys.push([target, event])
      order.push('key ' + event.key)
    },
    edit: (target, command) => {
      edits.push([target, command])
      order.push('edit ' + command)
      if (command === 'copy') clipboard = 'copied in the page'
    },
    readClipboard: async () => clipboard,
    writeClipboard: async (text) => {
      clipboard = text
      order.push('clipboard ' + text)
    },
    movePopup: vi.fn(),
    closePopup: vi.fn(),
    focusEmulation: vi.fn(),
    defaultTarget: () => 'page',
    title: () => 'Browser — Synthetic page',
    icon: () => ({ width: 1, height: 1, argb: Buffer.from([1, 2, 3, 4]) }),
    loadGeometry: async () => options.geometry ?? null,
    saveGeometry: async (geometry) => {
      saved.push(geometry)
    },
    log: vi.fn(),
  }
  const presenter = new BrowserPresenter(deps)
  return {
    presenter,
    deps,
    mouse,
    keys,
    edits,
    order,
    saved,
    setWindows: (next: HitWindow<Target>[]) => {
      windows = next
    },
    clipboard: () => clipboard,
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
})
afterEach(() => {
  vi.useRealTimers()
})

describe('BrowserPresenter', () => {
  it('configures a new presenter window and shows it only when asked', async () => {
    const { presenter, deps } = setup()
    const { link, sent } = fakeLink()
    await presenter.attach(link)
    expect(sent).toEqual([
      ['limits', '480', '320', '1280', '800'],
      ['geometry', '80', '56', '1120', '640'],
      ['title', encodeText('Browser — Synthetic page')],
      ['icon', '1', '1', Buffer.from([1, 2, 3, 4]).toString('base64')],
      ['source', '2560', '0', '1120', '640'],
    ])
    expect(deps.resize).toHaveBeenCalledWith({ width: 1120, height: 640 })
    expect(presenter.present({ activate: true })).toBe(true)
    expect(sent.at(-1)).toEqual(['show', '1'])
    // A presenter that connects again later finds the window shown, without taking the keyboard.
    const again = fakeLink()
    await presenter.attach(again.link)
    expect(again.sent.at(-1)).toEqual(['show', '0'])
  })

  it('restores the saved geometry and saves a changed one after a pause', async () => {
    const { presenter, saved, deps } = setup({ geometry: { x: 100, y: 50, width: 900, height: 600 } })
    const { link, sent, receive, lastOf } = fakeLink()
    await presenter.attach(link)
    expect(lastOf('geometry')).toEqual(['geometry', '100', '50', '900', '600'])
    expect(lastOf('source')).toEqual(['source', '2560', '0', '900', '600'])
    // The window was made bigger than a tile: the browser takes the most it can, and the presenter follows it.
    receive('configure', 10, 20, 2000, 700)
    expect(deps.resize).toHaveBeenLastCalledWith({ width: 1280, height: 700 })
    expect(lastOf('source')).toEqual(['source', '2560', '0', '1280', '700'])
    expect(lastOf('geometry')).toEqual(['geometry', '10', '20', '1280', '700'])
    expect(saved).toEqual([])
    await vi.advanceTimersByTimeAsync(500)
    expect(saved).toEqual([{ x: 10, y: 20, width: 1280, height: 700 }])
    expect(sent.filter(([kind]) => kind === 'configure')).toEqual([])
  })

  it('counts clicks by time and distance, and holds the clicked view until the button is released', async () => {
    const { presenter, mouse } = setup()
    const { link, receive } = fakeLink()
    await presenter.attach(link)
    const click = async (x: number, y: number) => {
      receive('button', 1, 1, x, y, 0, 0)
      receive('button', 0, 1, x, y, 0, 0)
      await vi.advanceTimersByTimeAsync(0)
    }
    await click(200, 300)
    await vi.advanceTimersByTimeAsync(100)
    await click(202, 301)
    await vi.advanceTimersByTimeAsync(100)
    await click(203, 300)
    await vi.advanceTimersByTimeAsync(500)
    await click(203, 300)
    const presses = mouse.filter(([, event]) => event.type === 'mousePressed')
    expect(presses.map(([target, event]) => [target, event.x, event.y, event.clickCount])).toEqual([
      ['page', 200, 222, 1],
      ['page', 202, 223, 2],
      ['page', 203, 222, 3],
      ['page', 203, 222, 1],
    ])
    mouse.length = 0
    // Pressed in the address bar and released over the page: the address bar gets the drag and its release.
    receive('button', 1, 1, 400, 40, 0, 0)
    receive('motion', 410, 200, 256, 0)
    receive('button', 0, 1, 420, 300, 256, 0)
    await vi.advanceTimersByTimeAsync(0)
    expect(mouse.map(([target, event]) => [target, event.type, event.x, event.y, event.buttons])).toEqual([
      ['chrome', 'mousePressed', 400, 40, 1],
      ['chrome', 'mouseMoved', 410, 200, 1],
      ['chrome', 'mouseReleased', 420, 300, 0],
    ])
    mouse.length = 0
    receive('button', 1, 5, 500, 400, 0, 0)
    receive('button', 0, 5, 500, 400, 0, 0)
    await vi.advanceTimersByTimeAsync(0)
    expect(mouse.map(([target, event]) => [target, event.type, event.deltaY])).toEqual([['page', 'mouseWheel', 100]])
  })

  it('sends keys to the last clicked view, in order', async () => {
    const { presenter, keys } = setup()
    const { link, receive } = fakeLink()
    await presenter.attach(link)
    receive('key', 1, 0x61, 0, 0)
    receive('key', 0, 0x61, 0, 0)
    receive('button', 1, 1, 400, 40, 0, 0)
    receive('button', 0, 1, 400, 40, 0, 0)
    receive('key', 1, 0x41, SHIFT, 0)
    await vi.advanceTimersByTimeAsync(0)
    expect(keys.map(([target, event]) => [target, event.type, event.key, event.text])).toEqual([
      ['page', 'keyDown', 'a', 'a'],
      ['page', 'keyUp', 'a', undefined],
      ['chrome', 'keyDown', 'A', 'A'],
    ])
  })

  it('pastes the desktop clipboard into the page before the next key', async () => {
    const { presenter, order, edits } = setup()
    const { link, receive, lastOf } = fakeLink()
    await presenter.attach(link)
    receive('key', 1, 0x76, CONTROL, 0)
    receive('key', 0, 0x76, CONTROL, 0)
    receive('key', 1, 0x62, 0, 0)
    await vi.advanceTimersByTimeAsync(0)
    expect(lastOf('readclip')).toEqual(['readclip'])
    expect(order).toEqual([])
    receive('clip', encodeText('from the desktop'))
    await vi.advanceTimersByTimeAsync(0)
    expect(order).toEqual(['clipboard from the desktop', 'edit paste', 'key b'])
    expect(edits).toEqual([['page', 'paste']])
  })

  it('pastes nothing when the desktop clipboard is empty or does not answer, and goes on', async () => {
    const { presenter, order } = setup()
    const { link, receive } = fakeLink()
    await presenter.attach(link)
    receive('key', 1, 0x76, CONTROL, 0)
    receive('key', 1, 0x62, 0, 0)
    receive('clip-none')
    await vi.advanceTimersByTimeAsync(0)
    receive('key', 1, 0x76, CONTROL, 0)
    receive('key', 1, 0x63, 0, 0)
    await vi.advanceTimersByTimeAsync(999)
    expect(order).toEqual(['key b'])
    await vi.advanceTimersByTimeAsync(1)
    expect(order).toEqual(['key b', 'key c'])
  })

  it('copies what the page copied to the desktop clipboard', async () => {
    const { presenter, edits } = setup()
    const { link, receive, lastOf } = fakeLink()
    await presenter.attach(link)
    receive('key', 1, 0x63, CONTROL, 0)
    await vi.advanceTimersByTimeAsync(59)
    expect(edits).toEqual([['page', 'copy']])
    expect(lastOf('setclip')).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    expect(lastOf('setclip')).toEqual(['setclip', encodeText('copied in the page')])
  })

  it("closes a popup from its frame's close area and drags it by its title bar inside the browser", async () => {
    const { presenter, deps, mouse } = setup({ popup: true })
    const { link, receive } = fakeLink()
    await presenter.attach(link)
    // Title bar of the popup frame, at its right end: the close button.
    receive('button', 1, 1, 300 + 502 - 10, 105, 0, 0)
    receive('button', 0, 1, 300 + 502 - 10, 105, 0, 0)
    await vi.advanceTimersByTimeAsync(0)
    expect(deps.closePopup).toHaveBeenCalledTimes(1)
    receive('button', 1, 1, 400, 105, 0, 0)
    receive('motion', 450, 85, 256, 0)
    receive('button', 0, 1, 450, 85, 256, 0)
    await vi.advanceTimersByTimeAsync(0)
    expect(deps.movePopup).toHaveBeenLastCalledWith(expect.objectContaining({ id: 2 }), {
      x: ORIGIN.x + 350,
      y: ORIGIN.y + 80,
    })
    expect(mouse).toEqual([])
    // Typing goes to the popup the owner clicked into.
    receive('button', 1, 1, 400, 300, 0, 0)
    receive('button', 0, 1, 400, 300, 0, 0)
    await vi.advanceTimersByTimeAsync(0)
    expect(mouse.at(-1)).toEqual(['popup', expect.objectContaining({ type: 'mouseReleased', x: 99, y: 180 })])
  })

  it('hides on close, follows visibility with focus emulation, and drops a presenter that sends nonsense', async () => {
    const { presenter, deps } = setup()
    const { link, receive, sent } = fakeLink()
    await presenter.attach(link)
    receive('visible', 1)
    expect(deps.focusEmulation).toHaveBeenLastCalledWith(true)
    receive('close')
    expect(sent.at(-1)).toEqual(['hide'])
    receive('visible', 0)
    expect(deps.focusEmulation).toHaveBeenLastCalledWith(false)
    receive('button', 1, 'one', 2, 3, 0, 0)
    expect(link.close).toHaveBeenCalledTimes(1)
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('button'))
    expect(presenter.present({ activate: true })).toBe(false)
  })
})

describe('the desktop socket and the presenter', () => {
  let dir = ''
  beforeEach(async () => {
    vi.useRealTimers()
    dir = await mkdtemp(path.join(os.tmpdir(), 'presenter-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('hands a presenter to the session only after its role line, and refuses input before it', async () => {
    const attached: PresenterLink[] = []
    const service = new BotDesktopService({
      socketPath: path.join(dir, 'd.sock'),
      conversationId: () => 'conv',
      conversationCwd: () => dir,
      terminals: {
        list: () => [],
        create: () => ({ ok: false, reason: 'spawn-failed' }),
        belongsTo: () => false,
        exists: () => false,
        snapshot: () => ({ data: '', generation: 0, sequence: 0 }),
        write: () => false,
        resize: () => {},
        onOutput: () => () => {},
        onExit: () => () => {},
        title: () => 'Terminal',
      },
      viewers: { show: async () => {} },
      openFiles: async () => {},
      openUrl: async () => {},
      presentBrowser: async () => {},
      attachPresenter: (link) => attached.push(link),
      messages: {
        presenterUnavailable: 'unavailable',
        noConversation: 'none',
        invalidUrl: 'bad url',
        terminalFailed: 'failed',
        exit: () => 'exit',
      },
      log: () => {},
    })
    await service.start()
    const talk = (lines: string) =>
      new Promise<string>((resolve) => {
        const socket = net.connect(path.join(dir, 'd.sock'))
        let answer = ''
        socket.on('data', (chunk) => {
          answer += chunk.toString()
          if (answer.includes('\n')) {
            socket.destroy()
            resolve(answer)
          }
        })
        socket.write(lines)
      })
    expect(await talk('key\t1\t97\t0\t0\n')).toMatch(/^err\t/)
    expect(attached).toHaveLength(0)
    expect(await talk('presenter\t1\n')).toBe('ok\n')
    expect(attached).toHaveLength(1)
    await service.dispose()
  })
})
