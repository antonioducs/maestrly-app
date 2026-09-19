import { describe, expect, it, vi } from 'vitest'
import { awaitCursorOperation, closeCursorLease } from '../../src/main/chat/cursor-subscription/watchdog'

describe('Cursor startup and send ownership', () => {
  it.each(['create', 'resume', 'send'])('cancels %s promptly and cleans its late handle exactly once', async () => {
    const controller = new AbortController()
    let resolve!: (handle: { close(): void }) => void
    const operation = new Promise<{ close(): void }>((done) => {
      resolve = done
    })
    const close = vi.fn()
    const cleanup = vi.fn(async (value) => {
      value?.close()
    })
    const abandoned = vi.fn()
    const result = awaitCursorOperation(operation, {
      signal: controller.signal,
      onAbandon: abandoned,
      onLateSettled: cleanup,
    })
    const rejection = expect(result).rejects.toThrow()
    controller.abort()
    await rejection
    expect(abandoned).toHaveBeenCalledTimes(1)
    expect(cleanup).not.toHaveBeenCalled()
    resolve({ close })
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1))
    expect(cleanup).toHaveBeenCalledTimes(1)
  })

  it('retains the send lease until late rejection settles', async () => {
    vi.useFakeTimers()
    try {
      let reject!: (reason: Error) => void
      const operation = new Promise<never>((_, fail) => {
        reject = fail
      })
      const release = vi.fn()
      const result = awaitCursorOperation(operation, {
        signal: new AbortController().signal,
        timeoutMs: 10,
        onLateSettled: async () => {
          release()
        },
      })
      const rejection = expect(result).rejects.toThrow('deadline')
      await vi.advanceTimersByTimeAsync(10)
      await rejection
      expect(release).not.toHaveBeenCalled()
      reject(new Error('late send failure'))
      await vi.advanceTimersByTimeAsync(0)
      expect(release).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not release a store still owned by an agent whose close failed', async () => {
    const release = vi.fn()
    await expect(
      closeCursorLease({
        agent: {
          close() {
            throw new Error('close failed')
          },
        },
        release,
      })
    ).rejects.toThrow('close failed')
    expect(release).not.toHaveBeenCalled()
  })
})
