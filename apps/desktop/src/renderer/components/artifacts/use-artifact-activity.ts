import { useEffect, useState } from 'react'

/**
 * How many events on shared artifacts the owner has not seen: new devices, access requests, declined invitations and
 * comments. Asking never starts the host, so this stays at zero until artifacts are in use.
 */
export function useUnseenArtifactEvents(): number {
  const [count, setCount] = useState(0)

  useEffect(() => {
    let alive = true
    let request = 0
    const refresh = () => {
      const current = ++request
      window.api.artifacts
        .unseenCount()
        .then((next) => {
          if (alive && current === request) setCount(next)
        })
        .catch(() => {})
    }
    refresh()
    const offActivity = window.api.artifacts.onActivity(refresh)
    // Seeing the events in the center, or deleting an artifact, changes the count without new activity.
    const offChanged = window.api.artifacts.onChanged(refresh)
    const offStatus = window.api.artifacts.onStatus(refresh)
    return () => {
      alive = false
      offActivity()
      offChanged()
      offStatus()
    }
  }, [])

  return count
}
