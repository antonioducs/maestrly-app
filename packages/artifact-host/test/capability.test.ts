import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { signCapability, verifyCapability } from '../src/http/capability.js'

const key = randomBytes(32)
const payload = { a: 'A'.repeat(22), v: 2, s: 'session-id', e: 10_000 }

describe('capabilities', () => {
  it('round-trips a signed payload', () => {
    const token = signCapability(payload, key)
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
    expect(verifyCapability(token, key, 5_000)).toEqual(payload)
  })

  it('rejects tampering, expiry, other keys and malformed tokens', () => {
    const token = signCapability(payload, key)
    const [body, signature] = token.split('.') as [string, string]
    const flipped = signature.startsWith('A') ? `B${signature.slice(1)}` : `A${signature.slice(1)}`
    expect(verifyCapability(`${body}.${flipped}`, key, 5_000)).toBeNull()
    const forged = Buffer.from(JSON.stringify({ ...payload, v: 3 })).toString('base64url')
    expect(verifyCapability(`${forged}.${signature}`, key, 5_000)).toBeNull()
    expect(verifyCapability(token, key, 10_000)).toBeNull()
    expect(verifyCapability(token, randomBytes(32), 5_000)).toBeNull()
    expect(verifyCapability(`${token}${'a'.repeat(600)}`, key, 5_000)).toBeNull()
    expect(verifyCapability(body, key, 5_000)).toBeNull()
    expect(verifyCapability(`${token}.x`, key, 5_000)).toBeNull()
  })

  it('rejects well-signed payloads with an invalid shape', () => {
    const token = signCapability({ ...payload, a: '../x' }, key)
    expect(verifyCapability(token, key, 5_000)).toBeNull()
  })
})
