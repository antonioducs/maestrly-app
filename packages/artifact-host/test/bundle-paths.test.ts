import { describe, expect, it } from 'vitest'
import { contentTypeFor, isHtmlPath, isTextPath, normalizeBundlePath, validateBundle } from '../src/bundle-paths.js'
import { ArtifactHostError } from '../src/errors.js'
import { MAX_FILE_BYTES } from '../src/limits.js'

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn()
  } catch (error) {
    return error instanceof ArtifactHostError ? error.code : 'unexpected'
  }
  return undefined
}

const file = (path: string, size = 1) => ({ path, bytes: new Uint8Array(size) })

describe('normalizeBundlePath', () => {
  it.each(['index.html', 'assets/app.js', 'a-b_c.v2/IMG.PNG', 'fonts/x.woff2', 'data.json', 'lib/mod.mjs', 'w.wasm'])(
    'accepts %s',
    (path) => {
      expect(normalizeBundlePath(path)).toBe(path)
    }
  )

  it.each([
    '',
    '/abs.html',
    'a//b.html',
    './a.html',
    '../a.html',
    'a/../b.html',
    '.env',
    'a/.git/x.txt',
    'a\\b.html',
    'a b.html',
    'ç.html',
    '_maestrly/x.js',
    `${'a'.repeat(236)}.html`,
    `${Array.from({ length: 10 }, () => 'd').join('/')}/x.html`,
    'x\0.html',
  ])('rejects %j as an invalid path', (path) => {
    expect(codeOf(() => normalizeBundlePath(path))).toBe('invalid_path')
  })

  it.each(['x.exe', 'noext', 'map.js.map'])('rejects %s as an unsupported type', (path) => {
    expect(codeOf(() => normalizeBundlePath(path))).toBe('unsupported_type')
  })

  it('classifies content types from the extension only', () => {
    expect(contentTypeFor('a/B.HTML')).toBe('text/html; charset=utf-8')
    expect(contentTypeFor('x.png')).toBe('image/png')
    expect(contentTypeFor('x')).toBeNull()
    expect(isTextPath('style.css')).toBe(true)
    expect(isTextPath('x.png')).toBe(false)
    expect(isHtmlPath('page.htm')).toBe(true)
    expect(isHtmlPath('app.js')).toBe(false)
  })
})

describe('validateBundle', () => {
  it('accepts a bundle with an HTML entry', () => {
    expect(() => validateBundle([file('index.html'), file('app.js')], 'index.html')).not.toThrow()
  })

  it('rejects case-insensitive duplicates', () => {
    expect(codeOf(() => validateBundle([file('A.html'), file('a.html')], 'a.html'))).toBe('duplicate_path')
  })

  it('rejects too many files', () => {
    const files = Array.from({ length: 501 }, (_, i) => file(`f${i}.txt`))
    expect(codeOf(() => validateBundle(files, 'f0.txt'))).toBe('too_many_files')
  })

  it('rejects oversized files and bundles', () => {
    expect(codeOf(() => validateBundle([file('index.html', MAX_FILE_BYTES + 1)], 'index.html'))).toBe('file_too_large')
    const big = Array.from({ length: 6 }, (_, i) => file(`f${i}.html`, 9 * 1024 * 1024))
    expect(codeOf(() => validateBundle(big, 'f0.html'))).toBe('bundle_too_large')
  })

  it('requires an HTML entry that is part of the bundle', () => {
    expect(codeOf(() => validateBundle([file('index.html')], 'other.html'))).toBe('missing_entry')
    expect(codeOf(() => validateBundle([file('index.html'), file('app.js')], 'app.js'))).toBe('entry_not_html')
  })
})
