import { useEffect, useState } from 'react'
import type { FleetServerId } from '../../../shared/fleet-servers'
import { useFleetServerId } from './server-context'

/**
 * Object URLs of bots' pictures, by server, bot and version, for the app's lifetime: a picture is small and changes
 * only when the owner picks another, whose new version is a new entry. A failed load is forgotten, so a later view
 * tries again.
 */
const urls = new Map<string, Promise<string | null>>()

export function loadBotAvatar(serverId: FleetServerId, botId: string, version: string): Promise<string | null> {
  const key = `${serverId}\u0000${botId}\u0000${version}`
  let task = urls.get(key)
  if (!task) {
    task = window.api
      .fleetGetBotAvatar(serverId, botId)
      .then((image) =>
        image ? URL.createObjectURL(new Blob([new Uint8Array(image.data)], { type: image.mediaType })) : null
      )
    task.catch(() => urls.delete(key))
    urls.set(key, task)
  }
  return task
}

/** The URL of a bot's picture once loaded; null while it loads, when it has none, or when it cannot be read. */
export function useBotAvatarUrl(botId: string | undefined, version: string | null | undefined): string | null {
  const serverId = useFleetServerId()
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    setUrl(null)
    if (!botId || !version) return
    let live = true
    loadBotAvatar(serverId, botId, version)
      .then((loaded) => {
        if (live) setUrl(loaded)
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [serverId, botId, version])
  return url
}
