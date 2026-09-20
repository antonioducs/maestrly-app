/**
 * Encrypted secret storage for connector callbacks and inbound webhooks.
 *
 * The encryption key lives outside the database, supplied by the operator. Without it the server refuses to
 * read or write a secret instead of degrading to plaintext, and each stored secret records the key it was
 * sealed with so a rotation is explicit.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto'

export interface SecretKey {
  id: string
  key: Buffer
}

export class SecretKeyUnavailableError extends Error {
  readonly statusCode = 503
  constructor(message = 'No secret encryption key is configured on this instance.') {
    super(message)
    this.name = 'SecretKeyUnavailableError'
  }
}

/**
 * Parse the operator key material. The format is `keyId:base64key`, optionally repeated with commas so an old
 * key can still decrypt while a new one encrypts.
 */
export function parseSecretKeys(raw: string | undefined): SecretKey[] {
  if (!raw?.trim()) return []
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const separator = entry.indexOf(':')
      if (separator <= 0) throw new Error('Secret key material must use the keyId:base64key format.')
      const id = entry.slice(0, separator)
      const key = Buffer.from(entry.slice(separator + 1), 'base64')
      if (key.byteLength !== 32) throw new Error(`Secret key "${id}" must decode to exactly 32 bytes.`)
      return { id, key }
    })
}

export interface SealedSecret {
  cipher: Buffer
  nonce: Buffer
  keyId: string
  /** Stable fingerprint so the interface can confirm which secret is stored without revealing it. */
  fingerprint: string
}

export class SecretVault {
  private readonly keys: Map<string, Buffer>
  private readonly active: SecretKey | null

  constructor(keys: SecretKey[]) {
    this.keys = new Map(keys.map((entry) => [entry.id, entry.key]))
    this.active = keys[0] ?? null
  }

  get available(): boolean {
    return this.active !== null
  }

  get activeKeyId(): string | null {
    return this.active?.id ?? null
  }

  seal(secret: string): SealedSecret {
    if (!this.active) throw new SecretKeyUnavailableError()
    const nonce = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.active.key, nonce)
    const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final(), cipher.getAuthTag()])
    return {
      cipher: encrypted,
      nonce,
      keyId: this.active.id,
      fingerprint: createHash('sha256').update(secret).digest('hex').slice(0, 32),
    }
  }

  open(sealed: { cipher: Buffer; nonce: Buffer; keyId: string }): string {
    const key = this.keys.get(sealed.keyId)
    if (!key)
      throw new SecretKeyUnavailableError(
        `The key "${sealed.keyId}" that sealed this secret is not configured. Restore it or rotate the secret.`
      )
    const tag = sealed.cipher.subarray(sealed.cipher.byteLength - 16)
    const body = sealed.cipher.subarray(0, sealed.cipher.byteLength - 16)
    const decipher = createDecipheriv('aes-256-gcm', key, sealed.nonce)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')
  }

  /** Re-seal an existing secret with the active key, for an explicit rotation. */
  rotate(sealed: { cipher: Buffer; nonce: Buffer; keyId: string }): SealedSecret {
    return this.seal(this.open(sealed))
  }
}

export function fingerprintOfSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex').slice(0, 32)
}

/** Constant-time comparison for a signature or a bearer secret. */
export function secretsMatch(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  if (a.byteLength !== b.byteLength) return false
  return timingSafeEqual(a, b)
}
