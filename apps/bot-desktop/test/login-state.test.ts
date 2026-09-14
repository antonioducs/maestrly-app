import { expect, it } from 'vitest'
import type { AuthStatus } from '@maestrly/host-protocol'
import { mergeLoginStatus } from '../src/renderer/features/onboarding/login-state'
const pending: AuthStatus = { state: 'connecting', provider: 'codex', pending: { loginId: 'one', userCode: 'CODE', verificationUrl: 'https://auth.openai.com/codex/device', expiresAt: new Date(2000).toISOString() } }
it('retains the challenge across stale disconnected polls but expires without claiming success', () => {
  expect(mergeLoginStatus(pending, { state: 'disconnected', provider: 'codex' }, 1000)).toEqual(pending)
  expect(mergeLoginStatus(pending, { state: 'disconnected', provider: 'codex' }, 2000)).toMatchObject({ state: 'expired' })
})
it('accepts definitive completion, rejection and new challenges', () => {
  for (const state of ['connected', 'incompatible', 'expired'] as const) {
    expect(mergeLoginStatus(pending, { state, provider: 'codex' }, 1000).state).toBe(state)
  }
  const next: AuthStatus = { ...pending, pending: { ...pending.pending!, loginId: 'two' } }
  expect(mergeLoginStatus(pending, next, 1000).pending?.loginId).toBe('two')
})
