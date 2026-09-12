import { describe, it, expect } from 'vitest'
import { makeContextGuard } from '../../src/main/chat/context-guard'

// Intra-turn guard: stopWhen triggers when the latest step input+output crosses ratio×window.
// Compaction within a turn prevents overflow. Covers a production 502 where an agent turn
// grew from 73% to 100% before send-time automatic compaction could run.
const step = (input: number, output = 0) => ({ usage: { inputTokens: input, outputTokens: output } })

describe('makeContextGuard (window=100k, ratio=0.85 → threshold 85k)', () => {
  it('returns false below the threshold without tripping', () => {
    const g = makeContextGuard(100_000, 0.85)
    expect(g.condition({ steps: [step(50_000)] })).toBe(false)
    expect(g.condition({ steps: [step(84_999)] })).toBe(false)
    expect(g.tripped()).toBe(false)
  })

  it('returns true at the threshold (≥) and stays tripped until reset', () => {
    const g = makeContextGuard(100_000, 0.85)
    expect(g.condition({ steps: [step(85_000)] })).toBe(true)
    expect(g.tripped()).toBe(true)
    g.reset()
    expect(g.tripped()).toBe(false)
    expect(g.condition({ steps: [step(10_000)] })).toBe(false) // small steps continue after compaction
  })

  it('sums input+output from the last step because output also occupies the window', () => {
    const g = makeContextGuard(100_000, 0.85)
    expect(g.condition({ steps: [step(80_000, 6_000)] })).toBe(true) // 86k ≥ 85k
  })

  it('uses only the last step without summing the whole turn', () => {
    const g = makeContextGuard(100_000, 0.85)
    expect(g.condition({ steps: [step(60_000), step(70_000)] })).toBe(false)
  })

  it('does not trip when the provider reports no step usage', () => {
    const g = makeContextGuard(100_000, 0.85)
    expect(g.condition({ steps: [{}] })).toBe(false)
    expect(g.condition({ steps: [] })).toBe(false)
  })
})
