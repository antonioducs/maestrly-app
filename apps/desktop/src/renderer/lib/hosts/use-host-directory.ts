import { useCallback, useEffect, useRef, useState } from 'react'
import { type HostFsErrorCode, type HostFsListing, type HostFsRoot, hostFsErrorCode } from '../../../shared/host-fs'
import { useHostApi } from './host-context'

export type HostDirectoryError = HostFsErrorCode | 'unknown'

/**
 * Browsing the folders of the host in context, from the places it allows: its roots, the listing shown, and moving
 * between folders. An answer that arrives after another folder was asked for is dropped.
 */
export function useHostDirectory({
  enabled = true,
  includeFiles,
  start,
}: {
  enabled?: boolean
  includeFiles: boolean
  /** The folder to show first, once the roots are known; null shows none. */
  start: (roots: HostFsRoot[]) => string | null | Promise<string | null>
}) {
  const api = useHostApi()
  const [roots, setRoots] = useState<HostFsRoot[]>([])
  const [listing, setListing] = useState<HostFsListing | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<HostDirectoryError | null>(null)
  const [showHidden, setShowHidden] = useState(false)
  const hidden = useRef(false)
  const request = useRef(0)
  const startRef = useRef(start)
  startRef.current = start
  const listingRef = useRef(listing)
  listingRef.current = listing

  const explain = useCallback((cause: unknown) => setError(hostFsErrorCode(cause) ?? 'unknown'), [])
  const go = useCallback(
    async (path: string) => {
      const current = ++request.current
      setLoading(true)
      setError(null)
      try {
        const next = await api.hostFsList(path, { includeHidden: hidden.current, includeFiles })
        if (current === request.current) setListing(next)
      } catch (cause) {
        if (current === request.current) explain(cause)
      } finally {
        if (current === request.current) setLoading(false)
      }
    },
    [api, includeFiles, explain]
  )
  const reload = useCallback(async () => {
    const path = listingRef.current?.path
    if (path) await go(path)
  }, [go])
  const toggleHidden = useCallback(() => {
    hidden.current = !hidden.current
    setShowHidden(hidden.current)
    void reload()
  }, [reload])

  useEffect(() => {
    if (!enabled) return
    setListing(null)
    setRoots([])
    setError(null)
    hidden.current = false
    setShowHidden(false)
    let alive = true
    void (async () => {
      try {
        const found = await api.hostFsRoots()
        if (!alive) return
        setRoots(found)
        const first = await startRef.current(found)
        if (alive && first) await go(first)
      } catch (cause) {
        if (alive) explain(cause)
      }
    })()
    return () => {
      alive = false
      request.current++
    }
  }, [enabled, api, go, explain])

  return { roots, listing, loading, error, showHidden, go, reload, toggleHidden, setError, explain }
}
