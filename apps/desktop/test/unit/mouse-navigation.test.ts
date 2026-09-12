import { describe, expect, it, vi } from 'vitest'
import { attachMacMouseNavigation, attachWindowNavigation } from '../../src/main/mouse-navigation'

describe('mouse-navigation', () => {
  it('maps browser-backward/forward and cancels only when a view handled the command', () => {
    const listeners = new Map<string, (...args: never[]) => void>()
    const window = {
      on: vi.fn((event: string, handler: (...args: never[]) => void) => listeners.set(event, handler)),
    }
    const navigateFocused = vi.fn((direction: 'back' | 'forward') => direction === 'back')
    attachWindowNavigation(window as never, navigateFocused, 'win32')
    const handler = listeners.get('app-command') as
      | ((event: { preventDefault: () => void }, command: string) => void)
      | undefined

    const backEvent = { preventDefault: vi.fn() }
    handler?.(backEvent, 'browser-backward')
    expect(navigateFocused).toHaveBeenCalledWith('back')
    expect(backEvent.preventDefault).toHaveBeenCalledOnce()

    const forwardEvent = { preventDefault: vi.fn() }
    handler?.(forwardEvent, 'browser-forward')
    expect(navigateFocused).toHaveBeenCalledWith('forward')
    expect(forwardEvent.preventDefault).not.toHaveBeenCalled()

    handler?.({ preventDefault: vi.fn() }, 'unknown')
    expect(navigateFocused).toHaveBeenCalledTimes(2)
  })

  it('maps macOS page gestures and cancels only when a view handled the swipe', () => {
    const listeners = new Map<string, (...args: never[]) => void>()
    const window = {
      on: vi.fn((event: string, handler: (...args: never[]) => void) => listeners.set(event, handler)),
    }
    const navigateFocused = vi.fn((direction: 'back' | 'forward') => direction === 'back')
    attachWindowNavigation(window as never, navigateFocused, 'darwin')
    const handler = listeners.get('swipe') as
      | ((event: { preventDefault: () => void }, direction: string) => void)
      | undefined

    const leftEvent = { preventDefault: vi.fn() }
    handler?.(leftEvent, 'left')
    expect(navigateFocused).toHaveBeenCalledWith('back')
    expect(leftEvent.preventDefault).toHaveBeenCalledOnce()

    const rightEvent = { preventDefault: vi.fn() }
    handler?.(rightEvent, 'right')
    expect(navigateFocused).toHaveBeenCalledWith('forward')
    expect(rightEvent.preventDefault).not.toHaveBeenCalled()

    handler?.({ preventDefault: vi.fn() }, 'up')
    expect(navigateFocused).toHaveBeenCalledTimes(2)
  })

  it('captures native macOS back/forward, cancels both events, and navigates once on mouseDown', () => {
    const listeners = new Map<string, (...args: unknown[]) => void>()
    const webContents = {
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => listeners.set(event, handler)),
    }
    const navigate = vi.fn()

    attachMacMouseNavigation(webContents as never, navigate, 'darwin')
    const handler = listeners.get('before-mouse-event')
    const backDown = { preventDefault: vi.fn() }
    const backUp = { preventDefault: vi.fn() }
    const forwardDown = { preventDefault: vi.fn() }
    const leftDown = { preventDefault: vi.fn() }
    handler?.(backDown, { button: 'back', type: 'mouseDown' })
    handler?.(backUp, { button: 'back', type: 'mouseUp' })
    handler?.(forwardDown, { button: 'forward', type: 'mouseDown' })
    handler?.(leftDown, { button: 'left', type: 'mouseDown' })

    expect(navigate.mock.calls).toEqual([['back'], ['forward']])
    expect(backDown.preventDefault).toHaveBeenCalledOnce()
    expect(backUp.preventDefault).toHaveBeenCalledOnce()
    expect(forwardDown.preventDefault).toHaveBeenCalledOnce()
    expect(leftDown.preventDefault).not.toHaveBeenCalled()
  })

  it('does not install a native mouse listener outside macOS', () => {
    const webContents = { on: vi.fn() }

    attachMacMouseNavigation(webContents as never, vi.fn(), 'win32')

    expect(webContents.on).not.toHaveBeenCalled()
  })
})
