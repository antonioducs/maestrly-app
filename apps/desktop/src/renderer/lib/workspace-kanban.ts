import { useSyncExternalStore } from 'react'
import type { WorkspaceKanbanLink } from '../../shared/platform'

let links: WorkspaceKanbanLink[] = []
const listeners = new Set<() => void>()
let unsubscribe: (() => void) | undefined
let revision = 0
async function reload() {
  const request = ++revision
  try {
    const next = await window.api.platformWorkspaceLinks()
    if (request !== revision) return
    links = next
    for (const listener of listeners) listener()
  } catch {
    /* Keep cached labels visible when the platform is unavailable. */
  }
}
function subscribe(listener: () => void) {
  listeners.add(listener)
  if (listeners.size === 1) {
    unsubscribe = window.api.onPlatformLinksChanged(() => void reload())
    void reload()
    void window.api.platformRefreshWorkspaceLinks().catch(() => {})
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      unsubscribe?.()
      unsubscribe = undefined
      revision++
    }
  }
}
export function useWorkspaceKanban(workspaceId: string) {
  return useSyncExternalStore(subscribe, () => links).find((link) => link.workspaceId === workspaceId)
}
