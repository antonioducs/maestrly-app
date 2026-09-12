import { describe, expect, it } from 'vitest'
import { grokReasoningEffortsForModel, grokReasoningMeta } from '../../src/main/chat/grok-subscription/models'

describe('Grok reasoning metadata', () => {
  it('exposes the official matrix by model family', () => {
    expect(grokReasoningEffortsForModel('grok-4.6')).toEqual(['low', 'medium', 'high', 'xhigh'])
    expect(grokReasoningEffortsForModel('grok-4-6-fast')).toEqual(['low', 'medium', 'high', 'xhigh'])
    expect(grokReasoningEffortsForModel('grok-4.5')).toEqual(['low', 'medium', 'high'])
    expect(grokReasoningEffortsForModel('grok-4.20-multi-agent')).toEqual(['low', 'medium', 'high', 'xhigh'])
  })

  it('fails closed for media, non-reasoning, and unknown models', () => {
    expect(grokReasoningEffortsForModel('grok-4.6-non-reasoning')).toEqual([])
    expect(grokReasoningEffortsForModel('grok-imagine-video')).toEqual([])
    expect(grokReasoningEffortsForModel('grok-5')).toEqual([])
  })

  it('preserves authoritative canonical metadata and fills only missing capabilities', () => {
    expect(grokReasoningMeta('grok-4.6')).toEqual({
      reasoning: true,
      reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
    })
    expect(grokReasoningMeta('grok-4.6', { reasoning: false })).toEqual({ reasoning: false })
    expect(grokReasoningMeta('grok-4.6', { reasoning: true, reasoningEfforts: ['high'] })).toEqual({
      reasoning: true,
      reasoningEfforts: ['high'],
    })
  })
})
