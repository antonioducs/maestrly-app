import { describe, expect, it } from 'vitest'
import { applyEdits } from '../src/edits.js'
import { ArtifactHostError } from '../src/errors.js'
import { text, utf8 } from './helpers.js'

const bundle = () =>
  new Map<string, Uint8Array>([
    ['index.html', utf8('<h1>Hello</h1><p>World</p>')],
    ['app.js', utf8('let a = 1; let b = 1;')],
    ['logo.png', new Uint8Array([137, 80, 78, 71])],
  ])

function errorOf(fn: () => unknown): ArtifactHostError {
  try {
    fn()
  } catch (error) {
    if (error instanceof ArtifactHostError) return error
    throw error
  }
  throw new Error('expected an error')
}

describe('applyEdits', () => {
  it('replaces one exact occurrence', () => {
    const next = applyEdits(bundle(), [{ path: 'index.html', oldText: 'Hello', newText: 'Hi' }])
    expect(text(next.get('index.html'))).toBe('<h1>Hi</h1><p>World</p>')
  })

  it('applies edits in order', () => {
    const next = applyEdits(bundle(), [
      { path: 'index.html', oldText: 'Hello', newText: 'Hey there' },
      { path: 'index.html', oldText: 'Hey there', newText: 'Bye' },
    ])
    expect(text(next.get('index.html'))).toBe('<h1>Bye</h1><p>World</p>')
  })

  it('reports the failing edit', () => {
    const error = errorOf(() =>
      applyEdits(bundle(), [
        { path: 'index.html', oldText: 'Missing', newText: 'x' },
        { path: 'index.html', oldText: 'Hello', newText: 'x' },
      ])
    )
    expect(error.code).toBe('edit_not_found')
    expect(error.details?.index).toBe(1)
    expect(error.details?.path).toBe('index.html')
  })

  it('refuses ambiguous replacements', () => {
    const error = errorOf(() => applyEdits(bundle(), [{ path: 'app.js', oldText: '= 1;', newText: '= 2;' }]))
    expect(error.code).toBe('edit_ambiguous')
  })

  it('refuses binary and invalid UTF-8 files', () => {
    expect(errorOf(() => applyEdits(bundle(), [{ path: 'logo.png', oldText: 'P', newText: 'Q' }])).code).toBe(
      'edit_binary'
    )
    const broken = new Map([['bad.js', new Uint8Array([0x61, 0xff, 0x62])]])
    expect(errorOf(() => applyEdits(broken, [{ path: 'bad.js', oldText: 'a', newText: 'c' }])).code).toBe('edit_binary')
  })

  it('refuses files outside the bundle', () => {
    expect(errorOf(() => applyEdits(bundle(), [{ path: 'other.css', oldText: 'a', newText: 'b' }])).code).toBe(
      'edit_not_found'
    )
  })

  it('leaves the original bundle untouched', () => {
    const original = bundle()
    applyEdits(original, [{ path: 'index.html', oldText: 'Hello', newText: 'Hi' }])
    expect(text(original.get('index.html'))).toBe('<h1>Hello</h1><p>World</p>')
  })
})
