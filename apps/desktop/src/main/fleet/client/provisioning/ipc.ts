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
export function registerFleetProvisioningIpc(reg: IpcRegistrar, fleet: FleetClientService): void {
  const target = (raw: unknown) => resolveProvisioningTarget(fleet, raw)
  reg.mhandle('fleet:login:start', (_event, rawTarget: unknown, request: unknown) =>
    startBotLogin(fleet, target(rawTarget), fleetLoginStartRequestSchema.parse(request))
  )
  reg.handle('fleet:login:status', (_event, rawTarget: unknown, loginId: unknown) =>
    botLoginStatus(fleet, target(rawTarget), opaqueId.parse(loginId))
  )
  reg.mhandle('fleet:login:code', (_event, rawTarget: unknown, loginId: unknown, code: unknown) =>
    submitBotLoginCode(
      fleet,
      target(rawTarget),
      opaqueId.parse(loginId),
      fleetLoginCodeRequestSchema.parse({ code }).code
    )
  )
  reg.mhandle('fleet:login:cancel', (_event, rawTarget: unknown, loginId: unknown) =>
    cancelBotLogin(fleet, target(rawTarget), opaqueId.parse(loginId))
  )
  reg.mhandle('fleet:login:open', (_event, rawTarget: unknown, loginId: unknown, page: unknown) =>
    reopenBotLogin(fleet, target(rawTarget), opaqueId.parse(loginId), z.enum(['auth', 'device', 'manual']).parse(page))
  )
  reg.handle('fleet:provisioning:inventory', () => buildMacInventory())
  reg.mhandle('fleet:provisioning:import', (_event, rawTarget: unknown, input: unknown) =>
    importFromMac(fleet, target(rawTarget), selection.parse(input))
  )
  reg.handle('fleet:bot:accounts', async (_event, rawTarget: unknown) => {
    const route = provisioningRoute(target(rawTarget), 'accountsList')
    const accounts: FleetBotAccounts = await fleet.call(route.key, { params: route.params })
    return {
      ...accounts,
      apiKeys: accounts.apiKeys.map((account) => ({
        ...account,
        baseURL: provisioningAccountBaseURL(account.baseURL),
      })),
    }
  })
  reg.mhandle('fleet:bot:subscription-remove', (_event, rawTarget: unknown, kind: unknown, account: unknown) => {
    const params = { kind: fleetSubscriptionKindSchema.parse(kind), slot: slot.parse(account) }
    const route = provisioningRoute(target(rawTarget), 'subscriptionRemove', params)
    return fleet.call(route.key, { params: route.params })
  })
  reg.handle('fleet:bot:skills', (_event, rawTarget: unknown) => {
    const route = provisioningRoute(target(rawTarget), 'skillsList')
    return fleet.call(route.key, { params: route.params })
  })
  reg.mhandle('fleet:bot:skill-remove', (_event, rawTarget: unknown, name: unknown) => {
    const route = provisioningRoute(target(rawTarget), 'skillRemove', { name: fleetSkillNameSchema.parse(name) })
    return fleet.call(route.key, { params: route.params })
  })
  reg.handle('fleet:bot:mcp-servers', (_event, rawTarget: unknown) => {
    const route = provisioningRoute(target(rawTarget), 'mcpServersList')
    return fleet.call(route.key, { params: route.params })
  })
  reg.mhandle('fleet:bot:mcp-remove', (_event, rawTarget: unknown, serverId: unknown) => {
    const route = provisioningRoute(target(rawTarget), 'mcpServerRemove', { sid: opaqueId.parse(serverId) })
    return fleet.call(route.key, { params: route.params })
  })
}
