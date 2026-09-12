import { describe, expect, it } from 'vitest'
import type { SDKResultMessage } from '@anthropic-ai/claude-agent-sdk'
import { claudeServedModelMismatch } from '../../src/main/chat/claude-agent-sdk/served-model'

function success(modelUsage: SDKResultMessage['modelUsage']): SDKResultMessage {
  return {
    type: 'result',
    subtype: 'success',
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: false,
    num_turns: 1,
    result: 'ok',
    session_id: 'session',
    stop_reason: 'end_turn',
    total_cost_usd: 0,
    usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    modelUsage,
    permission_denials: [],
    uuid: 'result',
  } as unknown as SDKResultMessage
}

const usage = (canonicalModel?: string) => ({
  inputTokens: 1,
  outputTokens: 1,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
  webSearchRequests: 0,
  costUSD: 0,
  contextWindow: 1,
  maxOutputTokens: 1,
  ...(canonicalModel ? { canonicalModel } : {}),
})

describe('Claude served model validation', () => {
  it('accepts exact and context-variant matches', () => {
    expect(claudeServedModelMismatch('claude-opus-5[1m]', success({}), 'claude-opus-5')).toBeNull()
    expect(claudeServedModelMismatch('sonnet', success({}), 'claude-sonnet-5')).toBeNull()
  })

  it('reports an assistant model downgrade', () => {
    const mismatch = claudeServedModelMismatch('claude-fable-5-1', success({}), 'claude-opus-5')
    expect(mismatch).toMatchObject({ requested: 'claude-fable-5-1', served: 'claude-opus-5' })
    expect(mismatch?.message).toContain('provider session was discarded')
  })

  it('uses unambiguous modelUsage and ignores ambiguous multi-model usage', () => {
    const one = success({ 'served-key': usage('claude-opus-4-8') })
    expect(claudeServedModelMismatch('claude-opus-4-6', one)).toMatchObject({ served: 'claude-opus-4-8' })
    const many = success({ a: usage(), b: usage() })
    expect(claudeServedModelMismatch('claude-opus-4-6', many)).toBeNull()
  })
})
