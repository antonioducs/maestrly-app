import { autonomousProviderAllowed } from '../autonomous'
import { isActiveAccountProviderId, isSubscriptionFailoverProviderId } from '../../../shared/chat'
import { getAppSetting, setAppSetting } from '../../store'
import { accountPoolChain } from './account-pool'

export const SUPPORTED_FAILOVER_KINDS = ['codex-subscription', 'claude-subscription'] as const
/** Where the per-account failover routes lived before each provider's account pool replaced them. */
export const FAILOVER_CONFIG_KEY = 'chat.subscriptionFailover.v1'

/** A per-account failover route as it was saved, read only to move it into its provider's account pool. */
export interface LegacyFailoverRoute {
  primaryProviderId: string
  fallbackProviderIds: string[]
}

/** The saved routes that were on and had somewhere to go. Never throws: anything malformed is left out. */
export function readLegacyFailoverRoutes(): LegacyFailoverRoute[] {
  const raw = getAppSetting(FAILOVER_CONFIG_KEY)
  if (!raw) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  const routes = (parsed as { routes?: unknown } | null)?.routes
  if (!Array.isArray(routes)) return []
  const out: LegacyFailoverRoute[] = []
  for (const item of routes) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const route = item as { primaryProviderId?: unknown; enabled?: unknown; fallbackProviderIds?: unknown }
    const primary = typeof route.primaryProviderId === 'string' ? route.primaryProviderId.trim() : ''
    if (route.enabled !== true || !isSubscriptionFailoverProviderId(primary)) continue
    if (out.some((entry) => entry.primaryProviderId === primary)) continue
    const fallbacks = Array.isArray(route.fallbackProviderIds)
      ? [
          ...new Set(
            route.fallbackProviderIds
              .filter((id): id is string => typeof id === 'string')
              .map((id) => id.trim())
              .filter((id) => id !== primary && isSubscriptionFailoverProviderId(id))
          ),
        ]
      : []
    if (fallbacks.length > 0) out.push({ primaryProviderId: primary, fallbackProviderIds: fallbacks })
  }
  return out
}

export function clearLegacyFailoverRoutes(): void {
  if (getAppSetting(FAILOVER_CONFIG_KEY) !== null) setAppSetting(FAILOVER_CONFIG_KEY, JSON.stringify({ version: 1, routes: [] }))
}

/**
 * Chain frozen at turn start. The active-account selection runs on its pool: the active account first, then the
 * others in rotation order. Any other account runs alone.
 */
export function freezeFailoverChain(primaryProviderId: string): string[] {
  const primary = typeof primaryProviderId === 'string' ? primaryProviderId.trim() : ''
  if (!primary) return []
  if (isActiveAccountProviderId(primary)) return accountPoolChain(primary)
  return autonomousProviderAllowed(primary) ? [primary] : []
}
