import { useCallback, useEffect, useRef, useState } from 'react'
import type { PluginsStateDto } from '../../../shared/plugins'
import type { PluginsSource } from './plugins-source'

/** The plugin center's state, reloaded whenever any view reports a plugin change. */
export function usePluginsState(source: PluginsSource): {
  state: PluginsStateDto | null
  refresh(): Promise<void>
  busy: boolean
  error: boolean
} {
  const [state, setState] = useState<PluginsStateDto | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const request = useRef(0)
  const alive = useRef(true)
  const refresh = useCallback(async () => {
    const current = ++request.current
    setBusy(true)
    try {
      const next = await source.pluginsState()
      if (alive.current && current === request.current) {
        setState(next)
        setError(false)
      }
    } catch {
      if (alive.current && current === request.current) setError(true)
    } finally {
      if (alive.current && current === request.current) setBusy(false)
    }
  }, [source])
  useEffect(() => {
    alive.current = true
    void refresh()
    const unsubscribe = source.subscribe(() => void refresh())
    return () => {
      alive.current = false
      unsubscribe()
    }
  }, [source, refresh])
  return { state, refresh, busy, error }
}
