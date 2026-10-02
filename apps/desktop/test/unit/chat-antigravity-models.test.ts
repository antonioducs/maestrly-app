import { describe, expect, it } from 'vitest'
import {
  antigravityModelMeta,
  parseAntigravityModelOptions,
  resolveAntigravityModelValue,
} from '../../src/main/chat/antigravity-subscription/models'

/** The exact `configOptions[id='model'].options` returned by Antigravity ACP 1.2.1 on free and Pro accounts. */
const SPIKE_OPTIONS = [
  ['gemini-3.8-flash-high', 'Gemini 3.8 Flash (High)'],
  ['gemini-3.8-flash-medium', 'Gemini 3.8 Flash (Medium)'],
  ['gemini-3.8-flash-low', 'Gemini 3.8 Flash (Low)'],
  ['gemini-3.7-flash-high', 'Gemini 3.7 Flash (High)'],
  ['gemini-3.7-flash-medium', 'Gemini 3.7 Flash (Medium)'],
  ['gemini-3.7-flash-low', 'Gemini 3.7 Flash (Low)'],
  ['gemini-3.6-flash-high', 'Gemini 3.6 Flash (High)'],
  ['gemini-3.6-flash-medium', 'Gemini 3.6 Flash (Medium)'],
  ['gemini-3.6-flash-low', 'Gemini 3.6 Flash (Low)'],
  ['gemini-pro-agent', 'Gemini 3.1 Pro (High)'],
  ['gemini-3.1-pro-low', 'Gemini 3.1 Pro (Low)'],
].map(([value, name]) => ({ value, name, description: value }))

describe('Antigravity model catalog', () => {
  const entries = parseAntigravityModelOptions(SPIKE_OPTIONS)

  it('groups effort variants into one model per base name', () => {
    expect(entries.map((entry) => entry.id)).toEqual([
      'gemini-3.8-flash',
      'gemini-3.7-flash',
      'gemini-3.6-flash',
      'gemini-3.1-pro',
    ])
    expect(entries[0]).toEqual({
      id: 'gemini-3.8-flash',
      displayName: 'Gemini 3.8 Flash',
      efforts: { high: 'gemini-3.8-flash-high', medium: 'gemini-3.8-flash-medium', low: 'gemini-3.8-flash-low' },
      defaultEffort: 'high',
    })
    expect(entries[3]).toEqual({
      id: 'gemini-3.1-pro',
      displayName: 'Gemini 3.1 Pro',
      efforts: { high: 'gemini-pro-agent', low: 'gemini-3.1-pro-low' },
      defaultEffort: 'high',
    })
  })

  it('keeps options without an effort suffix as standalone models', () => {
    expect(parseAntigravityModelOptions([{ value: 'solo', name: 'Solo' }])).toEqual([
      { id: 'solo', displayName: 'Solo', efforts: {} },
    ])
  })

  it('resolves the ACP option value for a model and effort', () => {
    expect(resolveAntigravityModelValue(entries, 'gemini-3.1-pro', 'high')).toBe('gemini-pro-agent')
    expect(resolveAntigravityModelValue(entries, 'gemini-3.1-pro', 'low')).toBe('gemini-3.1-pro-low')
    expect(resolveAntigravityModelValue(entries, 'gemini-3.1-pro', 'medium')).toBe('gemini-pro-agent')
    expect(resolveAntigravityModelValue(entries, 'gemini-3.8-flash', undefined)).toBe('gemini-3.8-flash-high')
    expect(resolveAntigravityModelValue(entries, 'gemini-3.8-flash', 'off')).toBe('gemini-3.8-flash-high')
    expect(resolveAntigravityModelValue(entries, 'gemini-3.8-flash', 'medium')).toBe('gemini-3.8-flash-medium')
    expect(resolveAntigravityModelValue(entries, 'x')).toBeNull()
    expect(resolveAntigravityModelValue(parseAntigravityModelOptions([{ value: 'solo', name: 'Solo' }]), 'solo')).toBe(
      'solo'
    )
  })

  it('advertises only the efforts a model really offers', () => {
    expect(antigravityModelMeta(entries[3])).toEqual({
      chatCapable: true,
      vision: true,
      reasoning: true,
      reasoningEfforts: ['low', 'high'],
    })
    expect(antigravityModelMeta({ id: 'solo', displayName: 'Solo', efforts: {} })).toEqual({
      chatCapable: true,
      vision: true,
      reasoning: false,
      reasoningEfforts: [],
    })
  })
})
