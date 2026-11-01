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
  type ChatSubscriptionAccountPoolSwitch,
  type ChatSubscriptionAccountPoolSwitchReason,
} from '../../../shared/chat'
import { getAppSetting, setAppSetting } from '../../store'
import { autonomousProviderAllowed } from '../autonomous'
import { listAvailableChatProviders } from '../catalog'
import { failoverDiag } from './diag'
import { getSubscriptionFailoverRouter } from './router'

export const ACCOUNT_POOLS_CONFIG_KEY = 'chat.subscriptionAccountPools.v1'
export const ACCOUNT_POOL_SWITCHES_KEY = 'chat.subscriptionAccountPoolSwitches.v1'
const POLICIES: readonly ChatSubscriptionAccountPoolPolicy[] = ['drain', 'prefer-active']
const SWITCH_REASONS: readonly ChatSubscriptionAccountPoolSwitchReason[] = ['exhausted', 'manual']
/** Switches kept per provider; the settings show the most recent ones. */
const SWITCHES_KEPT = 20
const SWITCHES_SHOWN = 10

export interface SavedAccountPool {
  kind: ChatSubscriptionAccountPoolKind
  policy?: ChatSubscriptionAccountPoolPolicy
  activeProviderId?: string
  /** Absent: every account of the provider, so an account added later joins the rotation. */
  memberProviderIds?: string[]
  /** Accounts taken out of the rotation, which an account joining on its own must not bring back. */
  excludedProviderIds?: string[]
  /** Absent: on. */
  enabled?: boolean
  /** Absent: on unless the pool has its own member list, which pools saved before this setting never extended. */
  autoJoin?: boolean
}

export interface AccountPoolProbe {
  isAdmissible(providerId: string): boolean
  isSignedIn(providerId: string): boolean
  nextProbeAt(providerId: string): number
}

/** What the settings show about each member's quota: when an account out of quota is tried again (epoch ms). */
export interface AccountPoolHealth {
  limitedUntil(providerId: string): number | null
}

/** Pool members out of quota, as the failover router knows them: when each comes back. */
export function routerAccountPoolHealth(): AccountPoolHealth {
  const router = getSubscriptionFailoverRouter()
  return {
    limitedUntil: (providerId) => {
      const health = router.getHealth(providerId)
      if (health.state !== 'exhausted' || !health.exhaustion) return null
      const until = health.exhaustion.resetsAt ?? health.exhaustion.nextProbeAt
      return until > Date.now() ? until : null
    },
  }
}

const isPoolKind = (value: unknown): value is ChatSubscriptionAccountPoolKind =>
  (SUBSCRIPTION_ACCOUNT_POOL_KINDS as readonly unknown[]).includes(value)

function idList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const ids = [
    ...new Set(
      value.filter((id): id is string => typeof id === 'string' && id.trim().length > 0).map((id) => id.trim())
    ),
  ]
  return ids.length > 0 ? ids : undefined
}

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
    const members = idList(entry.memberProviderIds)
    if (members) saved.memberProviderIds = members
    const excluded = idList(entry.excludedProviderIds)
    if (excluded) saved.excludedProviderIds = excluded
    if (typeof entry.enabled === 'boolean') saved.enabled = entry.enabled
    if (typeof entry.autoJoin === 'boolean') saved.autoJoin = entry.autoJoin
    out.push(saved)
  }
  return out
}

export function readSavedAccountPools(): SavedAccountPool[] {
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

export function saveAccountPool(next: SavedAccountPool): void {
  writeSaved([...readSavedAccountPools().filter((pool) => pool.kind !== next.kind), next])
}

interface SavedSwitch extends ChatSubscriptionAccountPoolSwitch {
  kind: ChatSubscriptionAccountPoolKind
}

function readSwitches(): SavedSwitch[] {
  const raw = getAppSetting(ACCOUNT_POOL_SWITCHES_KEY)
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as { version?: unknown; switches?: unknown }
    if (parsed?.version !== 1 || !Array.isArray(parsed.switches)) return []
    return parsed.switches.filter(
      (entry): entry is SavedSwitch =>
        !!entry &&
        typeof entry === 'object' &&
        isPoolKind((entry as SavedSwitch).kind) &&
        typeof (entry as SavedSwitch).at === 'string' &&
        typeof (entry as SavedSwitch).fromProviderId === 'string' &&
        typeof (entry as SavedSwitch).toProviderId === 'string' &&
        SWITCH_REASONS.includes((entry as SavedSwitch).reason)
    )
  } catch {
    return []
  }
}

function recordSwitch(
  kind: ChatSubscriptionAccountPoolKind,
  fromProviderId: string,
  toProviderId: string,
  reason: ChatSubscriptionAccountPoolSwitchReason
): void {
  if (fromProviderId === toProviderId) return
  const entry: SavedSwitch = { kind, at: new Date().toISOString(), fromProviderId, toProviderId, reason }
  const all = [entry, ...readSwitches()]
  const kept = SUBSCRIPTION_ACCOUNT_POOL_KINDS.flatMap((poolKind) =>
    all.filter((item) => item.kind === poolKind).slice(0, SWITCHES_KEPT)
  )
  setAppSetting(ACCOUNT_POOL_SWITCHES_KEY, JSON.stringify({ version: 1, switches: kept }))
}

/** Most recent first. */
export function accountPoolSwitches(kind: ChatSubscriptionAccountPoolKind): ChatSubscriptionAccountPoolSwitch[] {
  return readSwitches()
    .filter((entry) => entry.kind === kind)
    .slice(0, SWITCHES_SHOWN)
    .map(({ kind: _kind, ...entry }) => entry)
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
  const autoJoin = saved?.autoJoin ?? explicit.length === 0
  const excluded = new Set(saved?.excludedProviderIds ?? [])
  const joined = autoJoin ? accounts.filter((id) => !explicit.includes(id) && !excluded.has(id)) : []
  const listed = [...explicit, ...joined]
  const memberProviderIds =
    listed.length > 0 ? listed : accounts.length > 0 ? [...accounts] : [accountPoolBaseProviderId(kind)]
  const activeProviderId =
    saved?.activeProviderId && memberProviderIds.includes(saved.activeProviderId)
      ? saved.activeProviderId
      : memberProviderIds[0]!
  return {
    kind,
    memberProviderIds,
    activeProviderId,
    policy: saved?.policy ?? 'drain',
    customMembers: explicit.length > 0,
    enabled: saved?.enabled ?? true,
    autoJoin,
  }
}

export function getAccountPool(kind: ChatSubscriptionAccountPoolKind): ChatSubscriptionAccountPool {
  return resolveAccountPool(
    kind,
    readSavedAccountPools().find((pool) => pool.kind === kind),
    accountPoolAccounts(kind)
  )
}

export function setAccountPool(patch: ChatSubscriptionAccountPoolPatch): ChatSubscriptionAccountPool {
  if (!isPoolKind(patch?.kind)) throw new Error('unknown-kind')
  const kind = patch.kind
  const accounts = accountPoolAccounts(kind)
  if (patch.policy !== undefined && !POLICIES.includes(patch.policy)) throw new Error('invalid-policy')
  if (patch.enabled !== undefined && typeof patch.enabled !== 'boolean') throw new Error('invalid-enabled')
  if (patch.autoJoin !== undefined && typeof patch.autoJoin !== 'boolean') throw new Error('invalid-auto-join')
  const saved = readSavedAccountPools().find((pool) => pool.kind === kind)
  const before = resolveAccountPool(kind, saved, accounts)
  const next: SavedAccountPool = { ...saved, kind }
  if (patch.policy !== undefined) next.policy = patch.policy
  if (patch.enabled !== undefined) next.enabled = patch.enabled
  if (patch.memberProviderIds !== undefined) {
    if (!Array.isArray(patch.memberProviderIds)) throw new Error('invalid-members')
    const members = [...new Set(patch.memberProviderIds.map((id) => (typeof id === 'string' ? id.trim() : '')))]
    if (members.length === 0 || members.some((id) => !accounts.includes(id))) throw new Error('invalid-members')
    next.memberProviderIds = members
    // A list of its own would stop new accounts joining a pool that never chose: it keeps what it did.
    next.autoJoin ??= before.autoJoin
    // An account taken out stays out even while new accounts join on their own; one put back is no longer excluded.
    const excluded = new Set(next.excludedProviderIds ?? [])
    for (const id of before.memberProviderIds) if (!members.includes(id)) excluded.add(id)
    for (const id of members) excluded.delete(id)
    if (excluded.size > 0) next.excludedProviderIds = [...excluded]
    else delete next.excludedProviderIds
  }
  if (patch.autoJoin !== undefined) {
    const current = resolveAccountPool(kind, next, accounts)
    next.autoJoin = patch.autoJoin
    // The members stay as they are: turning it off pins them, turning it on only lets accounts added later join.
    next.memberProviderIds = current.memberProviderIds
    if (patch.autoJoin) {
      const excluded = new Set([
        ...(next.excludedProviderIds ?? []),
        ...accounts.filter((id) => !current.memberProviderIds.includes(id)),
      ])
      if (excluded.size > 0) next.excludedProviderIds = [...excluded]
    }
  }
  if (patch.activeProviderId !== undefined) {
    const active = typeof patch.activeProviderId === 'string' ? patch.activeProviderId.trim() : ''
    if (!resolveAccountPool(kind, next, accounts).memberProviderIds.includes(active))
      throw new Error('active-not-member')
    next.activeProviderId = active
  }
  saveAccountPool(next)
  const after = resolveAccountPool(kind, next, accounts)
  if (patch.activeProviderId !== undefined) recordSwitch(kind, before.activeProviderId, after.activeProviderId, 'manual')
  return after
}

export function removeAccountFromAccountPools(providerId: string): void {
  const pools = readSavedAccountPools()
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
      if (next.excludedProviderIds) {
        const excluded = next.excludedProviderIds.filter((id) => id !== providerId)
        if (excluded.length > 0) next.excludedProviderIds = excluded
        else delete next.excludedProviderIds
      }
      return next
    })
  )
}

export function rotateToActive(ids: readonly string[], activeProviderId: string): string[] {
  const index = ids.indexOf(activeProviderId)
  return index <= 0 ? [...ids] : [...ids.slice(index), ...ids.slice(0, index)]
}

/**
 * Physical accounts an active-account selection runs on, the active one first; [] for any other id. A pool that is
 * off runs on its active account alone.
 */
export function accountPoolChain(providerId: string): string[] {
  const kind = isActiveAccountProviderId(providerId) ? accountPoolKindOf(providerId) : null
  if (!kind) return []
  const pool = getAccountPool(kind)
  const chain = pool.enabled ? rotateToActive(pool.memberProviderIds, pool.activeProviderId) : [pool.activeProviderId]
  return chain.filter((id) => autonomousProviderAllowed(id))
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
  if (!pool.enabled || pool.policy !== 'drain' || pool.activeProviderId !== exhaustedProviderId) return null
  const others = rotateToActive(pool.memberProviderIds, exhaustedProviderId)
    .slice(1)
    .filter((id) => probe.isSignedIn(id))
  const ready = others.find((id) => probe.isAdmissible(id))
  if (ready) return ready
  let soonest = exhaustedProviderId
  for (const id of others) if (probe.nextProbeAt(id) < probe.nextProbeAt(soonest)) soonest = id
  return soonest === exhaustedProviderId ? null : soonest
}

/** Accounts a drain pool may hand over to once `providerId` runs out; [] when the pool would not move. */
export function accountPoolSuccessors(providerId: string): string[] {
  const kind = accountPoolKindOf(providerId)
  if (!kind || isActiveAccountProviderId(providerId)) return []
  const pool = getAccountPool(kind)
  if (!pool.enabled || pool.policy !== 'drain' || pool.activeProviderId !== providerId) return []
  return rotateToActive(pool.memberProviderIds, providerId).slice(1)
}

/** Whether an account takes part in an enabled pool, whose settings then show its quota running out. */
export function isAccountPoolMember(providerId: string): boolean {
  const kind = accountPoolKindOf(providerId)
  if (!kind || isActiveAccountProviderId(providerId)) return false
  const pool = getAccountPool(kind)
  return pool.enabled && pool.memberProviderIds.includes(providerId)
}

export function advanceAccountPoolsAfterExhaustion(
  providerId: string,
  probe: AccountPoolProbe
): { kind: ChatSubscriptionAccountPoolKind; from: string; to: string } | null {
  const kind = accountPoolKindOf(providerId)
  if (!kind || isActiveAccountProviderId(providerId)) return null
  const to = nextActiveAfterExhaustion(getAccountPool(kind), providerId, probe)
  if (!to) return null
  saveAccountPool({ ...readSavedAccountPools().find((pool) => pool.kind === kind), kind, activeProviderId: to })
  recordSwitch(kind, providerId, to, 'exhausted')
  failoverDiag('account-pool-advance', { kind, from: providerId, to })
  return { kind, from: providerId, to }
}

/** The account a turn starts on now. */
export function currentAccountPoolMember(
  pool: ChatSubscriptionAccountPool,
  isLimited: (providerId: string) => boolean
): string {
  if (!pool.enabled || pool.policy === 'drain') return pool.activeProviderId
  return rotateToActive(pool.memberProviderIds, pool.activeProviderId).find((id) => !isLimited(id)) ?? pool.activeProviderId
}

/** Picker and settings entries for providers with two or more accounts. */
export function accountPoolInfos(
  providers: readonly ChatProviderInfo[],
  nameFor: (kind: ChatSubscriptionAccountPoolKind, active: ChatProviderInfo | undefined) => string,
  health?: AccountPoolHealth
): ChatSubscriptionAccountPoolInfo[] {
  return SUBSCRIPTION_ACCOUNT_POOL_KINDS.flatMap((kind) => {
    if (accountPoolAccounts(kind).length < 2) return []
    const pool = getAccountPool(kind)
    const byId = (id: string) => providers.find((provider) => provider.id === id)
    const limitedUntil: Record<string, string> = {}
    for (const id of pool.memberProviderIds) {
      const until = health?.limitedUntil(id)
      if (until && Number.isFinite(until)) limitedUntil[id] = new Date(until).toISOString()
    }
    const currentProviderId = currentAccountPoolMember(pool, (id) => id in limitedUntil)
    return [
      {
        ...pool,
        providerId: activeAccountProviderId(kind),
        name: nameFor(kind, byId(currentProviderId)),
        connected: pool.memberProviderIds.some((id) => byId(id)?.connected === true),
        currentProviderId,
        limitedUntil,
        recentSwitches: accountPoolSwitches(kind),
      },
    ]
  })
}
