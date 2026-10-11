import { describe, expect, it } from 'vitest'
import { createRateLimiter } from '../src/http/rate-limit.js'
import { testClock } from './helpers.js'

const MINUTE = 60_000

describe('rate limiter', () => {
  it('allows a fixed number of requests per minute, per scope and key', () => {
    const clock = testClock()
    const limiter = createRateLimiter(clock.now)
    for (let i = 0; i < 600; i++) expect(limiter.allow('host', '')).toBe(true)
    expect(limiter.allow('host', '')).toBe(false)
    // Other scopes and keys have their own budget.
    expect(limiter.allow('artifact', 'A')).toBe(true)
    clock.advance(MINUTE - 1)
    expect(limiter.allow('host', '')).toBe(false)
    clock.advance(1)
    expect(limiter.allow('host', '')).toBe(true)

    // The artifact's earlier window ended with the minute, so it has its full budget again.
    for (let i = 0; i < 300; i++) expect(limiter.allow('artifact', 'A')).toBe(true)
    expect(limiter.allow('artifact', 'A')).toBe(false)
    expect(limiter.allow('artifact', 'B')).toBe(true)
    for (let i = 0; i < 120; i++) expect(limiter.allow('session', 's1')).toBe(true)
    expect(limiter.allow('session', 's1')).toBe(false)
    expect(limiter.allow('session', 's2')).toBe(true)
  })

  it('makes a browser wait fifteen minutes after five wrong codes', () => {
    const clock = testClock()
    const limiter = createRateLimiter(clock.now)
    for (let i = 0; i < 5; i++) {
      expect(limiter.codeAttempt('A', 'browser').allowed).toBe(true)
      limiter.codeFailed('A', 'browser')
    }
    expect(limiter.codeAttempt('A', 'browser')).toEqual({ allowed: false, retryAfterMs: 15 * MINUTE })
    expect(limiter.codeAttempt('A', 'other').allowed).toBe(true)
    expect(limiter.codeAttempt('B', 'browser').allowed).toBe(true)
    clock.advance(15 * MINUTE - 1)
    expect(limiter.codeAttempt('A', 'browser')).toEqual({ allowed: false, retryAfterMs: 1 })
    clock.advance(1)
    expect(limiter.codeAttempt('A', 'browser').allowed).toBe(true)
  })

  it('caps code attempts per artifact per hour, whatever the browser', () => {
    const clock = testClock()
    const limiter = createRateLimiter(clock.now)
    for (let i = 0; i < 100; i++) expect(limiter.codeAttempt('A', `browser-${i}`).allowed).toBe(true)
    const refused = limiter.codeAttempt('A', 'browser-new')
    expect(refused.allowed).toBe(false)
    expect(refused.retryAfterMs).toBe(60 * MINUTE)
    expect(limiter.codeAttempt('B', 'browser-new').allowed).toBe(true)
    clock.advance(60 * MINUTE)
    expect(limiter.codeAttempt('A', 'browser-new').allowed).toBe(true)
  })
})
