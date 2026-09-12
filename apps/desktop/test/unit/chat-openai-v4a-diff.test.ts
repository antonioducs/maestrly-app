import { describe, expect, it } from 'vitest'
import { applyV4ADiff } from '../../src/main/chat/openai/v4a-diff'

describe('OpenAI V4A diff adapter', () => {
  it('parses create-file diffs and requires every line to be an insertion', () => {
    expect(applyV4ADiff('', '+one\n+two\n+', 'create')).toBe('one\ntwo\n')
    expect(() => applyV4ADiff('', '+one\ntwo', 'create')).toThrow(/Invalid Add File Line/)
  })

  it('applies anchored update chunks in order and preserves the input trailing newline', () => {
    const input = 'header\nfunction first() {\n  return 1\n}\nfunction second() {\n  return 2\n}\n'
    const diff = [
      '@@ function first() {',
      '-  return 1',
      '+  return 10',
      '@@ function second() {',
      '-  return 2',
      '+  return 20',
    ].join('\n')

    expect(applyV4ADiff(input, diff)).toBe(
      'header\nfunction first() {\n  return 10\n}\nfunction second() {\n  return 20\n}\n'
    )
  })

  it('supports context fuzz and end-of-file placement', () => {
    expect(applyV4ADiff('alpha  \nomega\n', '@@\n alpha\n+middle\n omega')).toBe('alpha  \nmiddle\nomega\n')
    expect(applyV4ADiff('first\nlast\n', '@@\n last\n+tail\n*** End of File')).toBe('first\nlast\ntail\n')
  })

  it('rejects stale context instead of partially applying a patch', () => {
    expect(() => applyV4ADiff('actual\n', '@@\n-stale\n+next')).toThrow(/Invalid Context/)
  })
})
