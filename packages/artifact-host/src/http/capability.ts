import { createHmac, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { ARTIFACT_ID_PATTERN } from '../ids.js'

/** Signed grant to read one version's files for one session: artifact, version, session and expiry. */
export interface CapabilityPayload {
  a: string
  v: number
  s: string
  e: number
}

const MAX_TOKEN_CHARS = 512
const BASE64URL = /^[A-Za-z0-9_-]+$/
const payloadSchema = z.object({
  a: z.string().regex(ARTIFACT_ID_PATTERN),
  v: z.number().int().min(1),
  s: z.string().min(1).max(64),
  e: z.number().int(),
})

const sign = (body: string, key: Buffer): Buffer => createHmac('sha256', key).update(body).digest()

export function signCapability(payload: CapabilityPayload, key: Buffer): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${body}.${sign(body, key).toString('base64url')}`
}

export function verifyCapability(token: string, key: Buffer, now: number): CapabilityPayload | null {
  if (typeof token !== 'string' || token.length > MAX_TOKEN_CHARS) return null
  const parts = token.split('.')
  if (parts.length !== 2) return null
  const [body, signature] = parts as [string, string]
  if (!BASE64URL.test(body) || !BASE64URL.test(signature)) return null
  const given = Buffer.from(signature, 'base64url')
  const expected = sign(body, key)
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null
  let decoded: unknown
  try {
    decoded = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  const parsed = payloadSchema.safeParse(decoded)
  if (!parsed.success || parsed.data.e <= now) return null
  return parsed.data
}
