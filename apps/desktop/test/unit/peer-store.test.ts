import { describe, expect, it, vi } from 'vitest'
import { issueToken, newPeerRecord, PeerStore } from '../../src/main/peer/store'
import { memoryPeerStorage, testIdentity } from './peer-helpers'

const T0 = 1_800_000_000_000

function record(issuedToken: string, addresses = ['10.0.0.5']) {
  const peer = testIdentity('B')
  return newPeerRecord({
    deviceId: peer.deviceId,
    name: 'MacBook B',
    os: 'mac',
    certPem: peer.certPem,
    port: 7690,
    addresses,
    issuedToken,
    hosting: true,
    now: T0,
  })
}

describe('PeerStore', () => {
  it('saves a paired computer, with its token in the keyring only', () => {
    const storage = memoryPeerStorage()
    const store = new PeerStore(storage)
    const saved = record(issueToken())
    expect(store.save(saved, 'token-to-reach-b-0123456789abcdef0123')).toBe(true)
    expect(store.list()).toEqual([saved])
    expect(store.get(saved.deviceId)).toEqual(saved)
    expect(store.tokenFor(saved.deviceId)).toBe('token-to-reach-b-0123456789abcdef0123')
    expect(storage.get('peer.records')).not.toContain('token-to-reach-b')
  })

  it('saves nothing without a keyring', () => {
    const store = new PeerStore(memoryPeerStorage(false))
    expect(store.save(record(issueToken()), 'token')).toBe(false)
    expect(store.list()).toEqual([])
  })

  it('authenticates only the token it issued', () => {
    const store = new PeerStore(memoryPeerStorage())
    const issued = issueToken()
    const saved = record(issued)
    store.save(saved, 'token')
    expect(store.authenticate(`Bearer ${issued}`)?.deviceId).toBe(saved.deviceId)
    expect(store.authenticate('Bearer wrong')).toBeNull()
    expect(store.authenticate(undefined)).toBeNull()
    expect(store.authenticate(issued)).toBeNull()
  })

  it('removes a computer with its token', () => {
    const store = new PeerStore(memoryPeerStorage())
    const saved = record(issueToken())
    store.save(saved, 'token')
    const listener = vi.fn()
    store.onChange(listener)
    expect(store.remove(saved.deviceId)).toBe(true)
    expect(store.get(saved.deviceId)).toBeNull()
    expect(store.tokenFor(saved.deviceId)).toBeNull()
    expect(listener).toHaveBeenCalledTimes(1)
    expect(store.remove(saved.deviceId)).toBe(false)
  })

  it('keeps the port a computer moved to, telling listeners only when it changes', () => {
    const store = new PeerStore(memoryPeerStorage())
    const saved = record(issueToken())
    store.save(saved, 'token')
    const listener = vi.fn()
    store.onChange(listener)
    store.setPort(saved.deviceId, 7700)
    expect(store.get(saved.deviceId)?.port).toBe(7700)
    store.setPort(saved.deviceId, 7700)
    store.setPort('unknown', 7701)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(store.tokenFor(saved.deviceId)).toBe('token')
  })

  it('keeps the newest addresses first, and records when it saw a computer at most each minute', () => {
    const store = new PeerStore(memoryPeerStorage())
    const saved = record(issueToken(), ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'])
    store.save(saved, 'token')
    store.touch(saved.deviceId, T0 + 1_000, '10.0.0.5')
    expect(store.get(saved.deviceId)?.addresses).toEqual(['10.0.0.5', 'a', 'b', 'c', 'd', 'e', 'f', 'g'])
    expect(store.get(saved.deviceId)?.lastSeenAt).toBe(T0)
    store.touch(saved.deviceId, T0 + 2_000, 'a')
    expect(store.get(saved.deviceId)?.addresses).toEqual(['a', '10.0.0.5', 'b', 'c', 'd', 'e', 'f', 'g'])
    expect(store.get(saved.deviceId)?.lastSeenAt).toBe(T0)
    store.touch(saved.deviceId, T0 + 60_000)
    expect(store.get(saved.deviceId)?.lastSeenAt).toBe(T0 + 60_000)
  })

  it('ignores records it cannot read', () => {
    const storage = memoryPeerStorage()
    storage.set('peer.records', '{not json')
    expect(new PeerStore(storage).list()).toEqual([])
    const saved = record(issueToken())
    storage.set('peer.records', JSON.stringify([saved, { deviceId: 'nope' }]))
    expect(new PeerStore(storage).list()).toEqual([saved])
  })

  it('makes a record with unique addresses and the certificate fingerprint', () => {
    const saved = record(issueToken(), ['10.0.0.5', '10.0.0.5', 'a.local'])
    expect(saved.addresses).toEqual(['10.0.0.5', 'a.local'])
    expect(saved.fingerprint).toBe(testIdentity('B').fingerprint)
    expect(saved).toMatchObject({ tint: null, pairedAt: T0, lastSeenAt: T0 })
    expect(saved.issuedTokenHash).toMatch(/^[0-9a-f]{64}$/)
  })
})
