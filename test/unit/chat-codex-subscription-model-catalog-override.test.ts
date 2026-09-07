import { describe, expect, it } from 'vitest'
import { codexLongContextWindowOverride } from '../../src/main/chat/codex-subscription/model-catalog-override'

describe('Astra model catalog override boundary', () => {
  it('does not infer the 1.05M Sol/Luna ceiling for Astra or future GPT-6 IDs', () => {
    expect(codexLongContextWindowOverride('gpt-6-astra')).toBeNull()
    expect(codexLongContextWindowOverride('gpt-6-astra-mini')).toBeNull()
    expect(codexLongContextWindowOverride('gpt-6-future')).toBeNull()
    expect(codexLongContextWindowOverride('gpt-5.6-sol')).toBe(1_050_000)
  })
})
