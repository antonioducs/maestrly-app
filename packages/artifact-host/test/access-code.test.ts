import { describe, expect, it } from 'vitest'
import { hashAccessCode, verifyAccessCode } from '../src/access-code.js'

describe('access codes', () => {
  it('hashes with a salt of its own, so equal codes never store equal values', () => {
    const first = hashAccessCode('secret1')
    const second = hashAccessCode('secret1')
    expect(first.startsWith('scrypt$')).toBe(true)
    expect(first.split('$')).toHaveLength(3)
    expect(first).not.toBe(second)
    expect(first).not.toContain('secret1')
  })

  it('verifies only the right code', () => {
    const stored = hashAccessCode('secret1')
    expect(verifyAccessCode('secret1', stored)).toBe(true)
    expect(verifyAccessCode('secret2', stored)).toBe(false)
    expect(verifyAccessCode('', stored)).toBe(false)
  })

  it('refuses malformed stored values instead of throwing', () => {
    expect(verifyAccessCode('secret1', 'x')).toBe(false)
    expect(verifyAccessCode('secret1', 'scrypt$a')).toBe(false)
    expect(verifyAccessCode('secret1', 'plain$YQ$YQ')).toBe(false)
    expect(verifyAccessCode('secret1', 'scrypt$$')).toBe(false)
  })
})
