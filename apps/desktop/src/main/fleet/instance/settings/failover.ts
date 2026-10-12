import {
  FLEET_FAILOVER_KINDS,
  fleetSettingsFailoverRouteSchema,
  type FleetEnvironmentSettingsService,
  type FleetSettingsOutput,
} from '@maestrly/bot-fleet-protocol'
import { getProvider, subscriptionProviderIdFor } from '../../../chat/catalog'
import { listFailoverRoutes, setFailoverRoute as saveFailoverRoute } from '../../../chat/subscription-failover/config'
import {
  subscriptionAccountId,
  subscriptionBaseProviderId,
  type ChatSubscriptionProviderKind,
} from '../../../../shared/chat'
import { InstanceHttpError } from '../server'
import { observeSettingsRevision, withSettingsRevision } from './revisions'

type FailoverKind = (typeof FLEET_FAILOVER_KINDS)[number]
type Route = FleetSettingsOutput<'failover'>['routes'][number]

const PROVIDER_KIND: Record<FailoverKind, ChatSubscriptionProviderKind> = {
  claude: 'claude-subscription',
  codex: 'codex-subscription',
}
const providerId = (kind: FailoverKind, slot: string | null): string =>
  subscriptionProviderIdFor(PROVIDER_KIND[kind], slot)

/** The kind and slot of a Claude or Codex subscription provider, or null for any other provider. */
function account(id: string): { kind: FailoverKind; slot: string | null } | null {
  const base = subscriptionBaseProviderId(id)
  const kind = FLEET_FAILOVER_KINDS.find((candidate) => providerId(candidate, null) === base)
  return kind ? { kind, slot: subscriptionAccountId(id) } : null
}

/**
 * The environment's account failover routes, as the desktop stores them: the provider ids stay inside the environment
 * and the owner's computer sees kinds and slots. A route that no longer reads as one is left out.
 */
function routes(): Route[] {
  return listFailoverRoutes().flatMap((route) => {
    const primary = account(route.primaryProviderId)
    if (!primary) return []
    const fallbacks = route.fallbackProviderIds.flatMap((id) => {
      const fallback = account(id)
      return fallback?.kind === primary.kind ? [fallback.slot] : []
    })
    const parsed = fleetSettingsFailoverRouteSchema.safeParse({ ...primary, enabled: route.enabled, fallbacks })
    return parsed.success ? [parsed.data] : []
  })
}

export const failover: FleetEnvironmentSettingsService['failover'] = async () => {
  const current = routes()
  return { revision: observeSettingsRevision('failover', current), routes: current }
}

export const setFailoverRoute: FleetEnvironmentSettingsService['setFailoverRoute'] = async (input) => {
  observeSettingsRevision('failover', routes())
  await withSettingsRevision('failover', input.expectedRevision, () => {
    const ids = [input.slot, ...input.fallbacks].map((slot) => providerId(input.kind, slot))
    if (ids.some((id) => !getProvider(id))) throw new InstanceHttpError(404, 'NOT_FOUND', 'Account does not exist.')
    try {
      saveFailoverRoute({ primaryProviderId: ids[0]!, enabled: input.enabled, fallbackProviderIds: ids.slice(1) })
    } catch {
      throw new InstanceHttpError(400, 'INVALID_REQUEST', 'The failover route could not be saved.')
    }
  })
  return failover({})
}
