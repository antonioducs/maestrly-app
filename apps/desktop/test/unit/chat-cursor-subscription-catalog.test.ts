import { describe, expect, it } from 'vitest'
import {
  CURSOR_SUBSCRIPTION_PROVIDER,
  CURSOR_SUBSCRIPTION_PROVIDER_ID,
  isCursorSubscriptionProvider,
  isManagedProvider,
  isSubscriptionProvider,
  withSubscriptionAccount,
} from '../../src/main/chat/catalog'
import {
  CHAT_SUBSCRIPTION_PROVIDER_KINDS,
  isPortableExecutionProviderId,
  isSubscriptionFailoverProviderId,
} from '../../src/shared/chat'

describe('Cursor subscription catalog', () => {
  it('recognizes default and additional accounts as managed subscription providers', () => {
    expect(CURSOR_SUBSCRIPTION_PROVIDER).toEqual({
      id: 'builtin_cursor_subscription',
      name: 'Cursor',
      baseURL: 'cursor://subscription',
      kind: 'cursor-subscription',
      builtin: 'cursor-subscription',
    })
    for (const id of [
      CURSOR_SUBSCRIPTION_PROVIDER_ID,
      withSubscriptionAccount(CURSOR_SUBSCRIPTION_PROVIDER_ID, 'acc_1'),
    ]) {
      expect(isCursorSubscriptionProvider(id)).toBe(true)
      expect(isManagedProvider(id)).toBe(true)
      expect(isSubscriptionProvider(id)).toBe(true)
      expect(isSubscriptionFailoverProviderId(id)).toBe(false)
    }
    expect(CHAT_SUBSCRIPTION_PROVIDER_KINDS).toContain('cursor-subscription')
  })
  it('allows portable selections with valid account slots', () => {
    expect(isPortableExecutionProviderId(CURSOR_SUBSCRIPTION_PROVIDER_ID)).toBe(true)
    expect(
      isPortableExecutionProviderId(
        withSubscriptionAccount(CURSOR_SUBSCRIPTION_PROVIDER_ID, 'acc_00000000-0000-4000-8000-000000000001')
      )
    ).toBe(true)
    expect(isPortableExecutionProviderId(withSubscriptionAccount(CURSOR_SUBSCRIPTION_PROVIDER_ID, '../escape'))).toBe(
      false
    )
    expect(isCursorSubscriptionProvider('prov_cursor')).toBe(false)
  })
})
