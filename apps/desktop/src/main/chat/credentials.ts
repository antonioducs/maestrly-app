/**
 * Chat BYOK credentials: one API key per provider, encrypted through secure storage (safeStorage).
 *
 * Conceptually adapted from opencode `credential.ts`, simplified to one last-write-wins key per
 * provider. `secure-store.ts` stores encrypted values in app_settings. Keys never reach the renderer;
 * it receives only key presence and storage mode (see service.ts).
 *
 * On Linux without a keyring, unavailable secure storage retains the key only in memory for this
 * process. Never persist plaintext. The UI receives the storage mode so it can explain that the key
 * will not survive a restart.
 */

import { secureGet, secureSet, secureRemove, secureStorageMode, type SecureStoreMode } from '../secure-store'

const keyName = (providerId: string) => `chat.apiKey.${providerId}`

/** In-memory fallback when no keyring is available; valid only for this process. */
const memoryKeys = new Map<string, string>()

/** Read the decrypted provider key or its in-memory fallback. Return null if absent. Never expose to the renderer. */
export function getApiKey(providerId: string): string | null {
  const fromStore = secureGet(keyName(providerId))
  if (fromStore) return fromStore
  return memoryKeys.get(providerId) ?? null
}

/** Whether a provider key is configured, without revealing its value. */
export function hasApiKey(providerId: string): boolean {
  return getApiKey(providerId) != null
}

/**
 * Store the provider key. Return the effective mode: 'secure' (encrypted on disk) or 'unavailable'
 * (kept in memory for this process). An empty key removes the existing credential.
 */
export function setApiKey(providerId: string, key: string): SecureStoreMode {
  const trimmed = key.trim()
  if (!trimmed) {
    clearApiKey(providerId)
    return secureStorageMode()
  }
  const persisted = secureSet(keyName(providerId), trimmed)
  if (persisted) {
    memoryKeys.delete(providerId)
    return 'secure'
  }
  // No keyring: retain in memory for this process; never write plaintext.
  memoryKeys.set(providerId, trimmed)
  return 'unavailable'
}

/** Remove the provider key from disk and memory. */
export function clearApiKey(providerId: string): void {
  secureRemove(keyName(providerId))
  memoryKeys.delete(providerId)
}

/** Effective storage mode on this machine ('secure' | 'unavailable'). */
export function apiKeyStorageMode(): SecureStoreMode {
  return secureStorageMode()
}
