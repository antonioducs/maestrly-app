import { useEffect, useRef, useState } from 'react'
import type { RoutineEvent } from '@maestrly/host-protocol'

/**
 * Follows what the Host did with a target's routines while the app was closed or idle.
 *
 * The Host does not need this window to do its work, so there is nothing to push: the app asks
 * for what happened since the cursor it already has. That is also why results are waiting when
 * a person comes back — the conversation catches up, it does not replay.
 */
export function useRoutineEvents(
  routineId: string | undefined,
  connected: boolean,
  onChanged: () => void,
  onError: (error: unknown) => void,
  intervalMs = 4_000
) {
  const [events, setEvents] = useState<RoutineEvent[]>([])
  const cursor = useRef(0)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    if (!connected) return () => undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      try {
        const page = await window.bot.routine({
          method: 'routine.events.list',
          params: { after: cursor.current, limit: 100, ...(routineId ? { routineId } : {}) },
        })
        if (!alive.current) return
        if (page.events.length) {
          cursor.current = page.cursor
          setEvents((current) => [...current, ...page.events].slice(-200))
          onChanged()
        }
      } catch (error) {
        if (alive.current) onError(error)
      } finally {
        if (alive.current) timer = setTimeout(() => void poll(), intervalMs)
      }
    }
    void poll()
    return () => {
      alive.current = false
      if (timer) clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routineId, connected, intervalMs])
  return events
}
