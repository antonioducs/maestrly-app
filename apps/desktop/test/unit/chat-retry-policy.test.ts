import { describe, expect, it } from 'vitest'
import {
  AI_SDK_MAX_RETRIES,
  classifyStreamRetry,
  HIGH_USAGE_RETRY_CONTEXT_MULTIPLIER,
  HIGH_USAGE_RETRY_STEP_LIMIT,
  shouldBlockHighUsageRetry,
} from '../../src/main/chat/retry-policy'

describe('chat retry policy', () => {
  it('keeps internal AI SDK retries disabled', () => {
    expect(AI_SDK_MAX_RETRIES).toBe(0)
  })

  it('does not retry quota, credit or account-limit errors', () => {
    expect(
      classifyStreamRetry({
        statusCode: 429,
        message: "This request would exceed your account's rate limit",
      })
    ).toEqual({ retryable: false, reason: 'quota', delayMs: 0 })
    expect(classifyStreamRetry({ status: 429, message: 'insufficient_quota: credit balance is too low' })).toEqual({
      retryable: false,
      reason: 'quota',
      delayMs: 0,
    })
  })

  it('respects Retry-After for transient throttling', () => {
    expect(
      classifyStreamRetry({
        status: 429,
        message: 'rate limited',
        responseHeaders: { 'retry-after': '12' },
      })
    ).toEqual({ retryable: true, reason: 'transient', delayMs: 12_000 })
  })

  it('blocks retries after high step or window consumption', () => {
    expect(
      shouldBlockHighUsageRetry({
        steps: HIGH_USAGE_RETRY_STEP_LIMIT,
        totalInput: 1,
        contextWindow: 200_000,
      })
    ).toBe(true)
    expect(
      shouldBlockHighUsageRetry({
        steps: 1,
        totalInput: 200_000 * HIGH_USAGE_RETRY_CONTEXT_MULTIPLIER,
        contextWindow: 200_000,
      })
    ).toBe(true)
    expect(shouldBlockHighUsageRetry({ steps: 2, totalInput: 100_000, contextWindow: 200_000 })).toBe(false)
  })
})
