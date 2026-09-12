import { describe, expect, it } from 'vitest'
import type { ChatProviderInfo } from '../../src/shared/chat'
import {
  labelForSubscriptionProvider,
  subscriptionDefaultLabelKey,
  addFallback,
  availableCandidates,
  emptyFailoverRoute,
  moveFallbackDown,
  moveFallbackUp,
  removeFallback,
  routeForPrimary,
  withEnabled,
} from '../../src/renderer/components/chat/subscription-failover-route'

const PRIMARY = 'builtin_codex_subscription'
const ACC_A = 'builtin_codex_subscription@acc_a'
const ACC_B = 'builtin_codex_subscription@acc_b'

const providers: ChatProviderInfo[] = [
  {
    id: PRIMARY,
    name: 'Codex',
    baseURL: 'codex://x',
    apiKeyPresent: false,
    connected: true,
    kind: 'codex-subscription',
  },
  {
    id: ACC_A,
    name: 'Codex — Work',
    baseURL: 'codex://x',
    apiKeyPresent: false,
    connected: false,
    kind: 'codex-subscription',
    accountId: 'acc_a',
    accountLabel: 'Work',
  },
  {
    id: ACC_B,
    name: 'Codex — Home',
    baseURL: 'codex://x',
    apiKeyPresent: false,
    connected: true,
    kind: 'codex-subscription',
    accountId: 'acc_b',
    accountLabel: 'Home',
  },
  {
    id: 'builtin_claude_subscription',
    name: 'Claude',
    baseURL: 'claude://x',
    apiKeyPresent: false,
    connected: true,
    kind: 'claude-subscription',
  },
]

describe('subscription-failover-route helpers', () => {
  it('routeForPrimary falls back to empty disabled route', () => {
    expect(routeForPrimary([], PRIMARY)).toEqual(emptyFailoverRoute(PRIMARY))
  })

  it('availableCandidates excludes self, duplicates, and other providers', () => {
    expect(
      availableCandidates({
        primaryProviderId: PRIMARY,
        fallbackProviderIds: [ACC_A],
        providers,
        defaultLabel: 'Default Codex',
      })
    ).toEqual([{ providerId: ACC_B, label: 'Home', connected: true }])
  })

  it('add/remove/move transform the ordered fallback list', () => {
    let route = emptyFailoverRoute(PRIMARY)
    route = addFallback(route, ACC_A)
    route = addFallback(route, ACC_B)
    route = addFallback(route, ACC_A) // duplicate no-op
    route = addFallback(route, 'builtin_claude_subscription') // other provider no-op
    expect(route.fallbackProviderIds).toEqual([ACC_A, ACC_B])

    route = moveFallbackDown(route, 0)
    expect(route.fallbackProviderIds).toEqual([ACC_B, ACC_A])
    route = moveFallbackUp(route, 1)
    expect(route.fallbackProviderIds).toEqual([ACC_A, ACC_B])

    route = removeFallback(route, ACC_A)
    expect(route.fallbackProviderIds).toEqual([ACC_B])
    expect(withEnabled(route, true).enabled).toBe(true)
  })
})

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
    it('isolates families and deduplicates candidates while retaining disconnected accounts', () => {
      expect(
        availableCandidates({
          primaryProviderId: primary,
          fallbackProviderIds: [],
          providers: [...accounts, ...accounts, ...providers.filter((p) => !p.id.startsWith(primary))],
          defaultLabel: family,
        })
      ).toEqual([
        { providerId: a, label: 'Work', connected: false },
        { providerId: b, label: 'b', connected: true },
      ])
      expect(
        availableCandidates({
          primaryProviderId: a,
          fallbackProviderIds: [b],
          providers: accounts,
          defaultLabel: family,
        })
      ).toEqual([{ providerId: primary, label: family, connected: true }])
    })
    it('preserves explicit ordering and rejects cross-family and unsupported slots', () => {
      const route = addFallback(addFallback(emptyFailoverRoute(primary), a), b)
      for (const invalid of [
        a,
        primary,
        'builtin_grok_subscription',
        `builtin_${family === 'codex' ? 'claude' : 'codex'}_subscription@other`,
      ]) {
        expect(addFallback(route, invalid)).toBe(route)
      }
      expect(moveFallbackDown(route, 0).fallbackProviderIds).toEqual([b, a])
      expect(moveFallbackUp(moveFallbackDown(route, 0), 1)).toEqual(route)
      expect(routeForPrimary([route], primary)).toBe(route)
      expect(removeFallback(route, a).fallbackProviderIds).toEqual([b])
    })
    it('uses family defaults, account labels, and stable missing-account identities', () => {
      expect(subscriptionDefaultLabelKey(a)).toBe(`settings.${family}SubscriptionHeading`)
      expect(labelForSubscriptionProvider(primary, accounts, family)).toBe(family)
      expect(labelForSubscriptionProvider(a, accounts, family)).toBe('Work')
      expect(labelForSubscriptionProvider(b, accounts, family)).toBe('b')
      expect(labelForSubscriptionProvider(`${primary}@removed`, accounts, family)).toBe(`${primary}@removed`)
    })
  })
}
