import { describe, expect, it } from 'vitest'
import {
  antigravityModelEntriesFromSession,
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

  it('reads concrete variants from the superseded models field when the model option lists families (ACP 1.4)', () => {
    const session = {
      sessionId: 's',
      configOptions: [
        {
          id: 'model',
          category: 'model',
          type: 'select' as const,
          currentValue: 'gemini-4-argon',
          options: [
            { value: 'gemini-4-argon', name: 'Gemini 4 Argon' },
            { value: 'gemini-3.1-pro', name: 'Gemini 3.1 Pro' },
          ],
        },
        {
          id: 'thinking_level',
          category: 'thought_level',
          type: 'select' as const,
          currentValue: 'high',
          options: [
            { value: 'low', name: 'Low' },
            { value: 'medium', name: 'Medium' },
            { value: 'high', name: 'High' },
          ],
        },
      ],
      models: {
        currentModelId: 'gemini-4-argon-high',
        availableModels: [
          { modelId: 'gemini-4-argon-high', name: 'Gemini 4 Argon (High)' },
          { modelId: 'gemini-4-argon-medium', name: 'Gemini 4 Argon (Medium)' },
          { modelId: 'gemini-4-argon-low', name: 'Gemini 4 Argon (Low)' },
          { modelId: 'gemini-pro-agent', name: 'Gemini 3.1 Pro (High)' },
          { modelId: 'gemini-3.1-pro-low', name: 'Gemini 3.1 Pro (Low)' },
        ],
      },
    }
    const parsed = antigravityModelEntriesFromSession(session)
    expect(parsed.map((entry) => entry.id)).toEqual(['gemini-4-argon', 'gemini-3.1-pro'])
    expect(antigravityModelMeta(parsed[0]).reasoningEfforts).toEqual(['low', 'medium', 'high'])
    expect(resolveAntigravityModelValue(parsed, 'gemini-4-argon', 'low')).toBe('gemini-4-argon-low')
  })

  it('falls back to the model option when the server sends no models field', () => {
    const parsed = antigravityModelEntriesFromSession({
      configOptions: [{ id: 'model', type: 'select', currentValue: 'gemini-pro-agent', options: SPIKE_OPTIONS }],
    })
    expect(parsed).toEqual(entries)
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
