import { useSyncExternalStore } from 'react'

type Listener = () => void

const listeners = new Set<Listener>()
let enabled: boolean | null = null
let sourceStarted = false
let eventRevision = 0

function notify(next: boolean): void {
  if (enabled === next) return
  enabled = next
  for (const listener of listeners) listener()
}

function startSource(): void {
  if (sourceStarted) return
  sourceStarted = true

  window.api.onMemoryAutoReclaimChanged((event) => {
    eventRevision++
    notify(event.enabled)
  })

  const snapshotRevision = eventRevision
  void window.api.getMemoryAutoReclaim().then((next) => {
    // An event received after the request started is newer than this snapshot.
    if (snapshotRevision === eventRevision) notify(next)
  })
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener)
  startSource()
  return () => listeners.delete(listener)
}

function getSnapshot(): boolean | null {
  return enabled
}

/** Renderer-wide source of truth for the main-process automatic reclaim kill switch. */
export function useMemoryAutoReclaim(): boolean | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
