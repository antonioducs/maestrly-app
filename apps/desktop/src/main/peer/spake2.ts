import { createHash, createHmac, hkdfSync, randomBytes } from 'node:crypto'
import { p256 } from '@noble/curves/nist.js'

/**
 * SPAKE2 (RFC 9382), ciphersuite P256-SHA256-HKDF-HMAC with the RFC's M and N. Two computers that share a short code
 * derive keys only they know; a man in the middle gets one guess per run. Party A asks to pair, party B shows the code.
 */
const Point = p256.Point
const M = Point.fromHex('02886e2f97ace46e55ba9dd7242579f2993b64e16ef3dcab95afd497333d8fa12f')
const N = Point.fromHex('03d8bbd6c639c62937b04d997f38c3770719c629d7014d49a24b4f98baa1292b49')
export const SPAKE2_ORDER: bigint = Point.Fn.ORDER
const SCALAR_BYTES = 32
const POINT_BYTES = 65

export type Spake2Party = 'A' | 'B'
export interface Spake2Start {
  party: Spake2Party
  w: bigint
  scalar: bigint
  /** pA or pB, uncompressed. */
  message: Uint8Array
}
export interface Spake2Keys {
  ke: Buffer
  confirmA: Buffer
  confirmB: Buffer
}

/** A scalar in [1, p), reduced from 64 bits more than p needs, as the RFC suggests. */
function randomScalar(): bigint {
  const value = BigInt(`0x${randomBytes(SCALAR_BYTES + 8).toString('hex')}`) % SPAKE2_ORDER
  return value === 0n ? 1n : value
}

const scalarBytes = (value: bigint): Buffer => Buffer.from(value.toString(16).padStart(SCALAR_BYTES * 2, '0'), 'hex')

function lengthPrefixed(parts: Uint8Array[]): Buffer {
  const out: Buffer[] = []
  for (const part of parts) {
    const length = Buffer.alloc(8)
    length.writeBigUInt64LE(BigInt(part.length))
    out.push(length, Buffer.from(part))
  }
  return Buffer.concat(out)
}

export function spake2Start(party: Spake2Party, w: bigint, scalar: bigint = randomScalar()): Spake2Start {
  const blind = party === 'A' ? M : N
  return { party, w, scalar, message: Point.BASE.multiply(scalar).add(blind.multiply(w)).toBytes(false) }
}

export function spake2Finish(
  start: Spake2Start,
  peerMessage: Uint8Array,
  ids: { a: Uint8Array; b: Uint8Array },
  aad: Uint8Array
): Spake2Keys {
  if (peerMessage.length !== POINT_BYTES || peerMessage[0] !== 4) throw new Error('Invalid SPAKE2 message')
  let peer: typeof Point.BASE
  try {
    peer = Point.fromBytes(peerMessage)
    peer.assertValidity()
  } catch {
    throw new Error('Invalid SPAKE2 message')
  }
  const k = peer.subtract((start.party === 'A' ? N : M).multiply(start.w)).multiply(start.scalar)
  if (k.equals(Point.ZERO)) throw new Error('Invalid SPAKE2 message')
  const [pA, pB] = start.party === 'A' ? [start.message, peerMessage] : [peerMessage, start.message]
  const tt = lengthPrefixed([ids.a, ids.b, pA, pB, k.toBytes(false), scalarBytes(start.w)])
  const digest = createHash('sha256').update(tt).digest()
  const info = Buffer.concat([Buffer.from('ConfirmationKeys'), Buffer.from(aad)])
  const kc = Buffer.from(hkdfSync('sha256', digest.subarray(16), Buffer.alloc(0), info, 32))
  const mac = (key: Buffer): Buffer => createHmac('sha256', key).update(tt).digest()
  return { ke: digest.subarray(0, 16), confirmA: mac(kc.subarray(0, 16)), confirmB: mac(kc.subarray(16)) }
}
