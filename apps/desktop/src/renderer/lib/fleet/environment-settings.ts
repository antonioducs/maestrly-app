import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  FleetEnvironmentSettingsApi,
  FleetEnvironmentSettingsService,
  FleetSettingsOutput,
} from '@maestrly/bot-fleet-protocol'

/** Bind once per mounted environment. No operation can fall back to local settings. */
export function createEnvironmentSettingsSource(
  environmentId: string,
  api: FleetEnvironmentSettingsApi,
  isCurrent: () => boolean = () => true
): FleetEnvironmentSettingsService {
  return Object.fromEntries(
    Object.entries(api).map(([key, method]) => [
      key,
      async (input: never) => {
        if (!isCurrent()) throw new Error('environment-settings-cancelled')
        const result = await method(environmentId, input)
        if (!isCurrent()) throw new Error('environment-settings-cancelled')
        return result
      },
    ])
  ) as FleetEnvironmentSettingsService
}
export function useEnvironmentSettingsSource(environmentId: string) {
  const lifetime = useMemo(() => ({ active: true }), [environmentId])
  const source = useMemo(
    () => createEnvironmentSettingsSource(environmentId, window.api.fleetEnvironmentSettings, () => lifetime.active),
    [environmentId, lifetime]
  )
  useEffect(() => {
    lifetime.active = true
    return () => {
      lifetime.active = false
    }
  }, [lifetime])
  return source
}
type ReadOperation = 'accounts' | 'models' | 'skills' | 'mcpServers' | 'runtimes' | 'preferences'
export function useEnvironmentSettingsResource<K extends ReadOperation>(environmentId: string, operation: K) {
  const source = useEnvironmentSettingsSource(environmentId)
  const [data, setData] = useState<FleetSettingsOutput<K> | null>(null)
  const [error, setError] = useState(false)
  const [busy, setBusy] = useState(false)
  const generation = useRef(0)
  const pending = useRef(false)
  const reload = useCallback(async () => {
    if (pending.current) return
    pending.current = true
    const request = ++generation.current
    setBusy(true)
    try {
      const read = source[operation] as (input: Record<string, never>) => Promise<FleetSettingsOutput<K>>
      const value = await read({})
      if (request === generation.current) {
        setData(value)
        setError(false)
      }
    } catch {
      if (request === generation.current) setError(true)
    } finally {
      if (request === generation.current) pending.current = false
      if (request === generation.current) setBusy(false)
    }
  }, [source, operation])
  useEffect(() => {
    setData(null)
    void reload()
    const refresh = () => {
      if (document.visibilityState === 'visible' && navigator.onLine) void reload()
    }
    window.addEventListener('focus', refresh)
    window.addEventListener('online', refresh)
    return () => {
      window.removeEventListener('focus', refresh)
      window.removeEventListener('online', refresh)
      generation.current++
      pending.current = false
    }
  }, [reload])
  return { source, data, setData, error, setError, busy, reload }
}

/** Changes during an awaited write invalidate its completion, including after unmount. */
export function useSettingsLifetime() {
  const epoch = useRef(0)
  useEffect(
    () => () => {
      epoch.current++
    },
    []
  )
  return epoch
}

/** Sanitized account summaries must never be written back as credentials. */
export function accountReplacementFields(draft: { baseURL: string; apiKey: string }) {
  return {
    ...(draft.baseURL.trim() ? { baseURL: draft.baseURL.trim() } : {}),
    ...(draft.apiKey ? { apiKey: draft.apiKey } : {}),
  }
}
