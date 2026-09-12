import { describe, expect, it } from 'vitest'
import type { ReviewLoopInfo } from '../../src/shared/chat'
import { findActivePairedReviewLoop } from '../../src/renderer/lib/review-loop-split'

function loop(status: ReviewLoopInfo['status']): ReviewLoopInfo {
  return {
    loopId: 'pair',
    driver: 'maestrly-pair',
    status,
    iteration: 1,
    maxIterations: 3,
    startedAt: 1,
    participants: {
      executor: { conversationId: 'executor', name: 'Executor', modelId: 'model', fastMode: false },
      reviewer: { conversationId: 'reviewer', name: 'Reviewer', modelId: 'model', fastMode: false },
    },
  }
}

describe('review loop split selection', () => {
  it.each(['reviewing', 'executing', 'finishing', 'cancelling'] as const)(
    'keeps both participants in the split while %s',
    (status) => {
      const current = loop(status)
      for (const id of ['executor', 'reviewer']) {
        expect(findActivePairedReviewLoop([current], id)).toBe(current)
      }
    }
  )

  it.each(['finished', 'cancelled', 'interrupted'] as const)(
    'releases the split on %s and does not reopen it when revisiting either conversation',
    (status) => {
      const current = loop('reviewing')
      expect(findActivePairedReviewLoop([current], 'executor')).toBe(current)
      const terminal = { ...current, status, finishReason: 'executor_failed' }
      for (const id of ['executor', 'unrelated', 'reviewer', 'executor']) {
        expect(findActivePairedReviewLoop([terminal], id)).toBeNull()
      }
    }
  )

  it('ignores retained terminal loops when a new pair starts', () => {
    const previous = loop('finished')
    const current = { ...loop('executing'), loopId: 'new-pair' }
    expect(findActivePairedReviewLoop([previous, current], 'reviewer')).toBe(current)
  })

  it('does not split unrelated conversations or the ChatGPT Web driver', () => {
    expect(findActivePairedReviewLoop([loop('reviewing')], 'unrelated')).toBeNull()
    expect(findActivePairedReviewLoop([loop('reviewing')], undefined)).toBeNull()
    expect(findActivePairedReviewLoop([{ ...loop('reviewing'), driver: 'chatgpt-web' }], 'executor')).toBeNull()
  })
})
