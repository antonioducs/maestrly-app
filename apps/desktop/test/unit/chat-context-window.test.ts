/**
 * Actual provider context window and manual user limit.
 * extractCatalog reads /models windows with varying field names (context_length, etc.).
 * resolveContextWindow uses limit→provider→catalog precedence, clamped to the actual ceiling.
 */
import { describe, it, expect } from 'vitest'
import { extractCatalog } from '../../src/main/chat/models'
import { resolveContextWindow } from '../../src/main/chat/context-limits'

describe('extractCatalog — /models context window', () => {
  it('OpenRouter: context_length with top_provider.context_length as fallback', () => {
    const { models, windows } = extractCatalog({
      data: [
        { id: 'anthropic/claude-3', context_length: 200000 },
        { id: 'meta/llama', top_provider: { context_length: 131072 } },
      ],
    })
    expect(models).toEqual(['anthropic/claude-3', 'meta/llama'])
    expect(windows['anthropic/claude-3']).toBe(200000)
    expect(windows['meta/llama']).toBe(131072)
  })

  it('accepts context_window, max_context_tokens, and limit.context', () => {
    const { windows } = extractCatalog({
      data: [
        { id: 'a', context_window: 128000 },
        { id: 'b', max_context_tokens: 32000 },
        { id: 'c', limit: { context: 1000000 } },
      ],
    })
    expect(windows).toEqual({ a: 128000, b: 32000, c: 1000000 })
  })

  it('keeps IDs with missing or invalid windows without adding them to windows', () => {
    const { models, windows } = extractCatalog({
      data: [
        { id: 'x' },
        { id: 'y', context_length: 0 },
        { id: 'z', context_length: -5 },
        { id: 'w', context_length: 'foo' },
      ],
    })
    expect(models).toEqual(['w', 'x', 'y', 'z']) // sorted
    expect(windows).toEqual({})
  })

  it('accepts a raw array without a {data} wrapper', () => {
    const { models, windows } = extractCatalog([{ id: 'solo', context_length: 8192 }])
    expect(models).toEqual(['solo'])
    expect(windows.solo).toBe(8192)
  })

  it('returns an empty catalog for unexpected JSON without throwing', () => {
    expect(extractCatalog(null)).toEqual({ models: [], windows: {} })
    expect(extractCatalog({ nope: true })).toEqual({ models: [], windows: {} })
  })
})

describe('resolveContextWindow — precedence and clamping', () => {
  it('uses the ceiling when no limit is set, prioritizing provider over catalog', () => {
    expect(resolveContextWindow({ providerWindow: 128000, catalogWindow: 1000000 })).toBe(128000)
    expect(resolveContextWindow({ catalogWindow: 1000000 })).toBe(1000000)
  })

  it('uses a limit below the ceiling', () => {
    expect(resolveContextWindow({ limit: 100000, providerWindow: 128000 })).toBe(100000)
    expect(resolveContextWindow({ limit: 100000, catalogWindow: 1000000 })).toBe(100000)
  })

  it('uses an effective 300k window for a 1M model with a custom 300k limit', () => {
    expect(resolveContextWindow({ limit: 300_000, providerWindow: 1_000_000, catalogWindow: 1_000_000 })).toBe(300_000)
    expect(resolveContextWindow({ limit: 300_000, catalogWindow: 1_000_000 })).toBe(300_000)
  })

  it('clamps a limit above the ceiling to the actual ceiling', () => {
    expect(resolveContextWindow({ limit: 500000, providerWindow: 128000 })).toBe(128000)
    expect(resolveContextWindow({ limit: 2000000, catalogWindow: 1000000 })).toBe(1000000)
  })

  it('honors the limit unchanged when no ceiling is known', () => {
    expect(resolveContextWindow({ limit: 100000 })).toBe(100000)
  })

  it('returns undefined without a source so the meter falls back to "tok"', () => {
    expect(resolveContextWindow({})).toBeUndefined()
    expect(resolveContextWindow({ limit: 0 })).toBeUndefined()
  })
})
