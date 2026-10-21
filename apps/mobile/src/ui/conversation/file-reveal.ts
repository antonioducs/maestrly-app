import { useSyncExternalStore } from 'react'

/**
 * The file a conversation scrolls to and highlights next, per server, bot and conversation, set from the bot's Files
 * sheet and cleared once the conversation found it or knows it is gone. Kept while the app runs.
 */
const reveals = new Map<string, string>()
const listeners = new Set<() => void>()

/** The bot's own conversation, or with `laneId` one of its routine runs or conversations with another bot. */
export const fileRevealKey = (serverId: string, botId: string, laneId?: string) =>
  laneId ? `${serverId}:${botId}:${laneId}` : `${serverId}:${botId}`

const changed = () => {
  for (const listener of listeners) listener()
}

export function revealFile(key: string, fileId: string) {
  reveals.set(key, fileId)
  changed()
}

export function pendingReveal(key: string): string | null {
  return reveals.get(key) ?? null
}

export function clearFileReveal(key: string) {
  if (reveals.delete(key)) changed()
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useFileReveal(key: string): string | null {
  return useSyncExternalStore(subscribe, () => pendingReveal(key))
}
