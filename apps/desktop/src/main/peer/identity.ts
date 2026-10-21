import { createPublicKey, generateKeyPairSync, randomBytes, randomUUID, X509Certificate } from 'node:crypto'
import forge from 'node-forge'

/** Where peer state lives: plain app settings, and secrets that only the OS keyring may hold. */
export interface PeerStorage {
  get(key: string): string | null
  set(key: string, value: string): void
  getSecret(key: string): string | null
  /** False when the keyring cannot keep it: nothing is stored then. */
  setSecret(key: string, value: string): boolean
  removeSecret(key: string): void
  secretsAvailable(): boolean
}

export interface PeerIdentity {
  deviceId: string
  name: string
  certPem: string
  keyPem: string
  /** SHA-256 of the certificate's DER, lowercase hex. */
  fingerprint: string
}

const IDENTITY_KEY = 'peer.identity'
const IDENTITY_SECRET = 'peer.identity.key'
const DAY_MS = 86_400_000

export const normalizeFingerprint = (value: string): string => value.replace(/:/g, '').toLowerCase()
export const certificateFingerprint = (pem: string): string =>
  normalizeFingerprint(new X509Certificate(pem).fingerprint256)

export function derToPem(der: Buffer): string {
  const lines = der.toString('base64').match(/.{1,64}/g) ?? []
  return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`
}

export function createSelfSignedCertificate(deviceId: string, keyPem: string, publicPem: string, now: Date): string {
  const cert = forge.pki.createCertificate()
  cert.publicKey = forge.pki.publicKeyFromPem(publicPem)
  // A positive serial: the leading byte keeps its sign bit clear.
  cert.serialNumber = `01${randomBytes(15).toString('hex')}`
  cert.validity.notBefore = new Date(now.getTime() - DAY_MS)
  cert.validity.notAfter = new Date(now.getTime() + 10 * 365 * DAY_MS)
  const attributes = [
    { name: 'commonName', value: deviceId },
    { name: 'organizationName', value: 'Maestrly' },
  ]
  cert.setSubject(attributes)
  cert.setIssuer(attributes)
  // The other computers trust this certificate as its own anchor, then compare its fingerprint with the pinned one.
  // Electron's BoringSSL accepts a self-signed anchor only when it may sign certificates; the fingerprint stays the
  // pin, so a certificate this key signs for anything else is still refused.
  cert.setExtensions([
    { name: 'basicConstraints', cA: true, critical: true },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, keyCertSign: true, critical: true },
    { name: 'extKeyUsage', serverAuth: true },
  ])
  cert.sign(forge.pki.privateKeyFromPem(keyPem), forge.md.sha256.create())
  return forge.pki.certificateToPem(cert)
}

type Stored = { deviceId: string; name: string; certPem: string }

const NAME_MAX = 128
/** A computer's name as the owner typed it, on one line and within what the peer protocol carries; '' when blank. */
export const cleanPeerName = (name: string): string =>
  name
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NAME_MAX)
    .trim()

function readStored(text: string | null): Stored | null {
  if (!text) return null
  try {
    const value = JSON.parse(text) as Partial<Stored>
    return typeof value.deviceId === 'string' && typeof value.name === 'string' && typeof value.certPem === 'string'
      ? { deviceId: value.deviceId, name: value.name, certPem: value.certPem }
      : null
  } catch {
    return null
  }
}

/**
 * This profile's identity among the owner's computers, created on first use. Null without a keyring: the private key
 * is never kept in plain text. A key the keyring lost means a new identity, which the other computers pair again.
 */
export function loadOrCreateIdentity(
  storage: PeerStorage,
  options: { defaultName: () => string; now?: () => Date }
): PeerIdentity | null {
  if (!storage.secretsAvailable()) return null
  const stored = readStored(storage.get(IDENTITY_KEY))
  const keyPem = storage.getSecret(IDENTITY_SECRET)
  if (stored && keyPem) {
    // A certificate from before it could anchor itself in Electron: the same key and device id get a new one. No
    // computer could pair with it then, so none pinned it.
    if (!new X509Certificate(stored.certPem).ca) {
      const publicPem = createPublicKey(keyPem).export({ type: 'spki', format: 'pem' }).toString()
      stored.certPem = createSelfSignedCertificate(
        stored.deviceId,
        keyPem,
        publicPem,
        (options.now ?? (() => new Date()))()
      )
      storage.set(IDENTITY_KEY, JSON.stringify(stored satisfies Stored))
    }
    return { ...stored, keyPem, fingerprint: certificateFingerprint(stored.certPem) }
  }
  const deviceId = randomUUID()
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  })
  const certPem = createSelfSignedCertificate(deviceId, privateKey, publicKey, (options.now ?? (() => new Date()))())
  if (!storage.setSecret(IDENTITY_SECRET, privateKey)) return null
  const name = cleanPeerName(options.defaultName()) || 'Computer'
  storage.set(IDENTITY_KEY, JSON.stringify({ deviceId, name, certPem } satisfies Stored))
  return { deviceId, name, certPem, keyPem: privateKey, fingerprint: certificateFingerprint(certPem) }
}

/** The name this profile has among the owner's computers, once it has an identity. */
export const storedPeerName = (storage: PeerStorage): string | null =>
  readStored(storage.get(IDENTITY_KEY))?.name ?? null

/**
 * Gives this profile another name among the owner's computers; false when it has no identity yet or the name is blank.
 * The other computers learn it the next time they reach this one.
 */
export function renameIdentity(storage: PeerStorage, name: string): boolean {
  const stored = readStored(storage.get(IDENTITY_KEY))
  const clean = cleanPeerName(name)
  if (!stored || !clean) return false
  storage.set(IDENTITY_KEY, JSON.stringify({ ...stored, name: clean } satisfies Stored))
  return true
}
