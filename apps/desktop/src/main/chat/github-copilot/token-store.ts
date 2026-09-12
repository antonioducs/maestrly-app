import { secureGet, secureRemove, secureSet, secureStorageMode } from '../../secure-store'

const TOKEN_KEY = 'chat.githubCopilot.oauthToken'

/** ACCOUNT secure-store key: the default account keeps the legacy key; additional accounts use suffixes. */
export function githubCopilotTokenKeyFor(accountId: string | null): string {
  return accountId ? `${TOKEN_KEY}.${accountId}` : TOKEN_KEY
}

export type GitHubCopilotTokenStorageMode = 'secure' | 'memory'

export interface GitHubCopilotTokenStore {
  get(): string | null
  set(token: string): GitHubCopilotTokenStorageMode
  clear(): void
  mode(): GitHubCopilotTokenStorageMode
}

export interface GitHubCopilotTokenStoreDependencies {
  getPersisted: (key: string) => string | null
  setPersisted: (key: string, value: string) => boolean
  removePersisted: (key: string) => boolean
  secureStorageMode: () => 'secure' | 'unavailable'
}

/** Token store used only by the main process. The OAuth token is never returned through preload/IPC. */
export function createGitHubCopilotTokenStore(
  dependencies: GitHubCopilotTokenStoreDependencies = {
    getPersisted: secureGet,
    setPersisted: secureSet,
    removePersisted: secureRemove,
    secureStorageMode,
  },
  tokenKey: string = TOKEN_KEY
): GitHubCopilotTokenStore {
  let memoryToken: string | null = null
  const store: GitHubCopilotTokenStore = {
    get: () => memoryToken ?? dependencies.getPersisted(tokenKey),
    set: (token) => {
      const normalized = token.trim()
      if (!normalized) {
        store.clear()
        return store.mode()
      }
      if (dependencies.setPersisted(tokenKey, normalized)) {
        memoryToken = null
        return 'secure'
      }
      // Do not let a previously persisted account resurrect if the keyring becomes available again later.
      if (!dependencies.removePersisted(tokenKey)) {
        throw new Error('Could not remove the previously persisted GitHub Copilot credential')
      }
      memoryToken = normalized
      return 'memory'
    },
    clear: () => {
      if (!dependencies.removePersisted(tokenKey)) {
        throw new Error('Could not remove the persisted GitHub Copilot credential')
      }
      memoryToken = null
    },
    mode: () => (memoryToken !== null || dependencies.secureStorageMode() !== 'secure' ? 'memory' : 'secure'),
  }
  return store
}

export const defaultGitHubCopilotTokenStore = createGitHubCopilotTokenStore()
