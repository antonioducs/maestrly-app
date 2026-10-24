import type { FleetBot, FleetScreenSurface } from '@maestrly/bot-fleet-protocol'
import { router } from 'expo-router'
import { useCallback } from 'react'
import { useFleet } from '../../fleet/react'
import { botScreenSurface, ownsTakeover } from '../../fleet/selectors'
import type { FleetState } from '../../fleet/state'
import { useServers } from '../../servers/ServersProvider'

export type ScreenAccess = {
  surface: FleetScreenSurface
  /** This phone controls the bot's screen. */
  owned: boolean
  /** The device that controls it from elsewhere, by name; null when none does. */
  other: string | null
}

/** Whether this phone can open the bot's screen now, and who controls it; null when it cannot. */
export function useScreenAccess(bot: FleetBot | null): ScreenAccess | null {
  const { active } = useServers()
  const surface = useFleet(useCallback((state: FleetState) => (bot ? botScreenSurface(state, bot) : null), [bot]))
  if (!bot || !surface || !active) return null
  const owned = ownsTakeover(bot.takeover, active.id)
  const other =
    bot.takeover.state !== 'none' && bot.takeover.deviceId !== active.id ? (bot.takeover.deviceName ?? '') : null
  return { surface, owned, other }
}

/** Opens the bot's screen; `give` opens it on the sheet that gives the screen back. */
export function openBotScreen(botId: string, options: { give?: boolean } = {}) {
  router.push({ pathname: '/bot-screen/[id]', params: { id: botId, ...(options.give ? { give: '1' } : {}) } })
}
