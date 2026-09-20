import { describe, expect, it } from 'vitest'
import { compareSemver, parseSemver, releasePageUrl, semverLt } from '../../src/shared/update'

describe('update semver helpers', () => {
  it('parses plain, v-prefixed and prerelease versions', () => {
    expect(parseSemver('1.2.3')).toEqual({ nums: [1, 2, 3], pre: [] })
    expect(parseSemver('v1.2.3-beta.4+build')).toEqual({ nums: [1, 2, 3], pre: ['beta', '4'] })
    expect(parseSemver('1.2')).toBeNull()
    expect(parseSemver('')).toBeNull()
  })
  it('orders by numbers first, then release over prerelease, then identifiers', () => {
    expect(compareSemver('0.7.0', '0.8.0')).toBe(-1)
    expect(compareSemver('1.0.0', '1.0.0-beta.1')).toBe(1)
    expect(compareSemver('1.0.0-beta.1', '1.0.0-beta.2')).toBe(-1)
    expect(compareSemver('1.0.0-alpha', '1.0.0-alpha.1')).toBe(-1)
    expect(compareSemver('1.0.0-1', '1.0.0-alpha')).toBe(-1)
    expect(compareSemver('1.0.0', '1.0.0')).toBe(0)
    expect(compareSemver('garbage', '1.0.0')).toBe(0)
  })
  it('semverLt is the strict less-than', () => {
    expect(semverLt('0.7.0', '0.7.1')).toBe(true)
    expect(semverLt('0.7.1', '0.7.1')).toBe(false)
  })
  it('builds the GitHub release page url', () => {
    expect(releasePageUrl('0.8.0')).toBe('https://github.com/antonioducs/maestrly-app/releases/tag/v0.8.0')
  })
})
