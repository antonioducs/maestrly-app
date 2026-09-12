import { secureGet, secureRemove, secureSet, secureStorageMode } from '../../secure-store'

const TOKEN_KEY = 'chat.grok.oauthTokens'

/** Secure-store key for an account slot: default keeps the legacy key; extra accounts are suffixed. */
export function grokTokenKeyFor(accountId: string | null): string {
  return accountId ? `${TOKEN_KEY}.${accountId}` : TOKEN_KEY
}

export interface GrokTokenBundle {
  accessToken: string
  refreshToken: string
  expiresAt: number
  idToken?: string
  scope?: string
  /**
   * Opaque session identifier created at LOGIN and preserved across refreshes. Provides account identity when
   * id_token lacks `sub`; rotating tokens NEVER contribute to identity.
   */
  sessionId?: string
}

export type GrokTokenStorageMode = 'secure' | 'memory'

export interface GrokTokenStore {
  get(): GrokTokenBundle | null
  set(bundle: GrokTokenBundle): GrokTokenStorageMode
  clear(): void
  mode(): GrokTokenStorageMode
}

export interface GrokTokenStoreDependencies {
  getPersisted: (key: string) => string | null
  setPersisted: (key: string, value: string) => boolean
  removePersisted: (key: string) => boolean
  secureStorageMode: () => 'secure' | 'unavailable'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/** Parse and validate a persisted token bundle. Invalid payloads are treated as absent. */
export function parseGrokTokenBundle(raw: string | null | undefined): GrokTokenBundle | null {
  if (!raw?.trim()) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed)) return null
    const accessToken = nonEmptyString(parsed.accessToken)
    const refreshToken = nonEmptyString(parsed.refreshToken)
    const expiresAt = Number(parsed.expiresAt)
    if (!accessToken || !refreshToken || !Number.isFinite(expiresAt)) return null
    const idToken = nonEmptyString(parsed.idToken) ?? undefined
    const scope = nonEmptyString(parsed.scope) ?? undefined
    const sessionId = nonEmptyString(parsed.sessionId) ?? undefined
    return {
      accessToken,
      refreshToken,
      expiresAt,
      ...(idToken ? { idToken } : {}),
      ...(scope ? { scope } : {}),
      ...(sessionId ? { sessionId } : {}),
    }
  } catch {
    return null
  }
}

function serializeBundle(bundle: GrokTokenBundle): string {
  return JSON.stringify({
    accessToken: bundle.accessToken.trim(),
    refreshToken: bundle.refreshToken.trim(),
    expiresAt: bundle.expiresAt,
    ...(bundle.idToken?.trim() ? { idToken: bundle.idToken.trim() } : {}),
    ...(bundle.scope?.trim() ? { scope: bundle.scope.trim() } : {}),
    ...(bundle.sessionId?.trim() ? { sessionId: bundle.sessionId.trim() } : {}),
  })
}

/**
 * Token store used only by the main process. The OAuth bundle never crosses preload/IPC.
 * Writes are atomic at the app_settings row level (single JSON blob per account key).
 */
export function createGrokTokenStore(
  dependencies: GrokTokenStoreDependencies = {
    getPersisted: secureGet,
    setPersisted: secureSet,
    removePersisted: secureRemove,
    secureStorageMode,
  },
  tokenKey: string = TOKEN_KEY
): GrokTokenStore {
  let memoryBundle: GrokTokenBundle | null = null
  const store: GrokTokenStore = {
    get: () => memoryBundle ?? parseGrokTokenBundle(dependencies.getPersisted(tokenKey)),
    set: (bundle) => {
      const accessToken = bundle.accessToken.trim()
      const refreshToken = bundle.refreshToken.trim()
      if (!accessToken || !refreshToken || !Number.isFinite(bundle.expiresAt)) {
        store.clear()
        return store.mode()
      }
      const normalized: GrokTokenBundle = {
        accessToken,
        refreshToken,
        expiresAt: bundle.expiresAt,
        ...(bundle.idToken?.trim() ? { idToken: bundle.idToken.trim() } : {}),
        ...(bundle.scope?.trim() ? { scope: bundle.scope.trim() } : {}),
        ...(bundle.sessionId?.trim() ? { sessionId: bundle.sessionId.trim() } : {}),
      }
      const serialized = serializeBundle(normalized)
      if (dependencies.setPersisted(tokenKey, serialized)) {
        memoryBundle = null
        return 'secure'
      }
      // Do not let a previously persisted account resurrect if the keyring becomes available again later.
      if (!dependencies.removePersisted(tokenKey)) {
        throw new Error('Could not remove the previously persisted Grok credential')
      }
      memoryBundle = normalized
      return 'memory'
    },
    clear: () => {
      if (!dependencies.removePersisted(tokenKey)) {
        throw new Error('Could not remove the persisted Grok credential')
      }
      memoryBundle = null
    },
    mode: () => (memoryBundle !== null || dependencies.secureStorageMode() !== 'secure' ? 'memory' : 'secure'),
  }
  return store
}

export const defaultGrokTokenStore = createGrokTokenStore()
