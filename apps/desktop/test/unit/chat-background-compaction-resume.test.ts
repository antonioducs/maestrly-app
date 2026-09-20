import { describe, expect, it, vi } from 'vitest'
import {
  splitPortableTranscript,
  summarizePortableTranscript,
  type PortableSummaryCheckpoint,
} from '../../src/main/chat/portable-context'

describe('background compaction portable stage checkpoints', () => {
  it('enforces chunk budgets in UTF-8 bytes without dropping multibyte text', () => {
    const source = `${'🙂'.repeat(900)}\n${'終'.repeat(900)}`
    const chunks = splitPortableTranscript(source, 1_000)

    expect(chunks.join('')).toBe(source)
    expect(chunks.every((chunk) => Buffer.byteLength(chunk, 'utf8') <= 1_000)).toBe(true)
  })

  it('resumes completed chunks without dispatching them again', async () => {
    let checkpoint: PortableSummaryCheckpoint | undefined
    const first = vi.fn(async () => ({ text: 'bounded summary' }))
    await expect(
      summarizePortableTranscript('x'.repeat(3_000), 1_000, first, {
        onCheckpoint: (value) => {
          checkpoint = value
          if (value.completed.length === 2) throw new Error('simulated process stop')
        },
      })
    ).rejects.toThrow('simulated process stop')
    expect(checkpoint?.completed).toHaveLength(2)

    const resumed = vi.fn(async () => ({ text: 'bounded summary' }))
    const result = await summarizePortableTranscript('x'.repeat(3_000), 1_000, resumed, { resume: checkpoint })

    // One remaining source chunk plus consolidation; the first two source calls are not repeated.
    expect(resumed).toHaveBeenCalledTimes(2)
    expect(result.summary).toBe('bounded summary')
  })

  it('rejects a checkpoint when the exact source identity changed', async () => {
    let checkpoint: PortableSummaryCheckpoint | undefined
    await expect(
      summarizePortableTranscript('original'.repeat(500), 1_000, async () => ({ text: 'summary' }), {
        onCheckpoint: (value) => {
          checkpoint = value
          throw new Error('stop')
        },
      })
    ).rejects.toThrow('stop')

    await expect(
      summarizePortableTranscript('edited'.repeat(500), 1_000, async () => ({ text: 'summary' }), {
        resume: checkpoint,
      })
    ).rejects.toThrow('checkpoint does not match its source')
  })

  it('waits 30 seconds for the single transient retry', async () => {
    vi.useFakeTimers()
    try {
      let calls = 0
      const operation = summarizePortableTranscript(
        'source',
        1_000,
        async () => {
          calls += 1
          if (calls === 1) {
            const error = new Error('rate limited') as Error & { status: number }
            error.status = 429
            throw error
          }
          return { text: 'summary' }
        },
        { retryDelayMs: 30_000, maxRetries: 1 }
      )
      await vi.advanceTimersByTimeAsync(29_999)
      expect(calls).toBe(1)
      await vi.advanceTimersByTimeAsync(1)
      await expect(operation).resolves.toMatchObject({ summary: 'summary', calls: 2 })
    } finally {
      vi.useRealTimers()
    }
  })
})
