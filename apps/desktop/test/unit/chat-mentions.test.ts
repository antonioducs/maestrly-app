import { describe, it, expect } from 'vitest'
import { findMentions } from '../../src/shared/chat-mentions'

/** Shared @file/@folder mention parsing for main-process injection and renderer chips. */
describe('findMentions', () => {
  it('finds a simple mention and returns the @ index', () => {
    const text = 'look at @src/store.ts here'
    const m = findMentions(text)
    expect(m).toHaveLength(1)
    expect(m[0].path).toBe('src/store.ts')
    expect(m[0].raw).toBe('@src/store.ts')
    expect(text.slice(m[0].index, m[0].index + m[0].raw.length)).toBe('@src/store.ts')
  })

  it('finds multiple mentions', () => {
    const m = findMentions('@a/b.ts and @c/d.ts')
    expect(m.map((x) => x.path)).toEqual(['a/b.ts', 'c/d.ts'])
  })

  it('does not treat email addresses as mentions', () => {
    const m = findMentions('please contact hello@example.com')
    expect(m).toHaveLength(0)
  })

  it('matches a mention at the start of the text', () => {
    const m = findMentions('@README.md is the documentation')
    expect(m).toHaveLength(1)
    expect(m[0].path).toBe('README.md')
    expect(m[0].index).toBe(0)
  })

  it('ignores @tokens without path syntax (/ or .)', () => {
    expect(findMentions('hello @someone there')).toHaveLength(0)
  })

  it('parses a :L10-20 range', () => {
    const m = findMentions('see @src/x.ts:L10-20')
    expect(m[0]).toMatchObject({ path: 'src/x.ts', startLine: 10, endLine: 20 })
  })

  it('parses a single-line :L42 range', () => {
    const m = findMentions('@a.ts:L42')
    expect(m[0]).toMatchObject({ path: 'a.ts', startLine: 42, endLine: undefined })
  })

  it('preserves trailing directory slashes', () => {
    const m = findMentions('this is in @src/components/')
    expect(m[0].path).toBe('src/components/')
  })

  it('stops mentions at punctuation outside the path', () => {
    const m = findMentions('(see @a/b.ts) and so on')
    expect(m).toHaveLength(1)
    expect(m[0].path).toBe('a/b.ts')
  })

  it('returns an empty list for text without @', () => {
    expect(findMentions('nothing here')).toEqual([])
  })
})
