import { describe, expect, it } from 'vitest'
import { digest, isArtifactId, newArtifactId, newSecretToken, safeEqual } from '../src/ids.js'

describe('ids', () => {
  it('creates unguessable, URL-safe artifact IDs', () => {
    const ids = new Set<string>()
    for (let i = 0; i < 1000; i += 1) {
      const id = newArtifactId()
      expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/)
      ids.add(id)
    }
    expect(ids.size).toBe(1000)
  })

  it('creates 256-bit secret tokens', () => {
    expect(newSecretToken()).toHaveLength(43)
  })

  it('digests tokens with SHA-256', () => {
    expect(digest('a')).toBe('ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb')
  })

  it('compares strings in constant time', () => {
    expect(safeEqual('abc', 'abc')).toBe(true)
    expect(safeEqual('abc', 'abd')).toBe(false)
    expect(safeEqual('abc', 'ab')).toBe(false)
  })

  it('recognizes only well-formed artifact IDs', () => {
    expect(isArtifactId(newArtifactId())).toBe(true)
    expect(isArtifactId('../x')).toBe(false)
    expect(isArtifactId('a'.repeat(23))).toBe(false)
    expect(isArtifactId(42)).toBe(false)
  })
})
