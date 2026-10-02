import type { PresenterLink } from './desktop-service'
import { constrainFrame, hitTest, type HitWindow, type Rect } from './hit-test'
import { cdpModifiers, editCommand, presentedKeyEvent, type EditCommand, type PresentedKeyEvent } from './keymap'
import { DesktopProtocolError, decodeText, encodeText } from './socket-protocol'
import {
  DEFAULT_PRESENTER_GEOMETRY,
  PRESENTED_BROWSER_LIMITS,
  clampPresentedSize,
  type PresentedSize,
} from '../window-bounds'

/**
 * The routing half of a bot's browser presenter. The native presenter (deploy/bot-fleet/desktop/presenter) shows the
 * bot's Maestrly browser, which lives on the environment display, in a window of the bot's own display, and forwards
 * the X input that window receives. Here that input becomes DevTools input events for the exact views of this bot's
 * browser: its tab strip and address bar, its active page, and its sign-in popups. Nothing is ever typed into the
 * environment display, whose keyboard focus every bot shares.
 */

export interface PresenterGeometry extends PresentedSize {
  /** The client area of the presented window on the bot's display. */
  x: number
  y: number
}
export interface PresentedMouseEvent {
  type: 'mousePressed' | 'mouseReleased' | 'mouseMoved' | 'mouseWheel'
  x: number
  y: number
  button: 'none' | 'left' | 'middle' | 'right'
  /** Buttons held: left 1, right 2, middle 4. */
  buttons: number
  clickCount: number
  modifiers: number
  deltaX?: number
  deltaY?: number
}
export interface PresenterIcon {
  width: number
  height: number
  /** width × height pixels, each a little-endian 0xAARRGGBB. */
  argb: Buffer
}

export interface BrowserPresenterDeps<T> {
  /** The bot's browser windows on the environment display, topmost first: its popups, then its browser. */
  windows(): HitWindow<T>[]
  /** The top left of the browser window on the environment display, where the presented picture starts. */
  origin(): { x: number; y: number }
  /** Sizes the browser window, already within the limits; returns the size it took. */
  resize(size: PresentedSize): PresentedSize
  mouse(target: T, event: PresentedMouseEvent): Promise<void>
  key(target: T, event: PresentedKeyEvent): Promise<void>
  edit(target: T, command: EditCommand): void
  /** The environment's clipboard, through which the browser copies and pastes. */
  readClipboard(): Promise<string>
  writeClipboard(text: string): Promise<void>
  /** Moves a popup so that its frame's top left is at `origin`. */
  movePopup(window: HitWindow<T>, origin: { x: number; y: number }): void
  closePopup(window: HitWindow<T>): void
  /** Makes the bot's pages behave as focused while the presented window is visible, so carets and focus rings show. */
  focusEmulation(enabled: boolean): void
  /** Where keys go until the owner clicks a view: the active page. */
  defaultTarget(): T | null
  title(): string
  icon(): PresenterIcon | null
  loadGeometry(): Promise<PresenterGeometry | null>
  saveGeometry(geometry: PresenterGeometry): Promise<void>
  log(message: string): void
}

const CLICK_INTERVAL_MS = 400
const CLICK_DISTANCE = 4
/** The browser writes a copy to the clipboard asynchronously; it has settled by then. */
const COPY_DELAY_MS = 60
const PASTE_TIMEOUT_MS = 1_000
const SAVE_DELAY_MS = 500
const CLIPBOARD_MAX = 1024 * 1024
const BUTTONS: Record<number, { name: 'left' | 'middle' | 'right'; mask: number }> = {
  1: { name: 'left', mask: 1 },
  2: { name: 'middle', mask: 4 },
  3: { name: 'right', mask: 2 },
}
/** X wheel buttons 4 to 7: up, down, left, right. */
const WHEEL: Record<number, { deltaX: number; deltaY: number }> = {
  4: { deltaX: 0, deltaY: -100 },
  5: { deltaX: 0, deltaY: 100 },
  6: { deltaX: -100, deltaY: 0 },
  7: { deltaX: 100, deltaY: 0 },
}

const integer = (value: string | undefined): number => {
  if (value === undefined || !/^-?\d{1,9}$/.test(value)) throw new DesktopProtocolError(`Not a number: ${value}`)
  return Number(value)
}
/** Letters compare without their case: a key released after Shift reports the other case. */
const keyIdentity = (keysym: number): number => (keysym >= 0x41 && keysym <= 0x5a ? keysym + 0x20 : keysym)

interface Capture<T> {
  target: T
  bounds: Rect
}
interface Drag<T> {
  window: HitWindow<T>
  frame: Rect
  bounds: Rect
  startX: number
  startY: number
}

export class BrowserPresenter<T> {
  private link: PresenterLink | null = null
  private geometry: PresenterGeometry = { ...DEFAULT_PRESENTER_GEOMETRY }
  private loaded = false
  /** Whether the owner or the bot wants the browser window on the desktop; it outlives presenter restarts. */
  private wanted = false
  private visibleNow = false
  private keyTarget: T | null = null
  private capture: Capture<T> | null = null
  private drag: Drag<T> | null = null
  private buttons = 0
  private swallowedButtons = new Set<number>()
  private consumedKeys = new Set<number>()
  private lastClick: { button: number; x: number; y: number; at: number; count: number } | null = null
  private chain: Promise<void> = Promise.resolve()
  /** Clipboard reads waiting for the presenter, oldest first: it answers them in order. */
  private pendingClips: Array<{ resolve: (text: string | null) => void; settled: boolean }> = []
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private connectWaiters = new Set<() => void>()
  private disposed = false

  constructor(private readonly deps: BrowserPresenterDeps<T>) {}

  get connected(): boolean {
    return this.link !== null
  }
  get visible(): boolean {
    return this.visibleNow
  }

  /** Takes over a presenter connection, replacing any earlier one, and sets its window up. */
  async attach(link: PresenterLink): Promise<void> {
    if (this.disposed) {
      link.close()
      return
    }
    this.link?.close()
    this.link = link
    this.resetInput()
    link.onLine((fields) => {
      if (this.link !== link) return
      try {
        this.receive(fields)
      } catch (error) {
        this.deps.log(`Closing the browser presenter after a bad line (${fields[0]}): ${describe(error)}`)
        link.close()
      }
    })
    link.onClose(() => {
      if (this.link !== link) return
      this.link = null
      this.visibleNow = false
      this.resetInput()
      this.dropClips()
    })
    if (!this.loaded) {
      this.loaded = true
      const saved = await this.deps.loadGeometry().catch((error: unknown) => {
        this.deps.log(`Could not read the browser window geometry: ${describe(error)}`)
        return null
      })
      if (saved) this.geometry = { x: Math.round(saved.x), y: Math.round(saved.y), ...clampPresentedSize(saved) }
    }
    if (this.link !== link) return
    const { minWidth, minHeight, maxWidth, maxHeight } = PRESENTED_BROWSER_LIMITS
    this.send(['limits', minWidth, minHeight, maxWidth, maxHeight])
    this.send(['geometry', this.geometry.x, this.geometry.y, this.geometry.width, this.geometry.height])
    this.refreshTitle()
    const icon = this.deps.icon()
    if (icon) this.send(['icon', icon.width, icon.height, icon.argb.toString('base64')])
    this.applySize(this.geometry)
    if (this.wanted) this.send(['show', 0])
    for (const wake of [...this.connectWaiters]) wake()
  }

  /** Waits for a presenter to connect, up to `timeoutMs`; resolves whether one is connected. */
  whenConnected(timeoutMs: number): Promise<boolean> {
    if (this.link) return Promise.resolve(true)
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer)
        this.connectWaiters.delete(done)
        resolve(this.link !== null)
      }
      const timer = setTimeout(done, timeoutMs)
      this.connectWaiters.add(done)
    })
  }

  /**
   * Shows the browser window on the bot's desktop; `activate` also raises it and gives it the keyboard. The wish holds
   * when no presenter is connected yet; the result says whether one was.
   */
  present(options: { activate: boolean }): boolean {
    this.wanted = true
    if (!this.link) return false
    this.send(['show', options.activate ? 1 : 0])
    return true
  }

  /**
   * Sizes the browser window again to the presented one: the bot's conversation, and so its browser window, may only
   * exist after the presenter connected.
   */
  refreshSize(): void {
    if (this.link) this.applySize(this.geometry)
  }

  /** Sends the window title again, after the active tab or its title changed. */
  refreshTitle(): void {
    if (this.link) this.send(['title', encodeText(this.deps.title())])
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = null
    this.dropClips()
    for (const wake of [...this.connectWaiters]) wake()
    this.link?.close()
    this.link = null
  }

  private send(fields: ReadonlyArray<string | number>): void {
    this.link?.send(fields.map(String))
  }

  private resetInput(): void {
    this.capture = null
    this.drag = null
    this.buttons = 0
    this.swallowedButtons.clear()
    this.consumedKeys.clear()
    this.lastClick = null
  }

  private receive(fields: string[]): void {
    const [kind, ...rest] = fields
    switch (kind) {
      case 'key':
        return this.onKey(integer(rest[0]) === 1, integer(rest[1]), integer(rest[2]))
      case 'button':
        return this.onButton(
          integer(rest[0]) === 1,
          integer(rest[1]),
          integer(rest[2]),
          integer(rest[3]),
          integer(rest[4])
        )
      case 'motion':
        return this.onMotion(integer(rest[0]), integer(rest[1]), integer(rest[2]))
      case 'configure':
        return this.onConfigure(integer(rest[0]), integer(rest[1]), integer(rest[2]), integer(rest[3]))
      case 'close':
        this.wanted = false
        this.send(['hide'])
        return
      case 'visible':
        this.visibleNow = integer(rest[0]) === 1
        this.deps.focusEmulation(this.visibleNow)
        return
      case 'focus':
        integer(rest[0])
        return
      case 'clip':
        if (rest[0] === undefined) throw new DesktopProtocolError('A clip line needs its text')
        return this.settleClip(decodeText(rest[0]))
      case 'clip-none':
        return this.settleClip(null)
      default:
        throw new DesktopProtocolError(`Unknown presenter line ${kind}`)
    }
  }

  // ---- Size -------------------------------------------------------------------------------------------------------

  private onConfigure(x: number, y: number, width: number, height: number): void {
    const size = this.applySize({ width, height })
    this.geometry = { x, y, ...size }
    // The window manager may allow a size the browser cannot take: the presented window follows the browser.
    if (size.width !== width || size.height !== height) this.send(['geometry', x, y, size.width, size.height])
    this.scheduleSave()
  }

  private applySize(requested: PresentedSize): PresentedSize {
    const size = this.deps.resize(clampPresentedSize(requested))
    const origin = this.deps.origin()
    this.send(['source', origin.x, origin.y, size.width, size.height])
    return size
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      void this.deps.saveGeometry({ ...this.geometry }).catch((error: unknown) => {
        this.deps.log(`Could not save the browser window geometry: ${describe(error)}`)
      })
    }, SAVE_DELAY_MS)
  }

  // ---- Mouse ------------------------------------------------------------------------------------------------------

  /** A point of the presented window, on the environment display. */
  private source(x: number, y: number): { x: number; y: number } {
    const origin = this.deps.origin()
    return { x: origin.x + x, y: origin.y + y }
  }

  private onButton(pressed: boolean, button: number, x: number, y: number, state: number): void {
    const point = this.source(x, y)
    const modifiers = cdpModifiers(state)
    const wheel = WHEEL[button]
    if (wheel) {
      if (!pressed || this.drag) return
      const hit = hitTest(this.deps.windows(), point.x, point.y)
      if (hit?.kind !== 'content') return
      this.dispatchMouse(hit.target, {
        type: 'mouseWheel',
        x: hit.x,
        y: hit.y,
        button: 'none',
        buttons: this.buttons,
        clickCount: 0,
        modifiers,
        ...wheel,
      })
      return
    }
    const known = BUTTONS[button]
    if (!known) return
    if (!pressed) {
      this.buttons &= ~known.mask
      if (this.swallowedButtons.delete(button)) {
        if (this.buttons === 0) this.drag = null
        return
      }
      const capture = this.capture
      if (capture) {
        this.dispatchMouse(capture.target, {
          type: 'mouseReleased',
          x: point.x - capture.bounds.x,
          y: point.y - capture.bounds.y,
          button: known.name,
          buttons: this.buttons,
          clickCount: this.lastClick?.count ?? 1,
          modifiers,
        })
        if (this.buttons === 0) this.capture = null
      }
      return
    }
    this.buttons |= known.mask
    if (this.drag) {
      this.swallowedButtons.add(button)
      return
    }
    const windows = this.deps.windows()
    const hit = hitTest(windows, point.x, point.y)
    if (!hit || hit.kind === 'frame') {
      this.swallowedButtons.add(button)
      return
    }
    if (hit.kind === 'close') {
      this.swallowedButtons.add(button)
      this.deps.closePopup(hit.window)
      return
    }
    if (hit.kind === 'titlebar') {
      this.swallowedButtons.add(button)
      const browser = windows.find((window) => window.kind === 'browser')
      if (button === 1 && browser)
        this.drag = {
          window: hit.window,
          frame: { ...hit.window.frame },
          bounds: browser.content,
          startX: point.x,
          startY: point.y,
        }
      return
    }
    const now = Date.now()
    const last = this.lastClick
    const count =
      last &&
      last.button === button &&
      now - last.at <= CLICK_INTERVAL_MS &&
      Math.abs(last.x - point.x) <= CLICK_DISTANCE &&
      Math.abs(last.y - point.y) <= CLICK_DISTANCE
        ? Math.min(last.count + 1, 3)
        : 1
    this.lastClick = { button, x: point.x, y: point.y, at: now, count }
    if (!this.capture) {
      const view = hit.window.views.find((candidate) => candidate.target === hit.target)
      this.capture = { target: hit.target, bounds: view?.bounds ?? hit.window.content }
    }
    this.keyTarget = this.capture.target
    this.dispatchMouse(this.capture.target, {
      type: 'mousePressed',
      x: point.x - this.capture.bounds.x,
      y: point.y - this.capture.bounds.y,
      button: known.name,
      buttons: this.buttons,
      clickCount: count,
      modifiers,
    })
  }

  private onMotion(x: number, y: number, state: number): void {
    const point = this.source(x, y)
    const drag = this.drag
    if (drag) {
      const origin = constrainFrame(drag.frame, point.x - drag.startX, point.y - drag.startY, drag.bounds)
      this.deps.movePopup(drag.window, origin)
      return
    }
    const modifiers = cdpModifiers(state)
    if (this.capture) {
      this.dispatchMouse(this.capture.target, {
        type: 'mouseMoved',
        x: point.x - this.capture.bounds.x,
        y: point.y - this.capture.bounds.y,
        button: 'none',
        buttons: this.buttons,
        clickCount: 0,
        modifiers,
      })
      return
    }
    const hit = hitTest(this.deps.windows(), point.x, point.y)
    if (hit?.kind !== 'content') return
    this.dispatchMouse(hit.target, {
      type: 'mouseMoved',
      x: hit.x,
      y: hit.y,
      button: 'none',
      buttons: this.buttons,
      clickCount: 0,
      modifiers,
    })
  }

  private dispatchMouse(target: T, event: PresentedMouseEvent): void {
    this.enqueue(() => this.deps.mouse(target, event))
  }

  // ---- Keyboard ---------------------------------------------------------------------------------------------------

  /** The view keys go to: the last one clicked while it still exists, otherwise the active page. */
  private keyboardTarget(): T | null {
    const current = this.keyTarget
    if (current !== null) {
      const present = this.deps
        .windows()
        .some((window) => window.windowTarget === current || window.views.some((view) => view.target === current))
      if (present) return current
      this.keyTarget = null
    }
    return this.deps.defaultTarget()
  }

  private onKey(pressed: boolean, keysym: number, state: number): void {
    const identity = keyIdentity(keysym)
    if (!pressed && this.consumedKeys.delete(identity)) return
    const command = pressed ? editCommand(keysym, state) : null
    if (command) {
      this.consumedKeys.add(identity)
      this.runEdit(command)
      return
    }
    const event = presentedKeyEvent(pressed, keysym, state)
    if (!event) return
    // The view is the one in effect when the key was typed, even if a later click changes it before this key is sent.
    const target = this.keyboardTarget()
    if (target === null) return
    this.enqueue(() => this.deps.key(target, event))
  }

  private runEdit(command: EditCommand): void {
    const target = this.keyboardTarget()
    if (target === null) return
    if (command === 'paste') {
      // Asked at once, so a quick answer is never missed; the paste itself waits its turn after earlier keys.
      const clip = this.readDesktopClipboard()
      this.enqueue(async () => {
        const text = await clip
        if (text === null) return
        await this.deps.writeClipboard(text)
        this.deps.edit(target, 'paste')
      })
      return
    }
    this.enqueue(async () => {
      this.deps.edit(target, command)
      if (command !== 'copy' && command !== 'cut') return
      await new Promise<void>((resolve) => setTimeout(resolve, COPY_DELAY_MS))
      const text = await this.deps.readClipboard()
      if (text && text.length <= CLIPBOARD_MAX) this.send(['setclip', encodeText(text)])
    })
  }

  /** The bot's desktop clipboard, or null when it is empty, not text, or does not answer within a second. */
  private readDesktopClipboard(): Promise<string | null> {
    if (!this.link) return Promise.resolve(null)
    return new Promise((resolve) => {
      const entry = { resolve, settled: false }
      // A read that times out stays queued, so its late answer is not taken for the next read's.
      const timer = setTimeout(() => {
        entry.settled = true
        resolve(null)
      }, PASTE_TIMEOUT_MS)
      entry.resolve = (text) => {
        clearTimeout(timer)
        resolve(text)
      }
      this.pendingClips.push(entry)
      this.send(['readclip'])
    })
  }

  /** The presenter's answer to the oldest clipboard read. */
  private settleClip(text: string | null): void {
    const entry = this.pendingClips.shift()
    if (entry && !entry.settled) {
      entry.settled = true
      entry.resolve(text)
    }
  }

  private dropClips(): void {
    for (const entry of this.pendingClips.splice(0)) {
      if (entry.settled) continue
      entry.settled = true
      entry.resolve(null)
    }
  }

  /** Input reaches the browser in the order it was typed, each event after the one before it finished. */
  private enqueue(operation: () => Promise<void>): void {
    this.chain = this.chain.then(operation).catch((error: unknown) => {
      this.deps.log(`Presented input failed: ${describe(error)}`)
    })
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
