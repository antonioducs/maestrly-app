import { fleetLoginStartRequestSchema, fleetLoginCodeRequestSchema } from '@maestrly/bot-fleet-protocol'
import { startBotLogin, botLoginStatus, submitBotLoginCode, cancelBotLogin, reopenBotLogin } from './logins'
import { z } from 'zod'
import {
  fleetBotIdSchema,
  fleetSubscriptionKindSchema,
  fleetAccountSlotIdSchema,
  fleetSkillNameSchema,
} from '@maestrly/bot-fleet-protocol'
import type { IpcRegistrar } from '../../../ipc-registrar'
import type { FleetClientService } from '../service'
import { buildMacInventory } from './inventory'
import { importFromMac } from './export'
const id = fleetBotIdSchema
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
export function registerFleetProvisioningIpc(reg: IpcRegistrar, fleet: FleetClientService): void {
  reg.mhandle('fleet:login:start', (_event, botId: unknown, request: unknown) =>
    startBotLogin(fleet, id.parse(botId), fleetLoginStartRequestSchema.parse(request))
  )
  reg.handle('fleet:login:status', (_event, botId: unknown, loginId: unknown) =>
    botLoginStatus(fleet, id.parse(botId), opaqueId.parse(loginId))
  )
  reg.mhandle('fleet:login:code', (_event, botId: unknown, loginId: unknown, code: unknown) =>
    submitBotLoginCode(
      fleet,
      id.parse(botId),
      opaqueId.parse(loginId),
      fleetLoginCodeRequestSchema.parse({ code }).code
    )
  )
  reg.mhandle('fleet:login:cancel', (_event, botId: unknown, loginId: unknown) =>
    cancelBotLogin(fleet, id.parse(botId), opaqueId.parse(loginId))
  )
  reg.mhandle('fleet:login:open', (_event, botId: unknown, loginId: unknown, target: unknown) =>
    reopenBotLogin(fleet, id.parse(botId), opaqueId.parse(loginId), z.enum(['auth', 'device', 'manual']).parse(target))
  )
  reg.handle('fleet:provisioning:inventory', () => buildMacInventory())
  reg.mhandle('fleet:provisioning:import', (_event, botId: unknown, input: unknown) =>
    importFromMac(fleet, id.parse(botId), selection.parse(input))
  )
  reg.handle('fleet:bot:accounts', (_event, botId: unknown) =>
    fleet.call('botAccountsList', { params: { id: id.parse(botId) } })
  )
  reg.mhandle('fleet:bot:subscription-remove', (_event, botId: unknown, kind: unknown, account: unknown) =>
    fleet.call('botSubscriptionRemove', {
      params: { id: id.parse(botId), kind: fleetSubscriptionKindSchema.parse(kind), slot: slot.parse(account) },
    })
  )
  reg.handle('fleet:bot:skills', (_event, botId: unknown) =>
    fleet.call('botSkillsList', { params: { id: id.parse(botId) } })
  )
  reg.mhandle('fleet:bot:skill-remove', (_event, botId: unknown, name: unknown) =>
    fleet.call('botSkillRemove', { params: { id: id.parse(botId), name: fleetSkillNameSchema.parse(name) } })
  )
  reg.handle('fleet:bot:mcp-servers', (_event, botId: unknown) =>
    fleet.call('botMcpServersList', { params: { id: id.parse(botId) } })
  )
  reg.mhandle('fleet:bot:mcp-remove', (_event, botId: unknown, serverId: unknown) =>
    fleet.call('botMcpServerRemove', { params: { id: id.parse(botId), sid: opaqueId.parse(serverId) } })
  )
}
