import {
  SUBSCRIPTION_ACCOUNT_POOL_KINDS,
  accountPoolBaseProviderId,
  accountPoolKindOf,
  activeAccountProviderId,
  isActiveAccountProviderId,
  subscriptionBaseProviderId,
  type ChatProviderInfo,
  type ChatSubscriptionAccountPool,
  type ChatSubscriptionAccountPoolInfo,
  type ChatSubscriptionAccountPoolKind,
  type ChatSubscriptionAccountPoolPatch,
  type ChatSubscriptionAccountPoolPolicy,
} from '../../../shared/chat'
import { getAppSetting, setAppSetting } from '../../store'
import { autonomousProviderAllowed } from '../autonomous'
import { listAvailableChatProviders } from '../catalog'
import { failoverDiag } from './diag'

export const ACCOUNT_POOLS_CONFIG_KEY = 'chat.subscriptionAccountPools.v1'
const POLICIES: readonly ChatSubscriptionAccountPoolPolicy[] = ['drain', 'prefer-active']

interface SavedAccountPool {
  kind: ChatSubscriptionAccountPoolKind
  policy?: ChatSubscriptionAccountPoolPolicy
  activeProviderId?: string
  /** Absent: every account of the provider, so an account added later joins the rotation. */
  memberProviderIds?: string[]
}

export interface AccountPoolProbe {
  isAdmissible(providerId: string): boolean
  isSignedIn(providerId: string): boolean
  nextProbeAt(providerId: string): number
}

const isPoolKind = (value: unknown): value is ChatSubscriptionAccountPoolKind =>
  (SUBSCRIPTION_ACCOUNT_POOL_KINDS as readonly unknown[]).includes(value)

/** Never throws: corrupt JSON, unknown kinds and malformed fields are dropped. */
export function sanitizeSavedAccountPools(raw: unknown): SavedAccountPool[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return []
  const { version, pools } = raw as { version?: unknown; pools?: unknown }
  if (version !== 1 || !Array.isArray(pools)) return []
  const out: SavedAccountPool[] = []
  for (const item of pools) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const entry = item as Record<string, unknown>
    if (!isPoolKind(entry.kind) || out.some((saved) => saved.kind === entry.kind)) continue
    const saved: SavedAccountPool = { kind: entry.kind }
    if (POLICIES.includes(entry.policy as ChatSubscriptionAccountPoolPolicy))
      saved.policy = entry.policy as ChatSubscriptionAccountPoolPolicy
    if (typeof entry.activeProviderId === 'string' && entry.activeProviderId.trim())
      saved.activeProviderId = entry.activeProviderId.trim()
    if (Array.isArray(entry.memberProviderIds)) {
      const members = [
        ...new Set(
          entry.memberProviderIds
            .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
            .map((id) => id.trim())
        ),
      ]
      if (members.length > 0) saved.memberProviderIds = members
    }
    out.push(saved)
  }
  return out
}

function readSaved(): SavedAccountPool[] {
  const raw = getAppSetting(ACCOUNT_POOLS_CONFIG_KEY)
  if (!raw) return []
  try {
    return sanitizeSavedAccountPools(JSON.parse(raw))
  } catch {
    return []
  }
}

function writeSaved(pools: SavedAccountPool[]): void {
  setAppSetting(ACCOUNT_POOLS_CONFIG_KEY, JSON.stringify({ version: 1, pools }))
}

function saveOne(next: SavedAccountPool): void {
  writeSaved([...readSaved().filter((pool) => pool.kind !== next.kind), next])
}

/** The provider's account slots in catalog order: the default slot first, then added accounts by creation. */
export function accountPoolAccounts(kind: ChatSubscriptionAccountPoolKind): string[] {
  const base = accountPoolBaseProviderId(kind)
  return listAvailableChatProviders()
    .map((provider) => provider.id)
    .filter((id) => subscriptionBaseProviderId(id) === base)
}

/** A saved pool applied to the accounts that exist now. */
export function resolveAccountPool(
  kind: ChatSubscriptionAccountPoolKind,
  saved: SavedAccountPool | undefined,
  accounts: readonly string[]
): ChatSubscriptionAccountPool {
  const explicit = (saved?.memberProviderIds ?? []).filter((id) => accounts.includes(id))
  const memberProviderIds = explicit.length > 0 ? explicit : accounts.length > 0 ? [...accounts] : [accountPoolBaseProviderId(kind)]
  const activeProviderId =
    saved?.activeProviderId && memberProviderIds.includes(saved.activeProviderId)
      ? saved.activeProviderId
      : memberProviderIds[0]!
  return { kind, memberProviderIds, activeProviderId, policy: saved?.policy ?? 'drain', customMembers: explicit.length > 0 }
}

export function getAccountPool(kind: ChatSubscriptionAccountPoolKind): ChatSubscriptionAccountPool {
  return resolveAccountPool(kind, readSaved().find((pool) => pool.kind === kind), accountPoolAccounts(kind))
}

export function setAccountPool(patch: ChatSubscriptionAccountPoolPatch): ChatSubscriptionAccountPool {
  if (!isPoolKind(patch?.kind)) throw new Error('unknown-kind')
  const kind = patch.kind
  const accounts = accountPoolAccounts(kind)
  if (patch.policy !== undefined && !POLICIES.includes(patch.policy)) throw new Error('invalid-policy')
  const next: SavedAccountPool = { ...readSaved().find((pool) => pool.kind === kind), kind }
  if (patch.policy !== undefined) next.policy = patch.policy
  if (patch.memberProviderIds !== undefined) {
    if (!Array.isArray(patch.memberProviderIds)) throw new Error('invalid-members')
    const members = [...new Set(patch.memberProviderIds.map((id) => (typeof id === 'string' ? id.trim() : '')))]
    if (members.length === 0 || members.some((id) => !accounts.includes(id))) throw new Error('invalid-members')
    next.memberProviderIds = members
  }
  if (patch.activeProviderId !== undefined) {
    const active = typeof patch.activeProviderId === 'string' ? patch.activeProviderId.trim() : ''
    if (!resolveAccountPool(kind, next, accounts).memberProviderIds.includes(active)) throw new Error('active-not-member')
    next.activeProviderId = active
  }
  saveOne(next)
  return resolveAccountPool(kind, next, accounts)
}

export function removeAccountFromAccountPools(providerId: string): void {
  const pools = readSaved()
  if (pools.length === 0) return
  writeSaved(
    pools.map((pool) => {
      const next: SavedAccountPool = { ...pool }
      if (next.activeProviderId === providerId) delete next.activeProviderId
      if (next.memberProviderIds) {
        const members = next.memberProviderIds.filter((id) => id !== providerId)
        if (members.length > 0) next.memberProviderIds = members
        else delete next.memberProviderIds
      }
      return next
    })
  )
}

export function rotateToActive(ids: readonly string[], activeProviderId: string): string[] {
  const index = ids.indexOf(activeProviderId)
  return index <= 0 ? [...ids] : [...ids.slice(index), ...ids.slice(0, index)]
}

/** Physical accounts an active-account selection runs on, the active one first; [] for any other id. */
export function accountPoolChain(providerId: string): string[] {
  const kind = isActiveAccountProviderId(providerId) ? accountPoolKindOf(providerId) : null
  if (!kind) return []
  const pool = getAccountPool(kind)
  return rotateToActive(pool.memberProviderIds, pool.activeProviderId).filter((id) => autonomousProviderAllowed(id))
}

/** The physical account a stored selection stands for right now; physical ids pass through. */
export function resolveAccountPoolProviderId(providerId: string): string {
  const kind = isActiveAccountProviderId(providerId) ? accountPoolKindOf(providerId) : null
  if (!kind) return providerId
  return accountPoolChain(providerId)[0] ?? getAccountPool(kind).activeProviderId
}

/**
 * Drain: once the active account runs out, the next signed-in account that can run takes over and keeps it. When
 * none can, the one whose quota returns first does, so the next turn starts where quota comes back soonest.
 */
export function nextActiveAfterExhaustion(
  pool: ChatSubscriptionAccountPool,
  exhaustedProviderId: string,
  probe: AccountPoolProbe
): string | null {
  if (pool.policy !== 'drain' || pool.activeProviderId !== exhaustedProviderId) return null
  const others = rotateToActive(pool.memberProviderIds, exhaustedProviderId)
    .slice(1)
    .filter((id) => probe.isSignedIn(id))
  const ready = others.find((id) => probe.isAdmissible(id))
  if (ready) return ready
  let soonest = exhaustedProviderId
  for (const id of others) if (probe.nextProbeAt(id) < probe.nextProbeAt(soonest)) soonest = id
  return soonest === exhaustedProviderId ? null : soonest
}

export function advanceAccountPoolsAfterExhaustion(
  providerId: string,
  probe: AccountPoolProbe
): { kind: ChatSubscriptionAccountPoolKind; from: string; to: string } | null {
  const kind = accountPoolKindOf(providerId)
  if (!kind || isActiveAccountProviderId(providerId)) return null
  const to = nextActiveAfterExhaustion(getAccountPool(kind), providerId, probe)
  if (!to) return null
  saveOne({ ...readSaved().find((pool) => pool.kind === kind), kind, activeProviderId: to })
  failoverDiag('account-pool-advance', { kind, from: providerId, to })
  return { kind, from: providerId, to }
}

/** Picker entries for providers with two or more accounts. */
export function accountPoolInfos(
  providers: readonly ChatProviderInfo[],
  nameFor: (kind: ChatSubscriptionAccountPoolKind, active: ChatProviderInfo | undefined) => string
): ChatSubscriptionAccountPoolInfo[] {
  return SUBSCRIPTION_ACCOUNT_POOL_KINDS.flatMap((kind) => {
    if (accountPoolAccounts(kind).length < 2) return []
    const pool = getAccountPool(kind)
    const byId = (id: string) => providers.find((provider) => provider.id === id)
    return [{
      ...pool,
      providerId: activeAccountProviderId(kind),
      name: nameFor(kind, byId(pool.activeProviderId)),
      connected: pool.memberProviderIds.some((id) => byId(id)?.connected === true),
    }]
  })
}
