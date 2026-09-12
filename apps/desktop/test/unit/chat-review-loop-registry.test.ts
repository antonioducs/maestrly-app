import { afterEach, describe, expect, it } from 'vitest'
import {
  __resetReviewLoopRegistryForTests,
  lookupReviewLoopByConversation,
  lookupReviewLoopById,
  releaseReviewLoop,
  reserveReviewLoop,
} from '../../src/main/chat/review-loop/registry'

afterEach(__resetReviewLoopRegistryForTests)

describe('review-loop registry', () => {
  it('projects the neutral driver/cwd and named participant roles', () => {
    const result = reserveReviewLoop({
      loopId: 'rl_target_shape',
      driver: 'maestrly-pair',
      cwd: '/canonical/repo',
      participants: { executor: 'executor', reviewer: 'reviewer' },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.reservation).toMatchObject({
      driver: 'maestrly-pair',
      cwd: '/canonical/repo',
      participants: { executor: 'executor', reviewer: 'reviewer' },
    })
  })

  it('reserves a pair atomically and indexes it by both conversations and loop', () => {
    const result = reserveReviewLoop({
      loopId: 'rl_pair_1',
      participants: [
        { driver: 'conversation', conversationId: 'executor-1' },
        { driver: 'conversation', conversationId: 'reviewer-1' },
      ],
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(lookupReviewLoopById('rl_pair_1')).toBe(result.reservation)
    expect(lookupReviewLoopByConversation('executor-1')).toBe(result.reservation)
    expect(lookupReviewLoopByConversation('reviewer-1')).toBe(result.reservation)
  })

  it('does not partially reserve a pair when either participant is already owned by another driver', () => {
    expect(
      reserveReviewLoop({
        loopId: 'rl_web',
        participants: [{ driver: 'chatgpt-web', conversationId: 'busy-conversation' }],
      }).ok
    ).toBe(true)

    const conflict = reserveReviewLoop({
      loopId: 'rl_pair',
      participants: [
        { driver: 'conversation', conversationId: 'free-conversation' },
        { driver: 'conversation', conversationId: 'busy-conversation' },
      ],
    })

    expect(conflict).toEqual({
      ok: false,
      error: 'conversation-already-reserved',
      conflictingLoopId: 'rl_web',
      conflictingConversationId: 'busy-conversation',
    })
    expect(lookupReviewLoopByConversation('free-conversation')).toBeNull()
    expect(lookupReviewLoopById('rl_pair')).toBeNull()
  })

  it('rejects duplicate participants even when they name different drivers', () => {
    expect(
      reserveReviewLoop({
        loopId: 'rl_duplicate',
        participants: [
          { driver: 'chatgpt-web', conversationId: 'same-conversation' },
          { driver: 'conversation', conversationId: 'same-conversation' },
        ],
      })
    ).toEqual({
      ok: false,
      error: 'duplicate-participant',
      conflictingConversationId: 'same-conversation',
    })
    expect(lookupReviewLoopByConversation('same-conversation')).toBeNull()
  })

  it('releases every index and global reset clears remaining reservations', () => {
    reserveReviewLoop({
      loopId: 'rl_one',
      participants: [{ driver: 'chatgpt-web', conversationId: 'conversation-1' }],
    })
    reserveReviewLoop({
      loopId: 'rl_two',
      participants: [{ driver: 'conversation', conversationId: 'conversation-2' }],
    })

    expect(releaseReviewLoop('rl_one')).toBe(true)
    expect(releaseReviewLoop('rl_one')).toBe(false)
    expect(lookupReviewLoopById('rl_one')).toBeNull()
    expect(lookupReviewLoopByConversation('conversation-1')).toBeNull()

    __resetReviewLoopRegistryForTests()
    expect(lookupReviewLoopById('rl_two')).toBeNull()
    expect(lookupReviewLoopByConversation('conversation-2')).toBeNull()
  })
})
