import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BROWSER_COMMAND_TIMEOUT_MS,
  BROWSER_EVALUATE_TIMEOUT_MS,
  BROWSER_FROZEN_PROBE_TIMEOUT_MS,
  attachToView,
  evaluate,
  getConsoleLogs,
  moveMouse,
  navigate,
  setBrowserCdpActivity,
} from '../../src/main/browser-control'

vi.mock('../../src/main/performance/metrics', () => ({ incrementPerformanceCounter: vi.fn() }))

/** A renderer whose main thread is stuck answers none of the protocol commands it handles. */
class FakeDebugger extends EventEmitter {
  readonly stuck = new Set<string>()
  evaluateResult: unknown = { result: { type: 'string', value: 'https://example.test/' } }
  readonly attach = vi.fn()
  readonly sendCommand = vi.fn((method: string, _params?: Record<string, unknown>): Promise<unknown> => {
    if (this.stuck.has(method)) return new Promise(() => {})
    if (method === 'Page.addScriptToEvaluateOnNewDocument') return Promise.resolve({ identifier: 'script-1' })
    if (method === 'Runtime.evaluate') return Promise.resolve(this.evaluateResult)
    if (method === 'Page.navigate') queueMicrotask(() => this.emit('message', {}, 'Page.loadEventFired', {}))
    return Promise.resolve({})
  })
}

class FakeWebContents extends EventEmitter {
  readonly debugger = new FakeDebugger()
  private url = 'https://example.test/'
  readonly isCrashed = vi.fn(() => false)
  readonly forcefullyCrashRenderer = vi.fn()
  readonly loadURL = vi.fn(async (url: string) => {
    this.url = url
  })

  getURL(): string {
    return this.url
  }

  isDestroyed(): boolean {
    return false
  }
}

async function attachedPage(): Promise<FakeWebContents> {
  const wc = new FakeWebContents()
  await attachToView(wc as never)
  return wc
}

const evaluations = (wc: FakeWebContents, expression: string) =>
  wc.debugger.sendCommand.mock.calls.filter(
    ([method, params]) => method === 'Runtime.evaluate' && params?.expression === expression
  )

describe('browser operations on a page that stops answering', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('ends a stuck evaluation at its deadline, then restarts the renderer on the next navigation', async () => {
    const wc = await attachedPage()
    wc.debugger.stuck.add('Runtime.evaluate')

    const evaluation = evaluate(wc as never, 'while (true) {}')
    const failed = expect(evaluation).rejects.toThrow(
      `evaluating JavaScript exceeded ${BROWSER_EVALUATE_TIMEOUT_MS} ms without a browser response; the page may be frozen.`
    )
    await vi.advanceTimersByTimeAsync(BROWSER_EVALUATE_TIMEOUT_MS)
    await failed
    // The page itself stops a synchronous loop shortly before the deadline.
    expect(evaluations(wc, 'while (true) {}')[0]?.[1]).toMatchObject({ timeout: BROWSER_EVALUATE_TIMEOUT_MS - 1_000 })

    const navigation = navigate(wc as never, 'https://next.test/')
    await vi.advanceTimersByTimeAsync(BROWSER_FROZEN_PROBE_TIMEOUT_MS)
    await expect(navigation).resolves.toEqual({ url: 'https://next.test/' })
    expect(wc.forcefullyCrashRenderer).toHaveBeenCalledOnce()
    expect(wc.loadURL).toHaveBeenCalledWith('https://next.test/')
    expect(wc.debugger.sendCommand).not.toHaveBeenCalledWith('Page.navigate', expect.anything())
  })

  it('keeps the renderer of a page that answers the probe again', async () => {
    const wc = await attachedPage()
    wc.debugger.stuck.add('Input.dispatchMouseEvent')

    const move = moveMouse(wc as never, 10, 20)
    const failed = expect(move).rejects.toThrow('may be frozen')
    await vi.advanceTimersByTimeAsync(BROWSER_COMMAND_TIMEOUT_MS)
    await failed

    wc.debugger.stuck.clear()
    await expect(navigate(wc as never, 'https://next.test/')).resolves.toEqual({ url: 'https://example.test/' })
    expect(evaluations(wc, '1')).toHaveLength(1)
    expect(wc.forcefullyCrashRenderer).not.toHaveBeenCalled()
    expect(wc.debugger.sendCommand).toHaveBeenCalledWith('Page.navigate', { url: 'https://next.test/' })
  })

  it('stops at once when the call is cancelled, without suspecting the page', async () => {
    const wc = await attachedPage()
    wc.debugger.stuck.add('Runtime.evaluate')
    const controller = new AbortController()

    const evaluation = evaluate(wc as never, 'await new Promise(() => {})', { signal: controller.signal })
    const cancelled = expect(evaluation).rejects.toThrow('evaluating JavaScript cancelled.')
    controller.abort()
    await cancelled

    wc.debugger.stuck.clear()
    await navigate(wc as never, 'https://next.test/')
    expect(evaluations(wc, '1')).toHaveLength(0)
  })

  it('explains a script the page stopped for running too long', async () => {
    const wc = await attachedPage()
    wc.debugger.evaluateResult = {
      result: { type: 'object' },
      exceptionDetails: { text: 'Uncaught', exception: { description: 'Error: Execution was terminated' } },
    }

    await expect(evaluate(wc as never, 'for (;;) {}', { timeoutMs: 5_000 })).rejects.toThrow(
      'the script ran for more than 4000 ms and was stopped.'
    )
  })
})

describe('browser debugger session that ends without the tab closing', () => {
  it('attaches again on the next operation and keeps one listener per tab', async () => {
    const wc = await attachedPage()
    await setBrowserCdpActivity(wc as never, true)

    wc.debugger.emit('detach', {}, 'target closed')
    await moveMouse(wc as never, 1, 1)
    expect(wc.debugger.attach).toHaveBeenCalledTimes(2)

    wc.debugger.emit('message', {}, 'Runtime.consoleAPICalled', { type: 'log', args: [{ value: 'once' }] })
    expect((await getConsoleLogs(wc as never)).map((entry) => entry.text)).toEqual(['once'])
  })
})
