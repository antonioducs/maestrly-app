import {
  subscriptionExhaustionMessageKey,
  subscriptionDefaultLabelKey,
} from '../../src/renderer/components/chat/subscription-failover-route'
import { describe, expect, it } from 'vitest'
import en from '../../src/shared/i18n/en/chat'
import pt from '../../src/shared/i18n/pt-BR/chat'

const KEYS = [
  'automaticRotation',
  'automaticRotationDescription',
  'addFallbackAccount',
  'moveFallbackUp',
  'moveFallbackDown',
  'removeFallback',
  'fallbackDisconnectedWarning',
  'accountsExhaustedError',
  'claudeAccountsExhaustedError',
  'failoverSwitchStatus',
] as const

describe('subscription failover i18n', () => {
  it('keeps settings keys in both locales', () => {
    for (const key of KEYS) {
      expect(typeof en.settings[key]).toBe('string')
      expect(en.settings[key].length).toBeGreaterThan(0)
      expect(typeof pt.settings[key]).toBe('string')
      expect(pt.settings[key].length).toBeGreaterThan(0)
    }
    expect(en.settings.failoverSwitchStatus).toContain('{{from}}')
    expect(pt.settings.failoverSwitchStatus).toContain('{{to}}')
    expect(en.messages.accountsExhaustedError.length).toBeGreaterThan(0)
    expect(pt.messages.accountsExhaustedError.length).toBeGreaterThan(0)
  })

  it.each([en, pt])('resolves both error families through the shared admission and stream lookup', (locale) => {
    for (const family of ['codex', 'claude'] as const) {
      const key = subscriptionExhaustionMessageKey(`${family}-accounts-exhausted`)!
      const message =
        locale.messages[
          key === 'messages.accountsExhaustedError' ? 'accountsExhaustedError' : 'claudeAccountsExhaustedError'
        ]
      expect(message).toContain(family === 'codex' ? 'Codex' : 'Claude')
      const headingKey = subscriptionDefaultLabelKey(`builtin_${family}_subscription@work`)
      expect(
        locale.settings[
          headingKey === 'settings.codexSubscriptionHeading' ? 'codexSubscriptionHeading' : 'claudeSubscriptionHeading'
        ]
      ).toContain(family === 'codex' ? 'Codex' : 'Claude')
    }
    expect(subscriptionExhaustionMessageKey('unknown')).toBeUndefined()
    expect(locale.settings.automaticRotationDescription).not.toMatch(/Codex|Claude/)
  })
})
