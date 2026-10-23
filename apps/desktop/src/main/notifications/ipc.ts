import { isFleetServerId, type FleetServerId } from '../../shared/fleet-servers'
import type { IpcRegistrar } from '../ipc-registrar'
import type { AppNotifications } from './app-notifications'

const MAX_BOT_ID = 200

function botTarget(value: unknown): { serverId: FleetServerId; botId: string } | null {
  if (!value || typeof value !== 'object') return null
  const { serverId, botId } = value as Record<string, unknown>
  return isFleetServerId(serverId) && typeof botId === 'string' && botId && botId.length <= MAX_BOT_ID
    ? { serverId, botId }
    : null
}

/**
 * What the main window tells of the owner's attention, and what it reads of bots' marks. A headless instance has no
 * notifications: it lists no marks and ignores what it is told.
 */
export function registerNotificationsIpc(reg: IpcRegistrar, notifications: () => AppNotifications | null): void {
  reg.handle('fleet:listBotAttention', () => notifications()?.botAttention.list() ?? [])
  reg.mon('fleet:visibleBot', (_event, target: unknown) => notifications()?.setVisibleBot(botTarget(target)))
}
