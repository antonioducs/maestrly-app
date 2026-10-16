import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { navHistory, navigate } from '../../src/main/browser-control'

vi.mock('../../src/main/performance/metrics', () => ({
  incrementPerformanceCounter: vi.fn(),
}))

/**
 * Navigation waits for a load event with a timeout. A tab that closes during or after that wait must not
 * leave a timer that later touches the destroyed WebContents: Electron throws "Object has been destroyed"
 * from every native accessor, and an exception thrown in a main-process timer shows a crash dialog.
 */
class FakeDebugger extends EventEmitter {
  /** When false, Page.navigate gets no load event, as with a page that never finishes loading. */
  emitLoad = true
  readonly attach = vi.fn()
  readonly sendCommand = vi.fn(async (method: string) => {
    if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: 'script-1' }
    if (method === 'Runtime.evaluate') return { result: { value: 'https://example.test/' } }
    if (method === 'Page.navigate' && this.emitLoad) {
      queueMicrotask(() => this.emit('message', {}, 'Page.loadEventFired', {}))
    }
    return {}
  })
}

class FakeWebContents extends EventEmitter {
  private readonly cdp = new FakeDebugger()
  private destroyed = false
  readonly reload = vi.fn()

  get debugger(): FakeDebugger {
    if (this.destroyed) throw new TypeError('Object has been destroyed')
    return this.cdp
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  destroy(): void {
    this.destroyed = true
    this.emit('destroyed')
  }

  /** A tab that is already gone before its destroyed event reaches the navigation wait. */
  destroyWithoutEvent(): void {
    this.destroyed = true
  }
}

describe('browser-control navigation waits', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('cancels the load timeout once the page loads, so closing the tab later is harmless', async () => {
    const wc = new FakeWebContents()

    await expect(navigate(wc as never, 'https://example.test/')).resolves.toEqual({ url: 'https://example.test/' })
    expect(vi.getTimerCount()).toBe(0)

    wc.destroy()
    expect(() => vi.advanceTimersByTime(15_000)).not.toThrow()
  })

  it('stops waiting as soon as the tab is destroyed instead of waiting for the timeout', async () => {
    const wc = new FakeWebContents()
    wc.debugger.emitLoad = false

    const navigation = navigate(wc as never, 'https://example.test/')
    const outcome = expect(navigation).rejects.toThrow('Object has been destroyed')
    await vi.waitFor(() => expect(wc.debugger.sendCommand).toHaveBeenCalledWith('Page.navigate', expect.anything()))
    wc.destroy()

    await outcome
    expect(vi.getTimerCount()).toBe(0)
    expect(() => vi.advanceTimersByTime(15_000)).not.toThrow()
  })

  it('does not touch a destroyed tab when a reload wait times out', async () => {
    const wc = new FakeWebContents()
    wc.reload.mockImplementation(() => wc.destroyWithoutEvent())

    const reload = navHistory(wc as never, 'reload')
    const outcome = expect(reload).rejects.toThrow('Object has been destroyed')
    await vi.waitFor(() => expect(wc.reload).toHaveBeenCalled())

    expect(() => vi.advanceTimersByTime(15_000)).not.toThrow()
    await outcome
  })
})
