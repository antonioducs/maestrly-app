/** Encrypted store round trip through Electron safeStorage and real app_settings. Without a keyring, mode is unavailable and plaintext is never persisted. The stub can simulate encryption availability. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { safeStorage } from 'electron' // alias -> stub
import { freshDb, closeDb } from '../helpers/db'
import { getAppSetting, setAppSetting } from '../../src/main/store'
import {
  secureGet,
  secureSet,
  secureRemove,
  secureStorageMode,
  isSecureStorageAvailable,
} from '../../src/main/secure-store'

// Test helper exposed only by the stub.
const setEnc = (v: boolean): void => (safeStorage as unknown as { __setEncryptionAvailable: (v: boolean) => void }).__setEncryptionAvailable(v)

describe('secure-store', () => {
  beforeEach(freshDb)
  afterEach(() => {
    setEnc(true) // Restore encryption availability for other cases.
    closeDb()
  })

  it('round trip encrypts writes and decrypts reads without storing plaintext', () => {
    expect(secureSet('provider.session', 'super-secret-jwt')).toBe(true)
    const raw = getAppSetting('provider.session')
    expect(raw).toMatch(/^enc:v1:/) // Versioned format.
    expect(raw).not.toContain('super-secret-jwt') // Do not leak plaintext.
    expect(secureGet('provider.session')).toBe('super-secret-jwt')
    expect(isSecureStorageAvailable()).toBe(true)
    expect(secureStorageMode()).toBe('secure')
  })

  it('remove clears the credential', () => {
    secureSet('k', 'v')
    expect(secureRemove('k')).toBe(true)
    expect(secureGet('k')).toBeNull()
  })

  it('ignores legacy plaintext rather than decrypting invalid ciphertext', () => {
    setAppSetting('provider.token', 'legacy-plaintext-fixture')
    expect(secureGet('provider.token')).toBeNull()
  })

  it('without a keyring, mode is unavailable, writes do not persist, and reads return null', () => {
    setEnc(false)
    expect(isSecureStorageAvailable()).toBe(false)
    expect(secureStorageMode()).toBe('unavailable')
    expect(secureSet('k', 'v')).toBe(false) // Reject the write.
    expect(getAppSetting('k')).toBeNull() // Nothing was written, including plaintext.
    expect(secureGet('k')).toBeNull()
  })
})
