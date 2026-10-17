import { describe, expect, it, vi } from 'vitest'

vi.mock('../../src/main/store', () => ({
  getAppSetting: () => null,
  setAppSetting: vi.fn(),
  getAppFlag: () => false,
  setAppFlag: vi.fn(),
}))

import { PROVIDER_PRESETS } from '../../src/main/chat/catalog'
import { apiProviderGlyph, subscriptionGlyph } from '../../src/renderer/components/chat/accounts/provider-glyphs'
import { CHAT_SUBSCRIPTION_PROVIDER_KINDS, defaultProviderKind } from '../../src/shared/chat'

describe('provider glyphs', () => {
  it('gives every subscription its provider mark', () => {
    expect(CHAT_SUBSCRIPTION_PROVIDER_KINDS.map(subscriptionGlyph)).toEqual([
      'openai',
      'githubcopilot',
      'claude',
      'grok',
      'cursor',
      'gemini',
    ])
  })

  it('recognizes API providers by their base URL host, subdomains included', () => {
    expect(apiProviderGlyph('https://api.openai.com/v1')).toBe('openai')
    expect(apiProviderGlyph('https://my-team.openai.azure.com/openai')).toBe('openai')
    expect(apiProviderGlyph('https://api.anthropic.com/v1')).toBe('anthropic')
    expect(apiProviderGlyph('https://openrouter.ai/api/v1')).toBe('openrouter')
    expect(apiProviderGlyph('https://api.deepseek.com/v1')).toBe('deepseek')
    expect(apiProviderGlyph('https://api.groq.com/openai/v1')).toBe('groq')
    expect(apiProviderGlyph('https://api.together.xyz/v1')).toBe('together')
    expect(apiProviderGlyph('https://api.mistral.ai/v1')).toBe('mistral')
    expect(apiProviderGlyph('https://token-plan-sgp.xiaomimimo.com/v1')).toBe('xiaomi')
    expect(apiProviderGlyph('https://API.X.AI/v1')).toBe('grok')
  })

  it('marks every API key preset, including Gemini through its OpenAI-compatible endpoint', () => {
    for (const preset of PROVIDER_PRESETS) expect(apiProviderGlyph(preset.baseURL), preset.name).not.toBeNull()
    const gemini = PROVIDER_PRESETS.find((preset) => preset.name === 'Gemini')
    expect(gemini).toMatchObject({ baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai' })
    expect(apiProviderGlyph(gemini!.baseURL)).toBe('gemini')
    expect(gemini!.kind ?? defaultProviderKind(gemini!.baseURL)).toBe('openai')
  })

  it('shows no mark for unknown, look-alike or invalid endpoints', () => {
    expect(apiProviderGlyph('http://localhost:11434/v1')).toBeNull()
    expect(apiProviderGlyph('https://max.ai/v1')).toBeNull()
    expect(apiProviderGlyph('https://openai.com.example.net/v1')).toBeNull()
    expect(apiProviderGlyph('https://notopenai.com/v1')).toBeNull()
    expect(apiProviderGlyph('https://storage.googleapis.com/v1')).toBeNull()
    expect(apiProviderGlyph('not a url')).toBeNull()
  })
})
