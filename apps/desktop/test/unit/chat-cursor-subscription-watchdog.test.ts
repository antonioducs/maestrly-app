import { describe, expect, it, vi } from 'vitest'
import type { RunResult, SDKMessage } from '@cursor/sdk'
import { runCursorRunWithWatchdog } from '../../src/main/chat/cursor-subscription/watchdog'

function message(type: string, data: Record<string, unknown> = {}): SDKMessage {
  return { type, agent_id: 'a', run_id: 'r', ...data } as unknown as SDKMessage
}

const never = <T>(): Promise<T> => new Promise<T>(() => {})

function harness() {
  return {
    cancel: vi.fn(async () => undefined),
    onMessage: vi.fn<(message: SDKMessage) => void>(),
    wait: vi.fn(async () => ({ id: 'run-1', status: 'finished' }) as RunResult),
  }
}

describe('runCursorRunWithWatchdog', () => {
  it('bounds a stream that never finishes and cancels exactly once', async () => {
    const h = harness()
    const outcome = await runCursorRunWithWatchdog({
      stream: () =>
        (async function* () {
          yield message('assistant', { message: { role: 'assistant', content: [{ type: 'text', text: '1' }] } })
          await never()
        })(),
      wait: h.wait,
      cancel: h.cancel,
      onMessage: h.onMessage,
      signal: new AbortController().signal,
      timeoutMs: 20,
      graceMs: 20,
    })
    expect(outcome.stalled).toBe('stream')
    expect(outcome.waitResult).toBeUndefined()
    expect(h.cancel).toHaveBeenCalledTimes(1)
    expect(h.onMessage).toHaveBeenCalledTimes(1)

    expect(h.wait).not.toHaveBeenCalled()
  })

  it('bounds wait after a completed stream and cancels exactly once', async () => {
    const h = harness()
    h.wait.mockImplementation(() => never())
    const outcome = await runCursorRunWithWatchdog({
      stream: () =>
        (async function* () {
          yield message('status', { status: 'FINISHED' })
        })(),
      wait: h.wait,
      cancel: h.cancel,
      onMessage: h.onMessage,
      signal: new AbortController().signal,
      timeoutMs: 20,
      graceMs: 20,
    })
    expect(outcome.stalled).toBe('wait')
    expect(outcome.waitResult).toBeUndefined()
    expect(h.cancel).toHaveBeenCalledTimes(1)
  })

  it('abandons locally after the cancellation grace period expires', async () => {
    const h = harness()
    const outcome = await runCursorRunWithWatchdog({
      stream: () =>
        (async function* () {
          yield message('assistant', { message: { role: 'assistant', content: [{ type: 'text', text: '1' }] } })

          await never()
        })(),
      wait: h.wait,
      cancel: h.cancel,
      onMessage: h.onMessage,
      signal: new AbortController().signal,
      timeoutMs: 15,
      graceMs: 15,
    })
    expect(outcome.stalled).toBe('stream')
    expect(outcome.cancelInvoked).toBe(true)
    expect(h.cancel).toHaveBeenCalledTimes(1)
    // Bounded: retornou mesmo com o runtime pendurado para sempre.
  })

  it('drains in-flight output after abort without reporting a stall', async () => {
    const controller = new AbortController()
    const h = harness()
    const outcome = await runCursorRunWithWatchdog({
      stream: () =>
        (async function* () {
          yield message('assistant', { message: { role: 'assistant', content: [{ type: 'text', text: '1' }] } })
          controller.abort()
          yield message('status', { status: 'CANCELLED' })
        })(),
      wait: h.wait,
      cancel: h.cancel,
      onMessage: h.onMessage,
      signal: controller.signal,
      timeoutMs: 1000,
      graceMs: 1000,
    })
    expect(outcome.aborted).toBe(true)
    expect(outcome.stalled).toBeNull()
    expect(outcome.abortGraceExpired).toBeNull()
    expect(outcome.cancelInvoked).toBe(true)
    expect(h.cancel).toHaveBeenCalledTimes(1)

    expect(h.onMessage).toHaveBeenCalledTimes(2)

    expect(controller.signal.aborted).toBe(true)
  })

  it('bounds cancellation of an unresponsive runtime without inventing a stall', async () => {
    const controller = new AbortController()
    const h = harness()
    const abortTimer = setTimeout(() => controller.abort(), 10)
    const startedAt = Date.now()
    try {
      const outcome = await runCursorRunWithWatchdog({
        stream: () =>
          (async function* () {
            yield message('assistant', { message: { role: 'assistant', content: [{ type: 'text', text: '1' }] } })
            await never()
          })(),
        wait: h.wait,
        cancel: h.cancel,
        onMessage: h.onMessage,
        signal: controller.signal,
        timeoutMs: 10_000,
        graceMs: 15,
      })

      expect(Date.now() - startedAt).toBeLessThan(1_000)
      expect(outcome.aborted).toBe(true)
      expect(outcome.stalled).toBeNull()
      expect(outcome.abortGraceExpired).toBe('stream')
      expect(h.cancel).toHaveBeenCalledTimes(1)
      expect(h.wait).not.toHaveBeenCalled()
    } finally {
      clearTimeout(abortTimer)
    }
  })

  it('bounds stream abort by the grace period rather than inactivity timeout', async () => {
    const controller = new AbortController()
    const h = harness()
    const abortTimer = setTimeout(() => controller.abort(), 5)
    const startedAt = Date.now()
    try {
      const outcome = await runCursorRunWithWatchdog({
        stream: () =>
          (async function* () {
            yield message('assistant', { message: { role: 'assistant', content: [{ type: 'text', text: '1' }] } })
            await never()
          })(),
        wait: h.wait,
        cancel: h.cancel,
        onMessage: h.onMessage,
        signal: controller.signal,
        timeoutMs: 10_000,
        graceMs: 20,
      })

      expect(Date.now() - startedAt).toBeLessThan(1_000)
      expect(outcome.aborted).toBe(true)
      expect(outcome.stalled).toBeNull()
      expect(outcome.abortGraceExpired).toBe('stream')
      expect(h.cancel).toHaveBeenCalledTimes(1)
      expect(h.wait).not.toHaveBeenCalled()
      expect(h.onMessage).toHaveBeenCalledTimes(1)
    } finally {
      clearTimeout(abortTimer)
    }
  })

  it('bounds wait abort by the grace period and cancels once', async () => {
    const controller = new AbortController()
    const h = harness()
    h.wait.mockImplementation(() => never())
    const abortTimer = setTimeout(() => controller.abort(), 5)
    const startedAt = Date.now()
    try {
      const outcome = await runCursorRunWithWatchdog({
        stream: () =>
          (async function* () {
            yield message('status', { status: 'FINISHED' })
          })(),
        wait: h.wait,
        cancel: h.cancel,
        onMessage: h.onMessage,
        signal: controller.signal,
        timeoutMs: 10_000,
        graceMs: 20,
      })
      expect(Date.now() - startedAt).toBeLessThan(1_000)
      expect(outcome.aborted).toBe(true)
      expect(outcome.stalled).toBeNull()
      expect(outcome.abortGraceExpired).toBe('wait')
      expect(outcome.waitResult).toBeUndefined()
      expect(h.cancel).toHaveBeenCalledTimes(1)
    } finally {
      clearTimeout(abortTimer)
    }
  })

  it('cancels exactly once when abort races the watchdog and removes timers', async () => {
    const controller = new AbortController()
    const h = harness()
    const removeSpy = vi.spyOn(controller.signal, 'removeEventListener')

    const abortTimer = setTimeout(() => controller.abort(), 25)
    try {
      const outcome = await runCursorRunWithWatchdog({
        stream: () =>
          (async function* () {
            yield message('assistant', { message: { role: 'assistant', content: [{ type: 'text', text: '1' }] } })
            await never()
          })(),
        wait: h.wait,
        cancel: h.cancel,
        onMessage: h.onMessage,
        signal: controller.signal,
        timeoutMs: 30,
        graceMs: 10,
      })

      expect(h.cancel).toHaveBeenCalledTimes(1)
      expect(outcome.aborted || outcome.stalled === 'stream').toBe(true)
      expect(outcome.abortGraceExpired === 'stream' || outcome.stalled === 'stream').toBe(true)

      expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function))
      controller.abort()
      expect(h.cancel).toHaveBeenCalledTimes(1)
    } finally {
      clearTimeout(abortTimer)
    }
  })

  it('returns promptly when the runtime responds within cancellation grace', async () => {
    const controller = new AbortController()
    const h = harness()
    const abortTimer = setTimeout(() => controller.abort(), 5)
    const startedAt = Date.now()
    try {
      const outcome = await runCursorRunWithWatchdog({
        stream: () =>
          (async function* () {
            yield message('assistant', { message: { role: 'assistant', content: [{ type: 'text', text: '1' }] } })

            await new Promise((resolve) => setTimeout(resolve, 80))
            yield message('status', { status: 'CANCELLED' })
          })(),
        wait: h.wait,
        cancel: h.cancel,
        onMessage: h.onMessage,
        signal: controller.signal,
        timeoutMs: 10_000,
        graceMs: 500,
      })

      expect(Date.now() - startedAt).toBeLessThan(300)
      expect(outcome.aborted).toBe(true)
      expect(outcome.abortGraceExpired).toBeNull()
      expect(h.onMessage).toHaveBeenCalledTimes(2)
      expect(h.cancel).toHaveBeenCalledTimes(1)
    } finally {
      clearTimeout(abortTimer)
    }
  })

  it('runs wait directly when streaming is unsupported', async () => {
    const h = harness()
    h.wait.mockImplementation(() => never())
    const outcome = await runCursorRunWithWatchdog({
      wait: h.wait,
      cancel: h.cancel,
      onMessage: h.onMessage,
      signal: new AbortController().signal,
      timeoutMs: 15,
      graceMs: 15,
    })
    expect(outcome.stalled).toBe('wait')
    expect(h.wait).toHaveBeenCalledTimes(1)
  })

  it('delivers messages and terminal results without cancelling normal runs', async () => {
    const h = harness()
    const outcome = await runCursorRunWithWatchdog({
      stream: () =>
        (async function* () {
          yield message('assistant', { message: { role: 'assistant', content: [{ type: 'text', text: '1' }] } })
          yield message('status', { status: 'FINISHED' })
        })(),
      wait: h.wait,
      cancel: h.cancel,
      onMessage: h.onMessage,
      signal: new AbortController().signal,
      timeoutMs: 1000,
      graceMs: 1000,
    })
    expect(outcome.stalled).toBeNull()
    expect(outcome.waitResult).toMatchObject({ status: 'finished' })
    expect(h.cancel).not.toHaveBeenCalled()
    expect(h.onMessage).toHaveBeenCalledTimes(2)
  })
})

describe('Cursor active time budgets', () => {
  it('enforces an absolute deadline despite continuous stream activity', async () => {
    vi.useFakeTimers()
    try {
      const h = harness()
      const pending = runCursorRunWithWatchdog({
        ...h,
        signal: new AbortController().signal,
        timeoutMs: 50,
        deadlineMs: 120,
        graceMs: 5,
        stream: async function* () {
          for (;;) {
            await new Promise((resolve) => setTimeout(resolve, 10))
            yield message('assistant')
          }
        },
      })
      await vi.advanceTimersByTimeAsync(130)
      expect(await pending).toMatchObject({ stalled: 'stream', timeoutKind: 'deadline' })
      expect(h.cancel).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('suspends inactivity and absolute budgets only while host input is pending', async () => {
    vi.useFakeTimers()
    try {
      let hostPending = true
      const h = harness()
      const pending = runCursorRunWithWatchdog({
        ...h,
        signal: new AbortController().signal,
        timeoutMs: 50,
        deadlineMs: 120,
        graceMs: 5,
        isHostPending: () => hostPending,
        stream: async function* () {
          await never<void>()
        },
      })
      await vi.advanceTimersByTimeAsync(1_000)
      expect(h.cancel).not.toHaveBeenCalled()
      hostPending = false
      await vi.advanceTimersByTimeAsync(160)
      expect(await pending).toMatchObject({ stalled: 'stream', timeoutKind: 'inactivity' })
    } finally {
      vi.useRealTimers()
    }
  })
})
