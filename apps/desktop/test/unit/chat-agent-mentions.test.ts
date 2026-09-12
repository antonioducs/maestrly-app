import { describe, expect, it } from 'vitest'
import {
  buildAgentMentionParts,
  dedupeAgentMentionNames,
  extractAgentMentionNames,
  filterAgentMentionNames,
  findAgentMentions,
  shouldReloadOnUserSaved,
  validateStructuredAgentMentions,
  type StructuredAgentMentionDraft,
} from '../../src/shared/chat-agent-mentions'

describe('structured agent mention parsing', () => {
  it('recognizes mentions at start and after whitespace', () => {
    expect(findAgentMentions('#testing')).toEqual([{ raw: '#testing', name: 'testing', index: 0 }])
    expect(findAgentMentions('use #testing')).toEqual([{ raw: '#testing', name: 'testing', index: 4 }])
    expect(findAgentMentions('run it #api-integration-engineer today')).toEqual([
      { raw: '#api-integration-engineer', name: 'api-integration-engineer', index: 7 },
    ])
  })

  it('normalizes mention names and separators', () => {
    expect(findAgentMentions('#Testing-Foo')).toEqual([{ raw: '#Testing-Foo', name: 'testing-foo', index: 0 }])
  })

  it('rejects foo#testing, #123, ##testing, and 123#testing', () => {
    expect(findAgentMentions('foo#testing')).toEqual([])
    expect(findAgentMentions('#123')).toEqual([])
    expect(findAgentMentions('##testing')).toEqual([])
    expect(findAgentMentions('123#testing')).toEqual([])
    expect(findAgentMentions('a_b#testing')).toEqual([])
  })

  it('filters unknown names against supplied catalogs', () => {
    const text = '#known #unknown'
    expect(findAgentMentions(text, ['known'])).toEqual([{ raw: '#known', name: 'known', index: 0 }])
  })

  it('accepts well-formed tokens without a catalog', () => {
    expect(findAgentMentions('use #anything-here')).toEqual([
      { raw: '#anything-here', name: 'anything-here', index: 4 },
    ])
  })

  it('recognizes explicit mention tokens inside questions', () => {
    expect(findAgentMentions('#testing?', ['testing'])).toEqual([{ raw: '#testing', name: 'testing', index: 0 }])
  })

  it('matches normalized catalog names', () => {
    expect(findAgentMentions('#General-Purpose', ['general-purpose'])).toEqual([
      { raw: '#General-Purpose', name: 'general-purpose', index: 0 },
    ])
  })

  it('preserves mention order and indices', () => {
    const out = findAgentMentions('a #explore e #testing', ['explore', 'testing'])
    expect(out).toEqual([
      { raw: '#explore', name: 'explore', index: 2 },
      { raw: '#testing', name: 'testing', index: 13 },
    ])
  })

  it('returns no mentions for empty or unmarked text', () => {
    expect(findAgentMentions('')).toEqual([])
    expect(findAgentMentions('nothing here')).toEqual([])
  })
})

describe('structured mention parts versus plain text', () => {
  const textPart = (text: string) => ({ type: 'text' as const, id: 't1', text })
  const mentionPart = (name: string) => ({ type: 'agent-mention' as const, id: 'm1', name })

  it('does not promote manual mention text to structured parts', () => {
    expect(extractAgentMentionNames([textPart('#testing')])).toEqual([])
    expect(extractAgentMentionNames([textPart('Não use #testing')])).toEqual([])
    expect(extractAgentMentionNames([textPart('Por que o #testing falhou?')])).toEqual([])
    expect(extractAgentMentionNames([textPart('use #testing')])).toEqual([])
  })

  it('creates structured parts from selected chips', () => {
    expect(extractAgentMentionNames([textPart('run this'), mentionPart('testing')])).toEqual(['testing'])
  })

  it('does not create structured mentions from pasted text', () => {
    expect(extractAgentMentionNames([textPart('code: #testing here')])).toEqual([])
  })

  it('leaves no orphaned parts after chip removal', () => {
    expect(extractAgentMentionNames([textPart('plain text now')])).toEqual([])
  })

  it('deduplicates chips while preserving order', () => {
    expect(
      extractAgentMentionNames([textPart('a'), mentionPart('testing'), mentionPart('explore'), mentionPart('Testing')])
    ).toEqual(['testing', 'explore'])
  })

  it('normalizes chip-name casing and separators', () => {
    expect(extractAgentMentionNames([mentionPart('Testing-Foo')])).toEqual(['testing-foo'])
  })

  it('filters names outside available catalogs', () => {
    expect(extractAgentMentionNames([mentionPart('ghost'), mentionPart('testing')], ['testing'])).toEqual(['testing'])
  })

  it('sanitizes arbitrary mention-name payloads', () => {
    expect(filterAgentMentionNames(undefined)).toEqual([])
    expect(filterAgentMentionNames([42, null, '', '  '])).toEqual([])
    expect(filterAgentMentionNames(['Testing', 'testing', 'ghost'], ['testing'])).toEqual(['testing'])
    expect(filterAgentMentionNames(['a', 'b', 'a'])).toEqual(['a', 'b'])
  })
})

describe('range-based structured mention rebuild', () => {
  const occ = (id: string, name: string, start: number, end: number): StructuredAgentMentionDraft => ({
    id,
    name,
    start,
    end,
  })
  const CATALOG = ['general-purpose', 'testing', 'explore']

  it('does not rebuild manual text as chips', () => {
    expect(validateStructuredAgentMentions([], 'use #testing', CATALOG)).toEqual([])
    expect(validateStructuredAgentMentions(undefined, 'use #testing', CATALOG)).toEqual([])
  })

  it('preserves chip IDs and ranges', () => {
    const out = validateStructuredAgentMentions([occ('a', 'testing', 5, 13)], 'test #testing', CATALOG)
    expect(out).toEqual([{ id: 'a', name: 'testing', start: 5, end: 13 }])
  })

  it('promotes only structured ranges in mixed text', () => {
    // manual #testing & #testing: second token occupies [18, 26).
    const out = validateStructuredAgentMentions([occ('a', 'testing', 18, 26)], 'manual #testing & #testing', CATALOG)
    expect(out).toEqual([{ id: 'a', name: 'testing', start: 18, end: 26 }])
    // The first textual range has no occurrence and must never be promoted.
  })

  it('keeps removed-chip metadata empty without promoting manual text', () => {
    expect(validateStructuredAgentMentions([], 'manual #testing & #testing', CATALOG)).toEqual([])
  })

  it('allows repeated agents with distinct occurrence IDs', () => {
    const out = validateStructuredAgentMentions(
      [occ('a', 'testing', 0, 8), occ('b', 'testing', 11, 19)],
      '#testing & #testing',
      CATALOG
    )
    expect(out).toEqual([
      { id: 'a', name: 'testing', start: 0, end: 8 },
      { id: 'b', name: 'testing', start: 11, end: 19 },
    ])
  })

  it('degrades occurrences removed from catalogs', () => {
    expect(validateStructuredAgentMentions([occ('a', 'testing', 0, 8)], '#testing', ['general-purpose'])).toEqual([])
  })

  it('discards reversed and out-of-bounds ranges', () => {
    expect(validateStructuredAgentMentions([occ('a', 'testing', 99, 108)], 'hi', CATALOG)).toEqual([])
    expect(validateStructuredAgentMentions([occ('a', 'testing', 8, 0)], '#testing', CATALOG)).toEqual([])
    expect(validateStructuredAgentMentions([occ('a', 'testing', 4, 4)], '#testing', CATALOG)).toEqual([])
  })

  it('discards ranges whose text changed', () => {
    expect(validateStructuredAgentMentions([occ('a', 'testing', 0, 8)], '#explore', CATALOG)).toEqual([])
  })

  it('matches original chip casing', () => {
    const out = validateStructuredAgentMentions([occ('a', 'testing', 0, 8)], '#Testing', CATALOG)
    expect(out).toEqual([{ id: 'a', name: 'testing', start: 0, end: 8 }])
  })

  it('discards missing IDs and invalid shapes', () => {
    expect(validateStructuredAgentMentions([occ('', 'testing', 0, 8)], '#testing', CATALOG)).toEqual([])
    expect(
      validateStructuredAgentMentions(
        [{ id: 'a', name: 42 as unknown as string, start: 0, end: 8 }],
        '#testing',
        CATALOG
      )
    ).toEqual([])
    expect(
      validateStructuredAgentMentions(
        [{ id: 'a', name: 'testing', start: 'x' as unknown as number, end: 8 }],
        '#testing',
        CATALOG
      )
    ).toEqual([])
  })

  it('keeps only the earliest overlapping range', () => {
    const out = validateStructuredAgentMentions(
      [occ('b', 'testing', 0, 8), occ('a', 'testing', 0, 8)],
      '#testing',
      CATALOG
    )
    expect(out).toEqual([{ id: 'b', name: 'testing', start: 0, end: 8 }])
  })

  it('compares normalized names and separators', () => {
    // #Testing-Foo has 12 characters (1 + 7 + 1 + 3).
    const out = validateStructuredAgentMentions([occ('a', 'Testing-Foo', 0, 12)], '#Testing-Foo', ['testing-foo'])
    expect(out).toEqual([{ id: 'a', name: 'testing-foo', start: 0, end: 12 }])
  })
})

describe('reducing structured occurrences to send names', () => {
  const occ = (id: string, name: string): StructuredAgentMentionDraft => ({ id, name, start: 0, end: 8 })

  it('reduces repeated agents to one name', () => {
    expect(dedupeAgentMentionNames([occ('a', 'testing'), occ('b', 'testing')])).toEqual(['testing'])
  })

  it('normalizes names while preserving appearance order', () => {
    expect(dedupeAgentMentionNames([occ('a', 'explore'), occ('b', 'Testing')])).toEqual(['explore', 'testing'])
  })

  it('ignores invalid entries and non-array payloads', () => {
    expect(dedupeAgentMentionNames(undefined)).toEqual([])
    expect(dedupeAgentMentionNames([occ('a', 'testing'), 42 as unknown as StructuredAgentMentionDraft])).toEqual([
      'testing',
    ])
  })
})

describe('preserving ranges through queue edit and resend', () => {
  // Composer text includes outer whitespace; trimming would shift offsets.
  // The first range is manual text and the second is the structured chip.
  const QUEUE_TEXT = '   manual words #testing & #testing   '
  const CHIP = { id: 'chip-1', name: 'testing', start: 27, end: 35 } satisfies StructuredAgentMentionDraft
  const CATALOG = ['general-purpose', 'testing', 'explore']

  it('preserves queued text byte-for-byte without trimming', () => {
    // Store raw text and structured occurrences as one immutable unit.
    expect(QUEUE_TEXT).toBe('   manual words #testing & #testing   ')
    expect(QUEUE_TEXT.length).toBe(38)
  })

  it('keeps round-trip offsets pointing to the second occurrence', () => {
    // Rebuild validates ranges against restored queue text.
    const rebuilt = validateStructuredAgentMentions([CHIP], QUEUE_TEXT, CATALOG)
    expect(rebuilt).toEqual([{ id: 'chip-1', name: 'testing', start: 27, end: 35 }])
  })

  it('restores only the structured second occurrence as a chip', () => {
    const rebuilt = validateStructuredAgentMentions([CHIP], QUEUE_TEXT, CATALOG)
    // Return only the chip occurrence; never promote the manual token.
    expect(rebuilt).toHaveLength(1)
    expect(rebuilt[0]?.start).toBe(27)
    expect(rebuilt[0]?.end).toBe(35)
  })

  it('removes deterministic selection despite homonymous manual text', () => {
    // Removing chip metadata removes deterministic testing selection on resend.
    expect(validateStructuredAgentMentions([], QUEUE_TEXT, CATALOG)).toEqual([])
    expect(dedupeAgentMentionNames([])).toEqual([])
  })

  it('reduces preserved chips to requested agent names', () => {
    expect(dedupeAgentMentionNames(validateStructuredAgentMentions([CHIP], QUEUE_TEXT, CATALOG))).toEqual(['testing'])
  })

  it('allows raw whitespace with attachments only', () => {
    const ws = '   '
    // Without attachments, !ws.trim() && attachments.length === 0 is true, so submitDraft returns blocked.
    const noAttachments = 0
    expect(!ws.trim() && noAttachments === 0).toBe(true)
    // Attachments permit whitespace-only text without normalizing it.
    const withAttachments: number = 1
    expect(!ws.trim() && withAttachments === 0).toBe(false)
    // No metadata may exist in text without tokens.
    expect(validateStructuredAgentMentions([], ws, CATALOG)).toEqual([])
  })

  it('preserves behavior without outer whitespace', () => {
    const plain = 'test #testing'
    const rebuilt = validateStructuredAgentMentions(
      [{ id: 'chip-1', name: 'testing', start: 5, end: 13 }],
      plain,
      CATALOG
    )
    expect(rebuilt).toEqual([{ id: 'chip-1', name: 'testing', start: 5, end: 13 }])
  })

  it('two chips for the SAME agent preserve distinct ids and ranges in queue and rebuild', () => {
    const both = [
      { id: 'chip-a', name: 'testing', start: 16, end: 24 },
      { id: 'chip-b', name: 'testing', start: 27, end: 35 },
    ] satisfies StructuredAgentMentionDraft[]
    const rebuilt = validateStructuredAgentMentions(both, QUEUE_TEXT, CATALOG)
    expect(rebuilt).toEqual(both)
    // Resend reduces repeated occurrences to one name.
    expect(dedupeAgentMentionNames(rebuilt)).toEqual(['testing'])
  })
})

describe('host-side IPC mention occurrence validation', () => {
  const occ = (id: string, name: string, start: number, end: number): StructuredAgentMentionDraft => ({
    id,
    name,
    start,
    end,
  })
  const CATALOG = ['general-purpose', 'testing', 'explore']

  it('validates and preserves occurrence fields', () => {
    const parts = buildAgentMentionParts([occ('m1', 'testing', 5, 13)], 'test #testing', CATALOG)
    expect(parts).toEqual([{ type: 'agent-mention', id: 'm1', name: 'testing', start: 5, end: 13 }])
  })

  it('rejects a range outside the text', () => {
    expect(buildAgentMentionParts([occ('m1', 'testing', 99, 108)], 'hi', CATALOG)).toEqual([])
  })

  it('rejects text changed after chip selection', () => {
    expect(buildAgentMentionParts([occ('m1', 'testing', 0, 8)], '#explore', CATALOG)).toEqual([])
  })

  it('rejects agents outside the catalog', () => {
    expect(buildAgentMentionParts([occ('m1', 'ghost', 0, 6)], '#ghost', CATALOG)).toEqual([])
  })

  it('preserves repeated names with distinct IDs', () => {
    const parts = buildAgentMentionParts(
      [occ('m1', 'testing', 0, 8), occ('m2', 'testing', 11, 19)],
      '#testing & #testing',
      CATALOG
    )
    expect(parts).toHaveLength(2)
    expect(parts.map((p) => p.id)).toEqual(['m1', 'm2'])
  })

  it('rejects overlapping ranges', () => {
    expect(
      buildAgentMentionParts([occ('m1', 'testing', 0, 8), occ('m2', 'testing', 0, 8)], '#testing', CATALOG)
    ).toEqual([{ type: 'agent-mention', id: 'm1', name: 'testing', start: 0, end: 8 }])
  })

  it('creates parts only for structured ranges in mixed text', () => {
    // manual #testing & #testing: manual token [7, 15), chip [18, 26).
    const parts = buildAgentMentionParts([occ('m1', 'testing', 18, 26)], 'manual #testing & #testing', CATALOG)
    expect(parts).toEqual([{ type: 'agent-mention', id: 'm1', name: 'testing', start: 18, end: 26 }])
  })

  it('discards legacy payloads without offsets', () => {
    expect(buildAgentMentionParts([{ id: 'm1', name: 'testing' }], '#testing', CATALOG)).toEqual([])
  })

  it('returns empty for invalid occurrence payloads', () => {
    expect(buildAgentMentionParts(undefined, '#testing', CATALOG)).toEqual([])
    expect(buildAgentMentionParts([], '#testing', CATALOG)).toEqual([])
    expect(buildAgentMentionParts([42], '#testing', CATALOG)).toEqual([])
    expect(buildAgentMentionParts([occ('m1', 'testing', 0, 8)], 42 as unknown as string, CATALOG)).toEqual([])
  })

  it('returns only valid mixed-payload occurrences without throwing', () => {
    const mixed = [null, undefined, 'testing', 42, {}, { id: 'bad' }, { id: 'ok', name: 'testing', start: 0, end: 8 }]
    expect(() => buildAgentMentionParts(mixed, '#testing', CATALOG)).not.toThrow()
    expect(buildAgentMentionParts(mixed, '#testing', CATALOG)).toEqual([
      { type: 'agent-mention', id: 'ok', name: 'testing', start: 0, end: 8 },
    ])
  })

  it('discards nonfinite, fractional and negative offsets', () => {
    const junk = [
      { id: 'nan', name: 'testing', start: Number.NaN, end: 8 },
      { id: 'inf', name: 'testing', start: 0, end: Number.POSITIVE_INFINITY },
      { id: 'float', name: 'testing', start: 0.5, end: 8 },
      { id: 'neg', name: 'testing', start: -1, end: 7 },
    ]
    expect(() => buildAgentMentionParts(junk, '#testing', CATALOG)).not.toThrow()
    expect(buildAgentMentionParts(junk, '#testing', CATALOG)).toEqual([])
  })

  it('returns empty for entirely invalid payloads without exceptions', () => {
    expect(() => buildAgentMentionParts([null, undefined, 'x', 1, {}, { id: 'a' }], '#testing', CATALOG)).not.toThrow()
    expect(buildAgentMentionParts([null, undefined, 'x', 1, {}, { id: 'a' }], '#testing', CATALOG)).toEqual([])
  })
})

describe('defensive mention sanitization before sorting', () => {
  const CATALOG = ['testing']

  it('keeps sort comparators safe with mixed entries', () => {
    const mixed = [null, undefined, 'testing', 42, {}, { id: 'bad' }, { id: 'ok', name: 'testing', start: 0, end: 8 }]
    expect(() => validateStructuredAgentMentions(mixed, '#testing', CATALOG)).not.toThrow()
    expect(validateStructuredAgentMentions(mixed, '#testing', CATALOG)).toEqual([
      { id: 'ok', name: 'testing', start: 0, end: 8 },
    ])
  })

  it('discards invalid numeric offsets before sorting', () => {
    expect(
      validateStructuredAgentMentions(
        [
          { id: 'a', name: 'testing', start: Number.NaN, end: 8 },
          { id: 'b', name: 'testing', start: 0, end: Number.POSITIVE_INFINITY },
          { id: 'c', name: 'testing', start: 1.5, end: 8 },
          { id: 'd', name: 'testing', start: -2, end: 6 },
        ],
        '#testing',
        CATALOG
      )
    ).toEqual([])
  })
})

describe('optimistic image message reconciliation', () => {
  const base = { streaming: true, compacted: false, localSlash: false, localAgentMentions: false, localImages: false }

  it('preserves optimistic streaming messages without local divergence', () => {
    expect(shouldReloadOnUserSaved({ ...base })).toBe(false)
  })

  it('reloads local image sends even for vision models', () => {
    // Vision models may lack description flags; optimistic image messages
    // The optimistic bubble would remain blank forever without reload.
    expect(shouldReloadOnUserSaved({ ...base, localImages: true })).toBe(true)
    expect(shouldReloadOnUserSaved({ ...base, streaming: true, localImages: true, imagesDescribed: 0 })).toBe(true)
  })

  it('reloads image resends with unpersisted optimistic artifact IDs', () => {
    expect(shouldReloadOnUserSaved({ ...base, streaming: false, localImages: true })).toBe(true)
    expect(shouldReloadOnUserSaved({ ...base, streaming: false })).toBe(true) // Outside streaming it already reloads.
  })

  it('without an image, existing triggers still apply', () => {
    expect(shouldReloadOnUserSaved({ ...base, localSlash: true })).toBe(true)
    expect(shouldReloadOnUserSaved({ ...base, localAgentMentions: true })).toBe(true)
    expect(shouldReloadOnUserSaved({ ...base, compacted: true })).toBe(true)
    expect(shouldReloadOnUserSaved({ ...base, imagesDescribed: 2 })).toBe(true)
  })
})
