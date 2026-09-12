import { describe, expect, it } from 'vitest'
import { convAccentColor } from '../../src/shared/conv-color'

describe('convAccentColor', () => {
  it('is deterministic (same convId → same color)', () => {
    expect(convAccentColor('4f3a2b1c-aaaa-bbbb-cccc-000000000001')).toBe(
      convAccentColor('4f3a2b1c-aaaa-bbbb-cccc-000000000001')
    )
  })

  it('returns valid HSL with fixed palette saturation and lightness', () => {
    expect(convAccentColor('any-id')).toMatch(/^hsl\(\d{1,3} 72% 62%\)$/)
  })

  it('distributes distinct IDs across different hues in a sample', () => {
    const ids = Array.from({ length: 20 }, (_, i) => `conv-${i}-${i * 7919}`)
    const colors = new Set(ids.map(convAccentColor))
    // Across 360 degrees, nearly all 20 IDs should differ; guards against a constant hash.
    expect(colors.size).toBeGreaterThanOrEqual(18)
  })
})
