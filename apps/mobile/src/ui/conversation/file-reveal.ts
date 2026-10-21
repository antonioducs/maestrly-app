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

/** How showing a file ended: shown, not in the conversation, or a page before it could not be read. */
export type RevealResult = 'found' | 'missing' | 'failed'
export type RevealStep = 'wait' | 'older' | RevealResult

/**
 * What a conversation does next to show a file: wait for its pages, scroll to the row that shows it, read the page
 * before the oldest one loaded, or stop. It stops once the oldest page is loaded without the file, or once a page it
 * asked for could not be read, so a failing server is not asked again and again.
 */
export function revealStep(state: {
  /** The row that shows the file among those loaded; -1 while none does. */
  index: number
  loaded: boolean
  loadingOlder: boolean
  hasOlder: boolean
  /** An older page was asked for to show this file. */
  asked: boolean
  /** The last page read failed. */
  failed: boolean
}): RevealStep {
  if (!state.loaded) return 'wait'
  if (state.index >= 0) return 'found'
  if (state.loadingOlder) return 'wait'
  if (state.asked && state.failed) return 'failed'
  return state.hasOlder ? 'older' : 'missing'
}
