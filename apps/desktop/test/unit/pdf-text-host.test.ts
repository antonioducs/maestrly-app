import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * Host side of PDF text extraction: one utility process per PDF, killed after every outcome (reply, crash,
 * timeout or abort) so untrusted parsing never outlives its job.
 */
const h = vi.hoisted(() => {
  class FakeChild {
    stdout = { on: vi.fn() }
    stderr = { on: vi.fn() }
    postMessage = vi.fn()
    kill = vi.fn()
    private listeners = new Map<string, Array<(...args: never[]) => void>>()

    on(event: string, listener: (...args: never[]) => void): this {
      const listeners = this.listeners.get(event) ?? []
      listeners.push(listener)
      this.listeners.set(event, listeners)
      return this
    }

    emit(event: string, ...args: unknown[]): void {
      for (const listener of this.listeners.get(event) ?? []) listener(...(args as never[]))
    }
  }
  const children: FakeChild[] = []
  return {
    FakeChild,
    children,
    fork: vi.fn(() => {
      const child = new FakeChild()
      children.push(child)
      return child
    }),
  }
})

vi.mock('electron', () => ({ utilityProcess: { fork: h.fork } }))

const { extractPdfTextIsolated, pdfWorkerPath, PDF_EXTRACTION_TIMEOUT_MS } = await import(
  '../../src/main/chat/pdf-text'
)

const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])
const latest = (): InstanceType<typeof h.FakeChild> => {
  const child = h.children.at(-1)
  if (!child) throw new Error('worker not forked')
  return child
}

afterEach(() => {
  vi.useRealTimers()
  h.children.length = 0
  h.fork.mockClear()
})

describe('extractPdfTextIsolated', () => {
  it('forks the pdf-worker entry, posts one job and kills the process after the result', async () => {
    const pending = extractPdfTextIsolated(bytes, { maxTextBytes: 1234 })
    const child = latest()

    expect(h.fork).toHaveBeenCalledWith(pdfWorkerPath(), [], expect.anything())
    expect(child.postMessage).toHaveBeenCalledWith({ bytes, maxTextBytes: 1234 })

    child.emit('message', { type: 'result', pageCount: 1, text: 'x', truncated: false })

    await expect(pending).resolves.toEqual({ ok: true, pageCount: 1, text: 'x', truncated: false })
    expect(child.kill).toHaveBeenCalled()
  })

  it('maps worker extraction errors', async () => {
    const pending = extractPdfTextIsolated(bytes, { maxTextBytes: 10 })
    latest().emit('message', { type: 'error', code: 'encrypted' })

    await expect(pending).resolves.toEqual({ ok: false, error: 'encrypted' })
  })

  it('treats unknown worker error codes as corrupt', async () => {
    const pending = extractPdfTextIsolated(bytes, { maxTextBytes: 10 })
    latest().emit('message', { type: 'error', code: 'something-else' })

    await expect(pending).resolves.toEqual({ ok: false, error: 'corrupt' })
  })

  it('reports a crash when the process exits before replying', async () => {
    const pending = extractPdfTextIsolated(bytes, { maxTextBytes: 10 })
    latest().emit('exit', 1)

    await expect(pending).resolves.toEqual({ ok: false, error: 'crashed' })
  })

  it('kills the process when extraction exceeds the timeout', async () => {
    vi.useFakeTimers()
    const pending = extractPdfTextIsolated(bytes, { maxTextBytes: 10, timeoutMs: 1000 })
    const child = latest()

    await vi.advanceTimersByTimeAsync(1000)

    await expect(pending).resolves.toEqual({ ok: false, error: 'timeout' })
    expect(child.kill).toHaveBeenCalled()
  })

  it('resolves the worker next to the main bundle, not from the app path', () => {
    // In the build this module is bundled into out/main/index.js, beside out/main/pdf-worker.js.
    expect(pdfWorkerPath()).toBe(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '../../src/main/chat/pdf-worker.js')
    )
  })

  it('uses a 20 second default timeout', () => {
    expect(PDF_EXTRACTION_TIMEOUT_MS).toBe(20_000)
  })

  it('kills the process when the send is aborted', async () => {
    const controller = new AbortController()
    const pending = extractPdfTextIsolated(bytes, { maxTextBytes: 10, signal: controller.signal })
    const child = latest()

    controller.abort()

    await expect(pending).resolves.toEqual({ ok: false, error: 'aborted' })
    expect(child.kill).toHaveBeenCalled()
  })

  it('does not fork when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(extractPdfTextIsolated(bytes, { maxTextBytes: 10, signal: controller.signal })).resolves.toEqual({
      ok: false,
      error: 'aborted',
    })
    expect(h.fork).not.toHaveBeenCalled()
  })
})
