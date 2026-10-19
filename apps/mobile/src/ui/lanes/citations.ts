import type { FleetRoutineRun } from '@maestrly/bot-fleet-protocol'
import { useSyncExternalStore } from 'react'

/**
 * The routine run the next message to a bot refers to, per server and bot, chosen in the run's conversation or from
 * its notice and shown above the bot's composer until the message is sent. Kept while the app runs, like drafts.
 */
const citations = new Map<string, FleetRoutineRun>()
const listeners = new Set<() => void>()

export const citationKey = (serverId: string, botId: string) => `${serverId}:${botId}`

export function setCitation(key: string, run: FleetRoutineRun | null) {
  if (run) citations.set(key, run)
  else if (!citations.delete(key)) return
  for (const listener of listeners) listener()
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useCitation(key: string): FleetRoutineRun | null {
  return useSyncExternalStore(subscribe, () => citations.get(key) ?? null)
}
