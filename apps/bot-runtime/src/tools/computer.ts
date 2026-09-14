import type { BrowserSession } from './browser.js'
import { runtimeError } from '../turns/service.js'
import { x11Command, x11Key } from '../desktop/input.js'
// Input belongs to this runtime's X server, never a shared controller desktop.
export class Computer {
  constructor(private browser: BrowserSession) {}
  async click(x: number, y: number, button: 'left' | 'right' | 'middle' = 'left', signal?: AbortSignal) {
    const desktop = this.browser.desktop
    if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y) || x < 0 || x >= desktop.width || y < 0 || y >= desktop.height)
      throw runtimeError('INVALID_COORDINATES', 'Coordinates must be inside this desktop')
    await desktop.ensure()
    // --sync waits for a motion event and can hang when the pointer is already here.
    // X11 processes this move and click in order on the same connection.
    await x11Command('input', ['mousemove', String(x), String(y), 'click', String({ left: 1, middle: 2, right: 3 }[button])], desktop.environment(), signal)
  }
  async type(text: string, signal?: AbortSignal) {
    if (text.includes('\0') || Buffer.byteLength(text) > 32 * 1024) throw runtimeError('INVALID_TEXT', 'Text exceeds desktop input limits')
    await this.browser.desktop.ensure()
    await x11Command('input', ['type', '--clearmodifiers', '--delay', '0', '--', text], this.browser.desktop.environment(), signal)
  }
  async key(key: string, signal?: AbortSignal) {
    await this.browser.desktop.ensure()
    await x11Command('input', ['key', '--clearmodifiers', x11Key(key)], this.browser.desktop.environment(), signal)
  }
}
