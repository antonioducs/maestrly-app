import type { BrowserWindowConstructorOptions, Rectangle, WebContents } from 'electron'
import type { AssistantSettings } from '../../shared/assistant'
import type { PanelTargetMetadata } from '../window-ipc'

/** The part of a BrowserWindow the assistant uses; tests pass a fake. */
export interface AssistantBrowserWindow {
  readonly webContents: WebContents
  isDestroyed(): boolean
  isVisible(): boolean
  isFocused(): boolean
  show(): void
  hide(): void
  focus(): void
  destroy(): void
  getBounds(): Rectangle
  setBounds(bounds: Rectangle): void
  setVisibleOnAllWorkspaces(visible: boolean, options?: { visibleOnFullScreen?: boolean }): void
  on(event: 'blur' | 'closed' | 'moved' | 'resized', listener: () => void): unknown
  on(event: 'close', listener: (event: { preventDefault(): void }) => void): unknown
}

export interface AssistantWindowDeps {
  create(options: BrowserWindowConstructorOptions): AssistantBrowserWindow
  load(win: AssistantBrowserWindow): Promise<void>
  settings(): AssistantSettings
  /** The assistant conversation, created on first use. */
  conversationId(): Promise<string>
  registerTarget(wc: WebContents, metadata: PanelTargetMetadata): void
  /** Work area of the display under the cursor. */
  cursorWorkArea(): Rectangle
  savedBounds(): Rectangle | null
  saveBounds(bounds: Rectangle): void
  platform: NodeJS.Platform
  preload: string
}

export const ASSISTANT_WINDOW_SIZE = { width: 480, height: 640 } as const

function fits(bounds: Rectangle, area: Rectangle): boolean {
  return (
    bounds.width >= 320 &&
    bounds.height >= 320 &&
    bounds.x >= area.x &&
    bounds.y >= area.y &&
    bounds.x + bounds.width <= area.x + area.width &&
    bounds.y + bounds.height <= area.y + area.height
  )
}

/** Saved bounds when they still fit the display under the cursor; otherwise the default size, centered on it. */
export function assistantBounds(area: Rectangle, saved: Rectangle | null): Rectangle {
  if (saved && fits(saved, area)) return saved
  const width = Math.min(ASSISTANT_WINDOW_SIZE.width, area.width)
  const height = Math.min(ASSISTANT_WINDOW_SIZE.height, area.height)
  return {
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + (area.height - height) / 2),
    width,
    height,
  }
}

/** Floating window that shows the assistant conversation from anywhere on the computer. */
export class AssistantWindow {
  private win: AssistantBrowserWindow | null = null
  private loading: Promise<AssistantBrowserWindow> | null = null
  private conversation: string | null = null
  private disposed = false
  /** Reasons the window stays up when it loses focus: a pending question, a recording. */
  private readonly holds = new Set<string>()
  private persistTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly deps: AssistantWindowDeps) {}

  private async window(): Promise<AssistantBrowserWindow> {
    if (this.win && !this.win.isDestroyed()) return this.win
    this.loading ??= this.createWindow().finally(() => {
      this.loading = null
    })
    return this.loading
  }

  private async createWindow(): Promise<AssistantBrowserWindow> {
    const area = this.deps.cursorWorkArea()
    const bounds = assistantBounds(area, this.deps.savedBounds())
    const win = this.deps.create({
      ...bounds,
      minWidth: 360,
      minHeight: 420,
      show: false,
      frame: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      fullscreenable: false,
      backgroundColor: '#0A0A0B',
      title: 'Maestrly',
      webPreferences: {
        preload: this.deps.preload,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    })
    if (this.deps.platform === 'darwin') {
      try {
        win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
      } catch {
        /* best effort: platform-specific */
      }
    }
    win.on('blur', () => {
      if (this.deps.settings().hideOnBlur && this.holds.size === 0) this.hide()
    })
    // Closing only hides: the window keeps its conversation loaded for the next shortcut.
    win.on('close', (event) => {
      if (this.disposed) return
      event.preventDefault()
      this.hide()
    })
    win.on('closed', () => {
      if (this.win === win) this.win = null
    })
    const persist = () => {
      if (this.persistTimer) clearTimeout(this.persistTimer)
      this.persistTimer = setTimeout(() => {
        this.persistTimer = null
        if (!win.isDestroyed()) this.deps.saveBounds(win.getBounds())
      }, 400)
    }
    win.on('moved', persist)
    win.on('resized', persist)
    this.win = win
    await this.retarget()
    await this.deps.load(win)
    return win
  }

  /** Register the window for the current assistant conversation's streams; again after a new session. */
  async retarget(): Promise<string> {
    const conversationId = await this.deps.conversationId()
    this.conversation = conversationId
    const win = this.win
    if (win && !win.isDestroyed())
      this.deps.registerTarget(win.webContents, { global: true, convId: conversationId, panel: 'assistant' })
    return conversationId
  }

  conversationId(): string | null {
    return this.conversation
  }

  webContents(): WebContents | null {
    const win = this.win
    return win && !win.isDestroyed() ? win.webContents : null
  }

  async show(opts: { listen?: boolean } = {}): Promise<void> {
    if (this.disposed) return
    const existed = !!this.win && !this.win.isDestroyed()
    const win = await this.window()
    if (win.isDestroyed()) return
    if (existed && !win.isVisible()) win.setBounds(assistantBounds(this.deps.cursorWorkArea(), win.getBounds()))
    win.show()
    win.focus()
    this.send('assistant:shown', { listen: opts.listen === true })
  }

  hide(): void {
    const win = this.win
    if (win && !win.isDestroyed() && win.isVisible()) win.hide()
  }

  /**
   * Shown and focused hides; anything else shows (a window left behind others comes back to the front). While the
   * voice listens or reads, it is a tap on the voice instead: it stops listening, or stops reading.
   */
  async toggle(opts: { listen?: boolean } = {}): Promise<void> {
    const win = this.win
    if (win && !win.isDestroyed() && win.isVisible() && (this.holds.has('listening') || this.holds.has('speaking'))) {
      await this.show({ listen: true })
      return
    }
    if (win && !win.isDestroyed() && win.isVisible() && win.isFocused()) {
      this.hide()
      return
    }
    await this.show(opts)
  }

  isVisible(): boolean {
    const win = this.win
    return !!win && !win.isDestroyed() && win.isVisible()
  }

  /** Keep the window up while it loses focus, for a reason the renderer reports (a question, a recording). */
  setHold(reason: string, held: boolean): void {
    if (held) this.holds.add(reason)
    else this.holds.delete(reason)
  }

  send(channel: string, payload?: unknown): void {
    const wc = this.webContents()
    if (!wc || wc.isDestroyed()) return
    try {
      wc.send(channel, payload)
    } catch {
      /* destroyed between the check and the send */
    }
  }

  dispose(): void {
    this.disposed = true
    if (this.persistTimer) clearTimeout(this.persistTimer)
    const win = this.win
    this.win = null
    if (win && !win.isDestroyed()) {
      try {
        this.deps.saveBounds(win.getBounds())
      } catch {
        /* best effort */
      }
      win.destroy()
    }
  }
}
