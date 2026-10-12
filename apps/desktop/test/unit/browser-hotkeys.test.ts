import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  attachBrowserHotkeyCapture,
  attachMainWindowBrowserHotkeys,
  browserShortcutAction,
  hasBrowserKeyboardFocus,
  setBrowserKeyboardFocus,
  setBrowserShortcutHandlers,
} from '../../src/main/browser-hotkeys'

interface Input {
  type: string
  key?: string
  code?: string
  meta?: boolean
  control?: boolean
  alt?: boolean
  shift?: boolean
  isAutoRepeat?: boolean
}

const primary = process.platform === 'darwin' ? { meta: true } : { control: true }

function fakeWebContents(id = 1) {
  const emitter = new EventEmitter()
  return Object.assign(emitter, { id, send: vi.fn(), isDestroyed: vi.fn(() => false) })
}

function press(wc: EventEmitter, input: Input) {
  const event = { preventDefault: vi.fn() }
  wc.emit('before-input-event', event, input)
  return event
}

afterEach(() => {
  setBrowserShortcutHandlers(null)
})

describe('browserShortcutAction', () => {
  it('matches Cmd+T/W on macOS and Ctrl+T/W on Windows and Linux', () => {
    expect(browserShortcutAction({ code: 'KeyT', meta: true }, 'darwin')).toBe('new-tab')
    expect(browserShortcutAction({ code: 'KeyW', meta: true }, 'darwin')).toBe('close-tab')
    expect(browserShortcutAction({ code: 'KeyT', control: true }, 'win32')).toBe('new-tab')
    expect(browserShortcutAction({ code: 'KeyW', control: true }, 'linux')).toBe('close-tab')
  })

  it('ignores the other primary modifier, extra modifiers, and other keys', () => {
    expect(browserShortcutAction({ code: 'KeyT', control: true }, 'darwin')).toBeNull()
    expect(browserShortcutAction({ code: 'KeyW', meta: true }, 'win32')).toBeNull()
    expect(browserShortcutAction({ code: 'KeyT', meta: true, shift: true }, 'darwin')).toBeNull()
    expect(browserShortcutAction({ code: 'KeyW', control: true, alt: true }, 'linux')).toBeNull()
    expect(browserShortcutAction({ code: 'KeyN', meta: true }, 'darwin')).toBeNull()
  })
})

describe('attachBrowserHotkeyCapture', () => {
  it('runs the handler for the resolved conversation and keeps Cmd+W from closing the window', () => {
    const handlers = { newTab: vi.fn(), closeTab: vi.fn() }
    setBrowserShortcutHandlers(handlers)
    const wc = fakeWebContents()
    attachBrowserHotkeyCapture(wc as never, () => 'conv-1')

    const newTab = press(wc, { type: 'keyDown', code: 'KeyT', ...primary })
    const closeTab = press(wc, { type: 'keyDown', code: 'KeyW', ...primary })

    expect(newTab.preventDefault).toHaveBeenCalledOnce()
    expect(closeTab.preventDefault).toHaveBeenCalledOnce()
    expect(handlers.newTab).toHaveBeenCalledWith('conv-1')
    expect(handlers.closeTab).toHaveBeenCalledWith('conv-1')
  })

  it('consumes key repeat without acting again', () => {
    const handlers = { newTab: vi.fn(), closeTab: vi.fn() }
    setBrowserShortcutHandlers(handlers)
    const wc = fakeWebContents()
    attachBrowserHotkeyCapture(wc as never, () => 'conv-1')

    const repeated = press(wc, { type: 'keyDown', code: 'KeyW', ...primary, isAutoRepeat: true })

    expect(repeated.preventDefault).toHaveBeenCalledOnce()
    expect(handlers.closeTab).not.toHaveBeenCalled()
  })

  it('lets keys through without a conversation, on key up, and for other combinations', () => {
    const handlers = { newTab: vi.fn(), closeTab: vi.fn() }
    setBrowserShortcutHandlers(handlers)
    const wc = fakeWebContents()
    let convId: string | null = null
    attachBrowserHotkeyCapture(wc as never, () => convId)

    expect(press(wc, { type: 'keyDown', code: 'KeyW', ...primary }).preventDefault).not.toHaveBeenCalled()
    convId = 'conv-1'
    expect(press(wc, { type: 'keyUp', code: 'KeyW', ...primary }).preventDefault).not.toHaveBeenCalled()
    expect(press(wc, { type: 'keyDown', code: 'KeyW' }).preventDefault).not.toHaveBeenCalled()
    expect(handlers.closeTab).not.toHaveBeenCalled()
  })
})

describe('attachMainWindowBrowserHotkeys', () => {
  it('keeps the shortcuts from the menu only while the keyboard is in a browser, and hands them back', () => {
    const handlers = { newTab: vi.fn(), closeTab: vi.fn() }
    setBrowserShortcutHandlers(handlers)
    const wc = fakeWebContents(77)
    attachMainWindowBrowserHotkeys(wc as never)

    expect(press(wc, { type: 'keyDown', code: 'KeyW', ...primary }).preventDefault).not.toHaveBeenCalled()

    setBrowserKeyboardFocus(wc, true)
    expect(press(wc, { type: 'keyDown', code: 'KeyT', ...primary }).preventDefault).toHaveBeenCalledOnce()
    expect(press(wc, { type: 'keyDown', code: 'KeyW', ...primary }).preventDefault).toHaveBeenCalledOnce()
    expect(
      press(wc, { type: 'keyDown', code: 'KeyW', ...primary, isAutoRepeat: true }).preventDefault
    ).toHaveBeenCalledOnce()
    expect(press(wc, { type: 'keyDown', code: 'KeyN', ...primary }).preventDefault).not.toHaveBeenCalled()
    // The browser may run on another host: the renderer acts through that host's API, never main's handlers.
    expect(wc.send.mock.calls).toEqual([
      ['drawer:browser-shortcut', 'new-tab'],
      ['drawer:browser-shortcut', 'close-tab'],
    ])
    expect(handlers.newTab).not.toHaveBeenCalled()
    expect(handlers.closeTab).not.toHaveBeenCalled()

    setBrowserKeyboardFocus(wc, false)
    expect(press(wc, { type: 'keyDown', code: 'KeyW', ...primary }).preventDefault).not.toHaveBeenCalled()
    expect(wc.send).toHaveBeenCalledTimes(2)
  })

  it('forgets focus when the renderer reloads or is destroyed', () => {
    const wc = fakeWebContents(78)
    attachMainWindowBrowserHotkeys(wc as never)
    setBrowserKeyboardFocus(wc, true)
    wc.emit('did-navigate')
    expect(hasBrowserKeyboardFocus(78)).toBe(false)

    setBrowserKeyboardFocus(wc, true)
    wc.emit('destroyed')
    expect(hasBrowserKeyboardFocus(78)).toBe(false)
  })
})
