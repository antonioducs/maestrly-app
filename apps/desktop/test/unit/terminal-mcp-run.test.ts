import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  readPtyOutput: vi.fn(),
  readPtyOutputSnapshot: vi.fn(),
  readPtyOutputStats: vi.fn(),
  clearPtyOutput: vi.fn(),
  signalPty: vi.fn(),
  getPtyInfo: vi.fn(),
  ptyExists: vi.fn(() => true),
  resizePty: vi.fn(),
  isShellOfConv: vi.fn(() => true),
  writeShellTerminal: vi.fn(() => true),
  createShellTerminal: vi.fn(),
  closeShellTerminal: vi.fn(),
  listShellTerminals: vi.fn(() => []),
  focusShellTerminal: vi.fn(),
  getConversation: vi.fn(),
}))

vi.mock('../../src/main/pty-manager', () => h)
vi.mock('../../src/main/terminal-manager', () => ({
  createShellTerminal: h.createShellTerminal,
  closeShellTerminal: h.closeShellTerminal,
  listShellTerminals: h.listShellTerminals,
  focusShellTerminal: h.focusShellTerminal,
  isShellOfConv: h.isShellOfConv,
  writeShellTerminal: h.writeShellTerminal,
}))
vi.mock('../../src/main/store', () => ({ getConversation: h.getConversation }))

import { registerTerminalTools } from '../../src/main/mcp/tools/terminal'

type Handler = (input: { id: string; command: string; timeout_ms?: number }) => Promise<unknown>

describe('terminal_run output polling', () => {
  const handlers: Record<string, Handler> = {}

  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    h.ptyExists.mockReturnValue(true)
    h.isShellOfConv.mockReturnValue(true)
    h.writeShellTerminal.mockReturnValue(true)
    for (const key of Object.keys(handlers)) delete handlers[key]
    registerTerminalTools({
      server: {
        registerTool: (name: string, _definition: unknown, handler: Handler) => {
          handlers[name] = handler
        },
      },
      convId: 'conv-1',
      locale: 'en',
      t: ((key: string) => key) as never,
    } as never)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('polls O(1) stats and returns the new tail when the ring was already full', async () => {
    const capacity = 256 * 1024
    const before = { generation: 1, sequence: 1, bufferedLength: capacity, totalChars: capacity }
    const after = { generation: 1, sequence: 2, bufferedLength: capacity, totalChars: capacity + 4 }
    h.readPtyOutputStats.mockReturnValueOnce(before).mockReturnValue(after)
    h.readPtyOutputSnapshot.mockReturnValue({
      ...after,
      data: 'a'.repeat(capacity - 4) + 'tail',
    })

    const resultPromise = handlers.terminal_run({ id: 'term-1', command: 'printf tail', timeout_ms: 5_000 })
    await vi.advanceTimersByTimeAsync(720)
    const result = await resultPromise

    expect(result).toEqual({ content: [{ type: 'text', text: 'tail' }] })
    expect(h.readPtyOutput).not.toHaveBeenCalled()
    expect(h.readPtyOutputSnapshot).toHaveBeenCalledOnce()
    expect(h.readPtyOutputStats.mock.calls.length).toBeGreaterThan(1)
  })

  it('returns the current ring when clear or rollover discarded part of the delta', async () => {
    const before = { generation: 1, sequence: 4, bufferedLength: 100, totalChars: 500 }
    const after = { generation: 1, sequence: 5, bufferedLength: 3, totalChars: 506 }
    h.readPtyOutputStats.mockReturnValueOnce(before).mockReturnValue(after)
    h.readPtyOutputSnapshot.mockReturnValue({ ...after, data: 'new' })

    const resultPromise = handlers.terminal_run({ id: 'term-1', command: 'printf new', timeout_ms: 5_000 })
    await vi.advanceTimersByTimeAsync(720)
    const result = await resultPromise

    expect(result).toEqual({ content: [{ type: 'text', text: 'new' }] })
    expect(h.readPtyOutputSnapshot).toHaveBeenCalledOnce()
  })
})
