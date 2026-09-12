import { describe, expect, it } from 'vitest'
import {
  changeSubagentProfileModel,
  changeSubagentProfileProvider,
  changeSubagentProfileFastMode,
  emptySubagentProfileCandidate,
  isRealSubagentProfileEffort,
  subagentProfileAllowsCustomEffort,
  subagentProfileEffortIds,
  subagentProfileModelOptions,
  subagentProfileProviders,
} from '../../src/renderer/lib/subagent-profile-editor'
import { isClaudeFableModelId, isUnavailableClaudeFable } from '../../src/shared/subagent-profiles'

const candidate = { providerId: 'openai', modelId: 'gpt-5.5', effort: 'high' }

describe('subagent profile editor domain', () => {
  it('exposes subscription providers only while connected', () => {
    expect(
      subagentProfileProviders([
        {
          id: 'codex',
          name: 'Codex',
          baseURL: 'codex://subscription',
          apiKeyPresent: false,
          connected: true,
          kind: 'codex-subscription',
        },
        {
          id: 'copilot',
          name: 'Copilot',
          baseURL: 'copilot://subscription',
          apiKeyPresent: false,
          connected: true,
          kind: 'github-copilot-subscription',
        },
        { id: 'openai', name: 'OpenAI', baseURL: 'https://api.openai.com/v1', apiKeyPresent: true },
      ])
    ).toMatchObject([{ id: 'codex' }, { id: 'copilot' }, { id: 'openai' }])
  })

  it('hides unusable runtime or login subscriptions', () => {
    expect(
      subagentProfileProviders([
        {
          id: 'codex',
          name: 'Codex',
          baseURL: 'codex://subscription',
          apiKeyPresent: false,
          connected: false,
          kind: 'codex-subscription',
        },
        {
          id: 'copilot',
          name: 'Copilot',
          baseURL: 'copilot://subscription',
          apiKeyPresent: false,
          connected: false,
          kind: 'github-copilot-subscription',
        },
      ])
    ).toEqual([])
  })

  it('starts candidates without mandatory effort', () => {
    expect(emptySubagentProfileCandidate('openai')).toEqual({ providerId: 'openai', modelId: '', effort: '' })
    expect(isRealSubagentProfileEffort('')).toBe(false)
    expect(isRealSubagentProfileEffort('off')).toBe(false)
    expect(isRealSubagentProfileEffort('maestrly-ultra')).toBe(false)
    expect(isRealSubagentProfileEffort('ultra')).toBe(true)
    expect(isRealSubagentProfileEffort('high')).toBe(true)
  })

  it('uses only real dynamic model efforts', () => {
    const metadata = {
      status: 'available' as const,
      meta: { reasoning: true, reasoningEfforts: ['none', 'low', 'medium', 'high', 'xhigh', 'off', 'ultra'] },
    }
    expect(subagentProfileEffortIds(metadata)).toEqual(['none', 'low', 'medium', 'high', 'xhigh', 'ultra'])
    expect(subagentProfileAllowsCustomEffort(metadata)).toBe(false)
  })

  it('uses shared default efforts for reasoning without levels', () => {
    expect(subagentProfileEffortIds({ status: 'available', meta: { reasoning: true } })).toEqual([
      'low',
      'medium',
      'high',
    ])
  })

  it('allows manual efforts without metadata and invents none for non-reasoning models', () => {
    expect(subagentProfileAllowsCustomEffort({ status: 'unavailable', meta: null })).toBe(true)
    expect(subagentProfileEffortIds({ status: 'available', meta: { reasoning: false } })).toEqual([])
    expect(subagentProfileAllowsCustomEffort({ status: 'available', meta: { reasoning: false } })).toBe(false)
  })

  it('clears effort after provider or model changes', () => {
    const fastCandidate = { ...candidate, fastMode: true as const }
    expect(changeSubagentProfileProvider(fastCandidate, 'anthropic')).toEqual({
      providerId: 'anthropic',
      modelId: '',
      effort: '',
    })
    expect(changeSubagentProfileModel(fastCandidate, 'gpt-5.6-sol')).toEqual({
      providerId: 'openai',
      modelId: 'gpt-5.6-sol',
      effort: '',
    })
    expect(changeSubagentProfileProvider(candidate, 'openai')).toBe(candidate)
    expect(changeSubagentProfileModel(candidate, 'gpt-5.5')).toBe(candidate)
  })

  it('stores only explicit Fast and removes it for Standard', () => {
    const fast = changeSubagentProfileFastMode(candidate, true)
    expect(fast).toEqual({ ...candidate, fastMode: true })
    expect(changeSubagentProfileFastMode(fast, false)).toEqual(candidate)
    expect(changeSubagentProfileFastMode(candidate, false)).toBe(candidate)
  })

  it('keeps unavailable Fable visible and disabled', () => {
    expect(
      subagentProfileModelOptions(
        'builtin_claude_subscription',
        ['default', 'opus[1m]', 'sonnet', 'haiku'],
        'unavailable',
        true
      )
    ).toEqual([
      { id: 'default', label: 'default' },
      { id: 'fable', label: 'fable', hint: 'unavailable', disabled: true },
      { id: 'opus[1m]', label: 'opus[1m]' },
      { id: 'sonnet', label: 'sonnet' },
      { id: 'haiku', label: 'haiku' },
    ])
    expect(
      subagentProfileModelOptions('builtin_claude_subscription', ['default', 'fable', 'opus[1m]'], 'unavailable', true)
    ).toEqual([
      { id: 'default', label: 'default' },
      { id: 'fable', label: 'fable' },
      { id: 'opus[1m]', label: 'opus[1m]' },
    ])
    expect(subagentProfileModelOptions('builtin_codex_subscription', ['gpt-5.6-luna'], 'unavailable', true)).toEqual([
      { id: 'gpt-5.6-luna', label: 'gpt-5.6-luna' },
    ])
    expect(subagentProfileModelOptions('builtin_claude_subscription', [], 'unavailable', false)).toEqual([])
  })

  it('recognizes only valid Fable aliases and concrete IDs', () => {
    for (const id of [
      'fable',
      'FABLE[1m]',
      'fable[2m]',
      'claude-fable-5',
      'claude-fable-5-1',
      'anthropic/claude-fable-5-1',
      'anthropic/claude-fable-5-20260701',
      'claude-fable-5-v2:1[1m]',
    ]) {
      expect(isClaudeFableModelId(id), id).toBe(true)
    }
    for (const id of ['fable-preview', 'claude-fable-', 'claude-fable-5-beta', 'other/fable-ish']) {
      expect(isClaudeFableModelId(id), id).toBe(false)
    }
    expect(
      isUnavailableClaudeFable('builtin_claude_subscription', 'claude-fable-5', ['default', 'opus[1m]', 'sonnet'])
    ).toBe(true)
    expect(isUnavailableClaudeFable('builtin_claude_subscription', 'claude-fable-5', ['default', 'fable'])).toBe(false)
    expect(isUnavailableClaudeFable('custom-anthropic', 'fable', [])).toBe(false)
  })
})
