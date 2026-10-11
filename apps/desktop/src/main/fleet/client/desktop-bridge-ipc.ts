import { z } from 'zod'
import {
  FLEET_DESKTOP_BRIDGE_FEATURE,
  fleetBotIdSchema,
  fleetDesktopIdSchema,
  fleetDesktopNameSchema,
  type FleetDesktopCallResult,
  type FleetDesktopLinkView,
  type FleetDesktopLinksResponse,
} from '@maestrly/bot-fleet-protocol'
import { botHost } from '../../bot/host'
import type { IpcRegistrar } from '../../ipc-registrar'
import { broadcast } from '../../window-ipc'
import { FleetClientError } from './api'
import { FleetDesktopBridge, type DesktopBridgeGateway } from './desktop-bridge'
import type { FleetClientService } from './service'
import { readFleetSettings } from './settings'

const key = z.string().min(1).max(191)
const ids = z
  .array(key)
  .max(200)
  .refine((value) => new Set(value).size === value.length, 'Duplicate identifiers are not allowed.')
/** The choices the person makes for a bot's access, plus the name this computer shows the bot. */
const accessInput = z
  .object({
    macName: fleetDesktopNameSchema,
    workspaceIds: ids.min(1),
    actions: z
      .array(z.enum(['chats:read', 'chats:write', 'chats:control', 'chats:answer']))
      .min(1)
      .max(4),
    selections: z
      .array(z.object({ providerId: key, modelId: key }).strict())
      .min(1)
      .max(500),
    permissionCeiling: z.enum(['ask', 'auto', 'full']),
  })
  .strict()

/** The bot server this computer paired with, as the bridge reaches it. */
export function fleetDesktopGateway(fleet: FleetClientService): DesktopBridgeGateway {
  const notFound = (error: unknown) =>
    error instanceof FleetClientError && (error.status === 404 || error.code === 'NOT_FOUND')
  return {
    deviceId: () => fleet.getConnection().deviceId,
    deviceName: () => readFleetSettings().deviceName,
    availability: (botId) => {
      if (fleet.getConnection().state !== 'connected') return 'disconnected'
      if (!fleet.hasFeature(FLEET_DESKTOP_BRIDGE_FEATURE)) return 'gateway-update'
      const snapshot = fleet.getSnapshot()
      const bot = snapshot.bots.find((item) => item.id === botId)
      // A bot that is not running reports nothing itself; its environment's Maestrly tells what it has.
      const environment = snapshot.environments.find((item) => item.id === bot?.environmentId)
      const capable = [...(bot?.capabilities ?? []), ...(environment?.capabilities ?? [])]
      return capable.includes(FLEET_DESKTOP_BRIDGE_FEATURE) ? 'ready' : 'bot-update'
    },
    botName: (botId) => fleet.getSnapshot().bots.find((item) => item.id === botId)?.name ?? null,
    links: async (botId) => {
      try {
        const response = (await fleet.call('botDesktopLinks', { params: { id: botId } })) as FleetDesktopLinksResponse
        return response.links
      } catch (error) {
        if (notFound(error)) return null
        throw error
      }
    },
    link: async (botId, name) =>
      (await fleet.call('botDesktopLinkPut', { params: { id: botId }, body: { name } })) as FleetDesktopLinkView,
    unlink: async (botId) => {
      try {
        await fleet.call('botDesktopLinkDelete', { params: { id: botId } })
      } catch (error) {
        if (!notFound(error)) throw error
      }
    },
    remove: async (botId, desktopId) => {
      await fleet.call('botDesktopLinkRemove', { params: { id: botId, desktopId } })
    },
    answer: async (callId, result: FleetDesktopCallResult) => {
      await fleet.call('desktopCallResult', { params: { callId }, body: result })
    },
  }
}

/**
 * Gives fleet bots access to projects on this computer: attaches the bridge to the fleet client (before it starts, so its
 * first stream already takes desktop calls) and serves the bot settings that manage it. Only this computer's own person
 * reaches these channels; no bot tool does.
 */
export function registerFleetDesktopBridgeIpc(reg: IpcRegistrar, fleet: FleetClientService): void {
  const bridge = new FleetDesktopBridge(fleetDesktopGateway(fleet), botHost, (botId) =>
    broadcast('fleet:desktop-access', { botId })
  )
  if (process.env.MAESTRLY_BOT_MODE !== '1') fleet.desktopBridge = bridge
  reg.handle('fleet:desktopAccess:get', (_event, botId: unknown) => bridge.state(fleetBotIdSchema.parse(botId)))
  reg.mhandle('fleet:desktopAccess:save', (_event, botId: unknown, input: unknown) =>
    bridge.save(fleetBotIdSchema.parse(botId), accessInput.parse(input))
  )
  reg.mhandle('fleet:desktopAccess:disable', (_event, botId: unknown) => bridge.disable(fleetBotIdSchema.parse(botId)))
  reg.mhandle('fleet:desktopAccess:removeOther', (_event, botId: unknown, desktopId: unknown) =>
    bridge.removeOther(fleetBotIdSchema.parse(botId), fleetDesktopIdSchema.parse(desktopId))
  )
}
