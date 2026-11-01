import { describe, expect, it } from 'vitest'
import {
  parseDurationText,
  parseRetryAfterHeader,
  retryTimingFromError,
} from '../../src/main/chat/model-fallback/retry-timing'

const NOW = Date.UTC(2026, 9, 31, 12, 0, 0)

describe('retry timing', () => {
  it('parses durations', () => {
    expect(parseDurationText('6m0s')).toBe(360_000)
    expect(parseDurationText('1.5s')).toBe(1_500)
    expect(parseDurationText('200ms')).toBe(200)
    expect(parseDurationText('4h 5m')).toBe(4 * 3_600_000 + 5 * 60_000)
    expect(parseDurationText('4hr 5min')).toBe(4 * 3_600_000 + 5 * 60_000)
    expect(parseDurationText('soon')).toBeNull()
  })

  it('parses Retry-After as seconds or an HTTP date', () => {
    expect(parseRetryAfterHeader('30', NOW)).toBe(NOW + 30_000)
    expect(parseRetryAfterHeader(new Date(NOW + 120_000).toUTCString(), NOW)).toBe(NOW + 120_000)
    expect(parseRetryAfterHeader('garbage', NOW)).toBeNull()
  })

  it('reads retry-after and retry-after-ms headers without capping them', () => {
    expect(retryTimingFromError({ status: 429, responseHeaders: { 'retry-after': '7200' } }, NOW)).toEqual({
      retryAt: NOW + 7_200_000,
      source: 'explicit',
    })
    expect(retryTimingFromError({ status: 429, responseHeaders: { 'retry-after-ms': '1500' } }, NOW)?.retryAt).toBe(
      NOW + 1_500
    )
  })

  it('uses the reset of an exhausted bucket only without an explicit hint', () => {
    const anthropic = {
      status: 429,
      responseHeaders: {
        'anthropic-ratelimit-tokens-remaining': '0',
        'anthropic-ratelimit-tokens-reset': new Date(NOW + 45_000).toISOString(),
        'anthropic-ratelimit-requests-remaining': '10',
        'anthropic-ratelimit-requests-reset': new Date(NOW + 999_000).toISOString(),
      },
    }
    expect(retryTimingFromError(anthropic, NOW)).toEqual({ retryAt: NOW + 45_000, source: 'bucket-reset' })
    const openai = {
      status: 429,
      responseHeaders: { 'x-ratelimit-remaining-requests': '0', 'x-ratelimit-reset-requests': '6m0s' },
    }
    expect(retryTimingFromError(openai, NOW)?.retryAt).toBe(NOW + 360_000)
    expect(
      retryTimingFromError({ ...openai, responseHeaders: { ...openai.responseHeaders, 'retry-after': '5' } }, NOW)
    ).toEqual({ retryAt: NOW + 5_000, source: 'explicit' })
  })

  it('ignores a bucket that still has room', () => {
    expect(
      retryTimingFromError(
        {
          status: 429,
          responseHeaders: { 'x-ratelimit-remaining-tokens': '500', 'x-ratelimit-reset-tokens': '30s' },
        },
        NOW
      )
    ).toBeNull()
  })

  it('reads body fields and Google RetryInfo', () => {
    expect(retryTimingFromError({ status: 429, responseBody: '{"error":{"retry_after":12}}' }, NOW)?.retryAt).toBe(
      NOW + 12_000
    )
    expect(
      retryTimingFromError({ status: 429, responseBody: `{"resets_at":${Math.floor((NOW + 600_000) / 1000)}}` }, NOW)
        ?.retryAt
    ).toBe(NOW + 600_000)
    expect(retryTimingFromError({ status: 429, responseBody: '{"resets_in_seconds":90}' }, NOW)?.retryAt).toBe(
      NOW + 90_000
    )
    const google = {
      status: 429,
      responseBody: JSON.stringify({
        error: {
          code: 429,
          details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '32s' }],
        },
      }),
    }
    expect(retryTimingFromError(google, NOW)?.retryAt).toBe(NOW + 32_000)
  })

  it('reads hints from the provider text', () => {
    expect(retryTimingFromError(new Error('Rate limited. Please try again in 6s.'), NOW)?.retryAt).toBe(NOW + 6_000)
    expect(retryTimingFromError(new Error('Weekly limit reached, resets in 4h 5m'), NOW)?.retryAt).toBe(
      NOW + 4 * 3_600_000 + 5 * 60_000
    )
    expect(retryTimingFromError(new Error('Please retry in 32.5s'), NOW)?.retryAt).toBe(NOW + 32_500)
    expect(retryTimingFromError(new Error('Please try again later'), NOW)).toBeNull()
  })

  it('reads the retryAfter property set by SDK wrappers', () => {
    expect(retryTimingFromError({ status: 429, retryAfter: 3 }, NOW)?.retryAt).toBe(NOW + 3_000)
  })
})
