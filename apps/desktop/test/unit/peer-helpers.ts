import type { PeerIdentity, PeerStorage } from '../../src/main/peer/identity'
import { loadOrCreateIdentity } from '../../src/main/peer/identity'

export function memoryPeerStorage(secrets = true): PeerStorage & { values: Map<string, string> } {
  const values = new Map<string, string>()
  return {
    values,
    get: (key) => values.get(key) ?? null,
    set: (key, value) => void values.set(key, value),
    getSecret: (key) => (secrets ? (values.get(`secret:${key}`) ?? null) : null),
    setSecret: (key, value) => {
      if (!secrets) return false
      values.set(`secret:${key}`, value)
      return true
    },
    removeSecret: (key) => void values.delete(`secret:${key}`),
    secretsAvailable: () => secrets,
  }
}

const cache = new Map<string, PeerIdentity>()
/** An identity per name, made once per test file: RSA key generation takes a moment. */
export function testIdentity(name: string): PeerIdentity {
  let identity = cache.get(name)
  if (!identity) {
    identity = loadOrCreateIdentity(memoryPeerStorage(), { defaultName: () => name }) ?? undefined
    if (!identity) throw new Error('A test identity could not be created.')
    cache.set(name, identity)
  }
  return identity
}
