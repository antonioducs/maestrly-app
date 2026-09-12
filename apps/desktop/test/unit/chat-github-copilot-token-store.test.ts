import { safeStorage } from 'electron'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createGitHubCopilotTokenStore,
  defaultGitHubCopilotTokenStore,
} from '../../src/main/chat/github-copilot/token-store'
import { getAppSetting } from '../../src/main/store'
import { closeDb, freshDb } from '../helpers/db'

const setEncryptionAvailable = (available: boolean): void =>
  (
    safeStorage as unknown as {
      __setEncryptionAvailable(value: boolean): void
    }
  ).__setEncryptionAvailable(available)

describe('GitHub Copilot token store', () => {
  beforeEach(() => {
    freshDb()
    setEncryptionAvailable(true)
    defaultGitHubCopilotTokenStore.clear()
  })

  afterEach(() => {
    defaultGitHubCopilotTokenStore.clear()
    setEncryptionAvailable(true)
    closeDb()
  })

  it('encrypts OAuth tokens through secure storage', () => {
    expect(defaultGitHubCopilotTokenStore.set('gho_super_secret')).toBe('secure')

    expect(defaultGitHubCopilotTokenStore.get()).toBe('gho_super_secret')
    const raw = getAppSetting('chat.githubCopilot.oauthToken')
    expect(raw).toMatch(/^enc:v1:/)
    expect(raw).not.toContain('gho_super_secret')
  })

  it('keeps tokens in memory without keyrings', () => {
    expect(defaultGitHubCopilotTokenStore.set('gho_previous_persisted')).toBe('secure')
    setEncryptionAvailable(false)

    expect(defaultGitHubCopilotTokenStore.set('gho_memory_only')).toBe('memory')
    expect(defaultGitHubCopilotTokenStore.get()).toBe('gho_memory_only')
    expect(getAppSetting('chat.githubCopilot.oauthToken')).not.toContain('gho_memory_only')

    setEncryptionAvailable(true)
    expect(defaultGitHubCopilotTokenStore.get()).toBe('gho_memory_only')
    expect(getAppSetting('chat.githubCopilot.oauthToken')).toBe('')

    defaultGitHubCopilotTokenStore.clear()
    expect(defaultGitHubCopilotTokenStore.get()).toBeNull()
  })

  it('preserves identity when persistent removal fails', () => {
    const store = createGitHubCopilotTokenStore({
      getPersisted: () => 'gho_old_account',
      setPersisted: () => false,
      removePersisted: () => false,
      secureStorageMode: () => 'unavailable',
    })

    expect(() => store.set('gho_new_account')).toThrow('previously persisted GitHub Copilot credential')
    expect(store.get()).toBe('gho_old_account')
    expect(() => store.clear()).toThrow('persisted GitHub Copilot credential')
    expect(store.get()).toBe('gho_old_account')
  })
})
