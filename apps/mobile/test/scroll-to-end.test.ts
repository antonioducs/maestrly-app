import { describe, expect, it } from 'vitest'
import { shouldOfferScrollToEnd } from '../src/ui/conversation/scroll-to-end'

describe('going back to the latest message', () => {
  it('is offered once the conversation is scrolled well away from its end', () => {
    expect(shouldOfferScrollToEnd(0, 800)).toBe(false)
    expect(shouldOfferScrollToEnd(500, 800)).toBe(false)
    expect(shouldOfferScrollToEnd(601, 800)).toBe(true)
    expect(shouldOfferScrollToEnd(250, 200)).toBe(true)
    expect(shouldOfferScrollToEnd(239, 200)).toBe(false)
  })
})
