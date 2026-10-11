import { useCallback, useEffect, useState } from 'react'
import type {
  ArtifactListItem,
  ArtifactServerStatus,
  LegacyArtifactView,
  LegacyMoveState,
} from '../../../shared/artifacts'

/** Artifacts on the bot server and the server's state, kept current by the main process's change events. */
export function useArtifacts() {
  const [items, setItems] = useState<ArtifactListItem[]>([])
  const [serverStatus, setServerStatus] = useState<ArtifactServerStatus | null>(null)
  const [loading, setLoading] = useState(true)
  // Whether the last list came from the server: without it, an empty list says nothing about what is stored.
  const [listed, setListed] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const server = await window.api.artifacts.serverStatus().catch(() => null)
    setServerStatus(server)
    try {
      setItems(server?.state === 'ready' ? await window.api.artifacts.list() : [])
      setListed(server?.state === 'ready')
      setError(null)
    } catch (reason) {
      setItems([])
      setListed(false)
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
    const offChanged = window.api.artifacts.onChanged(() => void refresh())
    // Pairing, reconnecting or unpairing the server changes everything listed here.
    const offConnection = window.api.onFleetConnection(() => void refresh())
    return () => {
      offChanged()
      offConnection()
    }
  }, [refresh])

  return { items, serverStatus, loading, listed, error, refresh }
}

const IDLE: LegacyMoveState = { phase: 'idle', items: [], moved: [], current: null, stopping: false, error: null }

/** What earlier versions left on this computer, and the move of it to the bot server, which runs in the main process. */
export function useLegacyArtifacts() {
  const [items, setItems] = useState<LegacyArtifactView[]>([])
  const [move, setMove] = useState<LegacyMoveState>(IDLE)
  const [loaded, setLoaded] = useState(false)

  const refresh = useCallback(async () => {
    const [list, state] = await Promise.allSettled([
      window.api.artifacts.legacyList(),
      window.api.artifacts.legacyState(),
    ])
    if (list.status === 'fulfilled') setItems(list.value)
    if (state.status === 'fulfilled') setMove(state.value)
    setLoaded(true)
  }, [])

  useEffect(() => {
    void refresh()
    const offState = window.api.artifacts.onLegacyState((state) => {
      setMove(state)
      if (state.phase !== 'running') void refresh()
    })
    const offChanged = window.api.artifacts.onChanged(() => void refresh())
    return () => {
      offState()
      offChanged()
    }
  }, [refresh])

  return { items, move, loaded, refresh }
}
