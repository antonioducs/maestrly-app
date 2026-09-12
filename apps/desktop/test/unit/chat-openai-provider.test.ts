import { describe, expect, it } from 'vitest'
import { buildOpenAIProviderFingerprint } from '../../src/main/chat/provider'

describe('OpenAI provider fingerprint', () => {
  it('is stable for equivalent trailing slashes and never exposes the key', () => {
    const first = buildOpenAIProviderFingerprint(
      { baseURL: 'https://api.openai.com/v1/' },
      'openai-responses',
      'sk-secret-value'
    )
    const second = buildOpenAIProviderFingerprint(
      { baseURL: 'https://api.openai.com/v1' },
      'openai-responses',
      'sk-secret-value'
    )

    expect(first).toBe(second)
    expect(first).toMatch(/^[a-f0-9]{64}$/)
    expect(first).not.toContain('secret')
  })

  it('changes when the endpoint, protocol, or credential changes', () => {
    const base = buildOpenAIProviderFingerprint({ baseURL: 'http://127.0.0.1:4144/v1' }, 'openai-responses', 'key-a')
    expect(
      buildOpenAIProviderFingerprint({ baseURL: 'http://127.0.0.1:4145/v1' }, 'openai-responses', 'key-a')
    ).not.toBe(base)
    expect(buildOpenAIProviderFingerprint({ baseURL: 'http://127.0.0.1:4144/v1' }, 'openai', 'key-a')).not.toBe(base)
    expect(
      buildOpenAIProviderFingerprint({ baseURL: 'http://127.0.0.1:4144/v1' }, 'openai-responses', 'key-b')
    ).not.toBe(base)
  })
})
