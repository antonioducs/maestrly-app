import type { WebContents } from 'electron'
import { eventKey, type KeyEventLike } from '../shared/shortcuts'

/**
 * Fixed Cmd+T/Cmd+W (Ctrl+T/Ctrl+W elsewhere) for the drawer browser. Each browser page and the floating chrome
 * capture them on their own WebContents and act through the injected handlers (index.ts), like the other hotkey
 * modules; the main window captures them only while its renderer reports the keyboard in a browser.
 */

export type BrowserShortcutAction = 'new-tab' | 'close-tab'

export interface BrowserShortcutHandlers {
  newTab(convId: string): void
  closeTab(convId: string): void
}

let handlers: BrowserShortcutHandlers | null = null

export function setBrowserShortcutHandlers(next: BrowserShortcutHandlers | null): void {
  handlers = next
}

/** Command on macOS, Control elsewhere, with no extra modifiers. */
export function browserShortcutAction(input: KeyEventLike, platform: string): BrowserShortcutAction | null {
  const primary = platform === 'darwin' ? !!input.meta && !input.control : !!input.control && !input.meta
  if (!primary || input.alt || input.shift) return null
  const key = eventKey(input)
  if (key === 't') return 'new-tab'
  if (key === 'w') return 'close-tab'
  return null
}

/** Captures the shortcuts on `wc` for the conversation `resolveConvId` returns; null lets the keys through. */
export function attachBrowserHotkeyCapture(wc: WebContents, resolveConvId: () => string | null): void {
  wc.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    const action = browserShortcutAction(input, process.platform)
    if (!action) return
    const convId = resolveConvId()
    if (!convId) return
    // Command/Control+W would otherwise reach the menu's Close Window, key repeat included.
    event.preventDefault()
    if (input.isAutoRepeat || !handlers) return
    if (action === 'new-tab') handlers.newTab(convId)
    else handlers.closeTab(convId)
  })
}

// Renderers whose keyboard is in a browser chrome or a streamed page, by WebContents id.
const keyboardInBrowser = new Set<number>()

/** A renderer reports the keyboard entering or leaving its browser chrome or streamed page. */
export function setBrowserKeyboardFocus(sender: Pick<WebContents, 'id'>, focused: boolean): void {
  if (focused) keyboardInBrowser.add(sender.id)
  else keyboardInBrowser.delete(sender.id)
}

export function hasBrowserKeyboardFocus(webContentsId: number): boolean {
  return keyboardInBrowser.has(webContentsId)
}

/**
 * Main-window capture, active only while that renderer reports the keyboard in a browser. The browser there may run on
 * another host, so the renderer performs the action through that host's API: main only keeps the keys from the menu
 * (Cmd+W would close the window) and hands them back.
 */
export function attachMainWindowBrowserHotkeys(wc: WebContents): void {
  const id = wc.id
  const forget = () => keyboardInBrowser.delete(id)
  wc.once('destroyed', forget)
  // A reloaded renderer cannot still hold focus in the old chrome.
  wc.on('did-navigate', forget)
  wc.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || !keyboardInBrowser.has(id)) return
    const action = browserShortcutAction(input, process.platform)
    if (!action) return
    event.preventDefault()
    if (input.isAutoRepeat || wc.isDestroyed()) return
    wc.send('drawer:browser-shortcut', action)
  })
}
