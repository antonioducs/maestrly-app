import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  beginClaudeAttempt,
  listClaudeAttempts,
  setClaudeAttemptOwner,
} from '../../src/main/chat/subscription-failover/claude-attempts'

const input = {
  providerId: 'claude',
  accountIdentity: { fingerprint: 'account', epoch: 1 },
  scope: 'helper' as const,
  abort: vi.fn(),
}
afterEach(() => setClaudeAttemptOwner(null))

describe('Claude attempt ownership', () => {
  it('tracks root, subagent and helper attempts until explicitly released', async () => {
    const releaseOwner = vi.fn()
    const owner = vi.fn(() => releaseOwner)
    setClaudeAttemptOwner(owner)
    const leases = (['root', 'subagent', 'helper'] as const).map((scope) => beginClaudeAttempt({ ...input, scope }))
    expect(listClaudeAttempts().map((attempt) => attempt.scope)).toEqual(['root', 'subagent', 'helper'])
    const done = vi.fn()
    void leases[0].done.then(done)
    listClaudeAttempts()[0].abort('rotate')
    await Promise.resolve()
    expect(done).not.toHaveBeenCalled()
    setClaudeAttemptOwner(null)
    for (const lease of leases) {
      lease.release()
      lease.release()
    }
    await Promise.all(leases.map((lease) => lease.done))
    expect(releaseOwner).toHaveBeenCalledTimes(3)
    expect(listClaudeAttempts()).toEqual([])
  })

  it('settles the registry and done even if owner cleanup throws', async () => {
    const releaseOwner = vi.fn(() => {
      throw new Error('cleanup')
    })
    setClaudeAttemptOwner(() => releaseOwner)
    const lease = beginClaudeAttempt(input)
    expect(lease.release).toThrow('cleanup')
    lease.release()
    await lease.done
    expect(releaseOwner).toHaveBeenCalledTimes(1)
    expect(listClaudeAttempts()).toEqual([])
  })

  it('cleans up when owner registration fails', () => {
    setClaudeAttemptOwner(() => {
      throw new Error('register')
    })
    expect(() => beginClaudeAttempt(input)).toThrow('register')
    expect(listClaudeAttempts()).toEqual([])
  })
})
