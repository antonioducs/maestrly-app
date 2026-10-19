import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, scryptSync } from 'node:crypto'
import type { PeerGrant } from '../../shared/peer'
import { peerGrantSchema } from './schemas'
import { SPAKE2_ORDER } from './spake2'

const LABEL = 'maestrly-peer-pairing-v1'
const IV_BYTES = 12
const TAG_BYTES = 16

export const b64u = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url')
export const fromB64u = (text: string): Buffer => Buffer.from(text, 'base64url')

/** The code as SPAKE2's w: scrypt slows offline guessing, and 64 bits more than p remove the bias of the reduction. */
export function passwordScalar(code: string, pairingId: string): bigint {
  const stretched = scryptSync(code, `${LABEL}:${pairingId}`, 40, { N: 16_384, r: 8, p: 1 })
  const value = BigInt(`0x${stretched.toString('hex')}`) % SPAKE2_ORDER
  if (value === 0n) throw new Error('Invalid pairing code')
  return value
}

/** Binds both certificates into the confirmations: a relay that presents another certificate fails them. */
export const pairingAad = (hostFingerprint: string, clientFingerprint: string): Buffer =>
  Buffer.concat([Buffer.from(LABEL), Buffer.from(hostFingerprint, 'hex'), Buffer.from(clientFingerprint, 'hex')])

const sealKey = (ke: Uint8Array, direction: 'client' | 'host'): Buffer =>
  Buffer.from(hkdfSync('sha256', ke, Buffer.alloc(0), `maestrly-peer-seal-v1:${direction}`, 32))

/** Encrypts what one computer gives the other under the pairing's key; `direction` is the computer that sends it. */
export function sealGrant(ke: Uint8Array, direction: 'client' | 'host', grant: PeerGrant): string {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', sealKey(ke, direction), iv)
  cipher.setAAD(Buffer.from(direction))
  const body = Buffer.concat([cipher.update(JSON.stringify(grant), 'utf8'), cipher.final()])
  return b64u(Buffer.concat([iv, body, cipher.getAuthTag()]))
}

/** Opens a sealed grant; throws when it was changed on the way or does not hold a grant. */
export function openGrant(ke: Uint8Array, direction: 'client' | 'host', sealed: string): PeerGrant {
  const bytes = fromB64u(sealed)
  if (bytes.length < IV_BYTES + TAG_BYTES + 2) throw new Error('Invalid sealed grant')
  const decipher = createDecipheriv('aes-256-gcm', sealKey(ke, direction), bytes.subarray(0, IV_BYTES))
  decipher.setAAD(Buffer.from(direction))
  decipher.setAuthTag(bytes.subarray(bytes.length - TAG_BYTES))
  const text = Buffer.concat([
    decipher.update(bytes.subarray(IV_BYTES, bytes.length - TAG_BYTES)),
    decipher.final(),
  ]).toString('utf8')
  return peerGrantSchema.parse(JSON.parse(text))
}
