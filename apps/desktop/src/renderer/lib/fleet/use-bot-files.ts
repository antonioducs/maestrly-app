import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  FLEET_FILES_MANAGE_FEATURE,
  type FleetBot,
  type FleetFileSettings,
  type FleetFilesDeleted,
  type FleetFilesList,
} from '@maestrly/bot-fleet-protocol'
import { fleetErrorMessage } from '@/lib/fleet/errors'
import type { FleetController } from '@/lib/fleet/use-fleet'

export interface BotFiles {
  supported: boolean
  list: FleetFilesList | null
  loading: boolean
  error: string | null
  refresh: () => void
  remove: (ids: string[]) => Promise<FleetFilesDeleted>
  saveSettings: (settings: FleetFileSettings) => Promise<void>
  removedAt: (fileId: string) => string | null
}

export function useBotFiles(fleet: FleetController, bot: FleetBot, active: boolean): BotFiles {
  const supported =
    fleet.state.connection.features.includes(FLEET_FILES_MANAGE_FEATURE) &&
    bot.capabilities.includes(FLEET_FILES_MANAGE_FEATURE)
  const [list, setList] = useState<FleetFilesList | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)
  // The bot's status says when its files changed: shared, deleted, or resized anywhere.
  const version = bot.sharedFiles?.updatedAt ?? null
  useEffect(() => {
    if (!supported || !active) return
    let alive = true
    setLoading(true)
    window.api
      .fleetListBotFiles(fleet.serverId, bot.id)
      .then(
        (next) => {
          if (!alive) return
          setList(next)
          setError(null)
        },
        (cause) => alive && setError(fleetErrorMessage(cause))
      )
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [supported, active, fleet.serverId, bot.id, version, nonce])
  const removed = useMemo(() => new Map(list?.removed.map((entry) => [entry.id, entry.removedAt])), [list])
  const removedAt = useCallback((fileId: string) => removed.get(fileId) ?? null, [removed])
  const remove = useCallback(
    async (ids: string[]) => {
      const result = await window.api.fleetDeleteBotFiles(fleet.serverId, bot.id, ids)
      const at = new Date().toISOString()
      setList(
        (current) =>
          current && {
            ...current,
            files: current.files.filter((file) => !result.deleted.includes(file.id)),
            removed: [...current.removed, ...result.deleted.map((id) => ({ id, removedAt: at }))],
            usage: result.usage,
          }
      )
      return result
    },
    [fleet.serverId, bot.id]
  )
  const saveSettings = useCallback(
    async (settings: FleetFileSettings) => {
      const usage = await window.api.fleetSetBotFileSettings(fleet.serverId, bot.id, settings)
      setList((current) => current && { ...current, usage })
    },
    [fleet.serverId, bot.id]
  )
  return {
    supported,
    list,
    loading,
    error,
    refresh: () => setNonce((n) => n + 1),
    remove,
    saveSettings,
    removedAt,
  }
}
