import { describe, expect, it } from 'vitest'
import {
  GROK_SUBSCRIPTION_PROVIDER,
  GROK_SUBSCRIPTION_PROVIDER_ID,
  isGrokSubscriptionProvider,
  isManagedProvider,
  isSubscriptionProvider,
  withSubscriptionAccount,
} from '../../src/main/chat/catalog'
import { CHAT_SUBSCRIPTION_PROVIDER_KINDS } from '../../src/shared/chat'

describe('Grok subscription catalog', () => {
  it('exposes canonical multi-account descriptors', () => {
    expect(GROK_SUBSCRIPTION_PROVIDER).toEqual({
      id: 'builtin_grok_subscription',
      name: 'Grok',
      baseURL: 'https://api.x.ai/v1',
      kind: 'grok-subscription',
      builtin: 'grok-subscription',
    })
    expect(GROK_SUBSCRIPTION_PROVIDER_ID).toBe('builtin_grok_subscription')
    expect(isGrokSubscriptionProvider(GROK_SUBSCRIPTION_PROVIDER_ID)).toBe(true)
    expect(isGrokSubscriptionProvider(withSubscriptionAccount(GROK_SUBSCRIPTION_PROVIDER_ID, 'acc_1'))).toBe(true)
    expect(isSubscriptionProvider(GROK_SUBSCRIPTION_PROVIDER_ID)).toBe(true)
    expect(isManagedProvider(GROK_SUBSCRIPTION_PROVIDER_ID)).toBe(true)
    expect(CHAT_SUBSCRIPTION_PROVIDER_KINDS).toContain('grok-subscription')
  })
})
