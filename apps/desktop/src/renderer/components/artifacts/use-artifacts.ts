import { useCallback, useEffect, useState } from 'react'
import type { ArtifactHostStatus, ArtifactListItem } from '../../../shared/artifacts'

/** Artifacts and host status, kept current by the main process's change and status events. */
export function useArtifacts() {
  const [items, setItems] = useState<ArtifactListItem[]>([])
  const [status, setStatus] = useState<ArtifactHostStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const [list, current] = await Promise.all([window.api.artifacts.list(), window.api.artifacts.status()])
      setItems(list)
      setStatus(current)
      setError(null)
    } catch (reason) {
      // The list needs the host: when it cannot start, the status explains why.
      setItems([])
      setStatus(await window.api.artifacts.status().catch(() => null))
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
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

  return { items, status, loading, error, refresh }
}
