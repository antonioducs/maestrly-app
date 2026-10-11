import { useSyncExternalStore } from 'react'
import { chatWindowKey, type ChatWindowTarget } from '../../shared/chat-window'

type Placement = 'missing' | 'docked' | 'opening' | 'detached'
export interface ChatWindowController {
  open: () => void
  reattach: () => void
}

const hosts = new Map<string, ChatWindowController>()
let requested: { key: string; expires: number } | null = null
const placements = new Map<string, Placement>()
const listeners = new Set<() => void>()
let detachedKeys: ReadonlySet<string> = new Set()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function setChatWindowPlacement(key: string, placement: Placement): void {
  if (placements.get(key) === placement) return
  if (placement === 'missing') placements.delete(key)
  else placements.set(key, placement)
  const detached = placement === 'opening' || placement === 'detached'
  if (detachedKeys.has(key) !== detached) {
    const next = new Set(detachedKeys)
    if (detached) next.add(key)
    else next.delete(key)
    detachedKeys = next
  }
  for (const listener of listeners) listener()
}

export function registerChatWindowHost(key: string, controller: ChatWindowController): () => void {
  hosts.set(key, controller)
  setChatWindowPlacement(key, 'docked')
  if (requested?.key === key) {
    queueMicrotask(() => {
      if (hosts.get(key) !== controller || requested?.key !== key) return
      const expired = requested.expires < Date.now()
      requested = null
      if (expired) return
      controller.open()
    })
  }
  return () => {
    if (hosts.get(key) !== controller) return
    hosts.delete(key)
    setChatWindowPlacement(key, 'missing')
  }
}

export function openChatWindow(target: ChatWindowTarget): void {
  hosts.get(chatWindowKey(target))?.open()
}

/** The sidebar may select and mount a cold chat before its window can be opened. */
export function requestChatWindow(target: ChatWindowTarget): void {
  const key = chatWindowKey(target)
  const host = hosts.get(key)
  requested = null
  if (host) host.open()
  else requested = { key, expires: Date.now() + 5_000 }
}

export function useChatWindowPlacement(target: ChatWindowTarget): Placement {
  const key = chatWindowKey(target)
  return useSyncExternalStore(subscribe, () => placements.get(key) ?? 'missing')
}

export function useDetachedChatKeys(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, () => detachedKeys)
}
