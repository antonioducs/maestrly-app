import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

const PREFIX = 'scrypt'
const SALT_BYTES = 16
const KEY_BYTES = 32
const COST = 16_384
const BASE64URL = /^[A-Za-z0-9_-]+$/

const derive = (code: string, salt: Buffer): Buffer => scryptSync(code, salt, KEY_BYTES, { N: COST })

/**
 * Access codes are chosen by people and can be short, so they are stored with scrypt and a salt of their own rather
 * than the plain digest used for high-entropy tokens.
 */
export function hashAccessCode(code: string): string {
  const salt = randomBytes(SALT_BYTES)
  return `${PREFIX}$${salt.toString('base64url')}$${derive(code, salt).toString('base64url')}`
}

/** False for a wrong code and for any stored value this module did not write. */
export function verifyAccessCode(code: string, stored: string): boolean {
  const parts = stored.split('$')
  if (parts.length !== 3 || parts[0] !== PREFIX) return false
  const [, salt, hash] = parts as [string, string, string]
  if (!BASE64URL.test(salt) || !BASE64URL.test(hash)) return false
  const expected = Buffer.from(hash, 'base64url')
  if (expected.length !== KEY_BYTES) return false
  return timingSafeEqual(derive(code, Buffer.from(salt, 'base64url')), expected)
}
