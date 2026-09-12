import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/main/store', () => ({
  getConversation: vi.fn(),
}))

vi.mock('../../src/main/terminal-manager', () => ({
  closeShellTerminal: vi.fn(),
  createShellTerminal: vi.fn(),
  getTerminalState: vi.fn(),
}))

import { getConversation } from '../../src/main/store'
import {
  closeShellTerminal,
  createShellTerminal,
  getTerminalState,
} from '../../src/main/terminal-manager'
import {
  attachTerminalHotkeyCapture,
  terminalShortcutAction,
} from '../../src/main/terminal-hotkeys'

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

const primaryModifier = process.platform === 'darwin' ? { meta: true } : { control: true }

function capture() {
  let listener: ((event: { preventDefault(): void }, input: Input) => void) | undefined
  const wc = {
    on: vi.fn((_channel: string, cb: typeof listener) => {
      listener = cb
    }),
  }
  attachTerminalHotkeyCapture(wc as never, 'conv-1')
  return (input: Input) => {
    const event = { preventDefault: vi.fn() }
    listener!(event, input)
    return event
  }
}

describe('terminalShortcutAction', () => {
  it('matches Cmd+T/W on macOS and Ctrl+T/W on Windows/Linux', () => {
    expect(terminalShortcutAction({ code: 'KeyT', meta: true }, 'darwin')).toBe('create')
    expect(terminalShortcutAction({ code: 'KeyW', meta: true }, 'darwin')).toBe('close')
    expect(terminalShortcutAction({ code: 'KeyT', control: true }, 'win32')).toBe('create')
    expect(terminalShortcutAction({ code: 'KeyW', control: true }, 'linux')).toBe('close')
  })

  it('ignores the wrong primary modifier and extra modifiers', () => {
    expect(terminalShortcutAction({ code: 'KeyW', control: true }, 'darwin')).toBeNull()
    expect(terminalShortcutAction({ code: 'KeyW', meta: true }, 'linux')).toBeNull()
    expect(terminalShortcutAction({ code: 'KeyT', meta: true, shift: true }, 'darwin')).toBeNull()
    expect(terminalShortcutAction({ code: 'KeyW', control: true, alt: true }, 'win32')).toBeNull()
  })
})

describe('attachTerminalHotkeyCapture', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getConversation).mockReturnValue({ id: 'conv-1', cwd: '/repo' } as never)
    vi.mocked(getTerminalState).mockReturnValue({
      terminals: [{ id: 'term:conv-1:1', cwd: '/repo' }],
      activeId: 'term:conv-1:1',
    })
  })

  it('creates and selects a terminal through the canonical manager flow', () => {
    const fire = capture()
    const event = fire({ type: 'keyDown', code: 'KeyT', ...primaryModifier })

    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(createShellTerminal).toHaveBeenCalledWith('conv-1', '/repo')
  })

  it('closes only the active tab and prevents the window from closing', () => {
    const fire = capture()
    const event = fire({ type: 'keyDown', code: 'KeyW', ...primaryModifier })

    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(closeShellTerminal).toHaveBeenCalledWith('conv-1', 'term:conv-1:1')
  })

  it('consumes Cmd/Ctrl+W when empty without trying to close a missing terminal', () => {
    vi.mocked(getTerminalState).mockReturnValue({ terminals: [], activeId: null })
    const fire = capture()
    const event = fire({ type: 'keyDown', code: 'KeyW', ...primaryModifier })

    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(closeShellTerminal).not.toHaveBeenCalled()
  })

  it('does not intercept unrelated keys or auto-repeat', () => {
    const fire = capture()
    const other = fire({ type: 'keyDown', code: 'KeyW' })
    const repeated = fire({ type: 'keyDown', code: 'KeyT', ...primaryModifier, isAutoRepeat: true })

    expect(other.preventDefault).not.toHaveBeenCalled()
    expect(repeated.preventDefault).not.toHaveBeenCalled()
    expect(createShellTerminal).not.toHaveBeenCalled()
    expect(closeShellTerminal).not.toHaveBeenCalled()
  })
})
