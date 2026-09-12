import { safeStorage } from 'electron'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createGrokTokenStore,
  defaultGrokTokenStore,
  grokTokenKeyFor,
  parseGrokTokenBundle,
} from '../../src/main/chat/grok-subscription/token-store'
import { getAppSetting } from '../../src/main/store'
import { closeDb, freshDb } from '../helpers/db'

const setEncryptionAvailable = (available: boolean): void =>
  (
    safeStorage as unknown as {
      __setEncryptionAvailable(value: boolean): void
    }
  ).__setEncryptionAvailable(available)

const sampleBundle = {
  accessToken: 'access_secret',
  refreshToken: 'refresh_secret',
  expiresAt: Date.now() + 3_600_000,
  idToken: 'id_secret',
  scope: 'openid',
  sessionId: 'sess_estavel',
}

describe('Grok token store', () => {
  beforeEach(() => {
    freshDb()
    setEncryptionAvailable(true)
    defaultGrokTokenStore.clear()
  })

  afterEach(() => {
    defaultGrokTokenStore.clear()
    setEncryptionAvailable(true)
    closeDb()
  })

  it('encrypts OAuth bundles in secure storage', () => {
    expect(defaultGrokTokenStore.set(sampleBundle)).toBe('secure')
    expect(defaultGrokTokenStore.get()?.accessToken).toBe('access_secret')
    const raw = getAppSetting('chat.grok.oauthTokens')
    expect(raw).toMatch(/^enc:v1:/)
    expect(raw).not.toContain('access_secret')
    expect(raw).not.toContain('refresh_secret')
  })

  it('keeps tokens in memory without keyrings and isolates accounts', () => {
    expect(defaultGrokTokenStore.set(sampleBundle)).toBe('secure')
    setEncryptionAvailable(false)

    expect(
      defaultGrokTokenStore.set({
        ...sampleBundle,
        accessToken: 'memory_access',
        refreshToken: 'memory_refresh',
      })
    ).toBe('memory')
    expect(defaultGrokTokenStore.get()?.accessToken).toBe('memory_access')
    expect(getAppSetting('chat.grok.oauthTokens')).not.toContain('memory_access')

    const extra = createGrokTokenStore(undefined, grokTokenKeyFor('acc_other'))
    expect(
      extra.set({
        accessToken: 'other_access',
        refreshToken: 'other_refresh',
        expiresAt: Date.now() + 1_000,
      })
    ).toBe('memory')
    expect(extra.get()?.accessToken).toBe('other_access')
    expect(defaultGrokTokenStore.get()?.accessToken).toBe('memory_access')

    defaultGrokTokenStore.clear()
    expect(defaultGrokTokenStore.get()).toBeNull()
    expect(extra.get()?.accessToken).toBe('other_access')
  })

  it('rejects malformed payloads', () => {
    expect(parseGrokTokenBundle('{')).toBeNull()
    expect(parseGrokTokenBundle(JSON.stringify({ accessToken: 'a' }))).toBeNull()
    expect(parseGrokTokenBundle(JSON.stringify(sampleBundle))?.refreshToken).toBe('refresh_secret')
  })

  it('preserves stable session IDs through serialization', () => {
    expect(parseGrokTokenBundle(JSON.stringify(sampleBundle))?.sessionId).toBe('sess_estavel')
    // Stable session IDs survive encrypted token-store serialization.
    defaultGrokTokenStore.set(sampleBundle)
    expect(defaultGrokTokenStore.get()?.sessionId).toBe('sess_estavel')
    // Legacy bundles without session IDs still parse but cannot derive identity.
    expect(
      parseGrokTokenBundle(JSON.stringify({ accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 1_000 }))
        ?.sessionId
    ).toBeUndefined()
  })

  it('preserves identity after persistent removal failure', () => {
    const store = createGrokTokenStore({
      getPersisted: () => JSON.stringify(sampleBundle),
      setPersisted: () => false,
      removePersisted: () => false,
      secureStorageMode: () => 'unavailable',
    })
    expect(() => store.set({ accessToken: 'new', refreshToken: 'new', expiresAt: Date.now() + 1_000 })).toThrow(
      'previously persisted Grok credential'
    )
    expect(store.get()?.accessToken).toBe('access_secret')
  })
})
