import { describe, expect, it } from 'vitest'
import {
  ACTIVE_ACCOUNT_SLOT,
  accountPoolKindOf,
  activeAccountProviderId,
  isActiveAccountProviderId,
  isPortableExecutionProviderId,
  isSubscriptionFailoverProviderId,
  subscriptionAccountId,
} from '../../src/shared/chat'

describe('active account provider ids', () => {
  it('builds one virtual id per pool family', () => {
    expect(activeAccountProviderId('claude-subscription')).toBe('builtin_claude_subscription@~active')
    expect(activeAccountProviderId('codex-subscription')).toBe('builtin_codex_subscription@~active')
    expect(subscriptionAccountId(activeAccountProviderId('claude-subscription'))).toBe(ACTIVE_ACCOUNT_SLOT)
  })
  it('recognizes only Claude and Codex virtual ids', () => {
    expect(isActiveAccountProviderId('builtin_claude_subscription@~active')).toBe(true)
    expect(isActiveAccountProviderId('builtin_cursor_subscription@~active')).toBe(false)
    expect(isActiveAccountProviderId('builtin_claude_subscription@acc_work')).toBe(false)
    expect(isActiveAccountProviderId('builtin_claude_subscription')).toBe(false)
    expect(isActiveAccountProviderId(null)).toBe(false)
  })
  it('keeps virtual ids out of failover routes and portable execution', () => {
    expect(isSubscriptionFailoverProviderId('builtin_codex_subscription@~active')).toBe(false)
    expect(isSubscriptionFailoverProviderId('builtin_codex_subscription@acc_work')).toBe(true)
    expect(isPortableExecutionProviderId('builtin_codex_subscription@~active')).toBe(false)
  })
  it('maps any id of a pool family to its kind', () => {
    expect(accountPoolKindOf('builtin_codex_subscription@acc_work')).toBe('codex-subscription')
    expect(accountPoolKindOf('builtin_claude_subscription@~active')).toBe('claude-subscription')
    expect(accountPoolKindOf('builtin_cursor_subscription')).toBeNull()
  })
})
