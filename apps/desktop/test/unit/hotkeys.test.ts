import { describe, expect, it, vi } from 'vitest'
import {
  attachHotkeyCapture,
  setActiveDrawerShortcut,
  setActiveShortcuts,
  setHotkeyHandler,
} from '../../src/main/hotkeys'
import { defaultDrawerShortcut, defaultShortcuts } from '../../src/shared/shortcuts'

function capture() {
  let listener: ((event: { preventDefault(): void }, input: Record<string, unknown>) => void) | null = null
  const wc = {
    on: vi.fn((event: string, next: typeof listener) => {
      if (event === 'before-input-event') listener = next
    }),
  }
  attachHotkeyCapture(wc as never)
  return (accepted: boolean) => {
    const preventDefault = vi.fn()
    listener?.(
      { preventDefault },
      {
        type: 'keyDown',
        key: 'g',
        code: 'KeyG',
        meta: true,
        control: true,
        alt: false,
        shift: false,
        isAutoRepeat: false,
      }
    )
    expect(preventDefault).toHaveBeenCalledTimes(accepted ? 1 : 0)
  }
}

describe('captura central dos atalhos', () => {
  it('consumes the combination only when the tool gate accepts the action', () => {
    setActiveShortcuts(defaultShortcuts('mac'))
    const accepted = vi.fn(() => false)
    setHotkeyHandler({
      visibleConvId: () => 'conv-1',
      isSuppressed: () => false,
      openPopup: accepted,
      openFloating: vi.fn(() => false),
      closeTop: vi.fn(() => false),
      toggleDrawer: vi.fn(() => false),
    })
    const press = capture()

    press(false)
    accepted.mockReturnValue(true)
    press(true)
  })

  it('toggles the drawer and consumes the shortcut when a conversation is visible', () => {
    setActiveDrawerShortcut(defaultDrawerShortcut('mac'))
    const toggleDrawer = vi.fn(() => true)
    setHotkeyHandler({
      visibleConvId: () => 'conv-1',
      isSuppressed: () => false,
      openPopup: vi.fn(() => false),
      openFloating: vi.fn(() => false),
      closeTop: vi.fn(() => false),
      toggleDrawer,
    })
    let listener: (event: { preventDefault(): void }, input: Record<string, unknown>) => void = () => undefined
    attachHotkeyCapture({ on: (_event: string, cb: typeof listener) => (listener = cb) } as never)
    const preventDefault = vi.fn()
    listener(
      { preventDefault },
      {
        type: 'keyDown',
        key: 'd',
        code: 'KeyD',
        meta: true,
        control: true,
        alt: false,
        shift: false,
        isAutoRepeat: false,
      }
    )
    expect(toggleDrawer).toHaveBeenCalledWith('conv-1')
    expect(preventDefault).toHaveBeenCalledOnce()
  })
})
