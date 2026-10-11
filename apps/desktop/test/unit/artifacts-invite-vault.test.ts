import { describe, expect, it, vi } from 'vitest'
import { INVITE_KEY_PREFIX, InviteVault, type InviteVaultStore } from '../../src/main/artifacts/invite-vault'
import { filterExportableSettings } from '../../src/main/local-data/data-export'

/** A stand-in for the app's secure store: it keeps values only while `available`, like the OS keyring. */
function fakeStore(available: boolean) {
  const values = new Map<string, string>()
  const store: InviteVaultStore = {
    get: vi.fn((key: string) => (available ? (values.get(key) ?? null) : null)),
    set: vi.fn((key: string, value: string) => {
      if (!available) return false
      values.set(key, value)
      return true
    }),
    remove: vi.fn((key: string) => values.delete(key)),
  }
  return { store, values }
}

describe('InviteVault', () => {
  it('keeps invitation tokens in the secure store, under a key of their own', () => {
    const { store, values } = fakeStore(true)
    const vault = new InviteVault(store)
    vault.save('person-1', 'token-1')
    vault.save('person-2', 'token-2')
    expect([...values.keys()]).toEqual(['artifacts.inviteToken.person-1', 'artifacts.inviteToken.person-2'])
    expect(vault.get('person-1')).toBe('token-1')
    // Another vault on the same store sees them: they survive a restart.
    expect(new InviteVault(store).get('person-2')).toBe('token-2')
    expect(vault.get('nobody')).toBeNull()

    vault.save('person-1', 'token-3')
    expect(vault.get('person-1')).toBe('token-3')
  })

  it('keeps tokens only in memory when secure storage is unavailable', () => {
    const { store, values } = fakeStore(false)
    const vault = new InviteVault(store)
    vault.save('person-1', 'token-1')
    expect(values.size).toBe(0)
    expect(vault.get('person-1')).toBe('token-1')
    expect(new InviteVault(store).get('person-1')).toBeNull()
  })

  it('stays out of data exports', () => {
    expect(
      filterExportableSettings([
        { key: `${INVITE_KEY_PREFIX}person-1`, value: 'enc:v1:abc' },
        { key: 'artifacts.ownerName', value: 'Antonio' },
      ])
    ).toEqual({ 'artifacts.ownerName': 'Antonio' })
  })

  it('removes a token from both places', () => {
    const secure = fakeStore(true)
    const vault = new InviteVault(secure.store)
    vault.save('person-1', 'token-1')
    vault.remove('person-1')
    expect(vault.get('person-1')).toBeNull()
    expect(secure.values.size).toBe(0)

    const memory = fakeStore(false)
    const other = new InviteVault(memory.store)
    other.save('person-1', 'token-1')
    other.remove('person-1')
    expect(other.get('person-1')).toBeNull()
    // Nothing was stored, so nothing is written to clear it.
    expect(memory.store.remove).not.toHaveBeenCalled()
  })
})
