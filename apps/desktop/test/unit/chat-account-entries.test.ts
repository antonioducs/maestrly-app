import { describe, expect, it } from 'vitest'
import {
  accountGroups,
  apiKeyAccountSummary,
  type AccountSummary,
  chatGptWebPhase,
  chatGptWebSummary,
  type ChatGptWebAccountSnapshot,
  connectableGroups,
  hasActiveRotation,
  isAccountListed,
  matchesAccountFilter,
  needsAttention,
  type SubscriptionAccountEntry,
  subscriptionAccountSummary,
  subscriptionPlanLabel,
} from '../../src/renderer/components/chat/accounts/account-entries'
import type { ChatGptWebStatus, ChatProviderInfo, ChatSubscriptionUsage } from '../../src/shared/chat'
import enChat from '../../src/shared/i18n/en/chat'
import ptBrChat from '../../src/shared/i18n/pt-BR/chat'

function provider(overrides: Partial<ChatProviderInfo> & Pick<ChatProviderInfo, 'id'>): ChatProviderInfo {
  return { name: overrides.id, baseURL: 'test://provider', apiKeyPresent: false, ...overrides }
}

const codexDefault = provider({ id: 'builtin_codex_subscription', kind: 'codex-subscription', connected: true })
const codexWork = provider({
  id: 'builtin_codex_subscription@acc_work',
  kind: 'codex-subscription',
  accountId: 'acc_work',
  accountLabel: 'Work',
})
const claudeDefault = provider({ id: 'builtin_claude_subscription', kind: 'claude-subscription' })
const openRouter = provider({ id: 'p_openrouter', name: 'OpenRouter', kind: 'openai', apiKeyPresent: true })

function usage(...percents: number[]): ChatSubscriptionUsage {
  return {
    state: 'ready',
    providerKind: 'codex-subscription',
    accountId: null,
    fetchedAt: 0,
    windows: percents.map((usedPercent, index) => ({
      id: `w${index}`,
      kind: 'other',
      usedPercent,
      resetsAt: null,
      durationMins: null,
    })),
  }
}

function webStatus(overrides: Partial<ChatGptWebStatus & { enabled: boolean }> = {}): ChatGptWebAccountSnapshot {
  return {
    tunnelReady: true,
    status: {
      enabled: true,
      binaryAvailable: true,
      configured: true,
      tunnelId: 'tun_1',
      apiKeyPresent: true,
      appName: 'Maestrly Bridge',
      tunnelState: 'ready',
      probeActive: false,
      appRefreshRequired: false,
      sessions: [],
      ...overrides,
    },
  }
}

const subscriptionEntry = (entry: ChatProviderInfo): SubscriptionAccountEntry => ({
  type: 'subscription',
  key: entry.id,
  providerKind: 'codex-subscription',
  provider: entry,
  accountId: entry.accountId ?? null,
  accountLabel: entry.accountLabel,
})

describe('account entries', () => {
  it('orders subscriptions by provider, puts ChatGPT Web after ChatGPT and API keys last', () => {
    const groups = accountGroups({ providers: [openRouter, codexWork, codexDefault, claudeDefault] })
    expect(groups.map((group) => group.id)).toEqual([
      'codex-subscription',
      'chatgpt-web',
      'github-copilot-subscription',
      'claude-subscription',
      'grok-subscription',
      'cursor-subscription',
      'antigravity-subscription',
      'api-keys',
    ])
    expect(groups[0].entries.map((entry) => entry.key)).toEqual([codexDefault.id, codexWork.id])
    expect(groups.at(-1)?.entries.map((entry) => entry.key)).toEqual([openRouter.id])
    // A host that does not list a provider still gets its default slot, under the canonical id.
    expect(groups[2].entries).toEqual([
      expect.objectContaining({ key: 'builtin_github_copilot_subscription', provider: undefined, accountId: null }),
    ])
  })

  it('summarizes subscription health, connection and usage', () => {
    const work = subscriptionEntry(codexWork)
    const base = subscriptionEntry(codexDefault)
    const signedIn = { state: 'signed-in', authenticated: true } as const

    expect(subscriptionAccountSummary(base, { status: signedIn, usage: usage(40, 85), runtime: null })).toEqual({
      health: 'ok',
      connected: true,
      peakUsage: 85,
      nearLimit: true,
      limitReached: false,
    })
    expect(subscriptionAccountSummary(base, { status: signedIn, usage: usage(100), runtime: null })).toMatchObject({
      nearLimit: true,
      limitReached: true,
    })
    // The catalog's connected flag stands in until the slot reports its status.
    expect(subscriptionAccountSummary(base, undefined)).toMatchObject({ health: 'ok', connected: true })
    const signedOut = { status: { state: 'signed-out', authenticated: false } as const, usage: null, runtime: null }
    expect(subscriptionAccountSummary(work, signedOut).health).toBe('attention')
    expect(subscriptionAccountSummary({ ...base, provider: claudeDefault }, signedOut).health).toBe('idle')
    expect(
      subscriptionAccountSummary(work, {
        status: { state: 'error', authenticated: false, error: 'x' },
        usage: null,
        runtime: null,
      }).health
    ).toBe('error')
  })

  it('lists added and active accounts and leaves unused providers as chips', () => {
    const groups = accountGroups({ providers: [codexDefault, claudeDefault, codexWork] })
    const claudeGroup = groups.find((group) => group.id === 'claude-subscription')!
    const codexGroup = groups.find((group) => group.id === 'codex-subscription')!
    const idle: AccountSummary = {
      health: 'idle',
      connected: false,
      peakUsage: null,
      nearLimit: false,
      limitReached: false,
    }
    const context = { selected: false, chatGptWebEnabled: false }

    expect(isAccountListed(claudeGroup.entries[0], idle, { ...context, group: claudeGroup })).toBe(false)
    expect(isAccountListed(claudeGroup.entries[0], idle, { ...context, group: claudeGroup, selected: true })).toBe(true)
    // An unused default slot stays next to the added accounts of the same provider.
    expect(isAccountListed(codexGroup.entries[0], idle, { ...context, group: codexGroup })).toBe(true)
    const web = groups.find((group) => group.id === 'chatgpt-web')!
    expect(isAccountListed(web.entries[0], idle, { ...context, group: web })).toBe(false)
    expect(isAccountListed(web.entries[0], idle, { ...context, group: web, chatGptWebEnabled: true })).toBe(true)
  })

  it('flags an API-key account whose key the provider refused and stops counting it as connected', () => {
    const entry = (overrides: Partial<ChatProviderInfo>) => ({
      type: 'api-key' as const,
      key: openRouter.id,
      provider: { ...openRouter, connected: true, ...overrides },
    })
    const rejected = apiKeyAccountSummary(
      entry({ keyCheck: { outcome: 'rejected', status: 401, detail: 'Incorrect API key provided', checkedAt: 1 } })
    )
    expect(rejected).toMatchObject({ health: 'error', connected: false })
    expect(needsAttention(rejected)).toBe(true)
    // Not being able to check says nothing about the key: it stays connected.
    expect(apiKeyAccountSummary(entry({ keyCheck: { outcome: 'unverified', checkedAt: 1 } }))).toMatchObject({
      health: 'ok',
      connected: true,
    })
    expect(apiKeyAccountSummary(entry({ keyCheck: { outcome: 'accepted', checkedAt: 1 } }))).toMatchObject({
      health: 'ok',
      connected: true,
    })
    expect(apiKeyAccountSummary(entry({}))).toMatchObject({ health: 'ok', connected: true })
    expect(apiKeyAccountSummary(entry({ connected: false, apiKeyPresent: false }))).toMatchObject({
      health: 'attention',
      connected: false,
    })
  })

  it('keeps a signed-in Claude account listed as needing attention while Claude Code is missing or too old', () => {
    const groups = accountGroups({ providers: [codexDefault, claudeDefault] })
    const claudeGroup = groups.find((group) => group.id === 'claude-subscription')!
    const entry = claudeGroup.entries[0] as SubscriptionAccountEntry
    const context = { selected: false, chatGptWebEnabled: false, group: claudeGroup }
    const unavailable = (errorCode: 'claude-code-not-installed' | 'claude-code-incompatible', saved: boolean) =>
      subscriptionAccountSummary(entry, {
        status: {
          state: 'unavailable',
          authenticated: false,
          errorCode,
          ...(saved ? { savedSignIn: true, email: 'owner@example.com' } : {}),
        },
        usage: null,
        runtime: null,
      })

    for (const errorCode of ['claude-code-not-installed', 'claude-code-incompatible'] as const) {
      const kept = unavailable(errorCode, true)
      expect(kept).toMatchObject({ health: 'attention', connected: false })
      expect(needsAttention(kept)).toBe(true)
      expect(isAccountListed(entry, kept, context)).toBe(true)
    }
    const kept = unavailable('claude-code-not-installed', true)
    const offered = connectableGroups(
      groups,
      (candidate, group) => group === claudeGroup && isAccountListed(candidate, kept, context)
    )
    expect(offered.map((group) => group.id)).not.toContain('claude-subscription')

    // Never signed in: nothing to fix on this slot, so Claude stays offered under "Available to connect".
    const never = unavailable('claude-code-not-installed', false)
    expect(never).toMatchObject({ health: 'idle', connected: false })
    expect(isAccountListed(entry, never, context)).toBe(false)
  })

  it('offers only unused providers to connect, never the API keys group', () => {
    const groups = accountGroups({ providers: [codexDefault, codexWork] })
    expect(groups.find((group) => group.id === 'api-keys')?.entries).toEqual([])
    const offered = connectableGroups(groups, (entry) => entry.key.startsWith('builtin_codex'))
    expect(offered.map((group) => group.id)).toEqual([
      'chatgpt-web',
      'github-copilot-subscription',
      'claude-subscription',
      'grok-subscription',
      'cursor-subscription',
      'antigravity-subscription',
    ])
    expect(offered.every((group) => group.entries.length > 0)).toBe(true)
  })

  it('reports the next ChatGPT Web setup step', () => {
    expect(chatGptWebPhase(undefined)).toBe('loading')
    expect(chatGptWebPhase(webStatus({ enabled: false }))).toBe('off')
    expect(chatGptWebPhase({ ...webStatus(), tunnelReady: false })).toBe('component')
    expect(chatGptWebPhase(webStatus({ apiKeyPresent: false }))).toBe('key')
    expect(chatGptWebPhase(webStatus({ tunnelId: null }))).toBe('tunnel')
    expect(chatGptWebPhase(webStatus({ tunnelState: 'error' }))).toBe('error')
    expect(chatGptWebPhase(webStatus({ appRefreshRequired: true }))).toBe('refresh')
    expect(chatGptWebPhase(webStatus())).toBe('ready')
    const session = {
      state: 'live' as const,
      pairingRequired: false,
      conversationId: 'c1',
      cwd: '/repo',
      startedAt: 0,
      lastActivityAt: null,
      toolCalls: 0,
      deliveries: 0,
    }
    expect(chatGptWebPhase(webStatus({ sessions: [session] }))).toBe('sessions')
    expect(chatGptWebPhase(webStatus({ sessions: [{ ...session, state: 'ended' }] }))).toBe('ready')

    expect(needsAttention(chatGptWebSummary(webStatus({ tunnelId: null })))).toBe(true)
    expect(needsAttention(chatGptWebSummary(webStatus({ enabled: false })))).toBe(false)
    expect(chatGptWebSummary(webStatus()).connected).toBe(true)
  })

  it('filters by attention, usage and every search term', () => {
    const summary: AccountSummary = {
      health: 'attention',
      connected: false,
      peakUsage: 92,
      nearLimit: true,
      limitReached: false,
    }
    expect(matchesAccountFilter(summary, 'attention', 'Work ChatGPT', '')).toBe(true)
    expect(matchesAccountFilter({ ...summary, health: 'ok' }, 'attention', 'Work ChatGPT', '')).toBe(false)
    expect(matchesAccountFilter({ ...summary, nearLimit: false }, 'near-limit', 'Work', '')).toBe(false)
    expect(matchesAccountFilter(summary, 'all', 'Work · antonio@acme.example ChatGPT', 'acme chatgpt')).toBe(true)
    expect(matchesAccountFilter(summary, 'all', 'Work ChatGPT', 'work claude')).toBe(false)
  })

  it('marks only primaries whose rotation is on and has fallbacks', () => {
    const routes = [
      { primaryProviderId: 'a', enabled: true, fallbackProviderIds: ['b'] },
      { primaryProviderId: 'c', enabled: true, fallbackProviderIds: [] },
      { primaryProviderId: 'd', enabled: false, fallbackProviderIds: ['a'] },
    ]
    expect(hasActiveRotation(routes, 'a')).toBe(true)
    expect(hasActiveRotation(routes, 'c')).toBe(false)
    expect(hasActiveRotation(routes, 'd')).toBe(false)
    expect(hasActiveRotation(routes, 'b')).toBe(false)
  })

  it('names the plans providers report and shows unknown codes as reported', () => {
    const catalog = (settings: Record<string, unknown>) => (key: string) => {
      const value = settings[key.replace(/^settings\./, '')]
      if (typeof value !== 'string') throw new Error(`Missing ${key}`)
      return value
    }
    const en = catalog(enChat.settings)
    expect(subscriptionPlanLabel('prolite', en)).toBe('Pro Lite')
    expect(subscriptionPlanLabel('plus', en)).toBe('Plus')
    expect(subscriptionPlanLabel('self_serve_business_usage_based', en)).toBe('Business (usage-based)')
    // Claude reports its subscription type the same way.
    expect(subscriptionPlanLabel('max', en)).toBe('Max')
    expect(subscriptionPlanLabel('PRO', en)).toBe('Pro')
    expect(subscriptionPlanLabel('free', catalog(ptBrChat.settings))).toBe('Gratuito')
    expect(subscriptionPlanLabel('SuperGrok Heavy', en)).toBe('SuperGrok Heavy')
    for (const missing of ['unknown', '  ', null, undefined]) expect(subscriptionPlanLabel(missing, en)).toBeNull()
    const labels = Object.entries(enChat.settings).filter(([key]) => key.startsWith('subscriptionPlan_'))
    expect(labels.length).toBeGreaterThan(0)
    for (const [key, label] of labels)
      expect(subscriptionPlanLabel(key.slice('subscriptionPlan_'.length), en)).toBe(label)
  })
})
