import { randomUUID } from 'node:crypto'
import type {
  BrowserWindow,
  IpcMain,
  IpcMainInvokeEvent,
  Rectangle,
  WebContents,
  HandlerDetails,
  WindowOpenHandlerResponse,
} from 'electron'
import { chatWindowKey, type ChatWindowRequest, type ChatWindowTarget } from '../shared/chat-window'

const TOKEN_TTL = 15_000
const MAX_PENDING = 64
const MAX_BOUNDS = 128

type Ticket = { request: ChatWindowRequest; key: string; expires: number; consumed: boolean }
type Entry = { window: BrowserWindow; frameName: string; closeRequested: boolean }

export class ChatWindowManager {
  private tickets = new Map<string, Ticket>()
  private windows = new Map<string, Entry>()
  private bounds = new Map<string, Rectangle>()
  private previousThrottling: boolean | undefined
  private disposed = false

  constructor(
    private owner: WebContents,
    private dependencies: {
      targetExists: (target: ChatWindowTarget) => boolean
      workArea: (bounds?: Rectangle) => Rectangle
      focusSource?: () => void
      now?: () => number
    }
  ) {
    owner.setWindowOpenHandler((details) => this.open(details))
    owner.on('did-create-window', (window, details) => this.created(window, details.frameName))
    owner.on('did-start-navigation', (_event, _url, inPlace, isMainFrame) => {
      if (isMainFrame && !inPlace) this.reset()
    })
    owner.on('render-process-gone', () => this.reset())
    owner.once('destroyed', () => this.dispose())
  }

  private assertOwner(event: IpcMainInvokeEvent): void {
    if (
      this.disposed ||
      this.owner.isDestroyed() ||
      event.sender !== this.owner ||
      event.senderFrame !== this.owner.mainFrame
    ) {
      throw new Error('Invalid chat window sender')
    }
  }

  prepare(event: IpcMainInvokeEvent, value: unknown): { key: string; frameName: string } {
    this.assertOwner(event)
    const request = value as ChatWindowRequest | null
    if (
      !request ||
      (request.kind !== 'conversation' && request.kind !== 'bot') ||
      typeof request.id !== 'string' ||
      !request.id.trim() ||
      request.id.length > 256 ||
      /[\u0000-\u001f\u007f]/.test(request.id) ||
      typeof request.title !== 'string' ||
      !request.title.trim() ||
      request.title.length > 512 ||
      /[\u0000-\u001f\u007f]/.test(request.title) ||
      !this.dependencies.targetExists(request)
    )
      throw new Error('Invalid chat window target')
    const key = chatWindowKey(request)
    const existing = this.windows.get(key)
    if (existing) {
      this.focus(event, key)
      return { key, frameName: existing.frameName }
    }
    this.prune()
    for (const [frameName, ticket] of this.tickets) {
      if (ticket.key === key) return { key, frameName }
    }
    if (this.tickets.size >= MAX_PENDING) throw new Error('Too many pending chat windows')
    const frameName = `maestrly-chat-${randomUUID()}`
    this.tickets.set(frameName, { request: { ...request }, key, expires: this.now() + TOKEN_TTL, consumed: false })
    return { key, frameName }
  }

  close(event: IpcMainInvokeEvent, key: unknown): void {
    this.assertOwner(event)
    this.assertKey(key)
    for (const [name, ticket] of this.tickets) if (ticket.key === key) this.tickets.delete(name)
    const child = this.windows.get(key)?.window
    if (child && !child.isDestroyed()) {
      child.destroy()
      this.dependencies.focusSource?.()
    }
  }

  focus(event: IpcMainInvokeEvent, key: unknown): void {
    this.assertOwner(event)
    this.assertKey(key)
    const window = this.windows.get(key)?.window
    if (!window || window.isDestroyed()) return
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  }

  showSource(event: IpcMainInvokeEvent, key: unknown): void {
    this.assertOwner(event)
    this.assertKey(key)
    if (this.windows.has(key)) this.dependencies.focusSource?.()
  }

  private assertKey(key: unknown): asserts key is string {
    if (typeof key !== 'string' || key.length > 269 || !/^(conversation|bot):[^\u0000-\u001f\u007f]+$/.test(key)) {
      throw new Error('Invalid chat window key')
    }
  }

  private now(): number {
    return this.dependencies.now?.() ?? Date.now()
  }

  private prune(): void {
    for (const [name, ticket] of this.tickets) if (ticket.expires <= this.now()) this.tickets.delete(name)
  }

  private open(details: HandlerDetails): WindowOpenHandlerResponse {
    this.prune()
    const ticket = this.tickets.get(details.frameName)
    if (this.disposed || details.url !== 'about:blank' || !ticket || ticket.consumed || this.windows.has(ticket.key)) {
      return { action: 'deny' }
    }
    ticket.consumed = true
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        ...this.windowBounds(ticket.key),
        title: ticket.request.title,
        backgroundColor: '#0A0A0B',
        show: true,
        minWidth: 420,
        minHeight: 380,
        frame: true,
        resizable: true,
        movable: true,
        minimizable: true,
        maximizable: true,
        fullscreenable: true,
        alwaysOnTop: false,
        modal: false,
        webPreferences: { preload: '', nodeIntegration: false, contextIsolation: true, webSecurity: true },
      },
    }
  }

  private windowBounds(key: string): Rectangle {
    const saved = this.bounds.get(key)
    const area = this.dependencies.workArea(saved)
    const width = Math.min(saved?.width ?? 780, area.width)
    const height = Math.min(saved?.height ?? 820, area.height)
    return {
      width,
      height,
      x: Math.max(
        area.x,
        Math.min(saved?.x ?? area.x + Math.round((area.width - width) / 2), area.x + area.width - width)
      ),
      y: Math.max(
        area.y,
        Math.min(saved?.y ?? area.y + Math.round((area.height - height) / 2), area.y + area.height - height)
      ),
    }
  }

  private created(window: BrowserWindow, frameName: string): void {
    const ticket = this.tickets.get(frameName)
    this.tickets.delete(frameName)
    if (this.disposed || !ticket?.consumed || this.windows.has(ticket.key)) {
      window.destroy()
      return
    }
    const { key } = ticket
    const entry: Entry = { window, frameName, closeRequested: false }
    this.windows.set(key, entry)
    if (this.previousThrottling === undefined) {
      this.previousThrottling = this.owner.getBackgroundThrottling()
      this.owner.setBackgroundThrottling(false)
    }
    const rememberBounds = () => {
      if (window.isDestroyed() || window.isMinimized() || window.isMaximized() || window.isFullScreen()) return
      this.bounds.delete(key)
      this.bounds.set(key, window.getBounds())
      if (this.bounds.size > MAX_BOUNDS) this.bounds.delete(this.bounds.keys().next().value!)
    }
    window.on('move', rememberBounds)
    window.on('resize', rememberBounds)
    // The owner renderer retains the React tree and every privileged API call.
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('render-process-gone', () => {
      if (!window.isDestroyed()) window.destroy()
    })
    window.webContents.on('will-navigate', (event) => event.preventDefault())
    window.webContents.on('will-frame-navigate', (event) => event.preventDefault())
    window.webContents.on('will-redirect', (event) => event.preventDefault())
    window.webContents.on('will-attach-webview', (event) => event.preventDefault())
    window.on('close', (event) => {
      event.preventDefault()
      rememberBounds()
      if (!entry.closeRequested) {
        entry.closeRequested = true
        this.send('chat-window:close-requested', key)
      }
    })
    window.on('closed', () => {
      this.windows.delete(key)
      this.send('chat-window:closed', key)
      this.restoreThrottling()
    })
  }

  private send(channel: string, key: string): void {
    if (this.owner.isDestroyed()) return
    try {
      this.owner.send(channel, key)
    } catch {
      // A renderer may disappear between the destruction check and the close notification.
    }
  }

  private restoreThrottling(): void {
    if (this.windows.size || this.previousThrottling === undefined) return
    if (!this.owner.isDestroyed()) this.owner.setBackgroundThrottling(this.previousThrottling)
    this.previousThrottling = undefined
  }

  // Reload and shutdown cannot wait for a renderer DOM-adoption acknowledgement.
  private reset(): void {
    this.tickets.clear()
    for (const { window } of [...this.windows.values()]) if (!window.isDestroyed()) window.destroy()
    this.windows.clear()
    this.restoreThrottling()
  }

  dispose(): void {
    this.disposed = true
    this.reset()
  }
}

export function registerChatWindowIpc(ipcMain: IpcMain, manager: () => ChatWindowManager | null): void {
  const current = () => {
    const result = manager()
    if (!result) throw new Error('Chat windows unavailable')
    return result
  }
  ipcMain.handle('chat-window:prepare', (event, request: unknown) => current().prepare(event, request))
  ipcMain.handle('chat-window:close', (event, key: unknown) => current().close(event, key))
  ipcMain.handle('chat-window:focus', (event, key: unknown) => current().focus(event, key))
  ipcMain.handle('chat-window:show-source', (event, key: unknown) => current().showSource(event, key))
}
