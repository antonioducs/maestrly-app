/** Encrypt user-enabled integration credentials with the operating-system keyring; never persist plaintext. */
import { safeStorage } from 'electron'
import { getAppSetting, setAppSetting } from './store'

export type SecureStoreMode = 'secure' | 'unavailable'

const ENC_PREFIX = 'enc:v1:'

export function isSecureStorageAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

export function secureStorageMode(): SecureStoreMode {
  return isSecureStorageAvailable() ? 'secure' : 'unavailable'
}

/** Ignore legacy plaintext and return null when the keyring or ciphertext is unavailable. */
export function secureGet(key: string): string | null {
  try {
    const raw = getAppSetting(key)
    if (!raw?.startsWith(ENC_PREFIX)) return null
    if (!isSecureStorageAvailable()) return null
    const buf = Buffer.from(raw.slice(ENC_PREFIX.length), 'base64')
    const plain = safeStorage.decryptString(buf)
    return plain.length > 0 ? plain : null
  } catch {
    return null
  }
}

/** Return false when encryption is unavailable so callers can keep credentials in memory only. */
export function secureSet(key: string, value: string): boolean {
  try {
    if (!isSecureStorageAvailable()) return false
    const blob = safeStorage.encryptString(value)
    setAppSetting(key, ENC_PREFIX + blob.toString('base64'))
    return true
  } catch {
    return false
  }
}

/** Persist removal before callers report success; an empty value is read as absent. */
export function secureRemove(key: string): boolean {
  try {
    setAppSetting(key, '')
    return true
  } catch {
    return false
  }
}
