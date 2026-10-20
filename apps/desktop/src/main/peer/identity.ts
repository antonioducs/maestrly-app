import { generateKeyPairSync, randomBytes, randomUUID, X509Certificate } from 'node:crypto'
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
  cert.setExtensions([
    { name: 'basicConstraints', cA: false, critical: true },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
    { name: 'extKeyUsage', serverAuth: true },
  ])
  cert.sign(forge.pki.privateKeyFromPem(keyPem), forge.md.sha256.create())
  return forge.pki.certificateToPem(cert)
}

type Stored = { deviceId: string; name: string; certPem: string }

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
  if (stored && keyPem) return { ...stored, keyPem, fingerprint: certificateFingerprint(stored.certPem) }
  const deviceId = randomUUID()
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  })
  const certPem = createSelfSignedCertificate(deviceId, privateKey, publicKey, (options.now ?? (() => new Date()))())
  if (!storage.setSecret(IDENTITY_SECRET, privateKey)) return null
  const name = options.defaultName().trim().slice(0, 128) || 'Computer'
  storage.set(IDENTITY_KEY, JSON.stringify({ deviceId, name, certPem } satisfies Stored))
  return { deviceId, name, certPem, keyPem: privateKey, fingerprint: certificateFingerprint(certPem) }
}
