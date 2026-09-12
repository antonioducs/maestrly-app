import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  createShellPty: vi.fn(),
  createDelegatePty: vi.fn(),
  clearPtyOutput: vi.fn(),
  forgetPty: vi.fn(),
  killPty: vi.fn(),
  killPtyAndWait: vi.fn(),
  ptyExists: vi.fn(),
  getPtyInfo: vi.fn(),
  writePty: vi.fn(),
  sendPtyData: vi.fn(),
  sendPtyExit: vi.fn(),
  broadcast: vi.fn(),
  sendToPanel: vi.fn(),
  sendToConversation: vi.fn(),
}))
vi.mock('../../src/main/pty-manager', () => ({
  createShellPty: h.createShellPty,
  createDelegatePty: h.createDelegatePty,
  clearPtyOutput: h.clearPtyOutput,
  forgetPty: h.forgetPty,
  killPty: h.killPty,
  killPtyAndWait: h.killPtyAndWait,
  ptyExists: h.ptyExists,
  getPtyInfo: h.getPtyInfo,
  writePty: h.writePty,
  sendPtyData: h.sendPtyData,
  sendPtyExit: h.sendPtyExit,
}))
vi.mock('../../src/main/window-ipc', () => ({
  broadcast: h.broadcast,
  sendToPanel: h.sendToPanel,
  sendToConversation: h.sendToConversation,
}))

import {
  __resetCwdActivityForTests,
  inspectCwdActivity,
  tryWithCwdExclusive,
} from '../../src/main/cwd-activity-coordinator'
import {
  closeShellTerminal,
  createShellTerminal,
  disposeShellTerminals,
  disposeShellTerminalsAndWait,
  getTerminalState,
  getShellTerminalOwnerScopeId,
  listShellTerminalsOwnedByScope,
  MAX_RETAINED_TERMINAL_TABS,
  writeShellTerminal,
  shellTermCwd,
} from '../../src/main/terminal-manager'

beforeEach(() => {
  vi.clearAllMocks()
  h.ptyExists.mockReturnValue(true)
  h.getPtyInfo.mockReturnValue({ pid: 1, process: 'zsh' })
  __resetCwdActivityForTests()
})
afterEach(() => {
  disposeShellTerminals('conv')
  __resetCwdActivityForTests()
})

describe('terminal manager cwd activity', () => {
  it('stores runtime owner and audit label without changing ordinary terminal descriptors', () => {
    const ordinary = createShellTerminal('conv', '/ui')
    const owned = createShellTerminal('conv', '/worker', 90, 30, {
      ownerScopeId: 'delegate-a',
      label: 'Worker A',
      activate: false,
    })
    if (!ordinary.ok || !owned.ok) throw new Error('terminals not created')

    expect(getTerminalState('conv').terminals).toContainEqual({ id: ordinary.id, cwd: '/ui' })
    expect(getTerminalState('conv').terminals).toContainEqual({
      id: owned.id,
      cwd: '/worker',
      ownerScopeId: 'delegate-a',
      label: 'Worker A',
    })
    expect(getShellTerminalOwnerScopeId('conv', ordinary.id)).toBeUndefined()
    expect(getShellTerminalOwnerScopeId('conv', owned.id)).toBe('delegate-a')
    expect(listShellTerminalsOwnedByScope('conv', 'delegate-a').map((terminal) => terminal.id)).toEqual([owned.id])
    expect(getTerminalState('conv').activeId).toBe(ordinary.id)
  })

  it('preserves the UI active terminal when a background worker spawn fails synchronously', () => {
    const ordinary = createShellTerminal('conv', '/ui')
    const otherWorker = createShellTerminal('conv', '/worker-b', 90, 30, {
      ownerScopeId: 'delegate-b',
      activate: false,
    })
    if (!ordinary.ok || !otherWorker.ok) throw new Error('terminals not created')

    h.createShellPty.mockImplementationOnce((args: { onExit: (code: number) => void }) => args.onExit(1))
    expect(
      createShellTerminal('conv', '/worker-a', 90, 30, {
        ownerScopeId: 'delegate-a',
        activate: false,
      })
    ).toEqual({ ok: false, reason: 'spawn-failed' })

    expect(getTerminalState('conv').activeId).toBe(ordinary.id)
    expect(getTerminalState('conv').terminals.map((terminal) => terminal.id)).toEqual([ordinary.id, otherWorker.id])
  })

  it('does not spawn a terminal during an exclusive Git transition', async () => {
    const result = await tryWithCwdExclusive('/repo', async () => createShellTerminal('conv', '/repo'))
    expect(result).toEqual({ ok: true, value: { ok: false, reason: 'cwd-locked' } })
    expect(h.createShellPty).not.toHaveBeenCalled()
  })

  it('an open idle terminal warns without blocking deletion', async () => {
    const result = createShellTerminal('conv', '/repo')
    expect(result).toMatchObject({ ok: true, id: expect.stringMatching(/^term:conv:/) })
    if (!result.ok) throw new Error('terminal not created')
    expect(inspectCwdActivity('/repo')).toEqual([{ kind: 'terminal', count: 1, blocking: false }])
    expect(await tryWithCwdExclusive('/repo', async () => 'ok')).toEqual({ ok: true, value: 'ok' })
    closeShellTerminal('conv', result.id)
    expect(inspectCwdActivity('/repo')).toEqual([])
  })

  it('a running terminal command blocks activity while an idle shell does not', async () => {
    const result = createShellTerminal('conv', '/repo')
    if (!result.ok) throw new Error('terminal not created')
    const id = result.id
    expect(writeShellTerminal(id, 'sleep 1\r')).toBe(true)
    expect(inspectCwdActivity('/repo')).toEqual([
      { kind: 'terminal', count: 1, blocking: true },
      { kind: 'terminal', count: 1, blocking: false },
    ])
    expect(await tryWithCwdExclusive('/repo', async () => 'no')).toMatchObject({ ok: false })
    closeShellTerminal('conv', id)
    expect(inspectCwdActivity('/repo')).toEqual([])
  })

  it('does not release long commands on timeout; waits for the foreground shell', async () => {
    vi.useFakeTimers()
    try {
      const result = createShellTerminal('conv', '/repo')
      if (!result.ok) throw new Error('terminal not created')
      const id = result.id
      h.getPtyInfo.mockReturnValue({ pid: 1, process: 'sleep' })
      expect(writeShellTerminal(id, 'sleep 60\r')).toBe(true)
      await vi.advanceTimersByTimeAsync(31_000)
      expect(inspectCwdActivity('/repo')).toContainEqual({
        kind: 'terminal',
        count: 1,
        blocking: true,
      })

      h.getPtyInfo.mockReturnValue({ pid: 1, process: 'zsh' })
      await vi.advanceTimersByTimeAsync(250)
      expect(inspectCwdActivity('/repo')).toEqual([
        ...(process.platform === 'win32' ? [{ kind: 'terminal', count: 1, blocking: true }] : []),
        { kind: 'terminal', count: 1, blocking: false },
      ])
      closeShellTerminal('conv', id)
    } finally {
      vi.useRealTimers()
    }
  })

  it('synchronous spawn failure leaves no tab or idle lease', () => {
    h.createShellPty.mockImplementationOnce((args: { onExit: (code: number) => void }) => args.onExit(1))
    expect(createShellTerminal('conv', '/repo')).toEqual({ ok: false, reason: 'spawn-failed' })
    expect(inspectCwdActivity('/repo')).toEqual([])
  })

  it('caps finished-tab history without killing live PTYs', () => {
    h.ptyExists.mockReturnValue(false)
    const ids: string[] = []
    for (let i = 0; i < MAX_RETAINED_TERMINAL_TABS + 1; i++) {
      const result = createShellTerminal('conv', '/repo')
      if (!result.ok) throw new Error('terminal not created')
      ids.push(result.id)
    }

    const state = getTerminalState('conv')
    expect(state.terminals).toHaveLength(MAX_RETAINED_TERMINAL_TABS)
    expect(state.terminals.some((terminal) => terminal.id === ids[0])).toBe(false)
    expect(state.activeId).toBe(ids.at(-1))
    expect(h.killPty).not.toHaveBeenCalled()
  })

  it('preserves a new tab when every previous tab is still live', () => {
    h.ptyExists.mockReturnValue(true)
    const ids: string[] = []
    for (let i = 0; i < MAX_RETAINED_TERMINAL_TABS + 1; i++) {
      const result = createShellTerminal('conv', '/repo')
      if (!result.ok) throw new Error('terminal not created')
      ids.push(result.id)
    }

    const state = getTerminalState('conv')
    expect(state.terminals).toHaveLength(MAX_RETAINED_TERMINAL_TABS + 1)
    expect(state.terminals.at(-1)?.id).toBe(ids.at(-1))
  })

  it('removes conversation authority before waiting for multiple exits', async () => {
    const first = createShellTerminal('conv', '/repo')
    const second = createShellTerminal('conv', '/repo')
    if (!first.ok || !second.ok) throw new Error('terminals not created')

    const resolves = new Map<string, (value: boolean) => void>()
    h.killPtyAndWait.mockImplementation((id: string) => new Promise<boolean>((resolve) => resolves.set(id, resolve)))

    const disposing = disposeShellTerminalsAndWait('conv')

    expect(shellTermCwd(first.id)).toBeNull()
    expect(shellTermCwd(second.id)).toBeNull()
    expect(getTerminalState('conv')).toEqual({ terminals: [], activeId: null })

    for (const resolve of resolves.values()) resolve(true)
    await expect(disposing).resolves.toBe(true)
  })
})
