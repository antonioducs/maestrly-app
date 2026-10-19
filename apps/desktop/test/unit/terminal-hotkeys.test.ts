import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/main/standalone-conversation-service', () => ({
  validateStandaloneConversationDirectory: vi.fn(),
}))

vi.mock('../../src/main/store', () => ({
  getConversation: vi.fn(),
}))

vi.mock('../../src/main/terminal-manager', () => ({
  closeShellTerminal: vi.fn(),
  createShellTerminal: vi.fn(),
  getTerminalState: vi.fn(),
}))

import { validateStandaloneConversationDirectory } from '../../src/main/standalone-conversation-service'
import { getConversation } from '../../src/main/store'
import { closeShellTerminal, createShellTerminal, getTerminalState } from '../../src/main/terminal-manager'
import { attachTerminalHotkeyCapture, terminalShortcutAction } from '../../src/main/terminal-hotkeys'

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

const panel = {
  send: vi.fn(),
  isDestroyed: vi.fn(() => false),
}

function capture(convId = 'conv-1') {
  let listener: ((event: { preventDefault(): void }, input: Input) => void) | undefined
  const wc = {
    ...panel,
    on: vi.fn((_channel: string, cb: typeof listener) => {
      listener = cb
    }),
  }
  attachTerminalHotkeyCapture(wc as never, convId)
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

  it('validates standalone cwd before creating a shortcut terminal', async () => {
    vi.mocked(getConversation).mockReturnValue({ id: 'conv-1', scope: 'standalone', cwd: '/forged' } as never)
    vi.mocked(validateStandaloneConversationDirectory).mockResolvedValue('/managed/chat')
    const fire = capture()
    fire({ type: 'keyDown', code: 'KeyT', ...primaryModifier })
    await Promise.resolve()
    expect(createShellTerminal).toHaveBeenCalledWith('conv-1', '/managed/chat')
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

  it("hands a remote host's terminal shortcuts to its panel, which runs them on the host", () => {
    const fire = capture('server-1/workspaces#conv-1')
    const create = fire({ type: 'keyDown', code: 'KeyT', ...primaryModifier })
    const close = fire({ type: 'keyDown', code: 'KeyW', ...primaryModifier })

    // Cmd/Ctrl+W still never reaches the window's menu.
    expect(create.preventDefault).toHaveBeenCalledOnce()
    expect(close.preventDefault).toHaveBeenCalledOnce()
    expect(panel.send.mock.calls).toEqual([
      ['drawer:terminal-shortcut', 'create'],
      ['drawer:terminal-shortcut', 'close'],
    ])
    // This computer neither looks the conversation up nor touches its own terminals.
    expect(getConversation).not.toHaveBeenCalled()
    expect(getTerminalState).not.toHaveBeenCalled()
    expect(createShellTerminal).not.toHaveBeenCalled()
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
