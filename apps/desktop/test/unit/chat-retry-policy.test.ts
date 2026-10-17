import { describe, expect, it } from 'vitest'
import { APICallError } from '@ai-sdk/provider'
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

  it('classifies a provider failure by its response, never by the prompt it was sent', () => {
    const failure = (statusCode: number, responseBody: string) =>
      new APICallError({
        message: '',
        url: 'https://provider.test/v1/chat/completions',
        requestBodyValues: {
          messages: [
            { role: 'system', content: 'The bash tool has a timeout; on a network error or rate limit, wait.' },
          ],
        },
        statusCode,
        responseHeaders: { connection: 'keep-alive', 'keep-alive': 'timeout=5' },
        responseBody,
      })
    expect(
      classifyStreamRetry(failure(402, '[{"error":{"message":"Your prepayment credits are depleted."}}]'))
    ).toEqual({ retryable: false, reason: 'fatal', delayMs: 0 })
    expect(classifyStreamRetry(failure(401, '{"error":{"message":"Incorrect API key provided"}}'))).toEqual({
      retryable: false,
      reason: 'fatal',
      delayMs: 0,
    })
    expect(classifyStreamRetry(failure(400, '{"error":{"message":"upstream timeout"}}'))).toMatchObject({
      retryable: true,
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
