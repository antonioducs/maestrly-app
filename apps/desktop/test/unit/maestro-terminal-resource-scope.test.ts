import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
  const terminals: Array<{
    id: string
    convId: string
    cwd: string
    ownerScopeId?: string
    label?: string
  }> = []
  let seq = 0
  const createShellTerminal = vi.fn(
    (
      convId: string,
      cwd: string,
      _cols?: number,
      _rows?: number,
      options: { ownerScopeId?: string; label?: string; activate?: boolean } = {}
    ) => {
      const terminal = { id: `term:${convId}:${++seq}`, convId, cwd, ...options }
      terminals.push(terminal)
      return { ok: true as const, id: terminal.id }
    }
  )
  const closeShellTerminal = vi.fn((_convId: string, id: string) => {
    const index = terminals.findIndex((terminal) => terminal.id === id)
    if (index >= 0) terminals.splice(index, 1)
  })
  return {
    terminals,
    reset: () => {
      terminals.length = 0
      seq = 0
    },
    createShellTerminal,
    closeShellTerminal,
    listShellTerminals: vi.fn((convId: string) => terminals.filter((terminal) => terminal.convId === convId)),
    listShellTerminalsOwnedByScope: vi.fn((convId: string, ownerScopeId: string) =>
      terminals.filter((terminal) => terminal.convId === convId && terminal.ownerScopeId === ownerScopeId)
    ),
    getShellTerminalOwnerScopeId: vi.fn(
      (convId: string, id: string) =>
        terminals.find((terminal) => terminal.convId === convId && terminal.id === id)?.ownerScopeId
    ),
    focusShellTerminal: vi.fn(),
    isShellOfConv: vi.fn((convId: string, id: string) => id.startsWith(`term:${convId}:`)),
    writeShellTerminal: vi.fn(() => true),
    readPtyOutput: vi.fn(() => ''),
    readPtyOutputSnapshot: vi.fn(),
    readPtyOutputStats: vi.fn(),
    clearPtyOutput: vi.fn(),
    signalPty: vi.fn(),
    getPtyInfo: vi.fn(() => ({ pid: 10, process: 'zsh' })),
    ptyExists: vi.fn((id: string) => terminals.some((terminal) => terminal.id === id)),
    resizePty: vi.fn(),
    getConversation: vi.fn(() => ({ cwd: '/repo' })),
  }
})

vi.mock('../../src/main/terminal-manager', () => ({
  createShellTerminal: h.createShellTerminal,
  closeShellTerminal: h.closeShellTerminal,
  listShellTerminals: h.listShellTerminals,
  listShellTerminalsOwnedByScope: h.listShellTerminalsOwnedByScope,
  focusShellTerminal: h.focusShellTerminal,
  getShellTerminalOwnerScopeId: h.getShellTerminalOwnerScopeId,
  isShellOfConv: h.isShellOfConv,
  writeShellTerminal: h.writeShellTerminal,
}))
vi.mock('../../src/main/pty-manager', () => ({
  readPtyOutput: h.readPtyOutput,
  readPtyOutputSnapshot: h.readPtyOutputSnapshot,
  readPtyOutputStats: h.readPtyOutputStats,
  clearPtyOutput: h.clearPtyOutput,
  signalPty: h.signalPty,
  getPtyInfo: h.getPtyInfo,
  ptyExists: h.ptyExists,
  resizePty: h.resizePty,
}))
vi.mock('../../src/main/store', () => ({ getConversation: h.getConversation }))

import { createMaestroWorkerScope } from '../../src/main/maestro-worker-scope'
import { registerTerminalTools } from '../../src/main/mcp/tools/terminal'

type Handler = (input: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>
  isError?: boolean
}>

function register(scope: ReturnType<typeof createMaestroWorkerScope>): Record<string, Handler> {
  const handlers: Record<string, Handler> = {}
  registerTerminalTools({
    server: {
      registerTool: (name: string, _definition: unknown, handler: Handler) => {
        handlers[name] = handler
      },
    } as never,
    convId: 'conv-1',
    locale: 'en',
    t: ((key: string, values?: Record<string, unknown>) =>
      `${key}${values ? ` ${JSON.stringify(values)}` : ''}`) as never,
    workerScope: scope,
  })
  return handlers
}

describe('Maestro terminal resource isolation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.reset()
  })

  it('lists and controls only exact-owner terminals, then cleans up only that owner', async () => {
    const scopeA = createMaestroWorkerScope({
      conversationId: 'conv-1',
      delegationId: 'delegate-a',
      label: 'Worker A',
    })
    const scopeB = createMaestroWorkerScope({
      conversationId: 'conv-1',
      delegationId: 'delegate-b',
      label: 'Worker B',
    })
    const a = register(scopeA)
    const b = register(scopeB)

    h.createShellTerminal('conv-1', '/ui')
    await a.terminal_create({ cwd: '/a' })
    await b.terminal_create({ cwd: '/b' })
    const uiId = h.terminals.find((terminal) => !terminal.ownerScopeId)!.id
    const aId = h.terminals.find((terminal) => terminal.ownerScopeId === scopeA.id)!.id
    const bId = h.terminals.find((terminal) => terminal.ownerScopeId === scopeB.id)!.id

    expect(h.terminals.find((terminal) => terminal.id === aId)).toMatchObject({
      ownerScopeId: scopeA.id,
      label: 'Worker A',
    })
    const listA = await a.terminal_list({})
    expect(listA.content[0]!.text).toContain(aId)
    expect(listA.content[0]!.text).not.toContain(bId)
    expect(listA.content[0]!.text).not.toContain(uiId)

    const listB = await b.terminal_list({})
    expect(listB.content[0]!.text).toContain(bId)
    expect(listB.content[0]!.text).not.toContain(aId)

    await expect(a.terminal_send({ id: bId, text: 'blocked' })).resolves.toMatchObject({ isError: true })
    await expect(a.terminal_close({ id: bId })).resolves.toMatchObject({ isError: true })
    expect(h.terminals.some((terminal) => terminal.id === bId)).toBe(true)
    expect(h.writeShellTerminal).not.toHaveBeenCalledWith(bId, 'blocked')

    await expect(a.terminal_send({ id: aId, text: 'allowed' })).resolves.not.toHaveProperty('isError')
    expect(h.writeShellTerminal).toHaveBeenCalledWith(aId, 'allowed')

    await scopeA.close()
    expect(h.terminals.map((terminal) => terminal.id)).toEqual([uiId, bId])
    await scopeA.close()
    expect(h.closeShellTerminal).toHaveBeenCalledTimes(1)

    await scopeB.close()
    expect(h.terminals.map((terminal) => terminal.id)).toEqual([uiId])
  })

  it('aborts terminal_run promptly and waits for its scoped cleanup', async () => {
    vi.useFakeTimers()
    try {
      const controller = new AbortController()
      const scope = createMaestroWorkerScope({
        conversationId: 'conv-1',
        delegationId: 'delegate-abort',
        signal: controller.signal,
      })
      const handlers = register(scope)
      await handlers.terminal_create({ cwd: '/worker' })
      const id = h.terminals.find((terminal) => terminal.ownerScopeId === scope.id)!.id
      h.readPtyOutputStats.mockReturnValue({ generation: 0, sequence: 0, totalChars: 0 })

      const running = handlers.terminal_run({ id, command: 'sleep 60', timeout_ms: 60_000 })
      const rejected = expect(running).rejects.toThrow()
      controller.abort()
      await vi.advanceTimersByTimeAsync(120)

      await rejected
      await scope.close()
      expect(h.terminals.some((terminal) => terminal.id === id)).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})
