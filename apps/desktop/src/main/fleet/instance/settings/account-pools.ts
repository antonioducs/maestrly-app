import {
  FLEET_ACCOUNT_POOL_KINDS,
  type FleetEnvironmentSettingsService,
  type FleetSettingsOutput,
} from '@maestrly/bot-fleet-protocol'
import { subscriptionProviderIdFor } from '../../../chat/catalog'
import {
  accountPoolAccounts,
  accountPoolSwitches,
  currentAccountPoolMember,
  getAccountPool,
  routerAccountPoolHealth,
  setAccountPool,
} from '../../../chat/subscription-failover/account-pool'
import {
  activeAccountProviderId,
  subscriptionAccountId,
  type ChatSubscriptionAccountPoolKind,
} from '../../../../shared/chat'
import { InstanceHttpError } from '../server'
import type { SettingsBotUsage } from './models'
import { observeSettingsRevision, withSettingsRevision } from './revisions'

type Kind = (typeof FLEET_ACCOUNT_POOL_KINDS)[number]
type Pool = FleetSettingsOutput<'accountPools'>['pools'][number]

export interface AccountPoolsSettingsHost {
  bots(): SettingsBotUsage[]
  accountsChanged(): void
}

const POOL_KIND: Record<Kind, ChatSubscriptionAccountPoolKind> = {
  claude: 'claude-subscription',
  codex: 'codex-subscription',
}
/** The owner's computer sees slots, never the provider ids inside the environment. */
const slotOf = (providerId: string): string | null => subscriptionAccountId(providerId)

/** What a change can conflict with: the rotation as saved, not who is out of quota right now. */
function savedPools() {
  return FLEET_ACCOUNT_POOL_KINDS.map((kind) => getAccountPool(POOL_KIND[kind]))
}

export function createAccountPoolsSettingsService(
  host: AccountPoolsSettingsHost
): Pick<FleetEnvironmentSettingsService, 'accountPools' | 'setAccountPool'> {
  const observeRevision = () => observeSettingsRevision('account-pools', savedPools())
  const pools = (): Pool[] => {
    const health = routerAccountPoolHealth()
    const bots = host.bots()
    return FLEET_ACCOUNT_POOL_KINDS.flatMap((kind): Pool[] => {
      const poolKind = POOL_KIND[kind]
      const accounts = accountPoolAccounts(poolKind)
      if (accounts.length < 2) return []
      const pool = getAccountPool(poolKind)
      const limited = pool.memberProviderIds.flatMap((id) => {
        const until = health.limitedUntil(id)
        return until ? [{ id, until: new Date(until).toISOString() }] : []
      })
      const active = activeAccountProviderId(poolKind)
      return [
        {
          kind,
          enabled: pool.enabled,
          policy: pool.policy,
          autoJoin: pool.autoJoin,
          members: pool.memberProviderIds.map(slotOf),
          active: slotOf(pool.activeProviderId),
          current: slotOf(currentAccountPoolMember(pool, (id) => limited.some((entry) => entry.id === id))),
          limited: limited.map((entry) => ({ slot: slotOf(entry.id), until: entry.until })),
          bots: bots.filter((bot) => bot.selection?.providerId === active).map(({ id, name }) => ({ id, name })),
          pinned: bots.flatMap((bot) => {
            const selection = bot.selection
            return selection && accounts.includes(selection.providerId)
              ? [{ id: bot.id, name: bot.name, slot: slotOf(selection.providerId), modelId: selection.modelId }]
              : []
          }),
          switches: accountPoolSwitches(poolKind).map((entry) => ({
            at: entry.at,
            from: slotOf(entry.fromProviderId),
            to: slotOf(entry.toProviderId),
            reason: entry.reason,
          })),
        },
      ]
    })
  }
  const accountPools: FleetEnvironmentSettingsService['accountPools'] = async () => ({
    revision: observeRevision(),
    pools: pools(),
  })
  return {
    accountPools,
    setAccountPool: async (input) => {
      observeRevision()
      await withSettingsRevision('account-pools', input.expectedRevision, () => {
        const poolKind = POOL_KIND[input.kind]
        const accounts = accountPoolAccounts(poolKind)
        if (accounts.length < 2) throw new InstanceHttpError(404, 'NOT_FOUND', 'This kind has no rotation.')
        const providerId = (slot: string | null) => subscriptionProviderIdFor(poolKind, slot)
        const members = input.members?.map(providerId)
        const active = input.active === undefined ? undefined : providerId(input.active)
        if ([...(members ?? []), ...(active ? [active] : [])].some((id) => !accounts.includes(id)))
          throw new InstanceHttpError(404, 'NOT_FOUND', 'Account does not exist.')
        try {
          setAccountPool({
            kind: poolKind,
            enabled: input.enabled,
            policy: input.policy,
            autoJoin: input.autoJoin,
            memberProviderIds: members,
            activeProviderId: active,
          })
        } catch {
          throw new InstanceHttpError(400, 'INVALID_REQUEST', 'The rotation could not be saved.')
        }
      })
      // The bots on the active account read their models again: the rotation decides which account that is.
      host.accountsChanged()
      return accountPools({})
    },
  }
}
