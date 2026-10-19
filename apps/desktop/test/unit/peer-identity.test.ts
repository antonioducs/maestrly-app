import { createPrivateKey, X509Certificate } from 'node:crypto'
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
