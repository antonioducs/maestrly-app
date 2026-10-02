import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface FakeProc {
  pid: number
  process: string
  write: ReturnType<typeof vi.fn>
  resize: ReturnType<typeof vi.fn>
  kill: ReturnType<typeof vi.fn>
  onData(listener: (data: string) => void): void
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): void
  emitData(data: string): void
  emitExit(exitCode: number, signal?: number): void
}

const spawned = vi.hoisted(() => ({ procs: [] as unknown[], fail: false }))

vi.mock('node-pty', () => {
  const spawn = () => {
    if (spawned.fail) throw new Error('spawn denied')
    let dataListener: (data: string) => void = () => {}
    let exitListener: (event: { exitCode: number; signal?: number }) => void = () => {}
    const proc: FakeProc = {
      pid: 4000 + spawned.procs.length,
      process: 'sh',
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      onData: (listener) => {
        dataListener = listener
      },
      onExit: (listener) => {
        exitListener = listener
      },
      emitData: (data) => dataListener(data),
      emitExit: (exitCode, signal) => exitListener({ exitCode, signal }),
    }
    spawned.procs.push(proc)
    return proc
  }
  return { spawn, default: { spawn } }
})
vi.mock('../../src/main/platform', () => ({ freeTerminalShell: vi.fn(() => ({ file: 'sh', args: [] })) }))
vi.mock('../../src/main/store', () => ({ getFreeTerminalShell: vi.fn() }))
vi.mock('../../src/main/crash-reporter', () => ({ captureProcessExit: vi.fn() }))
vi.mock('../../src/main/performance/metrics', () => ({
  incrementPerformanceCounter: vi.fn(),
  recordIpcSend: vi.fn(),
}))
vi.mock('../../src/main/performance/owned-processes', () => ({
  registerOwnedProcess: vi.fn(),
  unregisterOwnedProcess: vi.fn(),
}))

import { createShellPty, forgetPty, onPtyExit, onPtyOutput, readPtyOutputSnapshot } from '../../src/main/pty-manager'

let counter = 0
function startPty(): {
  id: string
  proc: FakeProc
  onData: ReturnType<typeof vi.fn>
  onExit: ReturnType<typeof vi.fn>
} {
  const id = `term:listeners:${++counter}`
  const onData = vi.fn()
  const onExit = vi.fn()
  createShellPty({ id, cwd: '/tmp', cols: 80, rows: 24, onData, onExit })
  return { id, proc: spawned.procs.at(-1) as FakeProc, onData, onExit }
}

describe('pty-manager output and exit listeners', () => {
  beforeEach(() => {
    spawned.fail = false
    // A shell that exits with a failure is logged by the manager.
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('delivers the output with its stream position', () => {
    const { id, proc } = startPty()
    const listener = vi.fn()
    onPtyOutput(id, listener)
    proc.emitData('one')
    proc.emitData('two')
    expect(listener.mock.calls).toEqual([
      ['one', { generation: 1, sequence: 1 }],
      ['two', { generation: 1, sequence: 2 }],
    ])
    // The listener sees the same position the snapshot reports, so a viewer can hand off without a gap.
    expect(readPtyOutputSnapshot(id)).toMatchObject({ data: 'onetwo', generation: 1, sequence: 2 })
  })

  it('keeps feeding the existing consumer', () => {
    const { id, proc, onData } = startPty()
    onPtyOutput(id, vi.fn())
    proc.emitData('x')
    expect(onData).toHaveBeenCalledWith('x', { generation: 1, sequence: 1 })
  })

  it('only delivers the output of the pty it listens to', () => {
    const first = startPty()
    const second = startPty()
    const listener = vi.fn()
    onPtyOutput(first.id, listener)
    second.proc.emitData('other')
    expect(listener).not.toHaveBeenCalled()
  })

  it('stops delivering after the subscription is cancelled', () => {
    const { id, proc } = startPty()
    const kept = vi.fn()
    const cancelled = vi.fn()
    onPtyOutput(id, kept)
    const cancel = onPtyOutput(id, cancelled)
    proc.emitData('before')
    cancel()
    cancel()
    proc.emitData('after')
    expect(cancelled.mock.calls.map((call) => call[0])).toEqual(['before'])
    expect(kept.mock.calls.map((call) => call[0])).toEqual(['before', 'after'])
  })

  it('does not let a failing listener break the pty or the other listeners', () => {
    const { id, proc, onData } = startPty()
    const after = vi.fn()
    onPtyOutput(id, () => {
      throw new Error('listener failed')
    })
    onPtyOutput(id, after)
    expect(() => proc.emitData('data')).not.toThrow()
    expect(after).toHaveBeenCalledTimes(1)
    expect(onData).toHaveBeenCalledTimes(1)
    expect(console.error).toHaveBeenCalledWith('[pty] Listener failed', expect.any(Error))
  })

  it('lets a listener cancel itself while it is being notified', () => {
    const { id, proc } = startPty()
    const second = vi.fn()
    const cancel = onPtyOutput(id, () => cancel())
    onPtyOutput(id, second)
    proc.emitData('a')
    proc.emitData('b')
    expect(second).toHaveBeenCalledTimes(2)
  })

  it('fires the exit listener with the exit code when the process ends', () => {
    const { id, proc, onExit } = startPty()
    const listener = vi.fn()
    onPtyExit(id, listener)
    proc.emitExit(3)
    expect(listener).toHaveBeenCalledExactlyOnceWith(3)
    expect(onExit).toHaveBeenCalledWith(3, true, 1)
  })

  it('does not fire a cancelled exit listener', () => {
    const { id, proc } = startPty()
    const listener = vi.fn()
    onPtyExit(id, listener)()
    proc.emitExit(0)
    expect(listener).not.toHaveBeenCalled()
  })

  it('reports a shell that failed to start as an exit', () => {
    spawned.fail = true
    const id = `term:listeners:${++counter}`
    const listener = vi.fn()
    onPtyExit(id, listener)
    createShellPty({ id, cwd: '/tmp', cols: 80, rows: 24, onData: vi.fn(), onExit: vi.fn() })
    expect(listener).toHaveBeenCalledExactlyOnceWith(1)
    forgetPty(id)
  })

  it('keeps the exit listener across a restart of the same id and reports each current exit once', () => {
    const { id, proc } = startPty()
    const listener = vi.fn()
    onPtyExit(id, listener)
    proc.emitExit(0)
    createShellPty({ id, cwd: '/tmp', cols: 80, rows: 24, onData: vi.fn(), onExit: vi.fn() })
    ;(spawned.procs.at(-1) as FakeProc).emitExit(7)
    expect(listener.mock.calls).toEqual([[0], [7]])
  })
})
