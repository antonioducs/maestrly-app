import { afterEach, describe, expect, it } from 'vitest'
import { computeCooldownUntil } from '../../src/main/chat/model-fallback/cooldown-policy'
import {
  clearStickyWinner,
  recordStickyWinner,
  resetStickyWinnersForTests,
  STICKY_IDLE_MS,
  STICKY_MAX_MS,
  stickyWinner,
  touchStickyWinner,
} from '../../src/main/chat/model-fallback/sticky'
import { modelCircuitKey, SubscriptionFailoverRouter } from '../../src/main/chat/subscription-failover/router'

const NOW = Date.UTC(2026, 9, 31, 12, 0, 0)
const MIN = 60_000
const HOUR = 60 * MIN

describe('cooldown policy', () => {
  it('follows the provider timing exactly for rate limits and never invents one', () => {
    expect(computeCooldownUntil('rate_limit', 1, NOW, NOW + 7 * HOUR)).toBe(NOW + 7 * HOUR)
    expect(computeCooldownUntil('rate_limit', 5, NOW)).toBeNull()
    expect(computeCooldownUntil('rate_limit', 1, NOW, NOW - 1)).toBeNull()
  })

  it('escalates billing to 24 h and auth to 1 h', () => {
    expect(computeCooldownUntil('billing', 1, NOW)).toBe(NOW + 10 * MIN)
    expect(computeCooldownUntil('billing', 2, NOW)).toBe(NOW + 20 * MIN)
    expect(computeCooldownUntil('billing', 4, NOW)).toBe(NOW + 80 * MIN)
    expect(computeCooldownUntil('billing', 20, NOW)).toBe(NOW + 24 * HOUR)
    expect(computeCooldownUntil('auth', 1, NOW)).toBe(NOW + 10 * MIN)
    expect(computeCooldownUntil('auth', 3, NOW)).toBe(NOW + 40 * MIN)
    expect(computeCooldownUntil('auth', 4, NOW)).toBe(NOW + HOUR)
  })

  it('steps transient model failures 30 s, 60 s, then 5 min', () => {
    expect(computeCooldownUntil('overloaded', 1, NOW)).toBe(NOW + 30_000)
    expect(computeCooldownUntil('server_error', 2, NOW)).toBe(NOW + 60_000)
    expect(computeCooldownUntil('timeout', 3, NOW)).toBe(NOW + 5 * MIN)
    expect(computeCooldownUntil('model_not_found', 9, NOW)).toBe(NOW + 5 * MIN)
    expect(computeCooldownUntil('overloaded', 1, NOW, NOW + 2 * MIN)).toBe(NOW + 2 * MIN)
  })

  it('keeps the subscription quota rule', () => {
    expect(computeCooldownUntil('quota', 1, NOW, NOW + HOUR)).toBe(NOW + HOUR)
    expect(computeCooldownUntil('quota', 1, NOW)).toBe(NOW + 5 * MIN)
  })
})

describe('router model circuits', () => {
  const router = new SubscriptionFailoverRouter()
  afterEach(() => router.reset())

  it('a model cooldown does not block another model of the same account', () => {
    const a = modelCircuitKey('openai', 'gpt-a')
    const b = modelCircuitKey('openai', 'gpt-b')
    router.recordFailure(a, { kind: 'overloaded', reason: 'overloaded', now: NOW })
    expect(router.isAdmissible(a, NOW + 1_000)).toBe(false)
    expect(router.isAdmissible(b, NOW + 1_000)).toBe(true)
    expect(router.isAdmissible('openai', NOW + 1_000)).toBe(true)
    expect(router.isAdmissible(a, NOW + 30_000)).toBe(true)
  })

  it('opens a rate-limit circuit only with provider timing, for exactly that long', () => {
    const key = modelCircuitKey('anthropic', 'claude-x')
    expect(router.recordFailure(key, { kind: 'rate_limit', reason: '429', now: NOW })).toBeNull()
    expect(router.isAdmissible(key, NOW)).toBe(true)
    router.recordFailure(key, { kind: 'rate_limit', reason: '429', retryAt: NOW + 90_000, now: NOW })
    expect(router.getHealth(key).exhaustion?.nextProbeAt).toBe(NOW + 90_000)
    expect(router.isAdmissible(key, NOW + 89_999)).toBe(false)
    expect(router.isAdmissible(key, NOW + 90_000)).toBe(true)
  })

  it('escalates repeated billing failures and resets the count after a success', () => {
    router.recordFailure('openrouter', { kind: 'billing', reason: 'no credits', now: NOW })
    expect(router.getHealth('openrouter').exhaustion?.nextProbeAt).toBe(NOW + 10 * MIN)
    const later = NOW + 11 * MIN
    router.recordFailure('openrouter', { kind: 'billing', reason: 'no credits', now: later })
    expect(router.getHealth('openrouter').exhaustion?.nextProbeAt).toBe(later + 20 * MIN)
    expect(router.failureCount('openrouter', 'billing', later)).toBe(2)
    const generation = router.getHealth('openrouter').exhaustion!.generation
    router.markAvailable('openrouter', { generation })
    expect(router.failureCount('openrouter', 'billing', later)).toBe(0)
  })

  it('forgets failure counts after 24 h', () => {
    router.recordFailure('p', { kind: 'auth', reason: '401', now: NOW })
    router.recordFailure('p', { kind: 'auth', reason: '401', now: NOW + 11 * MIN })
    expect(router.failureCount('p', 'auth', NOW + 11 * MIN)).toBe(2)
    const nextDay = NOW + 11 * MIN + 24 * HOUR + 1
    expect(router.failureCount('p', 'auth', nextDay)).toBe(0)
    router.recordFailure('p', { kind: 'auth', reason: '401', now: nextDay })
    expect(router.getHealth('p').exhaustion?.nextProbeAt).toBe(nextDay + 10 * MIN)
  })

  it('never shortens an open circuit with a briefer failure', () => {
    router.recordFailure('p', { kind: 'billing', reason: 'credits', now: NOW })
    router.recordFailure('p', { kind: 'timeout', reason: 'timeout', now: NOW + 1_000 })
    expect(router.getHealth('p').exhaustion?.nextProbeAt).toBe(NOW + 10 * MIN)
  })

  it('a model half-open lease that is never settled expires', () => {
    const key = modelCircuitKey('openai', 'gpt-a')
    router.recordFailure(key, { kind: 'overloaded', reason: 'overloaded', now: NOW })
    const admitted = router.tryAdmit(key, NOW + 30_000, { leaseTtlMs: 60_000 })
    expect(admitted).toMatchObject({ ok: true, lease: expect.any(Object) })
    expect(router.tryAdmit(key, NOW + 31_000, { leaseTtlMs: 60_000 })).toMatchObject({ ok: false })
    expect(router.isAdmissible(key, NOW + 89_999)).toBe(false)
    expect(router.isAdmissible(key, NOW + 90_000)).toBe(true)
    expect(router.tryAdmit(key, NOW + 90_000, { leaseTtlMs: 60_000 })).toMatchObject({ ok: true })
  })

  it('account half-open leases keep their singleflight semantics without a TTL', () => {
    router.markExhausted('acc', { reason: 'quota', source: 'structured-error', now: NOW })
    const admitted = router.tryAdmit('acc', NOW + 5 * MIN)
    expect(admitted.ok).toBe(true)
    expect(router.isAdmissible('acc', NOW + 10 * HOUR)).toBe(false)
  })
})

describe('sticky fallback winner', () => {
  const primary = { providerId: 'anthropic', modelId: 'opus' }
  const winner = { providerId: 'openai', modelId: 'gpt' }
  afterEach(() => resetStickyWinnersForTests())

  it('keeps the winner for 10 idle minutes', () => {
    recordStickyWinner('conv:1', primary, winner, 'rate_limit', NOW)
    expect(stickyWinner('conv:1', primary, NOW + STICKY_IDLE_MS)).toEqual(winner)
    expect(stickyWinner('conv:1', primary, NOW + STICKY_IDLE_MS + 1)).toBeNull()
  })

  it('caps reuse at 30 minutes from the first stick', () => {
    recordStickyWinner('conv:1', primary, winner, 'quota', NOW)
    for (let t = NOW + 5 * MIN; t < NOW + STICKY_MAX_MS; t += 5 * MIN) touchStickyWinner('conv:1', winner, t)
    expect(stickyWinner('conv:1', primary, NOW + STICKY_MAX_MS - 1)).toEqual(winner)
    expect(stickyWinner('conv:1', primary, NOW + STICKY_MAX_MS + 1)).toBeNull()
  })

  it('applies only to capacity reasons and to the same primary', () => {
    recordStickyWinner('conv:1', primary, winner, 'context_overflow', NOW)
    expect(stickyWinner('conv:1', primary, NOW)).toBeNull()
    recordStickyWinner('conv:1', primary, winner, 'overloaded', NOW)
    expect(stickyWinner('conv:1', { providerId: 'anthropic', modelId: 'sonnet' }, NOW)).toBeNull()
  })

  it('is cleared when the winner fails', () => {
    recordStickyWinner('conv:1', primary, winner, 'billing', NOW)
    clearStickyWinner('conv:1')
    expect(stickyWinner('conv:1', primary, NOW)).toBeNull()
  })
})
