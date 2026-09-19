import { describe, expect, it } from 'vitest'
import {
  createCursorTokenStore,
  cursorTokenKeyFor,
  type CursorTokenStoreDependencies,
} from '../../src/main/chat/cursor-subscription/token-store'

function memoryDeps(initial: Record<string, string> = {}): {
  deps: CursorTokenStoreDependencies
  persisted: Record<string, string>
} {
  const persisted = { ...initial }
  return {
    persisted,
    deps: {
      getPersisted: (key) => persisted[key] ?? null,
      setPersisted: (key, value) => {
        persisted[key] = value
        return true
      },
      removePersisted: (key) => {
        delete persisted[key]
        return true
      },
      secureStorageMode: () => 'secure',
    },
  }
}

describe('Cursor token store', () => {
  it('persists securely and clears credentials', () => {
    const { deps, persisted } = memoryDeps()
    const store = createCursorTokenStore(deps)
    expect(store.mode()).toBe('secure')
    expect(store.set(' crsr_secret ')).toBe('secure')
    expect(store.get()).toBe('crsr_secret')
    expect(persisted['chat.cursor.userApiKey']).toBe('crsr_secret')
    store.clear()
    expect(store.get()).toBeNull()
    expect(persisted['chat.cursor.userApiKey']).toBeUndefined()
  })

  it('falls back to memory without resurrecting persisted credentials', () => {
    const { persisted } = memoryDeps({ 'chat.cursor.userApiKey': 'old-secret' })
    const deps: CursorTokenStoreDependencies = {
      getPersisted: (key) => persisted[key] ?? null,
      setPersisted: () => false,
      removePersisted: (key) => {
        delete persisted[key]
        return true
      },
      secureStorageMode: () => 'unavailable',
    }
    const store = createCursorTokenStore(deps)
    expect(store.mode()).toBe('memory')
    expect(store.get()).toBe('old-secret')
    store.set('new-secret')
    expect(store.mode()).toBe('memory')
    expect(store.get()).toBe('new-secret')
    expect(persisted['chat.cursor.userApiKey']).toBeUndefined()
    store.clear()
    expect(store.get()).toBeNull()
  })

  it('isolates keys by account ID', () => {
    expect(cursorTokenKeyFor(null)).toBe('chat.cursor.userApiKey')
    expect(cursorTokenKeyFor('acc_A')).toBe('chat.cursor.userApiKey.acc_A')
    const { deps, persisted } = memoryDeps()
    const base = createCursorTokenStore(deps, cursorTokenKeyFor(null))
    const extra = createCursorTokenStore(deps, cursorTokenKeyFor('acc_A'))
    base.set('base-secret')
    expect(extra.get()).toBeNull()
    extra.set('extra-secret')
    expect(base.get()).toBe('base-secret')
    expect(persisted['chat.cursor.userApiKey.acc_A']).toBe('extra-secret')
  })

  it('clears empty credentials', () => {
    const { deps } = memoryDeps({ 'chat.cursor.userApiKey': 'x' })
    const store = createCursorTokenStore(deps)
    store.set('   ')
    expect(store.get()).toBeNull()
  })
})

describe('Cursor credential expiry', () => {
  it('persists expiry in the same secure value and honors it after restart', () => {
    const { deps, persisted } = memoryDeps()
    const expiresAt = Date.now() + 60_000
    createCursorTokenStore(deps).set('crsr_expiring', expiresAt)
    expect(JSON.parse(persisted['chat.cursor.userApiKey']!)).toEqual({
      version: 1,
      apiKey: 'crsr_expiring',
      apiKeyExpiresAtMs: expiresAt,
    })
    expect(createCursorTokenStore(deps).get()).toBe('crsr_expiring')
    persisted['chat.cursor.userApiKey'] = JSON.stringify({
      version: 1,
      apiKey: 'crsr_expiring',
      apiKeyExpiresAtMs: Date.now() - 1,
    })
    expect(createCursorTokenStore(deps).get()).toBeNull()
  })

  it('reads legacy string credentials without requiring an expiry', () => {
    const { deps } = memoryDeps({ 'chat.cursor.userApiKey': 'crsr_legacy' })
    expect(createCursorTokenStore(deps).get()).toBe('crsr_legacy')
  })

  it('rejects expired admission without replacing a valid credential', () => {
    const { deps } = memoryDeps({ 'chat.cursor.userApiKey': 'crsr_valid' })
    const store = createCursorTokenStore(deps)
    expect(() => store.set('crsr_expired', Date.now() - 1)).toThrow('expired')
    expect(store.get()).toBe('crsr_valid')
  })

  it('fails closed for malformed credential envelopes', () => {
    for (const raw of [
      '{',
      '{}',
      '{"version":1,"apiKey":"crsr_key"}',
      '{"version":1,"apiKey":"crsr_key","apiKeyExpiresAtMs":"tomorrow"}',
    ]) {
      const { deps } = memoryDeps({ 'chat.cursor.userApiKey': raw })
      expect(createCursorTokenStore(deps).get()).toBeNull()
    }
  })
})
