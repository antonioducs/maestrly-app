import { describe, expect, it } from 'vitest'
import type { ChatProviderInfo } from '../../src/shared/chat'
import {
  labelForSubscriptionProvider,
  subscriptionDefaultLabelKey,
  subscriptionExhaustionMessageKey,
} from '../../src/renderer/components/chat/subscription-failover-route'

for (const family of ['codex', 'claude'] as const) {
  describe(`${family} rotation`, () => {
    const primary = `builtin_${family}_subscription`
    const a = `${primary}@a`
    const b = `${primary}@b`
    const accounts: ChatProviderInfo[] = [
      { id: primary, name: family, baseURL: '', kind: `${family}-subscription`, apiKeyPresent: true },
      {
        id: a,
        name: family,
        baseURL: '',
        kind: `${family}-subscription`,
        accountId: 'a',
        accountLabel: ' Work ',
        apiKeyPresent: true,
        connected: false,
      },
      {
        id: b,
        name: family,
        baseURL: '',
        kind: `${family}-subscription`,
        accountId: 'b',
        accountLabel: ' ',
        apiKeyPresent: true,
      },
    ]
    it('uses family defaults, account labels, and stable missing-account identities', () => {
      expect(subscriptionDefaultLabelKey(a)).toBe(`settings.${family}SubscriptionHeading`)
      expect(labelForSubscriptionProvider(primary, accounts, family)).toBe(family)
      expect(labelForSubscriptionProvider(a, accounts, family)).toBe('Work')
      expect(labelForSubscriptionProvider(b, accounts, family)).toBe('b')
      expect(labelForSubscriptionProvider(`${primary}@removed`, accounts, family)).toBe(`${primary}@removed`)
    })
    it('tells which accounts ran out', () => {
      expect(subscriptionExhaustionMessageKey(`${family}-accounts-exhausted`)).toBe(
        family === 'codex' ? 'messages.accountsExhaustedError' : 'messages.claudeAccountsExhaustedError'
      )
      expect(subscriptionExhaustionMessageKey('other')).toBeUndefined()
    })
  })
}
