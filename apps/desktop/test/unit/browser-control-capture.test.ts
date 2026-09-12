import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/main/performance/metrics', () => ({
  incrementPerformanceCounter: vi.fn(),
}))

class FakeDebugger {
  private listeners = new Set<(_event: unknown, method: string, params: Record<string, unknown>) => void>()
  readonly attach = vi.fn()
  readonly sendCommand = vi.fn(async (method: string) => {
    if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: 'script-1' }
    return {}
  })

  on(event: string, listener: (_event: unknown, method: string, params: Record<string, unknown>) => void): void {
    if (event === 'message') this.listeners.add(listener)
  }

  off(event: string, listener: (_event: unknown, method: string, params: Record<string, unknown>) => void): void {
    if (event === 'message') this.listeners.delete(listener)
  }

  emit(method: string, params: Record<string, unknown>): void {
    for (const listener of [...this.listeners]) listener({}, method, params)
  }
}

class FakeWebContents {
  readonly debugger = new FakeDebugger()
  private destroyedListener: (() => void) | undefined

  once(event: string, listener: () => void): void {
    if (event === 'destroyed') this.destroyedListener = listener
  }

  destroy(): void {
    this.destroyedListener?.()
  }
}

const request = (id: string, url: string) => ({
  requestId: id,
  request: { method: 'GET', url },
})

describe('CDP capture generations', () => {
  beforeEach(() => vi.clearAllMocks())

  it('discards pending requests on reactivation and prevents old responses from completing new requests', async () => {
    const wc = new FakeWebContents()
    const { getNetworkLogs, setBrowserCdpActivity, waitFor } = await import('../../src/main/browser-control')

    await setBrowserCdpActivity(wc as never, true)
    wc.debugger.emit('Network.requestWillBeSent', request('old', 'https://old.test'))

    await setBrowserCdpActivity(wc as never, false)
    await setBrowserCdpActivity(wc as never, true)

    // A late event from the previous generation must not fill a current-generation request ID.
    wc.debugger.emit('Network.responseReceived', {
      requestId: 'old',
      response: { status: 200, mimeType: 'text/html' },
    })
    const afterReactivate = await getNetworkLogs(wc as never)
    const oldEntry = afterReactivate.find((entry) => entry.url === 'https://old.test')
    expect(oldEntry).toMatchObject({ url: 'https://old.test' })
    expect(oldEntry).not.toHaveProperty('status')

    wc.debugger.emit('Network.requestWillBeSent', request('new', 'https://new.test'))
    wc.debugger.emit('Network.responseReceived', {
      requestId: 'new',
      response: { status: 201, mimeType: 'application/json' },
    })
    expect(await getNetworkLogs(wc as never)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ url: 'https://new.test', status: 201, mimeType: 'application/json' }),
      ])
    )
    wc.debugger.emit('Network.loadingFinished', { requestId: 'new' })

    // Without clearing the table, the old request would keep networkIdle false until timeout.
    await expect(waitFor(wc as never, { networkIdle: true, timeoutMs: 700 })).resolves.toMatchObject({ matched: true })
  })

  it('truncates huge entries and rotates console output within a UTF-8 budget', async () => {
    const wc = new FakeWebContents()
    const { BROWSER_CDP_MAX_BUFFER_BYTES, BROWSER_CDP_MAX_ENTRY_BYTES, getConsoleLogs, setBrowserCdpActivity } =
      await import('../../src/main/browser-control')
    await setBrowserCdpActivity(wc as never, true)

    for (let index = 0; index < 40; index++) {
      wc.debugger.emit('Runtime.consoleAPICalled', {
        type: 'log',
        args: [{ value: `${index}:` + '🚀'.repeat(BROWSER_CDP_MAX_ENTRY_BYTES) }],
      })
    }

    const logs = await getConsoleLogs(wc as never, { limit: 500 })
    expect(logs.length).toBeLessThan(40)
    expect(logs[0].text).not.toContain('0:')
    expect(logs.every((entry) => Buffer.byteLength(JSON.stringify(entry)) <= BROWSER_CDP_MAX_ENTRY_BYTES)).toBe(true)
    expect(Buffer.byteLength(JSON.stringify(logs))).toBeLessThanOrEqual(BROWSER_CDP_MAX_BUFFER_BYTES + 2)
  })

  it('bounds network and reqById by bytes and removes old pending requests in deterministic order', async () => {
    const wc = new FakeWebContents()
    const {
      BROWSER_CDP_MAX_BUFFER_BYTES,
      BROWSER_CDP_MAX_ENTRY_BYTES,
      getNetworkLogs,
      setBrowserCdpActivity,
      waitFor,
    } = await import('../../src/main/browser-control')
    await setBrowserCdpActivity(wc as never, true)

    for (let index = 0; index < 20; index++) {
      wc.debugger.emit(
        'Network.requestWillBeSent',
        request(String(index), `https://test/${index}/` + 'x'.repeat(40_000))
      )
    }
    const network = await getNetworkLogs(wc as never, { limit: 500 })
    expect(network.every((entry) => Buffer.byteLength(JSON.stringify(entry)) <= BROWSER_CDP_MAX_ENTRY_BYTES)).toBe(true)
    expect(network.every((entry) => entry.url.length < 40_000)).toBe(true)
    expect(Buffer.byteLength(JSON.stringify(network))).toBeLessThanOrEqual(BROWSER_CDP_MAX_BUFFER_BYTES + 2)

    wc.debugger.emit('Network.responseReceived', {
      requestId: '10',
      response: { status: 299, mimeType: 'text/old' },
    })
    wc.debugger.emit('Network.responseReceived', {
      requestId: '19',
      response: { status: 201, mimeType: 'text/new' },
    })
    const correlated = await getNetworkLogs(wc as never, { limit: 500 })
    expect(correlated.find((entry) => entry.url.includes('/19/'))).toMatchObject({ status: 201 })
    expect(correlated.find((entry) => entry.url.includes('/10/'))).not.toHaveProperty('status')

    // At most the newest byte-budgeted correlation records survive. Completing those must reach idle;
    // old evicted ids cannot keep networkIdle pinned forever.
    for (let index = 19; index >= 0; index--) {
      wc.debugger.emit('Network.loadingFinished', { requestId: String(index) })
    }
    await expect(waitFor(wc as never, { networkIdle: true, timeoutMs: 700 })).resolves.toMatchObject({ matched: true })
  })

  it('checks cancellation before continuing browser_wait_for polling', async () => {
    const wc = new FakeWebContents()
    const { waitFor } = await import('../../src/main/browser-control')
    const controller = new AbortController()
    controller.abort()

    await expect(
      waitFor(wc as never, { networkIdle: true, timeoutMs: 60_000, signal: controller.signal })
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(wc.debugger.attach).not.toHaveBeenCalled()
  })
})
