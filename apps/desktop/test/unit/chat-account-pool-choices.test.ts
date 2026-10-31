import { describe, expect, it } from 'vitest'
import {
  activeAccountProviderId,
  type ChatProviderInfo,
  type ChatSubscriptionAccountPoolInfo,
  type ChatSubscriptionAccountPoolKind,
} from '../../src/shared/chat'
import {
  accountPoolCandidates,
  accountPoolFor,
  accountPoolProviderInfo,
  addAccountPoolMember,
  chatProviderChoices,
  makeAccountActive,
  moveAccountPoolMember,
  removeAccountPoolMember,
  withAccountPoolPolicy,
} from '../../src/renderer/components/chat/account-pool'
import { subagentProfileProviders } from '../../src/renderer/lib/subagent-profile-editor'

const provider = (
  id: string,
  kind: ChatProviderInfo['kind'],
  extra: Partial<ChatProviderInfo> = {}
): ChatProviderInfo => ({
  id,
  name: id,
  baseURL: '',
  apiKeyPresent: false,
  builtIn: true,
  connected: true,
  kind,
  ...extra,
})

const pool = (
  kind: ChatSubscriptionAccountPoolKind,
  extra: Partial<ChatSubscriptionAccountPoolInfo> = {}
): ChatSubscriptionAccountPoolInfo => ({
  kind,
  providerId: activeAccountProviderId(kind),
  name: 'Claude (active account)',
  connected: true,
  memberProviderIds: ['builtin_claude_subscription@a', 'builtin_claude_subscription@b'],
  activeProviderId: 'builtin_claude_subscription@a',
  policy: 'drain',
  customMembers: false,
  ...extra,
})

const providers: ChatProviderInfo[] = [
  provider('openai', 'openai', { builtIn: false, apiKeyPresent: true }),
  provider('builtin_claude_subscription@a', 'claude-subscription', { accountId: 'a', accountLabel: 'Work' }),
  provider('builtin_codex_subscription', 'codex-subscription'),
  provider('builtin_claude_subscription@b', 'claude-subscription', { accountId: 'b', accountLabel: 'Home' }),
  provider('builtin_claude_subscription@c', 'claude-subscription', {
    accountId: 'c',
    accountLabel: ' ',
    connected: false,
  }),
]

const ids = (list: readonly ChatProviderInfo[]) => list.map((entry) => entry.id)

describe('chat provider choices', () => {
  it('returns the physical providers unchanged when no pool exists', () => {
    expect(chatProviderChoices({ providers })).toBe(providers)
    expect(chatProviderChoices({ providers, subscriptionAccountPools: [] })).toBe(providers)
  })

  it('places each virtual pool entry before the first physical account of its provider', () => {
    const choices = chatProviderChoices({ providers, subscriptionAccountPools: [pool('claude-subscription')] })

    expect(ids(choices)).toEqual([
      'openai',
      'builtin_claude_subscription@~active',
      'builtin_claude_subscription@a',
      'builtin_codex_subscription',
      'builtin_claude_subscription@b',
      'builtin_claude_subscription@c',
    ])
    expect(choices.filter((entry) => !entry.accountPool)).toEqual(providers)
  })

  it('injects one entry for every pool and leaves the config untouched', () => {
    const codex = pool('codex-subscription', {
      name: 'Codex (active account)',
      memberProviderIds: ['builtin_codex_subscription', 'builtin_codex_subscription@x'],
      activeProviderId: 'builtin_codex_subscription',
    })
    const snapshot = structuredClone(providers)
    const choices = chatProviderChoices({ providers, subscriptionAccountPools: [pool('claude-subscription'), codex] })

    expect(ids(choices.filter((entry) => entry.accountPool))).toEqual([
      'builtin_claude_subscription@~active',
      'builtin_codex_subscription@~active',
    ])
    expect(ids(choices).indexOf('builtin_codex_subscription@~active')).toBe(
      ids(choices).indexOf('builtin_codex_subscription') - 1
    )
    expect(providers).toEqual(snapshot)
  })

  it('offers a new subagent candidate the active account ahead of the accounts it rotates over', () => {
    const claude = providers.filter((entry) => entry.kind === 'claude-subscription')
    const eligible = subagentProfileProviders(
      chatProviderChoices({ providers: claude, subscriptionAccountPools: [pool('claude-subscription')] })
    )
    expect(eligible[0]?.id).toBe('builtin_claude_subscription@~active')
  })

  it('skips a pool whose provider has no physical account', () => {
    const choices = chatProviderChoices({
      providers: [providers[0]],
      subscriptionAccountPools: [pool('claude-subscription')],
    })
    expect(ids(choices)).toEqual(['openai'])
  })

  it('describes the virtual entry like a built-in subscription provider', () => {
    expect(accountPoolProviderInfo(pool('claude-subscription', { connected: false }))).toEqual({
      id: 'builtin_claude_subscription@~active',
      name: 'Claude (active account)',
      baseURL: '',
      apiKeyPresent: false,
      builtIn: true,
      connected: false,
      kind: 'claude-subscription',
      accountPool: true,
    })
  })

  it('finds the pool of a provider family', () => {
    const claude = pool('claude-subscription')
    const config = { subscriptionAccountPools: [claude] }
    expect(accountPoolFor(config, 'claude-subscription')).toBe(claude)
    expect(accountPoolFor(config, 'codex-subscription')).toBeNull()
    expect(accountPoolFor({}, 'claude-subscription')).toBeNull()
  })
})

describe('account pool candidates', () => {
  it('offers only physical accounts of the same family that are not members', () => {
    const claude = pool('claude-subscription', { memberProviderIds: ['builtin_claude_subscription@a'] })
    const choices = chatProviderChoices({ providers, subscriptionAccountPools: [claude] })

    expect(accountPoolCandidates(claude, choices, 'Default account')).toEqual([
      { providerId: 'builtin_claude_subscription@b', label: 'Home', connected: true },
      { providerId: 'builtin_claude_subscription@c', label: 'c', connected: false },
    ])
  })

  it('names the account without a label by the default label and falls back to apiKeyPresent', () => {
    const codex = pool('codex-subscription', { memberProviderIds: [] })
    const list = [
      provider('builtin_codex_subscription', 'codex-subscription', { connected: undefined, apiKeyPresent: true }),
    ]
    expect(accountPoolCandidates(codex, list, 'Default account')).toEqual([
      { providerId: 'builtin_codex_subscription', label: 'Default account', connected: true },
    ])
  })

  it('offers nothing once every account is a member', () => {
    const claude = pool('claude-subscription', {
      memberProviderIds: [
        'builtin_claude_subscription@a',
        'builtin_claude_subscription@b',
        'builtin_claude_subscription@c',
      ],
    })
    expect(accountPoolCandidates(claude, providers, 'Default account')).toEqual([])
  })
})

describe('account pool patches', () => {
  const a = 'builtin_claude_subscription@a'
  const b = 'builtin_claude_subscription@b'
  const c = 'builtin_claude_subscription@c'
  const base = pool('claude-subscription')
  const three = pool('claude-subscription', { memberProviderIds: [a, b, c] })

  it('switches the active account of a member without touching the members', () => {
    expect(makeAccountActive(base, b)).toEqual({ kind: 'claude-subscription', activeProviderId: b })
  })

  it('adds a non-member to the pool when it becomes active', () => {
    expect(makeAccountActive(base, c)).toEqual({
      kind: 'claude-subscription',
      memberProviderIds: [a, b, c],
      activeProviderId: c,
    })
  })

  it('changes the policy and appends members', () => {
    expect(withAccountPoolPolicy(base, 'prefer-active')).toEqual({
      kind: 'claude-subscription',
      policy: 'prefer-active',
    })
    expect(addAccountPoolMember(base, c)).toEqual({ kind: 'claude-subscription', memberProviderIds: [a, b, c] })
    expect(base.memberProviderIds).toEqual([a, b])
  })

  it('removes a member and moves the pointer when the active account leaves', () => {
    expect(removeAccountPoolMember(three, a)).toEqual({
      kind: 'claude-subscription',
      memberProviderIds: [b, c],
      activeProviderId: b,
    })
    expect(removeAccountPoolMember(three, c)).toEqual({ kind: 'claude-subscription', memberProviderIds: [a, b] })
  })

  it('keeps the last member and ignores accounts outside the pool', () => {
    const single = pool('claude-subscription', { memberProviderIds: [a] })
    expect(removeAccountPoolMember(single, a)).toBeNull()
    expect(removeAccountPoolMember(base, c)).toBeNull()
  })

  it('moves a member by one place and refuses to pass the edges', () => {
    expect(moveAccountPoolMember(three, 1, -1)).toEqual({ kind: 'claude-subscription', memberProviderIds: [b, a, c] })
    expect(moveAccountPoolMember(three, 1, 1)?.memberProviderIds).toEqual([a, c, b])
    expect(three.memberProviderIds).toEqual([a, b, c])
    expect(moveAccountPoolMember(three, 0, -1)).toBeNull()
    expect(moveAccountPoolMember(three, 2, 1)).toBeNull()
    expect(moveAccountPoolMember(three, -1, 1)).toBeNull()
    expect(moveAccountPoolMember(three, 3, -1)).toBeNull()
  })
})
