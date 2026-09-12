import { describe, expect, it } from 'vitest'
import type { ChatMode } from '../../src/shared/chat'
import { capabilityBehaviorFor, cycleChatMode, isChatMode, normalizeChatMode } from '../../src/shared/chat-mode'

describe('Design chat mode policy', () => {
  it('recognizes exactly the four Standard modes', () => {
    for (const mode of ['agent', 'design', 'plan', 'ask'] satisfies ChatMode[]) expect(isChatMode(mode)).toBe(true)
    for (const value of ['maestro', 'reviewer', '', null, undefined, 1, {}]) expect(isChatMode(value)).toBe(false)
  })

  it('preserves valid preferences and normalizes missing, legacy, or invalid values to Agent', () => {
    for (const mode of ['agent', 'design', 'plan', 'ask'] satisfies ChatMode[])
      expect(normalizeChatMode(mode)).toBe(mode)
    for (const value of ['maestro', 'question', '', null, undefined, false])
      expect(normalizeChatMode(value)).toBe('agent')
  })

  it('maps only Design to Agent capabilities and preserves every other behavior', () => {
    expect(capabilityBehaviorFor('design')).toBe('agent')
    expect(capabilityBehaviorFor('agent')).toBe('agent')
    expect(capabilityBehaviorFor('plan')).toBe('plan')
    expect(capabilityBehaviorFor('ask')).toBe('ask')
    expect(capabilityBehaviorFor('maestro')).toBe('maestro')
  })

  it('cycles through Design between Agent and Plan', () => {
    expect(cycleChatMode('agent')).toBe('design')
    expect(cycleChatMode('design')).toBe('plan')
    expect(cycleChatMode('plan')).toBe('ask')
    expect(cycleChatMode('ask')).toBe('agent')
  })
})
