import { describe, expect, it } from 'vitest'
import {
  hostKey,
  isRemoteHostId,
  isValidHostId,
  LOCAL_HOST_ID,
  parseHostKey,
  remoteHostId,
} from '../../src/shared/host-key'

describe('host keys', () => {
  it("keeps this computer's ids as they are, so local state and storage keys do not move", () => {
    expect(hostKey(LOCAL_HOST_ID, 'abc')).toBe('abc')
    expect(parseHostKey('abc')).toEqual({ hostId: 'local', id: 'abc' })
  })

  it('prefixes the ids of a remote host and reads them back', () => {
    expect(hostKey('s1/e1', 'abc')).toBe('s1/e1#abc')
    expect(parseHostKey('s1/e1#abc')).toEqual({ hostId: 's1/e1', id: 'abc' })
    // Only the first separator splits: an id keeps any `#` of its own.
    expect(parseHostKey('s1/e1#term:abc#2')).toEqual({ hostId: 's1/e1', id: 'term:abc#2' })
  })

  it('tells remote hosts from this computer', () => {
    expect(isRemoteHostId(LOCAL_HOST_ID)).toBe(false)
    expect(isRemoteHostId('s1/e1')).toBe(true)
  })

  it('accepts only this computer and server/environment ids that cannot contain the key separator', () => {
    expect(isValidHostId('local')).toBe(true)
    expect(isValidHostId(remoteHostId('5f0c2a9e-7b1d-4c3e-9a8f-0d1e2f3a4b5c', 'work'))).toBe(true)
    expect(isValidHostId('direct/dev')).toBe(true)
    for (const invalid of ['a#b/c', '../x', 'a/b/c', 'server', 'Server/env', '', 'a/', '/b', 'a/b#c'])
      expect(isValidHostId(invalid)).toBe(false)
  })
})
