import { secureGet, secureRemove, secureSet, secureStorageMode } from '../../secure-store'

const TOKEN_KEY = 'chat.cursor.userApiKey'

export function cursorTokenKeyFor(accountId: string | null): string {
  return accountId ? `${TOKEN_KEY}.${accountId}` : TOKEN_KEY
}

export type CursorTokenStorageMode = 'secure' | 'memory'

export interface CursorTokenStore {
  get(): string | null
  set(token: string, apiKeyExpiresAtMs?: number): CursorTokenStorageMode
  clear(): void
  mode(): CursorTokenStorageMode
}

export interface CursorTokenStoreDependencies {
  getPersisted: (key: string) => string | null
  setPersisted: (key: string, value: string) => boolean
  removePersisted: (key: string) => boolean
  secureStorageMode: () => 'secure' | 'unavailable'
}

export function createCursorTokenStore(
  dependencies: CursorTokenStoreDependencies = {
    getPersisted: secureGet,
    setPersisted: secureSet,
    removePersisted: secureRemove,
    secureStorageMode,
  },
  tokenKey: string = TOKEN_KEY
): CursorTokenStore {
  let memoryToken: string | null = null
  const store: CursorTokenStore = {
    get: () => {
      const raw = memoryToken ?? dependencies.getPersisted(tokenKey)
      if (!raw) return null
      // Existing installations stored a bare key. New expiring keys use one
      // secure-store value so the key and its expiry cannot be torn apart.
      if (!raw.startsWith('{')) return raw
      try {
        const credential: unknown = JSON.parse(raw)
        if (!credential || typeof credential !== 'object') return null
        const { version, apiKey, apiKeyExpiresAtMs } = credential as Record<string, unknown>
        if (
          version !== 1 ||
          typeof apiKey !== 'string' ||
          typeof apiKeyExpiresAtMs !== 'number' ||
          !Number.isFinite(apiKeyExpiresAtMs) ||
          apiKeyExpiresAtMs <= Date.now()
        )
          return null
        return apiKey
      } catch {
        return null
      }
    },
    set: (token, apiKeyExpiresAtMs) => {
      const normalized = token.trim()
      if (!normalized) {
        store.clear()
        return store.mode()
      }
      if (apiKeyExpiresAtMs !== undefined && (!Number.isFinite(apiKeyExpiresAtMs) || apiKeyExpiresAtMs <= Date.now())) {
        throw new Error('Cursor credential has expired')
      }
      const serialized =
        apiKeyExpiresAtMs === undefined
          ? normalized
          : JSON.stringify({ version: 1, apiKey: normalized, apiKeyExpiresAtMs })
      if (dependencies.setPersisted(tokenKey, serialized)) {
        memoryToken = null
        return 'secure'
      }

      if (!dependencies.removePersisted(tokenKey)) {
        throw new Error('Could not remove the previously persisted Cursor credential')
      }
      memoryToken = serialized
      return 'memory'
    },
    clear: () => {
      if (!dependencies.removePersisted(tokenKey)) {
        throw new Error('Could not remove the persisted Cursor credential')
      }
      memoryToken = null
    },
    mode: () => (memoryToken !== null || dependencies.secureStorageMode() !== 'secure' ? 'memory' : 'secure'),
  }
  return store
}

export const defaultCursorTokenStore = createCursorTokenStore()
