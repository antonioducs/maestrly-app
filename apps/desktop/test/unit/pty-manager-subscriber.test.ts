import { describe, expect, it, vi } from 'vitest'

vi.mock('node-pty', () => ({}))
vi.mock('../../src/main/platform', () => ({ freeTerminalShell: vi.fn() }))
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

import { sendPtyData, subscribePtyData } from '../../src/main/pty-manager'

type WebContentsMock = {
  isDestroyed: ReturnType<typeof vi.fn>
  once: ReturnType<typeof vi.fn>
  removeListener: ReturnType<typeof vi.fn>
  send: ReturnType<typeof vi.fn>
  destroy: () => void
}

function webContents(): WebContentsMock {
  let onDestroyed: (() => void) | undefined
  let destroyed = false
  const contents: WebContentsMock = {
    isDestroyed: vi.fn(() => destroyed),
    once: vi.fn((_event: string, listener: () => void) => {
      onDestroyed = listener
    }),
    removeListener: vi.fn(),
    send: vi.fn(),
    destroy: () => {
      destroyed = true
      onDestroyed?.()
    },
  }
  return contents
}

describe('pty-manager subscribers', () => {
  it('clears all subscriptions when WebContents is destroyed', () => {
    const dead = webContents()
    const live = webContents()

    subscribePtyData(dead as never, 'term:one')
    subscribePtyData(dead as never, 'term:two')
    subscribePtyData(live as never, 'term:one')

    dead.destroy()
    sendPtyData('term:one', 'output')
    sendPtyData('term:two', 'output')

    expect(dead.send).not.toHaveBeenCalled()
    expect(live.send).toHaveBeenCalledTimes(1)
  })

  it('catches the race between isDestroyed and send while retaining other subscribers', () => {
    const racing = webContents()
    const live = webContents()
    racing.send.mockImplementationOnce(() => {
      racing.destroy()
      throw new Error('WebContents destroyed during send')
    })

    subscribePtyData(racing as never, 'term:race')
    subscribePtyData(live as never, 'term:race')

    expect(() => sendPtyData('term:race', 'first')).not.toThrow()
    sendPtyData('term:race', 'second')

    expect(racing.send).toHaveBeenCalledTimes(1)
    expect(live.send).toHaveBeenCalledTimes(2)
  })
})
