import { describe, expect, it, vi } from 'vitest'
import type { ChatMessage } from '../../src/shared/chat'
import {
  estimateNativeSeedContextTokens,
  estimatePortableContextTokens,
  portableContextLoad,
  portableContextOutputReserveTokens,
  portableContextReserveTokens,
  preflightContextLoad,
  splitPortableTranscript,
  summarizePortableTranscript,
} from '../../src/main/chat/portable-context'
import { openAINativeCompactionMarkerPart } from '../../src/main/chat/message'

function message(id: string, role: 'user' | 'assistant', text: string, createdAt: number): ChatMessage {
  return {
    id,
    conversationId: 'conversation',
    role,
    parts: [{ type: 'text', id: `${id}-text`, text }],
    createdAt,
  }
}

describe('portable context', () => {
  it('rebuilds all history when only a native checkpoint exists', () => {
    const prefix = message('before', 'user', 'A'.repeat(3_000), 1)
    const checkpoint: ChatMessage = {
      id: 'native',
      conversationId: 'conversation',
      role: 'assistant',
      parts: [openAINativeCompactionMarkerPart('native-part')],
      createdAt: 2,
    }
    const suffix = message('after', 'assistant', 'B'.repeat(3_000), 3)

    expect(estimatePortableContextTokens([prefix, checkpoint, suffix])).toBeGreaterThan(1_900)
  })

  it('uses only the summary and suffix after a portable text marker', () => {
    const prefix = message('before', 'user', 'A'.repeat(30_000), 1)
    const marker: ChatMessage = {
      id: 'portable',
      conversationId: 'conversation',
      role: 'assistant',
      parts: [{ type: 'compaction', id: 'portable-part', text: 'portable summary' }],
      createdAt: 2,
    }
    const suffix = message('after', 'user', 'small suffix', 3)

    expect(estimatePortableContextTokens([prefix, marker, suffix])).toBeLessThan(100)
  })

  it('projects native reseeding with the same limits applied to tool outputs', () => {
    const toolHeavy: ChatMessage = {
      id: 'assistant-tool-heavy',
      conversationId: 'conversation',
      role: 'assistant',
      parts: [
        {
          type: 'tool',
          id: 'tool-part',
          toolCallId: 'tool-call',
          toolName: 'bash',
          input: { command: 'huge-output' },
          state: { status: 'completed', output: 'x'.repeat(1_200_000) },
        },
      ],
      createdAt: 1,
    }

    expect(estimatePortableContextTokens([toolHeavy])).toBeGreaterThan(390_000)
    expect(estimateNativeSeedContextTokens([toolHeavy])).toBeLessThan(6_000)
  })

  it('splits without losing or duplicating the middle', () => {
    const source = Array.from({ length: 20_000 }, (_, index) => `${index % 10}`).join('')
    const chunks = splitPortableTranscript(source, 1_337)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.join('')).toBe(source)
  })

  it('summarizes every block and consolidates in isolated calls', async () => {
    const seen: string[] = []
    const summarize = vi.fn(async (prompt: string, phase: 'chunk' | 'consolidate') => {
      seen.push(prompt)
      return {
        text: phase === 'chunk' ? `chunk:${prompt.slice(-20)}` : `final:${prompt.length}`,
        usage: { input: 10, output: 2, cacheRead: 0, cacheCreate: 0, totalInput: 10 },
        runtimeEstimatedCostUsd: 0.001,
      }
    })

    const result = await summarizePortableTranscript('x'.repeat(5_000), 1_000, summarize)

    expect(seen.filter((prompt) => prompt.startsWith('Source chunk'))).toHaveLength(5)
    expect(result.summary).toMatch(/^final:/)
    expect(result.calls).toBeGreaterThan(5)
    expect(result.usage?.totalInput).toBe(result.calls * 10)
    expect(result.runtimeEstimatedCostUsd).toBeCloseTo(result.calls * 0.001, 10)
  })

  it.each([
    ['Codex compactado → BYOK', 1_050_000, 1_000_000],
    ['Copilot compactado → BYOK', 1_050_000, 1_000_000],
    ['BYOK 1M/500k → Codex 256k', 500_000, 256_000],
    ['BYOK grande → Copilot', 300_000, 128_000],
    ['BYOK grande → BYOK menor', 500_000, 200_000],
  ])('triggers portable preflight for %s', (_scenario, historyTokens, window) => {
    const load = portableContextLoad(window, historyTokens, 1_000)
    expect(load.shouldCompact).toBe(true)
    expect(load.overflow).toBe(true)
  })

  it('reserves system/tools/output space without compacting a safe switch', () => {
    const load = portableContextLoad(1_000_000, 60_000, 1_000)
    expect(load.reserveTokens).toBe(64_000)
    expect(load.shouldCompact).toBe(false)
    expect(load.overflow).toBe(false)
  })

  describe('preflightContextLoad — measured vs estimated', () => {
    const customWindow = 300_000

    it('portable-transcript applies the full conservative reserve', () => {
      const load = preflightContextLoad(customWindow, 250_000, 1_000, 'portable-transcript')
      expect(load.reserveTokens).toBe(portableContextReserveTokens(customWindow))
      expect(load.reserveTokens).toBe(30_000)
      // 250k + 1k + 30k = 281k: below the cap but above 90%, so compaction is required.
      expect(load.requiredTokens).toBe(281_000)
      expect(load.shouldCompact).toBe(true)
      expect(load.overflow).toBe(false)
    })

    it('portable-transcript overflows when occupancy approaches the custom limit', () => {
      const load = preflightContextLoad(customWindow, 270_000, 1_000, 'portable-transcript')
      // 270k + 1k + 30k = 301k ≥ 300k
      expect(load.overflow).toBe(true)
      expect(load.shouldCompact).toBe(true)
    })

    it('runtime-usage does not add the full portable reserve to measured occupancy again', () => {
      const load = preflightContextLoad(customWindow, 270_000, 1_000, 'runtime-usage')
      expect(load.reserveTokens).toBe(portableContextOutputReserveTokens(customWindow))
      expect(load.reserveTokens).toBe(15_000)
      // 270k + 1k + 15k = 286k < 300k: no artificial overflow from double counting.
      expect(load.requiredTokens).toBe(286_000)
      expect(load.overflow).toBe(false)
      expect(load.shouldCompact).toBe(true) // 286/300 ≥ 0.9
    })

    it('runtime-usage still counts pending usage and can legitimately overflow', () => {
      const load = preflightContextLoad(customWindow, 270_000, 20_000, 'runtime-usage')
      // 270k + 20k + 15k = 305k ≥ 300k
      expect(load.overflow).toBe(true)
      expect(load.shouldCompact).toBe(true)
    })

    it('runtime-usage admits comfortable occupancy without compaction', () => {
      const load = preflightContextLoad(customWindow, 200_000, 1_000, 'runtime-usage')
      // 200k + 1k + 15k = 216k / 300k = 0.72
      expect(load.shouldCompact).toBe(false)
      expect(load.overflow).toBe(false)
    })

    it('actual 1M window with a custom 300k limit: reserves scale to the effective ceiling', () => {
      expect(portableContextReserveTokens(customWindow)).toBe(30_000)
      expect(portableContextOutputReserveTokens(customWindow)).toBe(15_000)
      // full 1M window would reserve more — custom limit keeps preflight on the effective ceiling
      expect(portableContextReserveTokens(1_000_000)).toBe(64_000)
    })
  })
})
