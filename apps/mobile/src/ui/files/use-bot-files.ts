import type { FleetBot } from '@maestrly/bot-fleet-protocol'
import { useCallback, useEffect } from 'react'
import { filesManageSupported, freshestUsage } from '../../fleet/files'
import { useFleet, useFleetController } from '../../fleet/react'
import type { FleetState } from '../../fleet/state'

const selectFeatures = (state: FleetState) => state.features

/** A bot's shared files: whether it manages them, loaded and current, and the newest reading of its space. */
export function useBotFiles(bot: FleetBot) {
  const controller = useFleetController()
  const features = useFleet(selectFeatures)
  const supported = filesManageSupported(features, bot)
  const state = useFleet(useCallback((fleet: FleetState) => fleet.files[bot.id], [bot.id]))
  const version = bot.sharedFiles?.updatedAt ?? null
  useEffect(() => {
    if (supported) controller.ensureFiles(bot.id)
  }, [controller, supported, bot.id, version])
  return { supported, state, usage: freshestUsage(state?.list?.usage, bot.sharedFiles) }
}
