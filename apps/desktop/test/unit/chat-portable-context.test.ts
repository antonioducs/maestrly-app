import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage } from '../../src/shared/chat'
import {
  estimateNativeSeedContextTokens,
  estimatePortableContextTokens,
  portableContextLoad,
  portableContextOutputReserveTokens,
  portableContextReserveTokens,
  preflightContextLoad,
  splitPortableTranscript,
  summarizePortableTranscript,
  type PortableSummaryCallResult,
  type PortableSummaryProgress,
} from '../../src/main/chat/portable-context'
import { openAINativeCompactionMarkerPart } from '../../src/main/chat/message'

function message(id: string, role: 'user' | 'assistant', text: string, createdAt: number): ChatMessage {
  return {
    id,
    conversationId: 'conversation',
    role,
    parts: [{ type: 'text', id: `${id}-text`, text }],
    createdAt,
  }
}

describe('portable context', () => {
  it('rebuilds all history when only a native checkpoint exists', () => {
    const prefix = message('before', 'user', 'A'.repeat(3_000), 1)
    const checkpoint: ChatMessage = {
      id: 'native',
      conversationId: 'conversation',
      role: 'assistant',
      parts: [openAINativeCompactionMarkerPart('native-part')],
      createdAt: 2,
    }
    const suffix = message('after', 'assistant', 'B'.repeat(3_000), 3)

    expect(estimatePortableContextTokens([prefix, checkpoint, suffix])).toBeGreaterThan(1_900)
  })

  it('uses only the summary and suffix after a portable text marker', () => {
    const prefix = message('before', 'user', 'A'.repeat(30_000), 1)
    const marker: ChatMessage = {
      id: 'portable',
      conversationId: 'conversation',
      role: 'assistant',
      parts: [{ type: 'compaction', id: 'portable-part', text: 'portable summary' }],
      createdAt: 2,
    }
    const suffix = message('after', 'user', 'small suffix', 3)

    expect(estimatePortableContextTokens([prefix, marker, suffix])).toBeLessThan(100)
  })

  it('projects native reseeding with the same limits applied to tool outputs', () => {
    const toolHeavy: ChatMessage = {
      id: 'assistant-tool-heavy',
      conversationId: 'conversation',
      role: 'assistant',
      parts: [
        {
          type: 'tool',
          id: 'tool-part',
          toolCallId: 'tool-call',
          toolName: 'bash',
          input: { command: 'huge-output' },
          state: { status: 'completed', output: 'x'.repeat(1_200_000) },
        },
      ],
      createdAt: 1,
    }

    expect(estimatePortableContextTokens([toolHeavy])).toBeGreaterThan(390_000)
    expect(estimateNativeSeedContextTokens([toolHeavy])).toBeLessThan(6_000)
  })

  it('splits without losing or duplicating the middle', () => {
    const source = Array.from({ length: 20_000 }, (_, index) => `${index % 10}`).join('')
    const chunks = splitPortableTranscript(source, 1_337)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.join('')).toBe(source)
  })

  it('summarizes every block and consolidates in isolated calls', async () => {
    const seen: string[] = []
    const summarize = vi.fn(async (prompt: string, phase: 'chunk' | 'consolidate') => {
      seen.push(prompt)
      return {
        text: phase === 'chunk' ? `chunk:${prompt.slice(-20)}` : `final:${prompt.length}`,
        usage: { input: 10, output: 2, cacheRead: 0, cacheCreate: 0, totalInput: 10 },
        runtimeEstimatedCostUsd: 0.001,
      }
    })

    const result = await summarizePortableTranscript('x'.repeat(5_000), 1_000, summarize)

    expect(seen.filter((prompt) => prompt.startsWith('Source chunk'))).toHaveLength(5)
    expect(result.summary).toMatch(/^final:/)
    expect(result.calls).toBeGreaterThan(5)
    expect(result.usage?.totalInput).toBe(result.calls * 10)
    expect(result.runtimeEstimatedCostUsd).toBeCloseTo(result.calls * 0.001, 10)
  })

  describe('summary stage recovery', () => {
    const attemptUsage = { input: 10, output: 2, cacheRead: 3, cacheCreate: 1, totalInput: 14 }
    const measured = (text = 'summary'): PortableSummaryCallResult => ({
      text,
      usage: { ...attemptUsage },
      runtimeEstimatedCostUsd: 0.01,
    })

    beforeEach(() => vi.useFakeTimers())
    afterEach(() => {
      const timers = vi.getTimerCount()
      vi.useRealTimers()
      expect(timers).toBe(0)
    })

    it('allows a complete multi-stage summary to take longer than ten minutes', async () => {
      const summarize = vi.fn(
        () => new Promise<PortableSummaryCallResult>((resolve) => setTimeout(() => resolve(measured()), 120_000))
      )
      const pending = summarizePortableTranscript('x'.repeat(7_000), 1_000, summarize)

      await vi.advanceTimersByTimeAsync(16 * 60_000)

      expect(await pending).toMatchObject({ summary: 'summary', calls: 8 })
      expect(summarize).toHaveBeenCalledTimes(8)
    })

    it('retries only the timed-out chunk with a fresh signal and reports level progress', async () => {
      const progress: PortableSummaryProgress[] = []
      const signals: AbortSignal[] = []
      const summarize = vi.fn((_prompt: string, _phase: string, signal?: AbortSignal) => {
        signals.push(signal!)
        return signals.length === 2 ? new Promise<PortableSummaryCallResult>(() => {}) : Promise.resolve(measured())
      })
      const pending = summarizePortableTranscript('a'.repeat(1_000) + 'b'.repeat(1_000), 1_000, summarize, {
        stepTimeoutMs: 100,
        onProgress: (value) => progress.push(value),
      })

      await vi.advanceTimersByTimeAsync(100)

      expect(await pending).toMatchObject({ summary: 'summary', calls: 4 })
      expect(summarize.mock.calls.map(([prompt]) => prompt.split(':')[0])).toEqual([
        'Source chunk 1/2',
        'Source chunk 2/2',
        'Source chunk 2/2',
        'Summary group 1/1',
      ])
      expect(signals[1].aborted).toBe(true)
      expect(signals[2].aborted).toBe(false)
      expect(signals[1]).not.toBe(signals[2])
      expect(progress).toEqual([
        { status: 'running', phase: 'chunk', completed: 0, total: 2, attempt: 1 },
        { status: 'running', phase: 'chunk', completed: 1, total: 2, attempt: 1 },
        { status: 'running', phase: 'chunk', completed: 1, total: 2, attempt: 1 },
        { status: 'retrying', phase: 'chunk', completed: 1, total: 2, attempt: 2 },
        { status: 'running', phase: 'chunk', completed: 2, total: 2, attempt: 2 },
        { status: 'running', phase: 'consolidate', completed: 0, total: 1, attempt: 1 },
        { status: 'running', phase: 'consolidate', completed: 1, total: 1, attempt: 1 },
      ])
    })

    it('stops promptly on cancellation even when the callback ignores its signal', async () => {
      const controller = new AbortController()
      const reason = new Error('Cancelled by the user')
      const onProgress = vi.fn()
      let rejectAttempt!: (error: Error) => void
      const summarize = vi.fn((_prompt: string, _phase: string, _signal?: AbortSignal) =>
        summarize.mock.calls.length === 1
          ? Promise.resolve(measured())
          : new Promise<PortableSummaryCallResult>((_resolve, reject) => {
              rejectAttempt = reject
            })
      )
      const pending = summarizePortableTranscript('x'.repeat(3_000), 1_000, summarize, {
        signal: controller.signal,
        onProgress,
      })
      const failure = pending.catch((error: unknown) => error)
      await vi.advanceTimersByTimeAsync(0)
      controller.abort(reason)

      expect(await failure).toMatchObject({ message: reason.message, partialUsage: attemptUsage })
      expect(reason).not.toHaveProperty('partialUsage')
      const progressCount = onProgress.mock.calls.length
      rejectAttempt(new Error('Late provider rejection'))
      await vi.runAllTimersAsync()
      expect(summarize).toHaveBeenCalledTimes(2)
      expect(onProgress).toHaveBeenCalledTimes(progressCount)
      expect(summarize.mock.calls[1][2]?.aborted).toBe(true)
    })

    it('does not start work or progress for an already-cancelled request', async () => {
      const controller = new AbortController()
      controller.abort()
      const summarize = vi.fn(async () => measured())
      const onProgress = vi.fn()
      await expect(
        summarizePortableTranscript('source', 1_000, summarize, { signal: controller.signal, onProgress })
      ).rejects.toMatchObject({ name: 'AbortError' })
      expect(summarize).not.toHaveBeenCalled()
      expect(onProgress).not.toHaveBeenCalled()
    })

    it('honors cancellation from progress before dispatching the next stage', async () => {
      const controller = new AbortController()
      const summarize = vi.fn(async () => measured())
      const onProgress = vi.fn((progress: PortableSummaryProgress) => {
        if (progress.completed === 1) controller.abort()
      })
      await expect(
        summarizePortableTranscript('x'.repeat(2_000), 1_000, summarize, { signal: controller.signal, onProgress })
      ).rejects.toMatchObject({ name: 'AbortError', partialUsage: attemptUsage, runtimeEstimatedCostUsd: 0.01 })
      expect(summarize).toHaveBeenCalledTimes(1)
      expect(onProgress).toHaveBeenCalledTimes(2)
    })

    it.each([
      Object.assign(new Error('network authentication failed'), { statusCode: 401 }),
      Object.assign(new Error('Forbidden'), { status: 403 }),
      Object.assign(new Error('network configuration invalid'), { name: 'ChatConfigError' }),
      new Error('Missing API key'),
      new Error('Authentication failed'),
      new Error('API key is invalid'),
      new Error('Permission denied'),
      new Error('Model not found'),
      new DOMException('Aborted', 'AbortError'),
      new Error('Provider failed', { cause: Object.assign(new Error('Unauthorized'), { statusCode: 401 }) }),
    ])('never retries authentication, configuration, or abort errors: %s', async (error) => {
      const summarize = vi.fn().mockRejectedValue(error)
      const shouldRetry = vi.fn(() => true)
      await expect(summarizePortableTranscript('source', 1_000, summarize, { shouldRetry })).rejects.toThrow(
        error.message
      )
      expect(summarize).toHaveBeenCalledTimes(1)
      expect(shouldRetry).not.toHaveBeenCalled()
    })

    it.each([
      Object.assign(new Error('Service unavailable'), { statusCode: 503 }),
      Object.assign(new Error('Connection lost'), { code: 'ECONNRESET' }),
      new TypeError('fetch failed'),
      new Error('Provider failed', { cause: Object.assign(new Error('Connection lost'), { code: 'ECONNRESET' }) }),
    ])('retries a transient failure and retains its usage exactly once: %s', async (error) => {
      const billedError = Object.assign(error, { partialUsage: { ...attemptUsage }, runtimeEstimatedCostUsd: 0.02 })
      const summarize = vi.fn().mockRejectedValueOnce(billedError).mockResolvedValueOnce(measured())

      const result = await summarizePortableTranscript('source', 1_000, summarize)

      expect(result).toMatchObject({
        summary: 'summary',
        calls: 2,
        usage: { input: 20, output: 4, cacheRead: 6, cacheCreate: 2, totalInput: 28 },
        runtimeEstimatedCostUsd: 0.03,
      })
      expect(billedError.partialUsage).toEqual(attemptUsage)
    })

    it('allows the caller to classify provider-specific transient errors', async () => {
      const error = new Error('Provider warming up')
      const shouldRetry = vi.fn(() => true)
      const summarize = vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce(measured())
      expect(await summarizePortableTranscript('source', 1_000, summarize, { shouldRetry })).toMatchObject({ calls: 2 })
      expect(shouldRetry).toHaveBeenCalledWith(error)
    })

    it('does not retry unclassified failures by default', async () => {
      const summarize = vi.fn().mockRejectedValue(new Error('Unexpected provider response'))
      await expect(summarizePortableTranscript('source', 1_000, summarize)).rejects.toThrow(
        'Unexpected provider response'
      )
      expect(summarize).toHaveBeenCalledTimes(1)
    })

    it('lets the caller veto transient retries while retaining failed-attempt billing', async () => {
      const error = Object.assign(new Error('network error'), { partialUsage: attemptUsage })
      const summarize = vi.fn().mockRejectedValue(error)
      const shouldRetry = vi.fn(() => false)
      await expect(summarizePortableTranscript('source', 1_000, summarize, { shouldRetry })).rejects.toMatchObject({
        partialUsage: attemptUsage,
      })
      expect(summarize).toHaveBeenCalledTimes(1)
      expect(shouldRetry).toHaveBeenCalledWith(error)
    })

    it('accounts for a timed-out attempt that rejects while its retry is still running', async () => {
      let rejectFirst!: (error: Error) => void
      let resolveRetry!: (result: PortableSummaryCallResult) => void
      const summarize = vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<PortableSummaryCallResult>((_resolve, reject) => {
              rejectFirst = reject
            })
        )
        .mockImplementationOnce(
          () =>
            new Promise<PortableSummaryCallResult>((resolve) => {
              resolveRetry = resolve
            })
        )
      const pending = summarizePortableTranscript('source', 1_000, summarize, { stepTimeoutMs: 100 })
      await vi.advanceTimersByTimeAsync(100)
      rejectFirst(
        Object.assign(new Error('Aborted after cleanup'), {
          partialUsage: attemptUsage,
          runtimeEstimatedCostUsd: 0.02,
        })
      )
      resolveRetry(measured('complete'))

      expect(await pending).toMatchObject({
        summary: 'complete',
        calls: 2,
        usage: { totalInput: 28, output: 4 },
        runtimeEstimatedCostUsd: 0.03,
      })
    })

    it('does not accept or mutate returned billing with a stale result after recovery', async () => {
      let resolveFirst!: (result: PortableSummaryCallResult) => void
      const summarize = vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<PortableSummaryCallResult>((resolve) => {
              resolveFirst = resolve
            })
        )
        .mockResolvedValueOnce(measured('complete'))
      const pending = summarizePortableTranscript('source', 1_000, summarize, { stepTimeoutMs: 100 })
      await vi.advanceTimersByTimeAsync(100)
      const result = await pending
      resolveFirst(measured('stale'))
      await vi.advanceTimersByTimeAsync(0)

      expect(result).toMatchObject({ summary: 'complete', calls: 2, usage: attemptUsage })
      expect(result).not.toHaveProperty('runtimeEstimatedCostUsd')
    })

    it('retries failed consolidation without repeating any successful source chunks', async () => {
      const summarize = vi
        .fn()
        .mockResolvedValueOnce(measured('first chunk'))
        .mockResolvedValueOnce(measured('second chunk'))
        .mockRejectedValueOnce(new Error('network error'))
        .mockResolvedValueOnce(measured('complete'))
      const result = await summarizePortableTranscript('x'.repeat(2_000), 1_000, summarize)
      expect(result).toMatchObject({ summary: 'complete', calls: 4 })
      expect(summarize.mock.calls.map(([, phase]) => phase)).toEqual(['chunk', 'chunk', 'consolidate', 'consolidate'])
      expect(summarize.mock.calls[2][0]).toBe(summarize.mock.calls[3][0])
    })

    it('rejects terminal consolidation failure instead of returning a partial summary', async () => {
      const summarize = vi
        .fn()
        .mockResolvedValueOnce(measured('first chunk'))
        .mockResolvedValueOnce(measured('second chunk'))
        .mockRejectedValueOnce(new Error('Invalid model'))
      await expect(summarizePortableTranscript('x'.repeat(2_000), 1_000, summarize)).rejects.toMatchObject({
        message: 'Invalid model',
        partialUsage: { totalInput: 28, output: 4 },
        runtimeEstimatedCostUsd: 0.02,
      })
      expect(summarize).toHaveBeenCalledTimes(3)
    })

    it.each([
      'timeout',
      'cancel',
    ] as const)('retains usage published by provider abort handling on %s', async (mode) => {
      const controller = new AbortController()
      const summarize = vi.fn(
        (_prompt: string, _phase: string, signal?: AbortSignal) =>
          new Promise<PortableSummaryCallResult>((_resolve, reject) => {
            signal!.addEventListener(
              'abort',
              () =>
                reject(
                  Object.assign(new Error('Aborted'), {
                    partialUsage: attemptUsage,
                    runtimeEstimatedCostUsd: 0.02,
                  })
                ),
              { once: true }
            )
          })
      )
      const pending = summarizePortableTranscript('source', 1_000, summarize, {
        signal: controller.signal,
        stepTimeoutMs: 100,
        maxRetries: 0,
      })
      const failure = pending.catch((error: unknown) => error)
      await vi.advanceTimersByTimeAsync(0)
      if (mode === 'cancel') controller.abort()
      else await vi.advanceTimersByTimeAsync(100)
      expect(await failure).toMatchObject({
        name: mode === 'cancel' ? 'AbortError' : 'TimeoutError',
        partialUsage: attemptUsage,
        runtimeEstimatedCostUsd: 0.02,
      })
      expect(summarize).toHaveBeenCalledTimes(1)
    })

    it('can disable retries without losing failed-attempt billing', async () => {
      const error = Object.assign(new Error('network error'), {
        partialUsage: { ...attemptUsage },
        runtimeEstimatedCostUsd: 0.02,
      })
      const summarize = vi.fn().mockRejectedValue(error)
      await expect(summarizePortableTranscript('source', 1_000, summarize, { maxRetries: 0 })).rejects.toMatchObject({
        partialUsage: attemptUsage,
        runtimeEstimatedCostUsd: 0.02,
      })
      expect(summarize).toHaveBeenCalledTimes(1)
    })

    it('retries empty output and accounts for both billed attempts', async () => {
      const summarize = vi.fn().mockResolvedValueOnce(measured('  \n')).mockResolvedValueOnce(measured('complete'))
      expect(await summarizePortableTranscript('source', 1_000, summarize)).toMatchObject({
        summary: 'complete',
        calls: 2,
        usage: { totalInput: 28, output: 4 },
        runtimeEstimatedCostUsd: 0.02,
      })
    })

    it('rejects exhausted empty summaries with billing for prior stages and both failed attempts', async () => {
      const summarize = vi.fn().mockResolvedValueOnce(measured()).mockResolvedValue(measured(''))
      await expect(summarizePortableTranscript('x'.repeat(2_000), 1_000, summarize)).rejects.toMatchObject({
        message: 'The context compactor returned an empty summary',
        partialUsage: { totalInput: 42, output: 6 },
        runtimeEstimatedCostUsd: 0.03,
      })
      expect(summarize).toHaveBeenCalledTimes(3)
    })

    it('attaches complete aggregate billing to a terminal error without mutating provider errors', async () => {
      const error = Object.freeze(
        Object.assign(new Error('Invalid model'), {
          status: 400,
          partialUsage: attemptUsage,
          runtimeEstimatedCostUsd: 0.02,
        })
      )
      const summarize = vi.fn().mockResolvedValueOnce(measured()).mockRejectedValueOnce(error)
      const failure = await summarizePortableTranscript('x'.repeat(2_000), 1_000, summarize).catch((value) => value)
      expect(failure).toMatchObject({
        message: 'Invalid model',
        status: 400,
        cause: error,
        partialUsage: { totalInput: 28, output: 4 },
        runtimeEstimatedCostUsd: 0.03,
      })
      expect(error.partialUsage).toEqual(attemptUsage)
    })

    it('omits incomplete native cost so token-based pricing remains available', async () => {
      const error = Object.assign(new Error('network error'), { partialUsage: attemptUsage })
      const summarize = vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce(measured())
      const result = await summarizePortableTranscript('source', 1_000, summarize)
      expect(result.usage?.totalInput).toBe(28)
      expect(result).not.toHaveProperty('runtimeEstimatedCostUsd')
    })

    it('does not expose the last error cost as a complete total when a prior call is unpriced', async () => {
      const error = Object.assign(new Error('Invalid model'), {
        partialUsage: attemptUsage,
        runtimeEstimatedCostUsd: 0.01,
      })
      const summarize = vi.fn().mockResolvedValueOnce({ text: 'summary', usage: attemptUsage }).mockRejectedValue(error)
      const failure = await summarizePortableTranscript('x'.repeat(2_000), 1_000, summarize).catch((value) => value)
      expect(failure.partialUsage.totalInput).toBe(28)
      expect(failure).not.toHaveProperty('runtimeEstimatedCostUsd')
    })

    it('enforces the overall deadline during a stage without retrying or starting later stages', async () => {
      const signals: AbortSignal[] = []
      const summarize = vi.fn((_prompt: string, _phase: string, signal?: AbortSignal) => {
        signals.push(signal!)
        return signals.length === 1
          ? new Promise<PortableSummaryCallResult>((resolve) => setTimeout(() => resolve(measured()), 80))
          : new Promise<PortableSummaryCallResult>(() => {})
      })
      const pending = summarizePortableTranscript('x'.repeat(3_000), 1_000, summarize, {
        stepTimeoutMs: 100,
        totalTimeoutMs: 150,
      })
      const failure = pending.catch((error: unknown) => error)
      await vi.advanceTimersByTimeAsync(150)
      expect(await failure).toMatchObject({ name: 'TimeoutError', partialUsage: attemptUsage })
      expect(summarize).toHaveBeenCalledTimes(2)
      expect(signals[1].aborted).toBe(true)
    })

    it('fails after the default single retry of a stalled stage', async () => {
      const summarize = vi.fn(() => new Promise<PortableSummaryCallResult>(() => {}))
      const pending = summarizePortableTranscript('source', 1_000, summarize, { stepTimeoutMs: 100 })
      const failure = pending.catch((error: unknown) => error)
      await vi.advanceTimersByTimeAsync(200)
      expect(await failure).toMatchObject({ name: 'TimeoutError' })
      expect(summarize).toHaveBeenCalledTimes(2)
    })

    it('caps the default overall budget at sixty minutes for large transcripts', async () => {
      const summarize = vi.fn(
        () => new Promise<PortableSummaryCallResult>((resolve) => setTimeout(() => resolve(measured()), 150_000))
      )
      const failure = summarizePortableTranscript('x'.repeat(30_000), 1_000, summarize).catch((error: unknown) => error)
      await vi.advanceTimersByTimeAsync(60 * 60_000)
      expect(await failure).toMatchObject({
        name: 'TimeoutError',
        message: 'Context compaction exceeded its time budget',
      })
      expect(summarize).toHaveBeenCalledTimes(24)
    })

    it('retains every source character and complete chunk summaries in consolidation', async () => {
      const source = 'a'.repeat(1_000) + 'b'.repeat(1_000)
      const summaries = ['first summary\nwith detail', 'second summary\nwith detail']
      const summarize = vi.fn(async (_prompt: string, phase: string) => ({
        text: phase === 'chunk' ? summaries[summarize.mock.calls.length - 1] : 'complete',
      }))
      await summarizePortableTranscript(source, 1_000, summarize)
      expect(
        summarize.mock.calls
          .slice(0, 2)
          .map(([prompt]) => prompt.split(':\n\n')[1])
          .join('')
      ).toBe(source)
      expect(summarize.mock.calls[2][0]).toContain(summaries[0])
      expect(summarize.mock.calls[2][0]).toContain(summaries[1])
    })

    it('retains the convergence guard and accumulated usage', async () => {
      const summarize = vi.fn(async () => measured('x'.repeat(1_000)))
      const failure = await summarizePortableTranscript('x'.repeat(2_000), 1_000, summarize).catch((value) => value)
      expect(failure.message).toBe('The context compactor did not converge')
      expect(failure.partialUsage.totalInput).toBe(summarize.mock.calls.length * 14)
      expect(failure.runtimeEstimatedCostUsd).toBeCloseTo(summarize.mock.calls.length * 0.01)
    })
  })

  it.each([
    ['Codex compactado → BYOK', 1_050_000, 1_000_000],
    ['Copilot compactado → BYOK', 1_050_000, 1_000_000],
    ['BYOK 1M/500k → Codex 256k', 500_000, 256_000],
    ['BYOK grande → Copilot', 300_000, 128_000],
    ['BYOK grande → BYOK menor', 500_000, 200_000],
  ])('triggers portable preflight for %s', (_scenario, historyTokens, window) => {
    const load = portableContextLoad(window, historyTokens, 1_000)
    expect(load.shouldCompact).toBe(true)
    expect(load.overflow).toBe(true)
  })

  it('reserves system/tools/output space without compacting a safe switch', () => {
    const load = portableContextLoad(1_000_000, 60_000, 1_000)
    expect(load.reserveTokens).toBe(64_000)
    expect(load.shouldCompact).toBe(false)
    expect(load.overflow).toBe(false)
  })

  describe('preflightContextLoad — measured vs estimated', () => {
    const customWindow = 300_000

    it('portable-transcript applies the full conservative reserve', () => {
      const load = preflightContextLoad(customWindow, 250_000, 1_000, 'portable-transcript')
      expect(load.reserveTokens).toBe(portableContextReserveTokens(customWindow))
      expect(load.reserveTokens).toBe(30_000)
      // 250k + 1k + 30k = 281k: below the cap but above 90%, so compaction is required.
      expect(load.requiredTokens).toBe(281_000)
      expect(load.shouldCompact).toBe(true)
      expect(load.overflow).toBe(false)
    })

    it('portable-transcript overflows when occupancy approaches the custom limit', () => {
      const load = preflightContextLoad(customWindow, 270_000, 1_000, 'portable-transcript')
      // 270k + 1k + 30k = 301k ≥ 300k
      expect(load.overflow).toBe(true)
      expect(load.shouldCompact).toBe(true)
    })

    it('runtime-usage does not add the full portable reserve to measured occupancy again', () => {
      const load = preflightContextLoad(customWindow, 270_000, 1_000, 'runtime-usage')
      expect(load.reserveTokens).toBe(portableContextOutputReserveTokens(customWindow))
      expect(load.reserveTokens).toBe(15_000)
      // 270k + 1k + 15k = 286k < 300k: no artificial overflow from double counting.
      expect(load.requiredTokens).toBe(286_000)
      expect(load.overflow).toBe(false)
      expect(load.shouldCompact).toBe(true) // 286/300 ≥ 0.9
    })

    it('runtime-usage still counts pending usage and can legitimately overflow', () => {
      const load = preflightContextLoad(customWindow, 270_000, 20_000, 'runtime-usage')
      // 270k + 20k + 15k = 305k ≥ 300k
      expect(load.overflow).toBe(true)
      expect(load.shouldCompact).toBe(true)
    })

    it('runtime-usage admits comfortable occupancy without compaction', () => {
      const load = preflightContextLoad(customWindow, 200_000, 1_000, 'runtime-usage')
      // 200k + 1k + 15k = 216k / 300k = 0.72
      expect(load.shouldCompact).toBe(false)
      expect(load.overflow).toBe(false)
    })

    it('actual 1M window with a custom 300k limit: reserves scale to the effective ceiling', () => {
      expect(portableContextReserveTokens(customWindow)).toBe(30_000)
      expect(portableContextOutputReserveTokens(customWindow)).toBe(15_000)
      // full 1M window would reserve more — custom limit keeps preflight on the effective ceiling
      expect(portableContextReserveTokens(1_000_000)).toBe(64_000)
    })
  })
})
