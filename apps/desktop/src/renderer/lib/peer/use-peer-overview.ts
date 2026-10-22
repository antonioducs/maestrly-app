import { useSyncExternalStore } from 'react'
import type { PeerOverview } from '../../../shared/peer'

const hasPeerApi = (): boolean => typeof window !== 'undefined' && typeof window.api?.peerOverview === 'function'

let overview: PeerOverview | null = null
let started = false
const listeners = new Set<() => void>()

function set(next: PeerOverview): void {
  overview = next
  for (const listener of [...listeners]) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (!started && hasPeerApi()) {
    started = true
    window.api.onPeerChanged(set)
    void window.api
      .peerOverview()
      .then(set)
      .catch(() => undefined)
  }
  return () => void listeners.delete(listener)
}

const snapshot = (): PeerOverview | null => overview

/**
 * This computer among the owner's computers, as the main process last pushed it: whether it shares itself, the
 * computers it paired with, and a pairing another one asks for. Null until the main process answers.
 */
export const usePeerOverview = (): PeerOverview | null => useSyncExternalStore(subscribe, snapshot, snapshot)

/** Keeps what a call answered, ahead of the push that follows it. */
export const acceptPeerOverview = (next: PeerOverview): void => set(next)
