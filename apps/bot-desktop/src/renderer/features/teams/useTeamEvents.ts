import { useEffect, useRef, useState } from 'react'
import type { TeamEvent } from '@maestrly/host-protocol'

export type TeamEventState = { events: TeamEvent[]; cursor: number }
/** Merges a page into the local buffer, keeping order and a bounded window. */
export function mergeTeamEvents(state: TeamEventState, page: { events: TeamEvent[]; cursor: number }): TeamEventState {
  if (!page.events.length) return { ...state, cursor: Math.max(state.cursor, page.cursor) }
  const merged = new Map(state.events.map((event) => [event.seq, event]))
  for (const event of page.events) merged.set(event.seq, event)
  const events = [...merged.values()].sort((a, b) => a.seq - b.seq).slice(-200)
  return { events, cursor: Math.max(state.cursor, page.cursor, events.at(-1)?.seq ?? 0) }
}
/** Events that mean the conversation itself changed and must be re-read. */
const REFRESH_ON = new Set([
  'run.status',
  'task.status',
  'delegation.submitted',
  'member.message',
  'approval.requested',
  'approval.resolved',
  'question.asked',
  'question.answered',
  'artifact.shared',
  'artifact.revoked',
  'memory.proposed',
  'memory.changed',
  'membership.changed',
])

/**
 * Follows one team's events. Polling belongs to the client only: the Host coordinates the
 * work durably, so closing the window never stops or resumes anything.
 */
export function useTeamEvents(teamId: string, connected: boolean, refresh: () => Promise<void>, onError: (error: unknown) => void) {
  const [state, setState] = useState<TeamEventState>({ events: [], cursor: 0 })
  const callbacks = useRef({ refresh, onError })
  callbacks.current = { refresh, onError }
  useEffect(() => {
    if (!connected) return
    let disposed = false
    let current: TeamEventState = { events: [], cursor: 0 }
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const page = await window.bot.team({ method: 'team.events.list', params: { teamId, after: current.cursor, limit: 100 } })
        if (disposed) return
        current = mergeTeamEvents(current, page)
        setState(current)
        if (page.events.some((event) => REFRESH_ON.has(event.kind))) await callbacks.current.refresh()
        if (!disposed) timer = setTimeout(poll, page.hasMore ? 0 : 1500)
      } catch (error) {
        if (!disposed) {
          callbacks.current.onError(error)
          timer = setTimeout(poll, 1500)
        }
      }
    }
    void poll()
    return () => {
      disposed = true
      clearTimeout(timer)
    }
  }, [teamId, connected])
  return state.events
}
