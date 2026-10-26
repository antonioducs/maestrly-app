import { describe, expect, it } from 'vitest'
import { responseAuthor, responsePreview } from '../../src/renderer/components/artifacts/responses-view'
import type { TFn } from '../../src/renderer/components/settings/shared'

/** Shows the key and its values, so the tests check what is said without depending on a language. */
const t = ((key: string, values: Record<string, unknown> = {}) =>
  `${key}${Object.keys(values).length ? ` ${JSON.stringify(values)}` : ''}`) as unknown as TFn

describe('responsePreview', () => {
  it('shows the first fields, one line each, and counts the rest', () => {
    expect(responsePreview({ a: 'one', b: 2, c: true, d: null, e: 'five' })).toEqual({
      fields: [
        { key: 'a', value: 'one' },
        { key: 'b', value: '2' },
        { key: 'c', value: 'true' },
      ],
      more: 2,
    })
    expect(responsePreview({ a: 'one' }, 3)).toEqual({ fields: [{ key: 'a', value: 'one' }], more: 0 })
    expect(responsePreview({}, 3)).toEqual({ fields: [], more: 0 })
    expect(responsePreview({ a: 1, b: 2 }, 1)).toEqual({ fields: [{ key: 'a', value: '1' }], more: 1 })
  })

  it('writes values that are not text as JSON, and cuts long ones', () => {
    expect(responsePreview({ list: [1, 'x'], nested: { ok: true }, none: null }).fields).toEqual([
      { key: 'list', value: '[1,"x"]' },
      { key: 'nested', value: '{"ok":true}' },
      { key: 'none', value: 'null' },
    ])
    const [long] = responsePreview({ text: 'x'.repeat(500) }).fields
    expect(long?.value).toHaveLength(120)
    expect(long?.value.endsWith('…')).toBe(true)
    expect(responsePreview({ text: 'x'.repeat(120) }).fields[0]?.value).toBe('x'.repeat(120))
  })

  it('keeps a line a line', () => {
    expect(responsePreview({ text: 'first\nsecond\tthird' }).fields[0]?.value).toBe('first second third')
  })
})

describe('responseAuthor', () => {
  it('names the owner as “you” and marks guests as unverified', () => {
    expect(responseAuthor(t, { kind: 'owner', name: 'Antonio', verified: true })).toBe('artifacts.comments.you')
    expect(responseAuthor(t, { kind: 'guest', name: 'Paula', verified: false })).toBe(
      'artifacts.comments.unverified {"name":"Paula"}'
    )
    expect(responseAuthor(t, { kind: 'invited', name: 'Maria', verified: true })).toBe('Maria')
  })
})
