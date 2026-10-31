import {
  subscriptionExhaustionMessageKey,
  subscriptionDefaultLabelKey,
} from '../../src/renderer/components/chat/subscription-failover-route'
import { describe, expect, it } from 'vitest'
import { FALLBACK_REASONS } from '../../src/main/chat/model-fallback/error-classifier'
import en from '../../src/shared/i18n/en/chat'
import pt from '../../src/shared/i18n/pt-BR/chat'
import enEnvironment from '../../src/shared/i18n/en/environment-settings'
import ptEnvironment from '../../src/shared/i18n/pt-BR/environment-settings'

const placeholders = (text: string) => [...text.matchAll(/{{(\w+)}}/g)].map((match) => match[1]).sort()
const poolKeys = (settings: Record<string, unknown>) =>
  Object.keys(settings)
    .filter((key) => key.startsWith('accountPool'))
    .sort()

describe('subscription failover i18n', () => {
  it('keeps the rotation keys and their placeholders in both locales', () => {
    const keys = poolKeys(en.settings)
    expect(keys.length).toBeGreaterThan(20)
    expect(poolKeys(pt.settings)).toEqual(keys)
    for (const key of [...keys, 'accountsExhaustedError', 'claudeAccountsExhaustedError', 'failoverSwitchStatus']) {
      const english = en.settings[key as keyof typeof en.settings] as string
      const portuguese = pt.settings[key as keyof typeof pt.settings] as string
      expect(english.length, key).toBeGreaterThan(0)
      expect(portuguese.length, key).toBeGreaterThan(0)
      expect(placeholders(portuguese), key).toEqual(placeholders(english))
    }
    expect(en.messages.accountsExhaustedError.length).toBeGreaterThan(0)
    expect(pt.messages.accountsExhaustedError.length).toBeGreaterThan(0)
  })

  it('keeps the environment rotation texts in both locales', () => {
    const flatten = (value: unknown, prefix = ''): Array<[string, string]> =>
      typeof value === 'string'
        ? [[prefix, value]]
        : Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => flatten(child, `${prefix}.${key}`))
    const english = flatten(enEnvironment.accountPools)
    const portuguese = new Map(flatten(ptEnvironment.accountPools))
    expect(english.map(([key]) => key).sort()).toEqual([...portuguese.keys()].sort())
    for (const [key, text] of english) expect(placeholders(portuguese.get(key)!), key).toEqual(placeholders(text))
    expect(enEnvironment).not.toHaveProperty('failover')
    expect(ptEnvironment).not.toHaveProperty('failover')
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
  })

  it.each([en, pt])('names every reason that can move a turn to another model', (locale) => {
    expect(locale.settings.modelFallbackSwitchStatus).toContain('{{to}}')
    for (const reason of [...FALLBACK_REASONS, 'unknown'] as const) {
      const text = (locale.settings.modelFallbackReason as Record<string, string>)[reason]
      expect(typeof text).toBe('string')
      expect(text.length).toBeGreaterThan(0)
    }
  })
})
