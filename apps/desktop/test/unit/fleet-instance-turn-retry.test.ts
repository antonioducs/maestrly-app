import { describe, expect, it, vi } from 'vitest'

const chains = vi.hoisted(() => new Map<string, string[]>())
vi.mock('../../src/main/chat/subscription-failover/config', () => ({
  freezeFailoverChain: (providerId: string) => chains.get(providerId) ?? [providerId],
}))
vi.mock('../../src/main/chat/diag-log', () => ({ chatDiag: () => {} }))

import {
  QUOTA_RECHECK_MS,
  START_RETRY_MAX_MS,
  START_RETRY_MIN_MS,
  startRetry,
} from '../../src/main/fleet/instance/turn-retry'
import { HALF_OPEN_RECHECK_MS, SubscriptionFailoverRouter } from '../../src/main/chat/subscription-failover/router'

const NOW = Date.parse('2026-10-12T15:00:00.000Z')
const PRIMARY = 'builtin_claude_subscription'
const SECOND = 'builtin_claude_subscription@acc_two'
const exhausted = (router: SubscriptionFailoverRouter, providerId: string, resetsAt: number) =>
  router.markExhausted(providerId, { reason: 'usage limit', source: 'structured-error', resetsAt, now: NOW })

describe('bot turn start retries', () => {
  it('waits for the first account of the failover list to come back, instead of every few seconds', () => {
    const router = new SubscriptionFailoverRouter()
    chains.set(PRIMARY, [PRIMARY, SECOND])
    exhausted(router, PRIMARY, NOW + 60 * 60_000)
    exhausted(router, SECOND, NOW + 4 * 60_000)
    const retry = startRetry(new Error('claude-accounts-exhausted'), 1, () => PRIMARY, NOW, router)
    expect(retry).toEqual({
      at: NOW + 4 * 60_000,
      key: 'claude-accounts-exhausted',
      text: 'claude-accounts-exhausted until=2026-10-12T15:04:00.000Z',
      // A usage limit holds every conversation of the bot: they share its accounts.
      quota: true,
    })
    // The same failure on the next attempts keeps the same kind: the bot reports it once.
    expect(startRetry(new Error('claude-accounts-exhausted'), 7, () => PRIMARY, NOW, router).key).toBe(retry.key)
  })

  it('checks again before a distant reset, so a newly connected account can take over', () => {
    const router = new SubscriptionFailoverRouter()
    chains.set(PRIMARY, [PRIMARY])
    exhausted(router, PRIMARY, NOW + 3 * 24 * 60 * 60_000)
    const retry = startRetry(new Error('claude-accounts-exhausted'), 1, () => PRIMARY, NOW, router)
    expect(retry.at).toBe(NOW + QUOTA_RECHECK_MS)
    expect(retry.text).toBe('claude-accounts-exhausted until=2026-10-15T15:00:00.000Z')
  })

  it('backs off other start failures up to a ceiling', () => {
    const router = new SubscriptionFailoverRouter()
    const delays = [1, 2, 3, 4, 10, 50].map(
      (failures) => startRetry(new Error('unavailable'), failures, () => PRIMARY, NOW, router).at - NOW
    )
    expect(delays).toEqual([
      START_RETRY_MIN_MS,
      2 * START_RETRY_MIN_MS,
      4 * START_RETRY_MIN_MS,
      8 * START_RETRY_MIN_MS,
      START_RETRY_MAX_MS,
      START_RETRY_MAX_MS,
    ])
    expect(startRetry('not an error', 1, () => null, NOW, router)).toMatchObject({
      key: '',
      text: 'Turn failed.',
      quota: false,
    })
    // Any other failure holds only the conversation whose turn could not start.
    expect(startRetry(new Error('unavailable'), 1, () => PRIMARY, NOW, router).quota).toBe(false)
  })

  it('falls back to backing off when the router already admits an account again', () => {
    const router = new SubscriptionFailoverRouter()
    chains.set(PRIMARY, [PRIMARY])
    const retry = startRetry(new Error('codex-accounts-exhausted'), 2, () => PRIMARY, NOW, router)
    expect(retry).toEqual({
      at: NOW + 2 * START_RETRY_MIN_MS,
      key: 'codex-accounts-exhausted',
      text: 'codex-accounts-exhausted',
      quota: true,
    })
  })
})

describe('failover router recovery time', () => {
  it('is now when an account of the chain may take a turn, else the earliest probe', () => {
    const router = new SubscriptionFailoverRouter()
    expect(router.recoveryAt([], NOW)).toBe(NOW)
    exhausted(router, PRIMARY, NOW + 10 * 60_000)
    expect(router.recoveryAt([PRIMARY, SECOND], NOW)).toBe(NOW)
    exhausted(router, SECOND, NOW + 2 * 60_000)
    expect(router.recoveryAt([PRIMARY, SECOND], NOW)).toBe(NOW + 2 * 60_000)
    // Once due, a probe may start at once.
    expect(router.recoveryAt([PRIMARY, SECOND], NOW + 3 * 60_000)).toBe(NOW + 3 * 60_000)
  })

  it('gives an in-flight probe time to settle', () => {
    const router = new SubscriptionFailoverRouter()
    exhausted(router, PRIMARY, NOW + 60_000)
    expect(router.tryAdmit(PRIMARY, NOW + 60_000)).toMatchObject({ ok: true })
    expect(router.recoveryAt([PRIMARY], NOW + 60_000)).toBe(NOW + 60_000 + HALF_OPEN_RECHECK_MS)
  })
})
