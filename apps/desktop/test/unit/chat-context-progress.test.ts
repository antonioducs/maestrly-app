import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatStreamEvent } from '../../src/shared/chat'
import { createContextProgressPublisher } from '../../src/main/chat/context-progress'

function setup() {
  const events: ChatStreamEvent[] = []
  const diagnostic = vi.fn()
  const publisher = createContextProgressPublisher({
    messageId: 'assistant',
    model: { providerId: 'logical-provider', modelId: 'logical-model' },
    apply: (event) => events.push(event),
    sanitizeError: (error) => String((error as Error).message).replace('secret', '[REDACTED]'),
    onCompactionError: diagnostic,
  })
  return {
    publisher,
    diagnostic,
    events,
    samples: () => events.filter((event) => event.kind === 'context-usage').map((event) => event.snapshot),
    progress: () => events.filter((event) => event.kind === 'compaction-progress').map((event) => event.progress),
  }
}

describe('assistant context progress publisher', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('publishes the first observation immediately and the latest within one second', () => {
    const { publisher, samples } = setup()
    const observe = publisher.observeAttempt()
    observe({ usedTokens: 100, quality: 'measured' })
    expect(samples()).toMatchObject([{ usedTokens: 100, sequence: 1 }])
    vi.advanceTimersByTime(200)
    observe({ usedTokens: 200, quality: 'measured' })
    vi.advanceTimersByTime(200)
    observe({ usedTokens: 300, modelContextWindow: 1_000, quality: 'measured' })
    vi.advanceTimersByTime(599)
    expect(samples()).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(samples().at(-1)).toMatchObject({
      usedTokens: 300,
      sequence: 3,
      modelContextWindow: 1_000,
      model: { providerId: 'logical-provider', modelId: 'logical-model' },
    })
    publisher.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('flushes at attempt boundaries, accepts decreases, and rejects old or disposed observers', () => {
    const { publisher, samples } = setup()
    const old = publisher.observeAttempt()
    old({ usedTokens: 800, quality: 'measured' })
    old({ usedTokens: 900, quality: 'measured' })
    const current = publisher.observeAttempt()
    expect(samples().at(-1)?.usedTokens).toBe(900)
    current({ usedTokens: 100, quality: 'measured' })
    old({ usedTokens: 999, quality: 'measured' })
    publisher.dispose()
    expect(samples().map((sample) => [sample.usedTokens, sample.sequence])).toEqual([
      [800, 1],
      [900, 2],
      [100, 3],
    ])
    current({ usedTokens: 888, quality: 'measured' })
    vi.advanceTimersByTime(2_000)
    expect(samples()).toHaveLength(3)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('publishes stages before success and waits for a fresh sample to measure the reduction', async () => {
    const { publisher, samples, progress } = setup()
    const old = publisher.observeAttempt()
    old({ usedTokens: 900, quality: 'measured' })
    await publisher.compact(
      async (report) => {
        expect(progress().at(-1)).toMatchObject({ status: 'running', beforeTokens: 900 })
        report({ status: 'retrying', phase: 'chunk', completed: 1, total: 3, attempt: 2 })
        report({ status: 'running', phase: 'consolidate', completed: 0, total: 1, attempt: 1 })
        return 'summary'
      },
      { signal: new AbortController().signal, failureMessage: 'failed' }
    )
    expect(progress().map((value) => value.status)).toEqual(['running', 'retrying', 'running', 'completed'])
    expect(progress().at(-1)).not.toHaveProperty('afterTokens')
    expect(samples()).toHaveLength(1)
    old({ usedTokens: 999, quality: 'measured' })
    publisher.observeAttempt()({ usedTokens: 150, quality: 'measured' })
    publisher.flush()
    expect(progress().at(-1)).toMatchObject({
      status: 'completed',
      beforeTokens: 900,
      afterTokens: 150,
      afterQuality: 'measured',
    })
    publisher.dispose()
  })

  it.each([false, true])('preserves the last measurement and original error when cancelled=%s', async (cancelled) => {
    const { publisher, samples, progress, diagnostic } = setup()
    publisher.observeAttempt()({ usedTokens: 900, quality: 'measured' })
    const controller = new AbortController()
    const error = new Error('summarizer rejected secret')
    await expect(
      publisher.compact(
        async () => {
          if (cancelled) controller.abort()
          throw error
        },
        { signal: controller.signal, failureMessage: 'generic failure' }
      )
    ).rejects.toBe(error)
    expect(progress().at(-1)).toMatchObject({ status: cancelled ? 'cancelled' : 'failed', beforeTokens: 900 })
    if (!cancelled) expect(progress().at(-1)?.error).toBe('summarizer rejected [REDACTED]')
    expect(progress().at(-1)).not.toHaveProperty('afterTokens')
    expect(samples()).toHaveLength(1)
    expect(samples()[0].usedTokens).toBe(900)
    expect(diagnostic).toHaveBeenCalledWith('summarizer rejected [REDACTED]', cancelled)
    publisher.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([false, true])('keeps the current observer live for native compaction with an inline sample=%s', (inline) => {
    const { publisher, samples, progress } = setup()
    const observe = publisher.observeAttempt()
    observe({ usedTokens: 900, quality: 'measured' })
    const native = publisher.beginNative()
    expect(progress().at(-1)).toMatchObject({ status: 'running', phase: 'native', beforeTokens: 900 })
    const after = { usedTokens: 150, quality: 'measured' as const }
    native.complete(inline ? after : undefined)
    if (!inline) {
      expect(progress().at(-1)).not.toHaveProperty('afterTokens')
      observe(after)
      publisher.flush()
    }
    expect(progress().at(-1)).toMatchObject({ status: 'completed', afterTokens: 150, afterQuality: 'measured' })
    const completedCount = progress().length
    native.complete({ usedTokens: 999, quality: 'measured' })
    native.fail(new Error('late failure'), false)
    expect(progress()).toHaveLength(completedCount)
    observe({ usedTokens: 250, quality: 'measured' })
    publisher.flush()
    expect(samples().at(-1)?.usedTokens).toBe(250)
    expect(progress().at(-1)?.afterTokens).toBe(150)
    publisher.dispose()
  })

  it.each([
    false,
    true,
  ])('settles external native failure once with its sanitized reason when cancelled=%s', (cancelled) => {
    const { publisher, samples, progress, diagnostic } = setup()
    const observe = publisher.observeAttempt()
    observe({ usedTokens: 900, quality: 'measured' })
    const native = publisher.beginNative()
    native.fail(new Error('native rejected secret'), cancelled)
    native.complete({ usedTokens: 100, quality: 'measured' })
    native.fail(new Error('late failure'), false)
    expect(progress()).toHaveLength(2)
    expect(progress().at(-1)).toMatchObject({
      status: cancelled ? 'cancelled' : 'failed',
      error: 'native rejected [REDACTED]',
      beforeTokens: 900,
    })
    expect(progress().at(-1)).not.toHaveProperty('afterTokens')
    expect(samples().at(-1)?.usedTokens).toBe(900)
    expect(diagnostic).toHaveBeenCalledExactlyOnceWith('native rejected [REDACTED]', cancelled)
    observe({ usedTokens: 950, quality: 'measured' })
    publisher.dispose()
    expect(samples().at(-1)?.usedTokens).toBe(950)
    expect(progress().at(-1)).not.toHaveProperty('afterTokens')
    expect(vi.getTimerCount()).toBe(0)
  })
})
