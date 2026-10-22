import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CdpPipe } from '../../src/main/fleet/instance/bot-browser/cdp-pipe'
import { ChromiumPage } from '../../src/main/fleet/instance/bot-browser/chromium-page'

function page(send: (method: string, params?: Record<string, unknown>) => Promise<unknown>) {
  return new ChromiumPage({ send } as unknown as CdpPipe, 'target-1', 'session-1', {
    targetId: 'target-1',
    url: 'about:blank',
    title: '',
  })
}

afterEach(() => vi.useRealTimers())

describe('ChromiumPage.loadURL', () => {
  it('returns once the page has loaded, not when the browser starts the navigation', async () => {
    const tab = page(async () => ({}))
    let settled = false
    const load = tab.loadURL('http://example.test/').then(() => (settled = true))
    await vi.waitFor(() => expect(tab.debugger.listenerCount('message')).toBe(1))
    await Promise.resolve()
    expect(settled).toBe(false)
    tab.handleEvent({ method: 'Page.frameNavigated', params: { frame: { url: 'http://example.test/' } } })
    expect(settled).toBe(false)
    tab.handleEvent({ method: 'Page.loadEventFired', params: {} })
    await load
    expect(settled).toBe(true)
    expect(tab.debugger.listenerCount('message')).toBe(0)
  })

  it('gives a load that never fires a fixed wait', async () => {
    vi.useFakeTimers()
    const tab = page(async () => ({}))
    const load = tab.loadURL('http://example.test/')
    await vi.advanceTimersByTimeAsync(15_000)
    await load
    expect(tab.debugger.listenerCount('message')).toBe(0)
  })

  it('rejects a navigation the browser refused and stops listening', async () => {
    const tab = page(async () => ({ errorText: 'net::ERR_NAME_NOT_RESOLVED' }))
    await expect(tab.loadURL('http://nowhere.test/')).rejects.toThrow(/ERR_NAME_NOT_RESOLVED/)
    expect(tab.debugger.listenerCount('message')).toBe(0)
  })

  it('stops waiting when the tab closes', async () => {
    const tab = page(async () => ({}))
    const load = tab.loadURL('http://example.test/')
    await vi.waitFor(() => expect(tab.debugger.listenerCount('message')).toBe(1))
    tab.markDestroyed()
    await load
  })
})

describe('ChromiumPage.forcefullyCrashRenderer', () => {
  const renderers = (...cpu: Array<[number, number]>) => ({
    processInfo: [
      { type: 'browser', id: 10, cpuTime: 1 },
      ...cpu.map(([id, cpuTime]) => ({ type: 'renderer', id, cpuTime })),
    ],
  })

  /** A browser whose renderers use the CPU time given per reading, in the order of the readings. */
  function stuckBrowser(readings: Array<Array<[number, number]>>) {
    const calls: string[] = []
    let reading = 0
    const tab = page(async (method) => {
      calls.push(method)
      if (method === 'SystemInfo.getProcessInfo')
        return renderers(...readings[Math.min(reading++, readings.length - 1)])
      return {}
    })
    return { tab, calls }
  }

  it('ends the one renderer that keeps running a script, without asking the page to crash', async () => {
    vi.useFakeTimers()
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    const { tab, calls } = stuckBrowser([
      [
        [201, 5],
        [202, 2],
      ],
      [
        [201, 5.5],
        [202, 2.01],
      ],
    ])
    tab.forcefullyCrashRenderer()
    await vi.advanceTimersByTimeAsync(600)
    expect(kill).toHaveBeenCalledWith(201, 'SIGKILL')
    expect(calls).not.toContain('Page.crash')
    kill.mockRestore()
  })

  it('asks the page to crash when no renderer stands out, or two are busy', async () => {
    vi.useFakeTimers()
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    const idle = stuckBrowser([[[201, 5]], [[201, 5.02]]])
    idle.tab.forcefullyCrashRenderer()
    await vi.advanceTimersByTimeAsync(600)
    expect(idle.calls).toContain('Page.crash')
    const both = stuckBrowser([
      [
        [201, 5],
        [202, 2],
      ],
      [
        [201, 5.5],
        [202, 2.45],
      ],
    ])
    both.tab.forcefullyCrashRenderer()
    await vi.advanceTimersByTimeAsync(600)
    expect(both.calls).toContain('Page.crash')
    expect(kill).not.toHaveBeenCalled()
    kill.mockRestore()
  })

  it('asks the page to crash when the renderer cannot be ended', async () => {
    vi.useFakeTimers()
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('ESRCH')
    })
    const { tab, calls } = stuckBrowser([[[201, 5]], [[201, 5.5]]])
    tab.forcefullyCrashRenderer()
    await vi.advanceTimersByTimeAsync(600)
    expect(calls).toContain('Page.crash')
    kill.mockRestore()
  })

  it('holds a load until the renderer is gone', async () => {
    vi.useFakeTimers()
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    const { tab, calls } = stuckBrowser([[[201, 5]], [[201, 5.5]]])
    tab.forcefullyCrashRenderer()
    const load = tab.loadURL('http://example.test/')
    await vi.advanceTimersByTimeAsync(600)
    expect(calls).not.toContain('Page.navigate')
    tab.handleEvent({ method: 'Inspector.targetCrashed', params: {} })
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toContain('Page.navigate')
    tab.handleEvent({ method: 'Page.loadEventFired', params: {} })
    await load
    kill.mockRestore()
  })
})
