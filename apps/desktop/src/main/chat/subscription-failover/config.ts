import {autonomousProviderAllowed} from '../autonomous'
import {
  isSubscriptionFailoverProviderId,
  subscriptionAccountId,
  subscriptionBaseProviderId,
  type ChatSubscriptionFailoverConfigV1,
  type ChatSubscriptionFailoverRoute,
} from '../../../shared/chat'
import { getAppSetting, setAppSetting } from '../../store'
import { listAvailableChatProviders } from '../catalog'

export const SUPPORTED_FAILOVER_KINDS = ['codex-subscription', 'claude-subscription'] as const
export const FAILOVER_CONFIG_KEY = 'chat.subscriptionFailover.v1'
/** Mirrors `CODEX_SUBSCRIPTION_PROVIDER_ID` without importing it — incomplete catalog mocks cannot break buildConfig. */
const DEFAULT_CODEX_PROVIDER_ID = 'builtin_codex_subscription'

export type { ChatSubscriptionFailoverConfigV1, ChatSubscriptionFailoverRoute }

export function emptyFailoverConfig(): ChatSubscriptionFailoverConfigV1 {
  return { version: 1, routes: [] }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/** Valid primary: resembles Claude or Codex (base or @acc_ slot) and, if a catalog is supplied, exists in it. */
function isAcceptablePrimary(primaryProviderId: string, knownProviderIds: ReadonlySet<string>): boolean {
  if (!isSubscriptionFailoverProviderId(primaryProviderId)) return false
  if (knownProviderIds.size === 0) return true
  return knownProviderIds.has(primaryProviderId)
}

function normalizeFallbackIds(primaryProviderId: string, fallbackProviderIds: unknown): string[] {
  if (!Array.isArray(fallbackProviderIds)) return []
  const base = subscriptionBaseProviderId(primaryProviderId)
  const seen = new Set<string>([primaryProviderId])
  const out: string[] = []
  for (const item of fallbackProviderIds) {
    if (!isNonEmptyString(item)) continue
    const id = item.trim()
    if (seen.has(id)) continue
    if (!isSubscriptionFailoverProviderId(id)) continue
    if (subscriptionBaseProviderId(id) !== base) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

function normalizeRoute(raw: {
  primaryProviderId: string
  enabled?: unknown
  fallbackProviderIds?: unknown
}): ChatSubscriptionFailoverRoute {
  const primaryProviderId = raw.primaryProviderId.trim()
  return {
    primaryProviderId,
    enabled: raw.enabled === true,
    fallbackProviderIds: normalizeFallbackIds(primaryProviderId, raw.fallbackProviderIds),
  }
}

/** Never throws: corrupt JSON / invalid routes become empty or filtered config. */
export function sanitizeFailoverConfig(
  raw: unknown,
  knownProviderIds: ReadonlySet<string>
): ChatSubscriptionFailoverConfigV1 {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyFailoverConfig()
  const obj = raw as Record<string, unknown>
  if (obj.version !== 1) return emptyFailoverConfig()
  if (!Array.isArray(obj.routes)) return emptyFailoverConfig()

  const routes: ChatSubscriptionFailoverRoute[] = []
  const seenPrimaries = new Set<string>()
  for (const item of obj.routes) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const route = item as Record<string, unknown>
    if (!isNonEmptyString(route.primaryProviderId)) continue
    const primaryProviderId = route.primaryProviderId.trim()
    if (!isAcceptablePrimary(primaryProviderId, knownProviderIds)) continue
    if (seenPrimaries.has(primaryProviderId)) continue
    seenPrimaries.add(primaryProviderId)
    routes.push(
      normalizeRoute({
        primaryProviderId,
        enabled: route.enabled,
        fallbackProviderIds: route.fallbackProviderIds,
      })
    )
  }
  return { version: 1, routes }
}

function knownFailoverProviderIds(): Set<string> {
  const known = new Set<string>()
  known.add(DEFAULT_CODEX_PROVIDER_ID)
  known.add('builtin_claude_subscription')
  for (const provider of listAvailableChatProviders()) {
    if (isSubscriptionFailoverProviderId(provider.id)) known.add(provider.id)
  }
  return known
}

function readRawConfig(): unknown {
  const raw = getAppSetting(FAILOVER_CONFIG_KEY)
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function saveConfig(config: ChatSubscriptionFailoverConfigV1): void {
  setAppSetting(FAILOVER_CONFIG_KEY, JSON.stringify(config))
}

function loadSanitized(extraKnownIds?: Iterable<string>): ChatSubscriptionFailoverConfigV1 {
  const known = knownFailoverProviderIds()
  if (extraKnownIds) {
    for (const id of extraKnownIds) {
      if (isSubscriptionFailoverProviderId(id)) known.add(id)
    }
  }
  return sanitizeFailoverConfig(readRawConfig(), known)
}

export function listFailoverRoutes(): ChatSubscriptionFailoverRoute[] {
  return loadSanitized().routes
}

export function getFailoverRoute(primaryProviderId: string): ChatSubscriptionFailoverRoute | null {
  if (!isNonEmptyString(primaryProviderId)) return null
  const id = primaryProviderId.trim()
  return listFailoverRoutes().find((route) => route.primaryProviderId === id) ?? null
}

export function setFailoverRoute(route: ChatSubscriptionFailoverRoute): ChatSubscriptionFailoverRoute {
  const primaryProviderId = typeof route?.primaryProviderId === 'string' ? route.primaryProviderId.trim() : ''
  if (!isSubscriptionFailoverProviderId(primaryProviderId)) {
    throw new Error('primaryProviderId must be a Claude or Codex subscription provider')
  }
  const normalized = normalizeRoute({
    primaryProviderId,
    enabled: route.enabled,
    fallbackProviderIds: route.fallbackProviderIds,
  })
  const current = loadSanitized([primaryProviderId, ...normalized.fallbackProviderIds])
  const routes = current.routes.filter((r) => r.primaryProviderId !== primaryProviderId)
  routes.push(normalized)
  saveConfig({ version: 1, routes })
  return normalized
}

function matchesRemovedAccount(id: string, target: string): boolean {
  if (id === target) return true
  const idAccount = subscriptionAccountId(id)
  if (idAccount && idAccount === target) return true
  const targetAccount = subscriptionAccountId(target)
  if (
    targetAccount &&
    idAccount === targetAccount &&
    subscriptionBaseProviderId(id) === subscriptionBaseProviderId(target)
  )
    return true
  return false
}

/** Removes routes where the account is primary and removes it from every fallback list. */
export function removeAccountFromFailoverConfig(providerIdOrAccountId: string): void {
  const target = typeof providerIdOrAccountId === 'string' ? providerIdOrAccountId.trim() : ''
  if (!target) return
  // Structural parsing without catalog filtering — the account being removed may already be absent from the list.
  const looseKnown = new Set<string>()
  const raw = readRawConfig()
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const routes = (raw as { routes?: unknown }).routes
    if (Array.isArray(routes)) {
      for (const item of routes) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) continue
        const primary = (item as { primaryProviderId?: unknown }).primaryProviderId
        if (isNonEmptyString(primary) && isSubscriptionFailoverProviderId(primary.trim())) {
          looseKnown.add(primary.trim())
        }
        const fallbacks = (item as { fallbackProviderIds?: unknown }).fallbackProviderIds
        if (Array.isArray(fallbacks)) {
          for (const fb of fallbacks) {
            if (isNonEmptyString(fb) && isSubscriptionFailoverProviderId(fb.trim())) looseKnown.add(fb.trim())
          }
        }
      }
    }
  }
  for (const id of knownFailoverProviderIds()) looseKnown.add(id)
  looseKnown.add(target)
  const current = sanitizeFailoverConfig(raw, looseKnown)
  const routes = current.routes
    .filter((route) => !matchesRemovedAccount(route.primaryProviderId, target))
    .map((route) => ({
      ...route,
      fallbackProviderIds: route.fallbackProviderIds.filter((id) => !matchesRemovedAccount(id, target)),
    }))
  saveConfig({ version: 1, routes })
}

/**
 * Chain frozen at turn start: [primary, ...fallbacks] if the route is enabled with
 * fallbacks; otherwise only [primary]. Does not expand fallback routes (no recursion).
 */
export function freezeFailoverChain(primaryProviderId: string): string[] {
  const primary = typeof primaryProviderId === 'string' ? primaryProviderId.trim() : ''
  if (!primary) return []
  const route = getFailoverRoute(primary)
  if (route?.enabled && route.fallbackProviderIds.length > 0) {
    return [primary, ...route.fallbackProviderIds].filter(id=>autonomousProviderAllowed(id))
  }
  return autonomousProviderAllowed(primary) ? [primary] : []
}
