import type { SDKRateLimitInfo } from '@anthropic-ai/claude-agent-sdk'
import { describe, expect, it } from 'vitest'
import { classifyClaudeQuotaFailure } from '../../src/main/chat/claude-agent-sdk/quota-error'

describe('Claude quota classification', () => {
  it.each([1_800_000_000, 1_800_000_000_000])('normalizes reset %s', (resetsAt) => {
    const info: SDKRateLimitInfo = { status: 'rejected', rateLimitType: 'five_hour', resetsAt }
    expect(classifyClaudeQuotaFailure(null, info)).toMatchObject({
      kind: 'quota',
      info: { resetsAt: 1_800_000_000_000 },
    })
  })
  it.each([NaN, Infinity, -1, 0])('omits invalid reset %s', (resetsAt) => {
    expect(classifyClaudeQuotaFailure(null, { status: 'rejected', resetsAt })).toEqual({
      kind: 'quota',
      info: { reason: 'Claude subscription usage limit reached', source: 'rate-limits' },
    })
  })
  it('considers available overage and rejects exhausted credits', () => {
    expect(classifyClaudeQuotaFailure(null, { status: 'rejected', overageStatus: 'allowed' })).toEqual({
      kind: 'other',
    })
    expect(classifyClaudeQuotaFailure(null, { status: 'rejected', isUsingOverage: true })).toEqual({ kind: 'suspect' })
    expect(
      classifyClaudeQuotaFailure(null, {
        status: 'rejected',
        overageStatus: 'rejected',
        overageResetsAt: 1_800_000_100,
      })
    ).toMatchObject({ kind: 'quota', info: { resetsAt: 1_800_000_100_000 } })
    expect(classifyClaudeQuotaFailure(null, { status: 'allowed', errorCode: 'credits_required' }).kind).toBe('quota')
  })
  it.each([
    { status: 429 },
    { type: 'assistant', error: 'rate_limit', message: { content: [] } },
    { type: 'rate_limit_error' },
  ])('leaves raw transport limits suspect', (error) => {
    expect(classifyClaudeQuotaFailure(error)).toEqual({ kind: 'suspect' })
  })
  it('recognizes anchored official diagnostics', () => {
    expect(classifyClaudeQuotaFailure(new Error("You've hit your limit · resets 5pm")).kind).toBe('quota')
    expect(
      classifyClaudeQuotaFailure({
        type: 'result',
        subtype: 'error_during_execution',
        errors: ['Claude AI usage limit reached'],
      }).kind
    ).toBe('quota')
  })
  it('recognizes official Fable credit diagnostics only in SDK error messages', () => {
    const message = { content: [{ type: 'text', text: 'Fable 5 requires usage credits' }] }
    expect(classifyClaudeQuotaFailure({ type: 'assistant', error: 'billing_error', message }).kind).toBe('quota')
    expect(classifyClaudeQuotaFailure({ type: 'assistant', message }).kind).toBe('other')
    expect(classifyClaudeQuotaFailure(new Error("You've reached your weekly limit")).kind).toBe('quota')
    expect(classifyClaudeQuotaFailure(new Error("You're now using usage credits")).kind).toBe('other')
  })
  it.each([
    new Error('Network connection failed'),
    new Error('Invalid OAuth token'),
    new Error('Unknown model'),
    new Error("The tool said: You've hit your limit"),
    { type: 'user', message: "You've hit your limit" },
    { type: 'assistant', message: { content: [{ type: 'text', text: "You've hit your limit" }] } },
    { type: 'tool_result', content: "You've hit your limit" },
    { type: 'result', subtype: 'error_max_budget_usd', errors: ["You've hit your limit"] },
    { message: "You've hit your limit" },
  ])('does not classify unrelated or untrusted content', (error) => {
    expect(classifyClaudeQuotaFailure(error)).toEqual({ kind: 'other' })
  })
})
