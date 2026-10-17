import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { installSystemQuitHandlers, SYSTEM_QUIT_SIGNALS } from '../../src/main/system-quit'

function sources(platform: NodeJS.Platform) {
  const signals = new EventEmitter()
  const powerMonitor = new EventEmitter()
  const quit = vi.fn()
  const uninstall = installSystemQuitHandlers({ platform, signals, powerMonitor, quit })
  const shutdown = () => {
    const event = { preventDefault: vi.fn() }
    powerMonitor.emit('shutdown', event)
    return event
  }
  return { signals, powerMonitor, quit, uninstall, shutdown }
}

describe('system quit handlers', () => {
  it.each(SYSTEM_QUIT_SIGNALS)('quits on %s once, then leaves a repeated signal to the default action', (signal) => {
    const { signals, quit } = sources('linux')
    signals.emit(signal)
    expect(quit).toHaveBeenCalledOnce()
    expect(signals.listenerCount(signal)).toBe(0)
  })

  it('gives each signal its own attempt, as logind sends SIGHUP right after SIGTERM', () => {
    const { signals, quit } = sources('linux')
    signals.emit('SIGTERM')
    expect(signals.listenerCount('SIGHUP')).toBe(1)
    signals.emit('SIGHUP')
    expect(quit).toHaveBeenCalledTimes(2)
  })

  it('holds the Linux shutdown delay lock while it quits', () => {
    const { quit, shutdown } = sources('linux')
    expect(shutdown().preventDefault).toHaveBeenCalledOnce()
    expect(quit).toHaveBeenCalledOnce()
  })

  it('lets a macOS shutdown or logout go on while it quits', () => {
    const { quit, shutdown } = sources('darwin')
    expect(shutdown().preventDefault).not.toHaveBeenCalled()
    expect(quit).toHaveBeenCalledOnce()
  })

  it('does not watch signals or the power monitor on Windows', () => {
    const { signals, powerMonitor } = sources('win32')
    for (const signal of SYSTEM_QUIT_SIGNALS) expect(signals.listenerCount(signal)).toBe(0)
    expect(powerMonitor.listenerCount('shutdown')).toBe(0)
  })

  it('removes every listener when uninstalled', () => {
    const { signals, powerMonitor, uninstall } = sources('linux')
    uninstall()
    for (const signal of SYSTEM_QUIT_SIGNALS) expect(signals.listenerCount(signal)).toBe(0)
    expect(powerMonitor.listenerCount('shutdown')).toBe(0)
  })
})
