import { secureGet, secureRemove, secureSet } from '../secure-store'

/** Where tokens are kept at rest. `set` returns false when nothing could be stored securely. */
export interface InviteVaultStore {
  get(key: string): string | null
  set(key: string, value: string): boolean
  remove(key: string): unknown
}

const KEY_PREFIX = 'artifacts.invite.'
const secureStore: InviteVaultStore = { get: secureGet, set: secureSet, remove: secureRemove }

/**
 * The tokens of personal links, so the owner can copy a link again. The artifact host keeps only their digests. Here
 * they are encrypted with the operating-system keyring; without it they live in memory until the app quits, and the
 * link can then only be reset.
 */
export class InviteVault {
  private readonly memory = new Map<string, string>()

  constructor(private readonly store: InviteVaultStore = secureStore) {}

  save(principalId: string, token: string): void {
    if (this.store.set(KEY_PREFIX + principalId, token)) this.memory.delete(principalId)
    else this.memory.set(principalId, token)
  }

  get(principalId: string): string | null {
    return this.memory.get(principalId) ?? this.store.get(KEY_PREFIX + principalId)
  }

  remove(principalId: string): void {
    this.memory.delete(principalId)
    if (this.store.get(KEY_PREFIX + principalId) !== null) this.store.remove(KEY_PREFIX + principalId)
  }
}
