import { secureGet, secureRemove, secureSet, secureStorageMode } from '../secure-store'

export interface PlatformCredential {
  clientId?: string
  accessToken: string
  refreshToken?: string
  expiresAt: number
  userId?: string
  email?: string
}

export class PlatformCredentialStore {
  private readonly memory = new Map<string, PlatformCredential>()
  get(connectionId: string): PlatformCredential | null {
    const memory = this.memory.get(connectionId)
    if (memory) return memory
    const stored = secureGet(`platform.credential.${connectionId}`)
    if (!stored) return null
    try {
      return JSON.parse(stored) as PlatformCredential
    } catch {
      return null
    }
  }

  set(connectionId: string, credential: PlatformCredential): 'secure' | 'memory' {
    if (secureSet(`platform.credential.${connectionId}`, JSON.stringify(credential))) {
      this.memory.delete(connectionId)
      return 'secure'
    }
    this.memory.set(connectionId, credential)
    return 'memory'
  }

  remove(connectionId: string): void {
    this.memory.delete(connectionId)
    secureRemove(`platform.credential.${connectionId}`)
  }

  mode(): 'secure' | 'unavailable' {
    return secureStorageMode()
  }
}
