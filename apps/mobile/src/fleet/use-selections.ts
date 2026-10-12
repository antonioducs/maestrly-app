import type { FleetBot, FleetSelectionsResponse } from '@maestrly/bot-fleet-protocol'
import { useCallback, useEffect, useState } from 'react'
import { useFleetController } from './react'

// The models a bot may use change only when its accounts do; the last answer shows while a new one loads.
const cache = new Map<string, FleetSelectionsResponse>()

/** The models a bot's accounts offer, and the one it uses. */
export function useBotSelections(bot: FleetBot) {
  const controller = useFleetController()
  const key = `${controller.source.serverId}:${bot.id}`
  const [data, setData] = useState<FleetSelectionsResponse | null>(() => cache.get(key) ?? null)
  const [error, setError] = useState(false)
  const selection = JSON.stringify(bot.selection)

  const reload = useCallback(async () => {
    try {
      const response = await controller.source.call('botSelections', { params: { id: bot.id } })
      cache.set(key, response)
      setData(response)
      setError(false)
    } catch {
      setError(true)
    }
  }, [controller, bot.id, key])

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new selection on the server is a reason to reload
  useEffect(() => {
    void reload()
  }, [reload, selection])

  const option = data?.options.find(
    (item) => item.providerId === bot.selection?.providerId && item.modelId === bot.selection?.modelId
  )
  return { options: data?.options ?? [], option: option ?? null, loaded: data !== null, error, reload }
}
