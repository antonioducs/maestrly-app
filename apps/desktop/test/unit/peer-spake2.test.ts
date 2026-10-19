import { describe, expect, it } from 'vitest'
import { spake2Finish, spake2Start } from '../../src/main/peer/spake2'

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex')
// RFC 9382, Appendix B: the P256-SHA256-HKDF-HMAC vector with A='server' and B='client'.
const V = {
  w: '2ee57912099d31560b3a44b1184b9b4866e904c49d12ac5042c97dca461b1a5f',
  x: '43dd0fd7215bdcb482879fca3220c6a968e66d70b1356cac18bb26c84a78d729',
  y: 'dcb60106f276b02606d8ef0a328c02e4b629f84f89786af5befb0bc75b6e66be',
  pA: '04a56fa807caaa53a4d28dbb9853b9815c61a411118a6fe516a8798434751470f9010153ac33d0d5f2047ffdb1a3e42c9b4e6be662766e1eeb4116988ede5f912c',
  pB: '0406557e482bd03097ad0cbaa5df82115460d951e3451962f1eaf4367a420676d09857ccbc522686c83d1852abfa8ed6e4a1155cf8f1543ceca528afb591a1e0b7',
  ke: '0e0672dc86f8e45565d338b0540abe69',
  confirmA: '58ad4aa88e0b60d5061eb6b5dd93e80d9c4f00d127c65b3b35b1b5281fee38f0',
  confirmB: 'd3e2e547f1ae04f2dbdbf0fc4b79f8ecff2dff314b5d32fe9fcef2fb26dc459b',
}
const ids = { a: Buffer.from('server'), b: Buffer.from('client') }
const none = new Uint8Array()

describe('SPAKE2 (RFC 9382, P256-SHA256-HKDF-HMAC)', () => {
  it('matches the RFC test vector on both sides', () => {
    const a = spake2Start('A', BigInt(`0x${V.w}`), BigInt(`0x${V.x}`))
    const b = spake2Start('B', BigInt(`0x${V.w}`), BigInt(`0x${V.y}`))
    expect(hex(a.message)).toBe(V.pA)
    expect(hex(b.message)).toBe(V.pB)
    for (const keys of [spake2Finish(a, b.message, ids, none), spake2Finish(b, a.message, ids, none)]) {
      expect(hex(keys.ke)).toBe(V.ke)
      expect(hex(keys.confirmA)).toBe(V.confirmA)
      expect(hex(keys.confirmB)).toBe(V.confirmB)
    }
  })

  it('gives different confirmations for different passwords', () => {
    const a = spake2Start('A', 11n)
    const b = spake2Start('B', 12n)
    expect(hex(spake2Finish(a, b.message, ids, none).confirmB)).not.toBe(
      hex(spake2Finish(b, a.message, ids, none).confirmB)
    )
  })

  it('binds the additional data into the confirmations', () => {
    const a = spake2Start('A', 7n)
    const b = spake2Start('B', 7n)
    const left = spake2Finish(a, b.message, ids, Buffer.from('fingerprints-1'))
    const right = spake2Finish(b, a.message, ids, Buffer.from('fingerprints-2'))
    expect(hex(left.ke)).toBe(hex(right.ke))
    expect(hex(left.confirmA)).not.toBe(hex(right.confirmA))
  })

  it('refuses a message that is not an uncompressed curve point', () => {
    const a = spake2Start('A', 7n)
    expect(() => spake2Finish(a, new Uint8Array(65), ids, none)).toThrow('Invalid SPAKE2 message')
    expect(() => spake2Finish(a, a.message.subarray(0, 33), ids, none)).toThrow('Invalid SPAKE2 message')
  })
})
