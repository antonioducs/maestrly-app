import { describe, expect, it, vi } from 'vitest'
import {
  CodexAppServerAbortError,
  CodexAppServerClosedError,
  CodexAppServerProcessError,
  CodexAppServerRpcError,
  CodexAppServerTimeoutError,
  classifyCodexQuotaFailure,
  classifyCodexQuotaFailureWithRateLimits,
  extractTurnCompletedError,
  isRateLimitExhausted,
  mergeRateLimits,
  parseCodexRateLimits,
} from '../../src/main/chat/codex-subscription'

describe('parseCodexRateLimits / mergeRateLimits / isRateLimitExhausted', () => {
  it('prefers current rate-limit envelopes', () => {
    const parsed = parseCodexRateLimits({
      rateLimits: {
        primary: { usedPercent: '87.5', resetsAt: 1_700_000_000 },
        secondary: { usedPercent: 120, resetsAt: 1_700_000_000_000 },
        credits: { remaining: 3 },
        rateLimitReachedType: null,
        extra: 'kept',
      },
      rateLimitsByLimitId: {
        codex: { primary: { usedPercent: 100, resetsAt: 1_700_000_100 } },
      },
    })

    expect(parsed).toMatchObject({
      primary: { usedPercent: 87.5, resetsAt: 1_700_000_000_000 },
      secondary: { usedPercent: 100, resetsAt: 1_700_000_000_000 },
      credits: { remaining: 3 },
      rateLimitReachedType: null,
      extra: 'kept',
    })

    const withIso = parseCodexRateLimits({
      rateLimits: { primary: { resetsAt: '2024-01-01T00:00:00.000Z' } },
    })
    expect(withIso?.primary?.resetsAt).toBe(Date.parse('2024-01-01T00:00:00.000Z'))

    expect(parseCodexRateLimits({ rateLimits: { rateLimitReachedType: ' secondary ' } })).toMatchObject({
      rateLimitReachedType: 'secondary',
    })
    expect(parseCodexRateLimits({ rateLimits: { rateLimitReachedType: { type: 'primary' } } })).toMatchObject({
      rateLimitReachedType: null,
    })
  })

  it('preserves flat quota-error fallback', () => {
    const parsed = parseCodexRateLimits({
      primary: { usedPercent: '87.5', resetsAt: 1_700_000_000 },
      secondary: { usedPercent: 120, resetsAt: 1_700_000_000_000 },
      rateLimitReachedType: null,
    })

    expect(parsed).toMatchObject({
      primary: { usedPercent: 87.5, resetsAt: 1_700_000_000_000 },
      secondary: { usedPercent: 100, resetsAt: 1_700_000_000_000 },
      rateLimitReachedType: null,
    })
  })

  it('merges sparse fields without clearing absent values', () => {
    const prev = parseCodexRateLimits({
      primary: { usedPercent: 40, windowDurationMins: 60, resetsAt: 1_700_000_000 },
      secondary: { usedPercent: 10 },
      credits: { remaining: 2 },
      rateLimitReachedType: null,
    })!
    const next = parseCodexRateLimits({
      primary: { usedPercent: 95 },
      rateLimitReachedType: 'primary',
    })!

    expect(mergeRateLimits(prev, next)).toMatchObject({
      primary: { usedPercent: 95, windowDurationMins: 60, resetsAt: 1_700_000_000_000 },
      secondary: { usedPercent: 10 },
      credits: { remaining: 2 },
      rateLimitReachedType: 'primary',
    })
  })

  it('detects exhausted quota through structured limits and usage', () => {
    expect(
      isRateLimitExhausted({
        rateLimitReachedType: 'secondary',
        primary: { resetsAt: 50 },
        secondary: { resetsAt: 60 },
      })
    ).toEqual({
      exhausted: true,
      resetsAt: 60,
      reason: 'rateLimitReachedType',
    })
    expect(
      isRateLimitExhausted({
        rateLimitReachedType: 'future-window',
        primary: { resetsAt: 50 },
        secondary: { resetsAt: 80 },
      })
    ).toEqual({ exhausted: true, resetsAt: 50, reason: 'rateLimitReachedType' })
    expect(isRateLimitExhausted({ limitReached: true, primary: { resetsAt: 50 } })).toEqual({
      exhausted: true,
      resetsAt: 50,
      reason: 'limitReached',
    })
    expect(isRateLimitExhausted({ primary: { usedPercent: 100, resetsAt: 9 } })).toMatchObject({
      exhausted: true,
      resetsAt: 9,
    })
    expect(isRateLimitExhausted({ secondary: { usedPercent: 100, resetsAt: 8 } }).exhausted).toBe(true)
    expect(isRateLimitExhausted({ primary: { usedPercent: 99 } }).exhausted).toBe(false)
  })
})

describe('extractTurnCompletedError', () => {
  it('extracts the message from failed turn/completed', () => {
    expect(
      extractTurnCompletedError({
        threadId: 't1',
        turn: { id: 'turn-1', status: 'failed', error: { message: 'UsageLimitExceeded: weekly' } },
      })
    ).toEqual({
      message: 'UsageLimitExceeded: weekly',
      status: 'failed',
      structured: true,
    })
    expect(extractTurnCompletedError({ turn: { id: 'x', status: 'completed' } })).toBeNull()
  })
})

describe('classifyCodexQuotaFailure', () => {
  it('classifies strong markers and structured turn/completed', () => {
    expect(classifyCodexQuotaFailure(new Error('UsageLimitExceeded'))).toMatchObject({
      kind: 'quota',
      confidence: 'strong-marker',
    })
    expect(
      classifyCodexQuotaFailure({
        threadId: 't',
        turn: { id: '1', status: 'failed', error: { message: 'quota exceeded for plan' } },
      })
    ).toMatchObject({
      kind: 'quota',
      confidence: 'structured',
      message: 'quota exceeded for plan',
    })
  })

  it('preserves RPC error codes, methods and data', () => {
    const error = new CodexAppServerRpcError('usage limit hit', 429, 'turn/start', 7, { kind: 'UsageLimitExceeded' })
    const classified = classifyCodexQuotaFailure(error)
    expect(classified.kind).toBe('quota')
    expect(classified.message).toContain('code=429')
    expect(classified.message).toContain('method=turn/start')
    expect(classified.message).toContain('UsageLimitExceeded')
  })

  it('classifies auth, abort and network errors outside quota', () => {
    expect(classifyCodexQuotaFailure(new Error('unauthorized: login required'))).toEqual({
      kind: 'not-quota',
      reason: 'auth',
      message: 'unauthorized: login required',
    })
    expect(classifyCodexQuotaFailure(new CodexAppServerAbortError('Waiting aborted'))).toMatchObject({
      kind: 'not-quota',
      reason: 'abort',
    })
    expect(
      classifyCodexQuotaFailure(
        new CodexAppServerProcessError('exited unexpectedly', { code: 1, signal: null }, 'boom')
      )
    ).toMatchObject({ kind: 'not-quota', reason: 'network' })
    expect(classifyCodexQuotaFailure(new CodexAppServerTimeoutError('account/read', 1000))).toMatchObject({
      kind: 'not-quota',
      reason: 'network',
    })
    expect(classifyCodexQuotaFailure(new CodexAppServerClosedError())).toMatchObject({
      kind: 'not-quota',
      reason: 'network',
    })
  })

  it('distinguishes transient throttling from suspected quota', () => {
    expect(classifyCodexQuotaFailure(new Error('HTTP 429 Too Many Requests'))).toEqual({
      kind: 'not-quota',
      reason: 'transient-429',
      message: 'HTTP 429 Too Many Requests',
    })
    expect(classifyCodexQuotaFailure(new Error('429 rate limit from upstream'))).toMatchObject({
      kind: 'suspect',
    })
  })

  it('confirms quota suspicions from structured snapshots', () => {
    const classified = classifyCodexQuotaFailure(new Error('429 rate limit from upstream'), {
      rateLimits: {
        primary: { usedPercent: 42, resetsAt: 123 },
        secondary: { usedPercent: 10, resetsAt: 456 },
        rateLimitReachedType: 'secondary',
      },
    })
    expect(classified).toMatchObject({
      kind: 'quota',
      confidence: 'rate-limits-confirmed',
      resetsAt: 456,
    })
  })

  it('resolves weak suspicions while preserving strong quota markers', () => {
    const healthy = {
      primary: { usedPercent: 42, resetsAt: 123 },
      secondary: { usedPercent: 10, resetsAt: 456 },
    }

    expect(classifyCodexQuotaFailure(new Error('429 rate limit from upstream'), { rateLimits: healthy })).toMatchObject(
      { kind: 'not-quota' }
    )
    expect(
      classifyCodexQuotaFailure(new Error('429 rate limit: UsageLimitExceeded'), { rateLimits: healthy })
    ).toMatchObject({ kind: 'quota', confidence: 'strong-marker' })
    expect(classifyCodexQuotaFailure(new Error('429 rate limit from upstream'), { rateLimits: null })).toMatchObject({
      kind: 'suspect',
    })
  })

  it('enriches strong quota errors from exhausted fresh snapshots', async () => {
    const readRateLimits = vi.fn(async () => ({
      rateLimitReachedType: 'secondary',
      secondary: { usedPercent: 100, resetsAt: 1_700_000_100_000 },
    }))

    await expect(
      classifyCodexQuotaFailureWithRateLimits(new Error('UsageLimitExceeded: weekly quota exhausted'), readRateLimits)
    ).resolves.toMatchObject({
      kind: 'quota',
      confidence: 'rate-limits-confirmed',
      resetsAt: 1_700_000_100_000,
      message: expect.stringContaining('rateLimitReachedType'),
    })
    expect(readRateLimits).toHaveBeenCalledOnce()
  })

  it('preserves strong structured quota despite healthy fresh snapshots', async () => {
    const healthy = {
      primary: { usedPercent: 42, resetsAt: 123 },
      secondary: { usedPercent: 10, resetsAt: 456 },
    }
    const readRateLimits = vi.fn(async () => healthy)

    await expect(
      classifyCodexQuotaFailureWithRateLimits(new Error('UsageLimitExceeded: weekly quota exhausted'), readRateLimits)
    ).resolves.toMatchObject({ kind: 'quota', confidence: 'strong-marker' })
    await expect(
      classifyCodexQuotaFailureWithRateLimits(
        { turn: { id: 'turn-1', status: 'failed', error: { message: 'quota exceeded for plan' } } },
        readRateLimits
      )
    ).resolves.toMatchObject({ kind: 'quota', confidence: 'structured' })
    expect(readRateLimits).toHaveBeenCalledTimes(2)
  })

  it('preserves quota errors when limit reads fail', async () => {
    const readRateLimits = vi.fn(async () => {
      throw new Error('rateLimits/read unavailable')
    })

    await expect(
      classifyCodexQuotaFailureWithRateLimits(new Error('UsageLimitExceeded: weekly quota exhausted'), readRateLimits)
    ).resolves.toEqual({
      kind: 'quota',
      confidence: 'strong-marker',
      message: 'UsageLimitExceeded: weekly quota exhausted',
    })
  })
})
