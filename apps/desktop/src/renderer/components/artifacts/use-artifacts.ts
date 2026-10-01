import { useCallback, useEffect, useState } from 'react'
import type { ArtifactHostStatus, ArtifactListItem, ArtifactServerStatus } from '../../../shared/artifacts'

/** Artifacts and host status, kept current by the main process's change and status events. */
export function useArtifacts() {
  const [items, setItems] = useState<ArtifactListItem[]>([])
  const [status, setStatus] = useState<ArtifactHostStatus | null>(null)
  const [serverStatus, setServerStatus] = useState<ArtifactServerStatus | null>(null)
  const [loading, setLoading] = useState(true)
  // Whether the last list came from the host: without it, an empty list says nothing about what is stored.
  const [listed, setListed] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const server = window.api.artifacts
      .serverStatus()
      .then(setServerStatus)
      .catch(() => setServerStatus(null))
    try {
      const [list, current] = await Promise.all([window.api.artifacts.list(), window.api.artifacts.status()])
      setItems(list)
      setStatus(current)
      setListed(true)
      setError(null)
    } catch (reason) {
      // The list needs the host: when it cannot start, the status explains why.
      setItems([])
      setListed(false)
      setStatus(await window.api.artifacts.status().catch(() => null))
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      await server
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
    const offChanged = window.api.artifacts.onChanged(() => void refresh())
    const offStatus = window.api.artifacts.onStatus((next) => {
      setStatus(next)
      if (next.state === 'running') void refresh()
    })
    return () => {
      offChanged()
      offStatus()
    }
  }, [refresh])

  return { items, status, serverStatus, loading, listed, error, refresh }
}
