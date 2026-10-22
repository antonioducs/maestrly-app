import { createPrivateKey, X509Certificate } from 'node:crypto'
import forge from 'node-forge'
import { describe, expect, it } from 'vitest'
import { certificateFingerprint, loadOrCreateIdentity, normalizeFingerprint } from '../../src/main/peer/identity'
import { memoryPeerStorage } from './peer-helpers'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('peer identity', () => {
  it('is created once and loaded again', () => {
    const storage = memoryPeerStorage()
    const first = loadOrCreateIdentity(storage, { defaultName: () => 'MacBook A' })
    if (!first) throw new Error('No identity')
    expect(first.deviceId).toMatch(UUID)
    expect(first.name).toBe('MacBook A')
    expect(first.fingerprint).toMatch(/^[0-9a-f]{64}$/)
    const cert = new X509Certificate(first.certPem)
    expect(cert.subject).toContain(`CN=${first.deviceId}`)
    expect(new Date(cert.validTo).getTime() - Date.now()).toBeGreaterThan(9 * 365 * 86_400_000)
    expect(cert.checkPrivateKey(createPrivateKey(first.keyPem))).toBe(true)
    expect(loadOrCreateIdentity(storage, { defaultName: () => 'other' })).toEqual(first)
    const plain = [...storage.values].filter(([key]) => !key.startsWith('secret:')).map(([, value]) => value)
    expect(plain.join()).not.toContain('PRIVATE KEY')
  })

  it('has a certificate that anchors itself, as Electron requires of a pinned one', () => {
    const identity = loadOrCreateIdentity(memoryPeerStorage(), { defaultName: () => 'A' })
    if (!identity) throw new Error('No identity')
    const cert = new X509Certificate(identity.certPem)
    expect(cert.ca).toBe(true)
    expect(cert.checkIssued(cert)).toBe(true)
    expect(cert.verify(cert.publicKey)).toBe(true)
  })

  it('gets a new certificate for the same key and device when its own cannot anchor itself', () => {
    const storage = memoryPeerStorage()
    const first = loadOrCreateIdentity(storage, { defaultName: () => 'A' })
    if (!first) throw new Error('No identity')
    // A certificate as the first release issued it: not allowed to sign certificates.
    const old = forge.pki.createCertificate()
    old.publicKey = forge.pki.publicKeyFromPem(
      new X509Certificate(first.certPem).publicKey.export({ type: 'spki', format: 'pem' }).toString()
    )
    old.serialNumber = '01'
    old.validity.notBefore = new Date(Date.now() - 86_400_000)
    old.validity.notAfter = new Date(Date.now() + 86_400_000)
    old.setSubject([{ name: 'commonName', value: first.deviceId }])
    old.setIssuer([{ name: 'commonName', value: first.deviceId }])
    old.setExtensions([{ name: 'basicConstraints', cA: false, critical: true }])
    old.sign(forge.pki.privateKeyFromPem(first.keyPem), forge.md.sha256.create())
    storage.set(
      'peer.identity',
      JSON.stringify({ deviceId: first.deviceId, name: 'A', certPem: forge.pki.certificateToPem(old) })
    )

    const again = loadOrCreateIdentity(storage, { defaultName: () => 'other' })
    if (!again) throw new Error('No identity')
    expect(again.deviceId).toBe(first.deviceId)
    expect(again.keyPem).toBe(first.keyPem)
    expect(new X509Certificate(again.certPem).ca).toBe(true)
    expect(new X509Certificate(again.certPem).checkPrivateKey(createPrivateKey(first.keyPem))).toBe(true)
    // Kept: the next start loads the same certificate.
    expect(loadOrCreateIdentity(storage, { defaultName: () => 'other' })).toEqual(again)
  })

  it('is unavailable without a keyring and stores nothing', () => {
    const storage = memoryPeerStorage(false)
    expect(loadOrCreateIdentity(storage, { defaultName: () => 'A' })).toBeNull()
    expect(storage.values.size).toBe(0)
  })

  it('starts over when the keyring lost the key', () => {
    const storage = memoryPeerStorage()
    const first = loadOrCreateIdentity(storage, { defaultName: () => 'A' })
    storage.removeSecret('peer.identity.key')
    const second = loadOrCreateIdentity(storage, { defaultName: () => 'A' })
    expect(second?.deviceId).toMatch(UUID)
    expect(second?.deviceId).not.toBe(first?.deviceId)
  })

  it('normalizes fingerprints the way Node prints them', () => {
    const identity = loadOrCreateIdentity(memoryPeerStorage(), { defaultName: () => 'A' })
    if (!identity) throw new Error('No identity')
    expect(certificateFingerprint(identity.certPem)).toBe(
      normalizeFingerprint(new X509Certificate(identity.certPem).fingerprint256)
    )
    expect(normalizeFingerprint('AB:CD')).toBe('abcd')
  })
})
