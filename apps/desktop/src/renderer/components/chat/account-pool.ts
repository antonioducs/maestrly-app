import {
  SUBSCRIPTION_ACCOUNT_POOL_KINDS,
  accountPoolKindOf,
  isChatProviderConnected,
  isSubscriptionFailoverProviderId,
  type ChatConfig,
  type ChatProviderInfo,
  type ChatSubscriptionAccountPool,
  type ChatSubscriptionAccountPoolInfo,
  type ChatSubscriptionAccountPoolKind,
  type ChatSubscriptionAccountPoolPatch,
  type ChatSubscriptionAccountPoolPolicy,
} from '../../../shared/chat'
import { labelForSubscriptionProvider, type FailoverRouteCandidate } from './subscription-failover-route'

type PoolConfig = Pick<ChatConfig, 'providers' | 'subscriptionAccountPools'>

/** The renderer-side entry that stands for a pool's active account in a model selection. */
export function accountPoolProviderInfo(pool: ChatSubscriptionAccountPoolInfo): ChatProviderInfo {
  return {
    id: pool.providerId,
    name: pool.name,
    baseURL: '',
    apiKeyPresent: false,
    builtIn: true,
    connected: pool.connected,
    kind: pool.kind,
    accountPool: true,
  }
}

/**
 * Providers a model selection may pick from: the physical ones plus one active-account entry per pool, placed just
 * before the first account of its provider. Account management keeps using `config.providers`, where the entry
 * never exists.
 */
export function chatProviderChoices(config: PoolConfig): ChatProviderInfo[] {
  const pools = config.subscriptionAccountPools
  if (!pools?.length) return config.providers
  const placed = new Set<string>()
  const choices: ChatProviderInfo[] = []
  for (const provider of config.providers) {
    const pool = provider.kind ? pools.find((candidate) => candidate.kind === provider.kind) : undefined
    if (pool && !placed.has(pool.kind)) {
      placed.add(pool.kind)
      choices.push(accountPoolProviderInfo(pool))
    }
    choices.push(provider)
  }
  return choices
}

export function accountPoolFor(
  config: Pick<ChatConfig, 'subscriptionAccountPools'>,
  kind: string
): ChatSubscriptionAccountPoolInfo | null {
  return config.subscriptionAccountPools?.find((pool) => pool.kind === kind) ?? null
}

/** Accounts of the pool's provider that could join it. */
export function accountPoolCandidates(
  pool: ChatSubscriptionAccountPool,
  providers: readonly ChatProviderInfo[],
  defaultLabel: string
): FailoverRouteCandidate[] {
  const members = new Set(pool.memberProviderIds)
  const candidates: FailoverRouteCandidate[] = []
  for (const provider of providers) {
    if (!isSubscriptionFailoverProviderId(provider.id)) continue
    if (accountPoolKindOf(provider.id) !== pool.kind) continue
    if (members.has(provider.id)) continue
    candidates.push({
      providerId: provider.id,
      label: labelForSubscriptionProvider(provider.id, providers, defaultLabel),
      connected: isChatProviderConnected(provider),
    })
  }
  return candidates
}

/** Makes an account the active one, adding it to the pool first when it is not a member yet. */
export function makeAccountActive(
  pool: ChatSubscriptionAccountPool,
  providerId: string
): ChatSubscriptionAccountPoolPatch {
  if (pool.memberProviderIds.includes(providerId)) return { kind: pool.kind, activeProviderId: providerId }
  return {
    kind: pool.kind,
    memberProviderIds: [...pool.memberProviderIds, providerId],
    activeProviderId: providerId,
  }
}

export function withAccountPoolEnabled(
  pool: ChatSubscriptionAccountPool,
  enabled: boolean
): ChatSubscriptionAccountPoolPatch {
  return { kind: pool.kind, enabled }
}

export function withAccountPoolAutoJoin(
  pool: ChatSubscriptionAccountPool,
  autoJoin: boolean
): ChatSubscriptionAccountPoolPatch {
  return { kind: pool.kind, autoJoin }
}

export function withAccountPoolPolicy(
  pool: ChatSubscriptionAccountPool,
  policy: ChatSubscriptionAccountPoolPolicy
): ChatSubscriptionAccountPoolPatch {
  return { kind: pool.kind, policy }
}

export function addAccountPoolMember(
  pool: ChatSubscriptionAccountPool,
  providerId: string
): ChatSubscriptionAccountPoolPatch {
  return { kind: pool.kind, memberProviderIds: [...pool.memberProviderIds, providerId] }
}

/** Null when the account is not a member or is the last one: a pool never ends up empty. */
export function removeAccountPoolMember(
  pool: ChatSubscriptionAccountPool,
  providerId: string
): ChatSubscriptionAccountPoolPatch | null {
  if (!pool.memberProviderIds.includes(providerId) || pool.memberProviderIds.length <= 1) return null
  const remaining = pool.memberProviderIds.filter((id) => id !== providerId)
  return {
    kind: pool.kind,
    memberProviderIds: remaining,
    ...(pool.activeProviderId === providerId ? { activeProviderId: remaining[0] } : {}),
  }
}

/** Null when the move would pass either edge of the rotation order. */
export function moveAccountPoolMember(
  pool: ChatSubscriptionAccountPool,
  index: number,
  delta: -1 | 1
): ChatSubscriptionAccountPoolPatch | null {
  const target = index + delta
  const size = pool.memberProviderIds.length
  if (index < 0 || index >= size || target < 0 || target >= size) return null
  const members = [...pool.memberProviderIds]
  ;[members[index], members[target]] = [members[target], members[index]]
  return { kind: pool.kind, memberProviderIds: members }
}

const ACCOUNT_POOL_KEY_PREFIX = 'account-pool:'

/** The Accounts settings list a provider's rotation as an entry of its own, under this key. */
export function accountPoolEntryKey(kind: string): string {
  return ACCOUNT_POOL_KEY_PREFIX + kind
}

export function accountPoolKindOfEntryKey(key: string | null | undefined): ChatSubscriptionAccountPoolKind | null {
  if (!key?.startsWith(ACCOUNT_POOL_KEY_PREFIX)) return null
  const kind = key.slice(ACCOUNT_POOL_KEY_PREFIX.length)
  return (SUBSCRIPTION_ACCOUNT_POOL_KINDS as readonly string[]).includes(kind)
    ? (kind as ChatSubscriptionAccountPoolKind)
    : null
}

/** The account a turn starts on now; pools from hosts that predate it start on the active one. */
export function accountPoolCurrent(pool: ChatSubscriptionAccountPoolInfo): string {
  return pool.currentProviderId ?? pool.activeProviderId
}

/** The account the rotation moves to after the current one, skipping the ones that cannot run; null when none can. */
export function accountPoolNext(
  pool: ChatSubscriptionAccountPoolInfo,
  canRun: (providerId: string) => boolean
): string | null {
  if (!pool.enabled) return null
  const members = pool.memberProviderIds
  const index = members.indexOf(accountPoolCurrent(pool))
  const rotated = index < 0 ? members : [...members.slice(index + 1), ...members.slice(0, index)]
  return rotated.find((id) => id !== accountPoolCurrent(pool) && canRun(id)) ?? null
}
