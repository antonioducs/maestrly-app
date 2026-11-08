import {
  CHAT_SUBSCRIPTION_PROVIDER_KINDS,
  isChatProviderKeyRejected,
  isChatSubscriptionProviderKind,
} from '../../../../shared/chat'
import type {
  ChatConfig,
  ChatProviderInfo,
  ChatSubscriptionAuthStatus,
  ChatSubscriptionProviderKind,
  ChatSubscriptionUsage,
} from '../../../../shared/chat'
import type { RuntimeAssetInfo } from '../../../../shared/runtime-assets'
import { subscriptionUsageTone } from '../subscription-usage-presentation'

export interface SubscriptionAccountEntry {
  type: 'subscription'
  /** The slot's provider id: `builtin_*` for the default account, `builtin_*@acc_*` for the others. */
  key: string
  providerKind: ChatSubscriptionProviderKind
  /** Absent when an older host does not list this provider yet. */
  provider?: ChatProviderInfo
  accountId: string | null
  accountLabel?: string
}

export interface ApiKeyAccountEntry {
  type: 'api-key'
  key: string
  provider: ChatProviderInfo
}

export type AccountEntry = SubscriptionAccountEntry | ApiKeyAccountEntry

export type AccountGroupId = ChatSubscriptionProviderKind | 'api-keys'

export interface AccountGroup {
  id: AccountGroupId
  entries: AccountEntry[]
}

export function defaultSubscriptionProviderId(kind: ChatSubscriptionProviderKind): string {
  return `builtin_${kind.replaceAll('-', '_')}`
}

/** Every account slot in display order: subscriptions by provider, then API keys. */
export function accountGroups(config: Pick<ChatConfig, 'providers'>): AccountGroup[] {
  const groups: AccountGroup[] = []
  for (const kind of CHAT_SUBSCRIPTION_PROVIDER_KINDS) {
    const providers = config.providers.filter((provider) => provider.kind === kind)
    const base = providers.find((provider) => !provider.accountId)
    groups.push({
      id: kind,
      entries: [
        {
          type: 'subscription',
          key: base?.id ?? defaultSubscriptionProviderId(kind),
          providerKind: kind,
          provider: base,
          accountId: null,
          accountLabel: base?.accountLabel,
        },
        ...providers
          .filter((provider) => provider.accountId)
          .map(
            (provider): SubscriptionAccountEntry => ({
              type: 'subscription',
              key: provider.id,
              providerKind: kind,
              provider,
              accountId: provider.accountId ?? null,
              accountLabel: provider.accountLabel,
            })
          ),
      ],
    })
  }
  groups.push({
    id: 'api-keys',
    entries: config.providers
      .filter((provider) => !isChatSubscriptionProviderKind(provider.kind))
      .map((provider): ApiKeyAccountEntry => ({ type: 'api-key', key: provider.id, provider })),
  })
  return groups
}

export interface SubscriptionAccountSnapshot {
  status: ChatSubscriptionAuthStatus | null
  usage: ChatSubscriptionUsage | null
  runtime: RuntimeAssetInfo | null
}

export type AccountSnapshot = SubscriptionAccountSnapshot

/**
 * ok: usable. pending: loading or waiting for sign-in. attention: the user has something to fix.
 * error: the provider reported a failure. idle: not connected, and nothing is expected of the user.
 */
export type AccountHealth = 'ok' | 'pending' | 'attention' | 'error' | 'idle'

export interface AccountSummary {
  health: AccountHealth
  connected: boolean
  /** Highest used percentage across the reported usage windows. */
  peakUsage: number | null
  nearLimit: boolean
  limitReached: boolean
}

const NO_USAGE = { peakUsage: null, nearLimit: false, limitReached: false } as const

export function needsAttention(summary: AccountSummary): boolean {
  return summary.health === 'attention' || summary.health === 'error'
}

export function runtimeMissing(runtime: RuntimeAssetInfo | null | undefined): boolean {
  return !!runtime && runtime.status.state !== 'ready' && runtime.provided?.active !== true
}

/** Plan codes the providers report (Codex `planType`, Claude `subscriptionType`) that have a readable name. */
const KNOWN_SUBSCRIPTION_PLANS = new Set([
  'free',
  'go',
  'plus',
  'pro',
  'prolite',
  'max',
  'team',
  'business',
  'self_serve_business_usage_based',
  'enterprise',
  'enterprise_cbp_usage_based',
  'edu',
])

/** Readable plan name; codes without one show as reported, and an unknown plan shows nothing. */
export function subscriptionPlanLabel(planType: string | null | undefined, t: (key: string) => string): string | null {
  const reported = planType?.trim()
  if (!reported) return null
  const code = reported.toLowerCase()
  if (code === 'unknown') return null
  return KNOWN_SUBSCRIPTION_PLANS.has(code) ? t(`settings.subscriptionPlan_${code}`) : reported
}

export function subscriptionAccountSummary(
  entry: SubscriptionAccountEntry,
  snapshot: SubscriptionAccountSnapshot | undefined
): AccountSummary {
  // Until the slot reports its status, the catalog's connected flag keeps the list stable.
  const state = snapshot?.status?.state ?? (entry.provider?.connected ? 'signed-in' : null)
  if (state === 'signed-in') {
    const windows = snapshot?.usage?.state === 'ready' ? snapshot.usage.windows : []
    const peakUsage = windows.length > 0 ? Math.max(...windows.map((window) => window.usedPercent)) : null
    return {
      health: entry.provider ? 'ok' : 'attention',
      connected: true,
      peakUsage,
      nearLimit: peakUsage !== null && subscriptionUsageTone(peakUsage) !== 'normal',
      limitReached: peakUsage !== null && peakUsage >= 100,
    }
  }
  if (state === 'signing-in') return { health: 'pending', connected: false, ...NO_USAGE }
  if (state === 'error') return { health: 'error', connected: false, ...NO_USAGE }
  // Signed in, but the runtime it needs is missing or too old: it keeps its row and asks for the fix.
  if (state === 'unavailable' && snapshot?.status?.savedSignIn) {
    return { health: 'attention', connected: false, ...NO_USAGE }
  }
  if (state === null) return { health: 'idle', connected: false, ...NO_USAGE }
  // An added account that is signed out is skipped by rotation; the default slot simply is not in use.
  return { health: entry.accountId ? 'attention' : 'idle', connected: false, ...NO_USAGE }
}

export function apiKeyAccountSummary(entry: ApiKeyAccountEntry): AccountSummary {
  const keyed = entry.provider.connected ?? entry.provider.apiKeyPresent
  // A key the provider refused is saved but unusable: it needs a new key, so it does not count as connected.
  if (keyed && isChatProviderKeyRejected(entry.provider)) return { health: 'error', connected: false, ...NO_USAGE }
  return { health: keyed ? 'ok' : 'attention', connected: keyed, ...NO_USAGE }
}

export function accountSummary(entry: AccountEntry, snapshot: AccountSnapshot | undefined): AccountSummary {
  if (entry.type === 'subscription') return subscriptionAccountSummary(entry, snapshot)
  return apiKeyAccountSummary(entry)
}

/**
 * Whether the slot gets a row, rather than a chip under "Available to connect": everything the user added or is using,
 * and an unused default slot only when it sits next to added accounts or is the one being looked at.
 */
export function isAccountListed(
  entry: AccountEntry,
  summary: AccountSummary,
  context: { selected: boolean; group: AccountGroup }
): boolean {
  if (context.selected || entry.type === 'api-key') return true
  if (entry.accountId) return true
  return summary.health !== 'idle' || context.group.entries.length > 1
}

/** Providers offered under "Available to connect": none of their slots has a row. API keys have no provider to offer. */
export function connectableGroups(
  groups: readonly AccountGroup[],
  listed: (entry: AccountEntry, group: AccountGroup) => boolean
): AccountGroup[] {
  return groups.filter(
    (group) =>
      group.id !== 'api-keys' && group.entries.length > 0 && group.entries.every((entry) => !listed(entry, group))
  )
}

export type AccountFilter = 'all' | 'attention' | 'near-limit'

export function matchesAccountFilter(
  summary: AccountSummary,
  filter: AccountFilter,
  searchText: string,
  query: string
): boolean {
  if (filter === 'attention' && !needsAttention(summary)) return false
  if (filter === 'near-limit' && !summary.nearLimit) return false
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const haystack = searchText.toLowerCase()
  return terms.every((term) => haystack.includes(term))
}

export function baseUrlHost(baseURL: string): string {
  try {
    return new URL(baseURL).host || baseURL
  } catch {
    return baseURL
  }
}
