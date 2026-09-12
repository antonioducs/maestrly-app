import { describe, expect, it } from 'vitest'
import { isChatProviderConnected, isChatSubscriptionProviderKind, type ChatProviderInfo } from '../../src/shared/chat'

const provider = (patch: Partial<ChatProviderInfo>): ChatProviderInfo => ({
  id: 'provider-1',
  name: 'Provider',
  baseURL: 'https://example.test/v1',
  apiKeyPresent: false,
  ...patch,
})

describe('isChatProviderConnected', () => {
  it('preserves legacy API-key connection gates', () => {
    expect(isChatProviderConnected(provider({ apiKeyPresent: true }))).toBe(true)
    expect(isChatProviderConnected(provider({ apiKeyPresent: false }))).toBe(false)
  })

  it('prefers explicit subscription authentication state', () => {
    expect(
      isChatProviderConnected(provider({ kind: 'codex-subscription', connected: true, apiKeyPresent: false }))
    ).toBe(true)
    expect(
      isChatProviderConnected(provider({ kind: 'github-copilot-subscription', connected: true, apiKeyPresent: false }))
    ).toBe(true)
    expect(
      isChatProviderConnected(provider({ kind: 'claude-subscription', connected: true, apiKeyPresent: false }))
    ).toBe(true)
    expect(
      isChatProviderConnected(provider({ kind: 'grok-subscription', connected: true, apiKeyPresent: false }))
    ).toBe(true)
    expect(isChatProviderConnected(provider({ connected: false, apiKeyPresent: true }))).toBe(false)
  })

  it('distinguishes subscription providers from BYOK formats', () => {
    expect(isChatSubscriptionProviderKind('codex-subscription')).toBe(true)
    expect(isChatSubscriptionProviderKind('github-copilot-subscription')).toBe(true)
    expect(isChatSubscriptionProviderKind('claude-subscription')).toBe(true)
    expect(isChatSubscriptionProviderKind('grok-subscription')).toBe(true)
    expect(isChatSubscriptionProviderKind('openai-responses')).toBe(false)
    expect(isChatSubscriptionProviderKind(undefined)).toBe(false)
  })
})
