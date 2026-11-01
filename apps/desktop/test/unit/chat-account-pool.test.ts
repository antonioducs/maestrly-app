import { beforeEach, describe, expect, it, vi } from 'vitest'

const settings = new Map<string, string>()
vi.mock('../../src/main/store', () => ({
  getAppSetting: (key: string) => settings.get(key) ?? null,
  setAppSetting: (key: string, value: string) => void settings.set(key, value),
}))
let providers: Array<{ id: string; connected?: boolean; accountLabel?: string }> = []
vi.mock('../../src/main/chat/catalog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/chat/catalog')>()
  return { ...actual, listAvailableChatProviders: () => providers as never }
})
const blocked = new Set<string>()
vi.mock('../../src/main/chat/autonomous', () => ({ autonomousProviderAllowed: (id: string) => !blocked.has(id) }))

const pool = await import('../../src/main/chat/subscription-failover/account-pool')
const A = 'builtin_claude_subscription'
const B = `${A}@acc_work`
const C = `${A}@acc_side`
const VIRTUAL = `${A}@~active`
const CODEX = 'builtin_codex_subscription'
const probe = (
  over: Partial<import('../../src/main/chat/subscription-failover/account-pool').AccountPoolProbe> = {}
) => ({
  isAdmissible: () => true,
  isSignedIn: () => true,
  nextProbeAt: () => 0,
  ...over,
})

beforeEach(() => {
  settings.clear()
  blocked.clear()
  providers = [{ id: A }, { id: B }, { id: CODEX }]
})

describe('account pool config', () => {
  it('defaults to every account of the provider, the default slot active, draining', () => {
    expect(pool.getAccountPool('claude-subscription')).toEqual({
      kind: 'claude-subscription',
      memberProviderIds: [A, B],
      activeProviderId: A,
      policy: 'drain',
      customMembers: false,
      enabled: true,
      autoJoin: true,
    })
  })
  it('keeps an implicit pool open to accounts added later', () => {
    pool.setAccountPool({ kind: 'claude-subscription', activeProviderId: B })
    providers = [...providers, { id: C }]
    expect(pool.getAccountPool('claude-subscription')).toMatchObject({
      memberProviderIds: [A, B, C],
      activeProviderId: B,
    })
  })
  it('keeps an account taken out of the rotation out while others join', () => {
    providers = [{ id: A }, { id: B }, { id: C }]
    pool.setAccountPool({ kind: 'claude-subscription', memberProviderIds: [A, C] })
    const D = `${A}@acc_new`
    providers = [...providers, { id: D }]
    expect(pool.getAccountPool('claude-subscription')).toMatchObject({ memberProviderIds: [A, C, D], autoJoin: true })
    pool.setAccountPool({ kind: 'claude-subscription', autoJoin: false })
    pool.setAccountPool({ kind: 'claude-subscription', autoJoin: true })
    const E = `${A}@acc_later`
    providers = [...providers, { id: E }]
    expect(pool.getAccountPool('claude-subscription').memberProviderIds).toEqual([A, C, D, E])
    pool.setAccountPool({ kind: 'claude-subscription', memberProviderIds: [A, C, D, E, B] })
    expect(pool.getAccountPool('claude-subscription').memberProviderIds).toEqual([A, C, D, E, B])
  })
  it('pins the members when accounts stop joining on their own', () => {
    pool.setAccountPool({ kind: 'claude-subscription', autoJoin: false })
    providers = [...providers, { id: C }]
    expect(pool.getAccountPool('claude-subscription')).toMatchObject({ memberProviderIds: [A, B], autoJoin: false })
  })
  it('records a switch made by hand, newest first', () => {
    pool.setAccountPool({ kind: 'claude-subscription', activeProviderId: B })
    pool.setAccountPool({ kind: 'claude-subscription', activeProviderId: B })
    pool.setAccountPool({ kind: 'claude-subscription', activeProviderId: A })
    expect(pool.accountPoolSwitches('claude-subscription')).toEqual([
      expect.objectContaining({ fromProviderId: B, toProviderId: A, reason: 'manual' }),
      expect.objectContaining({ fromProviderId: A, toProviderId: B, reason: 'manual' }),
    ])
    expect(pool.accountPoolSwitches('codex-subscription')).toEqual([])
  })
  it('rejects invalid patches', () => {
    expect(() => pool.setAccountPool({ kind: 'cursor-subscription' } as never)).toThrow('unknown-kind')
    expect(() => pool.setAccountPool({ kind: 'claude-subscription', memberProviderIds: [] })).toThrow('invalid-members')
    expect(() => pool.setAccountPool({ kind: 'claude-subscription', memberProviderIds: [CODEX] })).toThrow(
      'invalid-members'
    )
    expect(() =>
      pool.setAccountPool({ kind: 'claude-subscription', memberProviderIds: [B], activeProviderId: A })
    ).toThrow('active-not-member')
    expect(() => pool.setAccountPool({ kind: 'claude-subscription', policy: 'sometimes' as never })).toThrow(
      'invalid-policy'
    )
    expect(() => pool.setAccountPool({ kind: 'claude-subscription', enabled: 'yes' as never })).toThrow(
      'invalid-enabled'
    )
    expect(() => pool.setAccountPool({ kind: 'claude-subscription', autoJoin: 1 as never })).toThrow('invalid-auto-join')
  })
  it('drops removed accounts and falls back to the first member', () => {
    pool.setAccountPool({ kind: 'claude-subscription', memberProviderIds: [B, A], activeProviderId: B })
    providers = [{ id: A }]
    expect(pool.getAccountPool('claude-subscription')).toMatchObject({ memberProviderIds: [A], activeProviderId: A })
  })
  it('sanitizes corrupt saved pools', () => {
    expect(pool.sanitizeSavedAccountPools(null)).toEqual([])
    expect(pool.sanitizeSavedAccountPools({ version: 2, pools: [] })).toEqual([])
    expect(
      pool.sanitizeSavedAccountPools({
        version: 1,
        pools: [
          { kind: 'claude-subscription', policy: 'x', activeProviderId: 3, memberProviderIds: [B, B, '', 4] },
          { kind: 'claude-subscription', policy: 'drain' },
          { kind: 'grok-subscription' },
        ],
      })
    ).toEqual([{ kind: 'claude-subscription', memberProviderIds: [B] }])
  })
  it('removes a deleted account from the saved pool and its pointer', () => {
    pool.setAccountPool({ kind: 'claude-subscription', memberProviderIds: [A, B], activeProviderId: B })
    pool.removeAccountFromAccountPools(B)
    expect(JSON.parse(settings.get(pool.ACCOUNT_POOLS_CONFIG_KEY)!)).toEqual({
      version: 1,
      pools: [{ kind: 'claude-subscription', memberProviderIds: [A], autoJoin: true }],
    })
  })
})

describe('account pool chain', () => {
  it('rotates to the active account and resolves the virtual id to it', () => {
    providers = [{ id: A }, { id: B }, { id: C }]
    pool.setAccountPool({ kind: 'claude-subscription', activeProviderId: B })
    expect(pool.rotateToActive([A, B, C], C)).toEqual([C, A, B])
    expect(pool.accountPoolChain(VIRTUAL)).toEqual([B, C, A])
    expect(pool.resolveAccountPoolProviderId(VIRTUAL)).toBe(B)
    expect(pool.resolveAccountPoolProviderId(C)).toBe(C)
    expect(pool.accountPoolChain(C)).toEqual([])
    blocked.add(B)
    expect(pool.accountPoolChain(VIRTUAL)).toEqual([C, A])
    expect(pool.resolveAccountPoolProviderId(VIRTUAL)).toBe(C)
  })
  it('runs on the active account alone while the rotation is off', () => {
    providers = [{ id: A }, { id: B }, { id: C }]
    pool.setAccountPool({ kind: 'claude-subscription', activeProviderId: B, enabled: false })
    expect(pool.accountPoolChain(VIRTUAL)).toEqual([B])
    expect(pool.isAccountPoolMember(B)).toBe(false)
    expect(pool.accountPoolSuccessors(B)).toEqual([])
    expect(pool.advanceAccountPoolsAfterExhaustion(B, probe())).toBeNull()
  })
  it('starts where quota is left under prefer-active, and on the active account under drain', () => {
    providers = [{ id: A }, { id: B }, { id: C }]
    const resolved = pool.getAccountPool('claude-subscription')
    const limited = (id: string) => id === A || id === B
    expect(pool.currentAccountPoolMember(resolved, limited)).toBe(A)
    expect(pool.currentAccountPoolMember({ ...resolved, policy: 'prefer-active' }, limited)).toBe(C)
    expect(pool.currentAccountPoolMember({ ...resolved, policy: 'prefer-active' }, () => true)).toBe(A)
  })
})

describe('drain pointer', () => {
  const resolved = (over = {}) => ({ ...pool.getAccountPool('claude-subscription'), ...over })
  it('moves to the next signed-in admissible account', () => {
    providers = [{ id: A }, { id: B }, { id: C }]
    expect(pool.nextActiveAfterExhaustion(resolved(), A, probe({ isSignedIn: (id) => id !== B }))).toBe(C)
  })
  it('picks the account that recovers first when none is admissible', () => {
    providers = [{ id: A }, { id: B }, { id: C }]
    const at: Record<string, number> = { [A]: 500, [B]: 300, [C]: 100 }
    expect(
      pool.nextActiveAfterExhaustion(resolved(), A, probe({ isAdmissible: () => false, nextProbeAt: (id) => at[id]! }))
    ).toBe(C)
    expect(
      pool.nextActiveAfterExhaustion(
        resolved(),
        A,
        probe({ isAdmissible: () => false, nextProbeAt: (id) => (id === A ? 1 : 9) })
      )
    ).toBeNull()
  })
  it('stays put under prefer-active, for another account, or alone', () => {
    expect(pool.nextActiveAfterExhaustion(resolved({ policy: 'prefer-active' }), A, probe())).toBeNull()
    expect(pool.nextActiveAfterExhaustion(resolved(), B, probe())).toBeNull()
    expect(pool.nextActiveAfterExhaustion(resolved({ memberProviderIds: [A] }), A, probe())).toBeNull()
  })
  it('persists only the pointer, keeping the implicit membership', () => {
    expect(pool.advanceAccountPoolsAfterExhaustion(A, probe())).toEqual({ kind: 'claude-subscription', from: A, to: B })
    expect(JSON.parse(settings.get(pool.ACCOUNT_POOLS_CONFIG_KEY)!)).toEqual({
      version: 1,
      pools: [{ kind: 'claude-subscription', activeProviderId: B }],
    })
    expect(pool.advanceAccountPoolsAfterExhaustion(VIRTUAL, probe())).toBeNull()
    expect(pool.accountPoolSwitches('claude-subscription')).toEqual([
      expect.objectContaining({ fromProviderId: A, toProviderId: B, reason: 'exhausted' }),
    ])
  })
})

describe('account pool infos', () => {
  it('lists providers with two or more accounts, named after the active account', () => {
    const infos = pool.accountPoolInfos(
      [
        { id: A, name: 'Claude', baseURL: '', apiKeyPresent: false, connected: false },
        { id: B, name: 'Claude — Work', baseURL: '', apiKeyPresent: false, connected: true, accountLabel: 'Work' },
        { id: CODEX, name: 'Codex', baseURL: '', apiKeyPresent: false, connected: true },
      ],
      (kind, active) => `${kind}:${active?.accountLabel ?? 'default'}`
    )
    expect(infos).toEqual([
      expect.objectContaining({
        kind: 'claude-subscription',
        providerId: VIRTUAL,
        name: 'claude-subscription:default',
        connected: true,
      }),
    ])
  })
})
