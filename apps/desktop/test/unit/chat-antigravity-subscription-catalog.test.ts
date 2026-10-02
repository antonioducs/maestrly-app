import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  addSubscriptionAccount,
  ANTIGRAVITY_SUBSCRIPTION_PROVIDER_ID,
  isAntigravitySubscriptionProvider,
  isManagedProvider,
  isSubscriptionProvider,
  listAvailableChatProviders,
  subscriptionProviderIdFor,
} from '../../src/main/chat/catalog'
import { CHAT_SUBSCRIPTION_PROVIDER_KINDS, isChatSubscriptionProviderKind } from '../../src/shared/chat'
import { closeDb, freshDb } from '../helpers/db'

describe('Google AI subscription catalog entry', () => {
  beforeEach(freshDb)
  afterEach(closeDb)

  it('is a managed subscription provider kind', () => {
    expect(CHAT_SUBSCRIPTION_PROVIDER_KINDS).toContain('antigravity-subscription')
    expect(isChatSubscriptionProviderKind('antigravity-subscription')).toBe(true)
    expect(ANTIGRAVITY_SUBSCRIPTION_PROVIDER_ID).toBe('builtin_antigravity_subscription')
    expect(isSubscriptionProvider(ANTIGRAVITY_SUBSCRIPTION_PROVIDER_ID)).toBe(true)
    expect(isManagedProvider(ANTIGRAVITY_SUBSCRIPTION_PROVIDER_ID)).toBe(true)
    expect(isAntigravitySubscriptionProvider('builtin_cursor_subscription')).toBe(false)
  })

  it('derives additional account slots', () => {
    const account = addSubscriptionAccount('antigravity-subscription', 'Trabalho')
    const providerId = subscriptionProviderIdFor('antigravity-subscription', account.id)
    expect(providerId).toMatch(/^builtin_antigravity_subscription@acc_/)
    expect(isAntigravitySubscriptionProvider(providerId)).toBe(true)
    expect(isSubscriptionProvider(providerId)).toBe(true)
  })

  it('lists the default and additional Google AI accounts in the chat catalog', () => {
    const account = addSubscriptionAccount('antigravity-subscription', 'Trabalho')
    const ids = listAvailableChatProviders().map((provider) => provider.id)
    expect(ids).toContain(ANTIGRAVITY_SUBSCRIPTION_PROVIDER_ID)
    expect(ids).toContain(subscriptionProviderIdFor('antigravity-subscription', account.id))
  })
})
