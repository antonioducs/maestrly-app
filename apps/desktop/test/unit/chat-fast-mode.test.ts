import { describe, expect, it } from 'vitest'
import { applyFastModeServiceTier } from '../../src/main/chat/fast-mode'

describe('subagent Fast transport', () => {
  it('injects priority for Grok when the effective snapshot uses Fast', () => {
    expect(
      applyFastModeServiceTier({ 'openai-compatible': { existing: 'value' } }, true, 'builtin_grok_subscription')
    ).toEqual({
      'openai-compatible': { existing: 'value', service_tier: 'priority' },
    })
  })

  it('does not inject priority for Standard overrides or non-Grok providers', () => {
    const options = { 'openai-compatible': { existing: 'value' } }
    expect(applyFastModeServiceTier(options, false, 'builtin_grok_subscription')).toBe(options)
    expect(applyFastModeServiceTier(options, true, 'openai')).toBe(options)
  })
})
