import { describe, expect, it } from 'vitest'
import { nextQuickReasoningEffort } from '../../src/shared/chat'

describe('nextQuickReasoningEffort', () => {
  it('cycles normal effort levels and returns to off', () => {
    expect(nextQuickReasoningEffort('off', ['low', 'medium', 'high'], false)).toBe('low')
    expect(nextQuickReasoningEffort('low', ['low', 'medium', 'high'], false)).toBe('medium')
    expect(nextQuickReasoningEffort('high', ['low', 'medium', 'high'], false)).toBe('off')
  })

  it('honors a custom model list', () => {
    expect(nextQuickReasoningEffort('off', ['medium', 'high'], false)).toBe('medium')
    expect(nextQuickReasoningEffort('medium', ['medium', 'high'], false)).toBe('high')
    expect(nextQuickReasoningEffort('high', ['medium', 'high'], false)).toBe('off')
  })

  it('leaves synthetic Ultra and excludes unified native Ultra', () => {
    expect(nextQuickReasoningEffort('maestrly-ultra', ['low', 'high'], false)).toBe('off')
    expect(nextQuickReasoningEffort('ultra', ['low', 'high', 'ultra'], true)).toBe('off')
  })

  it('keeps regular ultra when the runtime does not unify it', () => {
    expect(nextQuickReasoningEffort('high', ['low', 'high', 'ultra'], false)).toBe('ultra')
    expect(nextQuickReasoningEffort('ultra', ['low', 'high', 'ultra'], false)).toBe('off')
  })

  it('safely returns off for stale values and empty lists', () => {
    expect(nextQuickReasoningEffort('xhigh', ['low', 'high'], false)).toBe('off')
    expect(nextQuickReasoningEffort('off', [], false)).toBe('off')
  })
})
