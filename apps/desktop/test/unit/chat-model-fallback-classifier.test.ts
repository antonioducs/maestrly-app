import { describe, expect, it } from 'vitest'
import { APICallError } from '@ai-sdk/provider'
import { classifyModelFailure, type ModelFailureReason } from '../../src/main/chat/model-fallback/error-classifier'
import { isContextOverflowText, parseContextLimitFromError } from '../../src/main/chat/model-fallback/overflow'
import { ClaudeAccountsExhaustedError } from '../../src/main/chat/subscription-failover/claude-ephemeral'
import { CodexAccountsExhaustedError } from '../../src/main/chat/subscription-failover/ephemeral'

const NOW = Date.UTC(2026, 9, 31, 12, 0, 0)

function apiError(statusCode: number, responseBody: string, responseHeaders: Record<string, string> = {}) {
  return new APICallError({
    message: '',
    url: 'https://provider.test/v1/chat/completions',
    requestBodyValues: {
      messages: [
        {
          role: 'system',
          content:
            'Never mention a rate limit, a timeout, insufficient_quota, the maximum context length or a content policy.',
        },
      ],
    },
    statusCode,
    responseHeaders: { connection: 'keep-alive', 'keep-alive': 'timeout=5', ...responseHeaders },
    responseBody,
  })
}

describe('classifyModelFailure', () => {
  const table: Array<[string, unknown, ModelFailureReason]> = [
    ['plain 429', apiError(429, '{"error":{"message":"Rate limit reached for requests"}}'), 'rate_limit'],
    [
      'OpenAI empty balance on 429',
      apiError(429, '{"error":{"code":"insufficient_quota","message":"You exceeded your current quota"}}'),
      'quota',
    ],
    ['402 prepayment', apiError(402, '{"error":{"message":"Your prepayment credits are depleted."}}'), 'billing'],
    [
      'Anthropic credit balance on 400',
      apiError(400, '{"error":{"message":"Your credit balance is too low to access the Anthropic API."}}'),
      'billing',
    ],
    ['401 invalid key', apiError(401, '{"error":{"message":"Incorrect API key provided"}}'), 'auth'],
    ['403 forbidden', apiError(403, '{"error":{"message":"Forbidden"}}'), 'auth'],
    ['529 overloaded', apiError(529, '{"type":"error","error":{"type":"overloaded_error"}}'), 'overloaded'],
    ['503 unavailable', apiError(503, 'Service Unavailable'), 'overloaded'],
    ['500 internal', apiError(500, '{"error":{"message":"Internal server error"}}'), 'server_error'],
    ['408 timeout', apiError(408, ''), 'timeout'],
    ['network', Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNRESET' } }), 'timeout'],
    ['404 model', apiError(404, '{"error":{"message":"The model `gpt-9` does not exist"}}'), 'model_not_found'],
    [
      'content policy',
      apiError(400, '{"error":{"code":"content_policy_violation","message":"Your request was rejected"}}'),
      'content_rejected',
    ],
    [
      'Anthropic overflow',
      apiError(400, '{"error":{"message":"prompt is too long: 210000 tokens > 200000 maximum"}}'),
      'context_overflow',
    ],
    ['413 payload', apiError(413, 'Request Entity Too Large'), 'payload_too_large'],
    ['400 malformed', apiError(400, '{"error":{"message":"messages: roles must alternate"}}'), 'format'],
    ['abort', Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }), 'aborted'],
    ['unknown', new Error('Something odd happened'), 'unknown'],
  ]

  it.each(table)('%s', (_name, error, reason) => {
    expect(classifyModelFailure(error, { now: NOW }).reason).toBe(reason)
  })

  it('never reads the request it was sent', () => {
    const failure = apiError(400, '{"error":{"message":"messages: roles must alternate"}}')
    const result = classifyModelFailure(failure, { now: NOW })
    expect(result).toMatchObject({ reason: 'format', fallback: false, retryInPlace: false })
  })

  it('treats a Claude OAuth refresh race as transient and a real sign-in failure as auth', () => {
    const contention = new Error(
      'Failed to refresh OAuth token: another Claude Code process is refreshing it or exited mid-refresh. Retry in a minute, or sign in again'
    )
    expect(classifyModelFailure(contention, { now: NOW })).toMatchObject({
      reason: 'auth_transient',
      fallback: false,
      retryInPlace: true,
    })
    const expired = new Error('OAuth token has expired. Please run /login to sign in again.')
    expect(classifyModelFailure(expired, { now: NOW })).toMatchObject({ reason: 'auth', fallback: true })
  })

  it('marks revoked credentials as permanent', () => {
    expect(
      classifyModelFailure(apiError(401, '{"error":{"message":"This API key has been revoked"}}'), { now: NOW })
    ).toMatchObject({ reason: 'auth', permanent: true, scope: 'account' })
  })

  it('maps exhausted subscription chains to quota with their reset', () => {
    const resetsAt = NOW + 3_600_000
    expect(classifyModelFailure(new ClaudeAccountsExhaustedError('all exhausted', resetsAt), { now: NOW })).toEqual(
      expect.objectContaining({ reason: 'quota', scope: 'account', fallback: true, retryAt: resetsAt })
    )
    expect(classifyModelFailure(new CodexAccountsExhaustedError('all exhausted', null), { now: NOW })).toMatchObject({
      reason: 'quota',
      retryInPlace: false,
    })
    expect(
      classifyModelFailure(
        { code: 'claude-accounts-exhausted', message: 'All Claude accounts are exhausted' },
        { now: NOW }
      ).reason
    ).toBe('quota')
  })

  it('recognizes Claude and Codex usage-limit envelopes', () => {
    expect(classifyModelFailure(new Error("You've hit your usage limit · resets 5pm"), { now: NOW }).reason).toBe(
      'quota'
    )
    expect(
      classifyModelFailure(
        { turn: { status: 'failed', error: { message: 'UsageLimitExceeded: try later' } } },
        { now: NOW }
      ).reason
    ).toBe('quota')
  })

  it('carries the provider retry timing and a revealed context limit', () => {
    const limited = classifyModelFailure(apiError(429, '{"error":{"message":"slow down"}}', { 'retry-after': '90' }), {
      now: NOW,
    })
    expect(limited).toMatchObject({ reason: 'rate_limit', retryAt: NOW + 90_000 })
    const overflow = classifyModelFailure(
      apiError(
        400,
        '{"error":{"message":"This model\'s maximum context length is 128000 tokens. However, your messages resulted in 130500 tokens."}}'
      ),
      { now: NOW }
    )
    expect(overflow).toMatchObject({
      reason: 'context_overflow',
      compact: true,
      contextLimit: 128_000,
      observedTokens: 130_500,
    })
  })

  it('reads a wrapped provider failure', () => {
    const wrapped = Object.assign(new Error('Failed after 3 attempts'), {
      lastError: apiError(402, '{"error":{"message":"Payment required"}}'),
    })
    expect(classifyModelFailure(wrapped, { now: NOW }).reason).toBe('billing')
  })

  it('does not treat a quota announced with a reset as an empty balance', () => {
    const resetting = apiError(429, '{"error":{"message":"Usage limit reached. Try again in 2h 30m."}}')
    expect(classifyModelFailure(resetting, { now: NOW })).toMatchObject({
      reason: 'rate_limit',
      retryAt: NOW + 2.5 * 3_600_000,
    })
  })
})

describe('context overflow detection', () => {
  const overflows = [
    'prompt is too long: 210000 tokens > 200000 maximum',
    "This model's maximum context length is 8192 tokens",
    'Error code: context_length_exceeded',
    'The input token count (1200000) exceeds the maximum number of tokens allowed (1048576).',
    'the request exceeds the available context size, try increasing it',
    "This model's maximum context length is 4096 tokens. (max_model_len)",
    '`inputs` tokens + `max_new_tokens` must be <= 4096',
    'litellm.ContextWindowExceededError: context window exceeded',
    'Input is too long for requested model.',
  ]
  it.each(overflows)('detects %s', (text) => {
    expect(isContextOverflowText(text, 400)).toBe(true)
  })

  const throttles = [
    'Too many tokens, please wait before trying again.',
    'Rate limit reached for gpt-4o on tokens per min (TPM): Limit 30000',
    'ThrottlingException: Too many tokens per day',
  ]
  it.each(throttles)('ignores throttling %s', (text) => {
    expect(isContextOverflowText(text, 400)).toBe(false)
  })

  it('ignores any 429', () => {
    expect(isContextOverflowText('prompt is too long', 429)).toBe(false)
  })

  it('parses limits and request sizes', () => {
    expect(parseContextLimitFromError('prompt is too long: 210000 tokens > 200000 maximum')).toEqual({
      limit: 200_000,
      observed: 210_000,
    })
    expect(
      parseContextLimitFromError(
        'The input token count (1200000) exceeds the maximum number of tokens allowed (1048576).'
      )
    ).toEqual({ limit: 1_048_576, observed: 1_200_000 })
    expect(parseContextLimitFromError('{"error":{"n_prompt_tokens":5000,"n_ctx":4096}}')).toEqual({
      limit: 4_096,
      observed: 5_000,
    })
    expect(parseContextLimitFromError('This model has max_model_len=32768')).toEqual({ limit: 32_768 })
    expect(parseContextLimitFromError('max_output_tokens must be at most 4096')).toEqual({})
    expect(parseContextLimitFromError('limit 12 tokens')).toEqual({})
  })
})
