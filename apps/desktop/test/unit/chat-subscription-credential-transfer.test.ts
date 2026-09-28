import { RuntimeConnection } from '@github/copilot-sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  GitHubCopilotSubscriptionManager,
  type GitHubCopilotRuntimeClient,
} from '../../src/main/chat/github-copilot/manager'
import { createGitHubCopilotTokenStore } from '../../src/main/chat/github-copilot/token-store'
import { CursorSubscriptionManager, type CursorSubscriptionSdk } from '../../src/main/chat/cursor-subscription/manager'
import { createCursorTokenStore } from '../../src/main/chat/cursor-subscription/token-store'

describe('subscription credential transfer', () => {
  const persisted = new Map<string, string>()
  const storage = {
    getPersisted: (key: string) => persisted.get(key) ?? null,
    setPersisted: (key: string, value: string) => {
      persisted.set(key, value)
      return true
    },
    removePersisted: (key: string) => {
      persisted.delete(key)
      return true
    },
    secureStorageMode: () => 'secure' as const,
  }
  let copilot: GitHubCopilotSubscriptionManager
  let cursor: CursorSubscriptionManager
  let cursorStore: ReturnType<typeof createCursorTokenStore>
  const loadSdk = vi.fn()
  const createClient = vi.fn()
  beforeEach(() => {
    vi.restoreAllMocks()
    persisted.clear()
    loadSdk.mockReset()
    createClient.mockReset()
    const tokenStore = createGitHubCopilotTokenStore(storage)
    copilot = new GitHubCopilotSubscriptionManager({
      tokenStore,
      getOAuthClientId: () => 'fixture-client',
      resolveRuntimePath: async () => '/fixture/copilot',
      resolveConnection: () => RuntimeConnection.forStdio({ path: '/fixture/copilot' }),
      acquireRuntimeLease: async () => null,
      ensureDirectory: async () => undefined,
      getUserDataPath: () => '/tmp/maestrly-transfer-fixture',
      createClient: createClient.mockImplementation(
        () =>
          ({
            start: async () => undefined,
            stop: async () => [],
            getAuthStatus: async () => ({ isAuthenticated: tokenStore.get() === 'gho_good' }),
          }) as unknown as GitHubCopilotRuntimeClient
      ),
    })
    cursorStore = createCursorTokenStore(storage)
    loadSdk.mockResolvedValue({
      Cursor: { me: async () => ({ apiKeyName: 'fixture', createdAt: '2026-01-01T00:00:00Z' }) },
    } as unknown as CursorSubscriptionSdk)
    cursor = new CursorSubscriptionManager({ tokenStore: cursorStore, loadSdk })
  })
  afterEach(async () => {
    await copilot.dispose()
    await cursor.dispose()
    vi.useRealTimers()
  })

  it.each(['copilot', 'cursor'] as const)(
    'refuses memory-only %s admission when secure storage is required',
    async (kind) => {
      vi.spyOn(storage, 'setPersisted').mockReturnValue(false)
      const admission =
        kind === 'copilot'
          ? copilot.admitToken('gho_good', { requireSecure: true })
          : cursor.admitApiKey('key_1', { requireSecure: true })
      await expect(admission).rejects.toThrow('Secure credential storage is unavailable.')
      expect(copilot.exportToken()).toBeNull()
      expect(cursor.exportCredential()).toBeNull()
      expect(persisted.size).toBe(0)
    }
  )

  it.each(['copilot', 'cursor'] as const)(
    'restores the previous %s credential after a required secure write fails',
    async (kind) => {
      const expiresAtMs = Date.now() + 86_400_000
      if (kind === 'copilot') await copilot.admitToken('gho_good')
      else await cursor.admitApiKey('previous_key', { expiresAtMs })
      const before = new Map(persisted)
      vi.spyOn(storage, 'setPersisted').mockReturnValueOnce(false)
      await expect(
        kind === 'copilot'
          ? copilot.admitToken('replacement', { requireSecure: true })
          : cursor.admitApiKey('replacement', { requireSecure: true })
      ).rejects.toThrow('Secure credential storage is unavailable.')
      expect(persisted).toEqual(before)
      if (kind === 'copilot') expect(copilot.exportToken()).toBe('gho_good')
      else expect(cursor.exportCredential()).toEqual({ apiKey: 'previous_key', expiresAtMs })
    }
  )
  it.each(['copilot', 'cursor'] as const)('retains optional memory-only %s admission', async (kind) => {
    vi.spyOn(storage, 'setPersisted').mockReturnValue(false)
    if (kind === 'copilot') {
      await copilot.admitToken('gho_good')
      expect(copilot.exportToken()).toBe('gho_good')
    } else {
      await cursor.admitApiKey('key_1')
      expect(cursor.exportCredential()?.apiKey).toBe('key_1')
    }
  })
  it('admits and exports an accepted Copilot token', async () => {
    await expect(copilot.admitToken('gho_good')).resolves.toMatchObject({ authenticated: true })
    expect(copilot.exportToken()).toBe('gho_good')
  })
  it('clears a refused Copilot token and restores identity', async () => {
    await expect(copilot.admitToken('gho_bad')).rejects.toThrow('did not accept')
    expect(copilot.exportToken()).toBeNull()
    expect(copilot.getAccountIdentity().fingerprint).toBeNull()
  })
  it('restores the previous Copilot credential after rejection', async () => {
    await copilot.admitToken('gho_good')
    const identity = copilot.getAccountIdentity()
    await expect(copilot.admitToken('gho_bad')).rejects.toThrow('did not accept')
    expect(copilot.exportToken()).toBe('gho_good')
    expect(copilot.getAccountIdentity().fingerprint).toBe(identity.fingerprint)
    await expect(copilot.getStatus()).resolves.toMatchObject({ authenticated: true })
  })
  it('admits Cursor credentials with their expiry', async () => {
    const expiresAtMs = Date.now() + 86_400_000
    await cursor.admitApiKey('key_1', { expiresAtMs })
    expect(cursor.exportCredential()).toEqual({ apiKey: 'key_1', expiresAtMs })
    expect(cursorStore.getCredential()).toEqual({ apiKey: 'key_1', expiresAtMs })
  })
  it('rejects an expired Cursor credential', async () => {
    await expect(cursor.admitApiKey('key_2', { expiresAtMs: Date.now() - 1 })).rejects.toThrow('expired')
    expect(cursorStore.get()).toBeNull()
  })
  it('exports a legacy Cursor key without expiry', async () => {
    cursorStore.set('legacy_key')
    expect(cursor.exportCredential()).toEqual({ apiKey: 'legacy_key', expiresAtMs: null })
  })
  it('does not export a Cursor key after expiry', async () => {
    vi.useFakeTimers()
    const expiresAtMs = Date.now() + 1000
    cursorStore.set('expiring_key', expiresAtMs)
    vi.advanceTimersByTime(1001)
    expect(cursor.exportCredential()).toBeNull()
    expect(cursorStore.get()).toBeNull()
  })
  it('peeks at Copilot status without starting a runtime', async () => {
    expect(copilot.peekStatus()).toBeNull()
    expect(createClient).not.toHaveBeenCalled()
    const status = await copilot.getStatus()
    expect(copilot.peekStatus()).toBe(status)
  })
  it('peeks at Cursor status without loading its SDK', async () => {
    expect(cursor.peekStatus()).toBeNull()
    expect(loadSdk).not.toHaveBeenCalled()
    const status = await cursor.getStatus()
    expect(cursor.peekStatus()).toBe(status)
  })
})
