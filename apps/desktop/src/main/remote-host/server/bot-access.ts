import {
  fleetBotIdSchema,
  type FleetDesktopCallResult,
  type FleetHostDesktopCallRequest,
} from '@maestrly/bot-fleet-protocol'
import { z } from 'zod'
import type { EnvironmentBotAccessInput, FleetDesktopAccessView } from '../../../shared/fleet-desktop-access'
import {
  FleetDesktopBridge,
  type DesktopBridgeGateway,
  type DesktopBridgeHost,
  type DesktopBridgePlace,
} from '../../fleet/client/desktop-bridge'
import { fleetDesktopAccessInputSchema } from '../../fleet/client/desktop-bridge-ipc'
import { gatewayRequest } from '../../fleet/instance/gateway-client'
import type { DesktopCallRoutes } from '../../fleet/instance/server'
import type { IpcRegistrar } from '../../ipc-registrar'
import type { HostGatewayAccess } from './config'

/** Pushed to the computers connected to this host when what it gives a bot changed, here or on the server. */
export const ENVIRONMENT_BOT_ACCESS_CHANGED = 'environment-bot-access:changed'

const HOST_PLACE: DesktopBridgePlace = {
  notLinked: 'This workspaces environment no longer gives you access.',
  unavailable: 'This workspaces environment could not run the call. Tell your owner.',
}

const accessInput = fleetDesktopAccessInputSchema.extend({ botName: z.string().trim().min(1).max(200) }).strict()

/**
 * The gateway as a workspaces host reaches it for its bots: it links and unlinks itself with its host token, and reads
 * only its own links. Its calls arrive as the gateway's own requests and are answered in them, never posted back.
 */
export function hostDesktopGateway(access: HostGatewayAccess, botNames: Map<string, string>): DesktopBridgeGateway {
  return {
    deviceId: () => access.environmentId,
    // The owner's computer names the environment: this host does not know the name the server shows.
    deviceName: () => null,
    availability: () => 'ready',
    botName: (botId) => botNames.get(botId) ?? null,
    links: async (botId) =>
      (await gatewayRequest(access.gateway, 'hostDesktopLinks')).links
        .filter((link) => link.botId === botId)
        .map(({ botId: _botId, ...link }) => link),
    link: async (botId, name) => {
      const { botId: _botId, ...link } = await gatewayRequest(
        access.gateway,
        'hostDesktopLinkPut',
        { name },
        { id: botId }
      )
      return link
    },
    unlink: async (botId) => {
      await gatewayRequest(access.gateway, 'hostDesktopLinkDelete', undefined, { id: botId })
    },
    remove: async () => {
      throw new Error('A workspaces host removes only its own access.')
    },
    answer: async () => {},
  }
}

/**
 * What a workspaces host gives the bots of its server: the projects, models, actions and ceiling the owner chose for
 * each, run with the same local bot service a computer runs, under connections of this host's own. The owner sets it
 * from a computer, over the bridge; the bots' calls arrive from the gateway at the control server.
 */
export class HostBotAccess implements DesktopCallRoutes {
  private readonly botNames = new Map<string, string>()
  private readonly bridge: FleetDesktopBridge | null

  constructor(
    private readonly access: HostGatewayAccess | null,
    host: DesktopBridgeHost,
    notify: (botId: string) => void = () => {}
  ) {
    this.bridge = access
      ? new FleetDesktopBridge(hostDesktopGateway(access, this.botNames), host, notify, Date.now, HOST_PLACE)
      : null
  }

  /** Whether this host can give bots access: the gateway that runs it gave it a host token. */
  get available(): boolean {
    return this.bridge !== null
  }

  /** Once the control server listens: access the server no longer knows of is taken back, and the reverse. */
  async start(): Promise<void> {
    if (!this.access || !this.bridge) return
    await this.bridge.connected()
    // No event tells a host of the links it holds, so the ones of bots it has no access for are looked for here.
    const links = await gatewayRequest(this.access.gateway, 'hostDesktopLinks').catch(() => null)
    const bots = new Set(links?.links.map((link) => link.botId))
    await Promise.all([...bots].map((botId) => this.bridge?.reconcile(botId)))
  }

  async call(request: FleetHostDesktopCallRequest): Promise<FleetDesktopCallResult> {
    const result = await this.bridge?.run(request)
    return result ?? { ok: false, error: { code: 'desktop_not_linked', message: HOST_PLACE.notLinked } }
  }

  async linksChanged(botId: string): Promise<void> {
    await this.bridge?.reconcile(botId)
  }

  async state(botId: string): Promise<FleetDesktopAccessView> {
    if (!this.bridge) return { availability: 'gateway-update', access: null, links: null, defaultName: '' }
    return this.bridge.state(botId)
  }

  async save(botId: string, input: EnvironmentBotAccessInput): Promise<FleetDesktopAccessView> {
    if (!this.bridge) throw new Error('Update the bot server before giving bots access to this environment.')
    const { botName, ...access } = input
    this.botNames.set(botId, botName)
    return this.bridge.save(botId, access)
  }

  async disable(botId: string): Promise<FleetDesktopAccessView> {
    if (!this.bridge) return this.state(botId)
    return this.bridge.disable(botId)
  }
}

/**
 * What another computer's renderer asks a workspaces host about the bots it gives access to. Outside server mode no
 * host answers: a computer gives bots access through its own desktop link instead.
 */
export function registerEnvironmentBotAccessIpc(reg: IpcRegistrar, access: () => HostBotAccess | null): void {
  const service = (): HostBotAccess => {
    const current = access()
    if (!current) throw new Error('Only a workspaces environment gives bots access here.')
    return current
  }
  reg.handle('environment-bot-access:get', (_event, botId: unknown) => service().state(fleetBotIdSchema.parse(botId)))
  reg.mhandle('environment-bot-access:save', (_event, botId: unknown, input: unknown) =>
    service().save(fleetBotIdSchema.parse(botId), accessInput.parse(input))
  )
  reg.mhandle('environment-bot-access:disable', (_event, botId: unknown) =>
    service().disable(fleetBotIdSchema.parse(botId))
  )
}
