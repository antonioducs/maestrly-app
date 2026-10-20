import { provisioningAccountBaseURL } from '../../../../shared/fleet-provisioning'
import {
  fleetLoginStartRequestSchema,
  fleetLoginCodeRequestSchema,
  type FleetBotAccounts,
} from '@maestrly/bot-fleet-protocol'
import { startBotLogin, botLoginStatus, submitBotLoginCode, cancelBotLogin, reopenBotLogin } from './logins'
import { z } from 'zod'
import {
  fleetSubscriptionKindSchema,
  fleetAccountSlotIdSchema,
  fleetSkillNameSchema,
} from '@maestrly/bot-fleet-protocol'
import type { IpcRegistrar } from '../../../ipc-registrar'
import type { FleetClientService } from '../service'
import { provisioningRoute, resolveProvisioningTarget } from '../targets'
import { buildMacInventory } from './inventory'
import { importFromMac } from './export'
import type { FleetIpcRegistrar } from '../scoped-ipc'
const opaqueId = z.string().min(1).max(256)
const slot = z.union([z.literal('default'), fleetAccountSlotIdSchema])
const selection = z
  .object({
    apiKeyIds: z.array(opaqueId).max(200),
    copyIds: z.array(opaqueId).max(200),
    skillNames: z.array(fleetSkillNameSchema).max(200),
    mcpServerIds: z.array(opaqueId).max(200),
  })
  .strict()
/**
 * Every channel takes a target: an environment (`{ environmentId }`), a bot (`{ botId }`) or, from the views that
 * predate environments, a bare bot id. It is validated before anything reaches the gateway.
 */
export function registerFleetProvisioningIpc(reg: IpcRegistrar, scoped: FleetIpcRegistrar): void {
  const target = (fleet: FleetClientService, raw: unknown) => resolveProvisioningTarget(fleet, raw)
  scoped.mhandle('fleet:login:start', (fleet, _event, rawTarget: unknown, request: unknown) =>
    startBotLogin(fleet, target(fleet, rawTarget), fleetLoginStartRequestSchema.parse(request))
  )
  scoped.handle('fleet:login:status', (fleet, _event, rawTarget: unknown, loginId: unknown) =>
    botLoginStatus(fleet, target(fleet, rawTarget), opaqueId.parse(loginId))
  )
  scoped.mhandle('fleet:login:code', (fleet, _event, rawTarget: unknown, loginId: unknown, code: unknown) =>
    submitBotLoginCode(
      fleet,
      target(fleet, rawTarget),
      opaqueId.parse(loginId),
      fleetLoginCodeRequestSchema.parse({ code }).code
    )
  )
  scoped.mhandle('fleet:login:cancel', (fleet, _event, rawTarget: unknown, loginId: unknown) =>
    cancelBotLogin(fleet, target(fleet, rawTarget), opaqueId.parse(loginId))
  )
  scoped.mhandle('fleet:login:open', (fleet, _event, rawTarget: unknown, loginId: unknown, page: unknown) =>
    reopenBotLogin(
      fleet,
      target(fleet, rawTarget),
      opaqueId.parse(loginId),
      z.enum(['auth', 'device', 'manual']).parse(page)
    )
  )
  reg.handle('fleet:provisioning:inventory', () => buildMacInventory())
  scoped.mhandle('fleet:provisioning:import', (fleet, _event, rawTarget: unknown, input: unknown) =>
    importFromMac(fleet, target(fleet, rawTarget), selection.parse(input))
  )
  scoped.handle('fleet:bot:accounts', async (fleet, _event, rawTarget: unknown) => {
    const route = provisioningRoute(target(fleet, rawTarget), 'accountsList')
    const accounts: FleetBotAccounts = await fleet.call(route.key, { params: route.params })
    return {
      ...accounts,
      apiKeys: accounts.apiKeys.map((account) => ({
        ...account,
        baseURL: provisioningAccountBaseURL(account.baseURL),
      })),
    }
  })
  scoped.mhandle(
    'fleet:bot:subscription-remove',
    (fleet, _event, rawTarget: unknown, kind: unknown, account: unknown) => {
      const params = { kind: fleetSubscriptionKindSchema.parse(kind), slot: slot.parse(account) }
      const route = provisioningRoute(target(fleet, rawTarget), 'subscriptionRemove', params)
      return fleet.call(route.key, { params: route.params })
    }
  )
  scoped.handle('fleet:bot:skills', (fleet, _event, rawTarget: unknown) => {
    const route = provisioningRoute(target(fleet, rawTarget), 'skillsList')
    return fleet.call(route.key, { params: route.params })
  })
  scoped.mhandle('fleet:bot:skill-remove', (fleet, _event, rawTarget: unknown, name: unknown) => {
    const route = provisioningRoute(target(fleet, rawTarget), 'skillRemove', { name: fleetSkillNameSchema.parse(name) })
    return fleet.call(route.key, { params: route.params })
  })
  scoped.handle('fleet:bot:mcp-servers', (fleet, _event, rawTarget: unknown) => {
    const route = provisioningRoute(target(fleet, rawTarget), 'mcpServersList')
    return fleet.call(route.key, { params: route.params })
  })
  scoped.mhandle('fleet:bot:mcp-remove', (fleet, _event, rawTarget: unknown, serverId: unknown) => {
    const route = provisioningRoute(target(fleet, rawTarget), 'mcpServerRemove', { sid: opaqueId.parse(serverId) })
    return fleet.call(route.key, { params: route.params })
  })
}
