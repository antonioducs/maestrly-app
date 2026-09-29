import { afterEach, describe, expect, it } from 'vitest'
import {
  getConversationContextLimit,
  limitConversationContextWindow,
  setConversationContextLimit,
} from '../../src/main/chat/conversation-context-limit'

describe('conversation context limit', () => {
  afterEach(() => {
    setConversationContextLimit('a', null)
    setConversationContextLimit('b', null)
  })

  it('leaves the model window alone without a limit', () => {
    expect(limitConversationContextWindow('a', 1_000_000)).toBe(1_000_000)
    expect(limitConversationContextWindow('a', undefined)).toBeUndefined()
  })

  it('caps a larger model window, keeps a smaller one, and stands in for an unknown one', () => {
    setConversationContextLimit('a', 300_000)
    expect(limitConversationContextWindow('a', 1_000_000)).toBe(300_000)
    expect(limitConversationContextWindow('a', 200_000)).toBe(200_000)
    expect(limitConversationContextWindow('a', undefined)).toBe(300_000)
    expect(limitConversationContextWindow('a', null)).toBe(300_000)
    expect(limitConversationContextWindow('b', 1_000_000)).toBe(1_000_000)
  })

  it('removes the limit with null, zero or an invalid value', () => {
    for (const value of [null, 0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      setConversationContextLimit('a', 300_000)
      setConversationContextLimit('a', value)
      expect(getConversationContextLimit('a'), String(value)).toBeUndefined()
    }
  })
})
