import { describe, expect, it, vi } from 'vitest'
import type { ChatStreamEvent } from '../../src/shared/chat'
import { createContextProgressPublisher } from '../../src/main/chat/context-progress'

describe('compaction publication cancellation', () => {
  it('preserves the bill when cancellation wins after the helper has resolved', async () => {
    const events: ChatStreamEvent[] = []
    const publisher = createContextProgressPublisher({
      messageId: 'assistant',
      model: { providerId: 'provider', modelId: 'model' },
      apply: (event) => events.push(event),
      sanitizeError: String,
      onCompactionError: vi.fn(),
    })
    const controller = new AbortController()
    const result = {
      summary: 'Complete summary',
      usage: { input: 10, output: 4, cacheRead: 2, cacheCreate: 0, totalInput: 12 },
      runtimeEstimatedCostUsd: 0.004,
    }
    let resolve!: (value: typeof result) => void
    const work = new Promise<typeof result>((done) => {
      resolve = done
    })
    const running = publisher.compact(() => work, {
      signal: controller.signal,
      failureMessage: 'Compaction failed',
    })
    resolve(result)
    controller.abort(new Error('Stopped'))
    await expect(running).rejects.toMatchObject({
      message: 'Stopped',
      partialUsage: result.usage,
      runtimeEstimatedCostUsd: result.runtimeEstimatedCostUsd,
    })
    expect(events.at(-1)).toMatchObject({ kind: 'compaction-progress', progress: { status: 'cancelled' } })
    expect(events.some((event) => event.kind === 'compaction-progress' && event.progress.status === 'completed')).toBe(
      false
    )
    publisher.dispose()
  })
})
