import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

export const ARTIFACT_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/

export const randomId = (bytes = 16): string => randomBytes(bytes).toString('base64url')

/** 128 random bits: artifact IDs appear in URLs and must not be guessable. */
export const newArtifactId = (): string => randomId(16)

export const newSecretToken = (): string => randomId(32)

export const digest = (token: string): string => createHash('sha256').update(token).digest('hex')

export const isArtifactId = (value: unknown): value is string =>
  typeof value === 'string' && ARTIFACT_ID_PATTERN.test(value)

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}
