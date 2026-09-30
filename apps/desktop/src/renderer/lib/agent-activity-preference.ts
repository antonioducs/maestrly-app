import { useSyncExternalStore } from 'react'

/**
 * How transcripts show what an agent did on the way to its answer: `compact` folds it into one activity line per
 * turn; `expanded` shows every reasoning block and tool card as before. A display preference of this computer, kept
 * with the other chat display settings in local storage.
 */
export type AgentActivityMode = 'compact' | 'expanded'

export const AGENT_ACTIVITY_MODES: readonly AgentActivityMode[] = ['compact', 'expanded']

const STORAGE_KEY = 'chat.agentActivity'
const listeners = new Set<() => void>()
/** The choice made in this window, for when local storage is unavailable. */
let chosen: AgentActivityMode | null = null

const isMode = (value: unknown): value is AgentActivityMode => value === 'compact' || value === 'expanded'

export function agentActivityMode(): AgentActivityMode {
  try {
    const stored = globalThis.localStorage?.getItem(STORAGE_KEY)
    if (isMode(stored)) return stored
  } catch {}
  return chosen ?? 'compact'
}

export function setAgentActivityMode(mode: AgentActivityMode): void {
  chosen = mode
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, mode)
  } catch {}
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  // Other windows of the app share local storage: follow a change made there.
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) listener()
  }
  globalThis.addEventListener?.('storage', onStorage)
  return () => {
    listeners.delete(listener)
    globalThis.removeEventListener?.('storage', onStorage)
  }
}

export function useAgentActivityMode(): AgentActivityMode {
  return useSyncExternalStore(subscribe, agentActivityMode, () => 'compact')
}
