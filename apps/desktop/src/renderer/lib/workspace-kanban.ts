import { useSyncExternalStore } from 'react'
import type { HostId } from '../../shared/host-key'
import type { WorkspaceKanbanLink } from '../../shared/platform'
import { hostApi, useHostId } from './hosts/host-context'

/** The Kanban links of one host's workspaces, loaded while at least one component shows them. */
interface KanbanStore {
  subscribe: (listener: () => void) => () => void
  links: () => WorkspaceKanbanLink[]
}

const stores = new Map<HostId, KanbanStore>()

function createStore(hostId: HostId): KanbanStore {
  const api = hostApi(hostId)
  let links: WorkspaceKanbanLink[] = []
  const listeners = new Set<() => void>()
  let unsubscribe: (() => void) | undefined
  let revision = 0
  async function reload() {
    const request = ++revision
    try {
      const next = await api.platformWorkspaceLinks()
      if (request !== revision) return
      links = next
      for (const listener of listeners) listener()
    } catch {
      /* Keep cached labels visible when the platform is unavailable. */
    }
  }
  return {
    links: () => links,
    subscribe: (listener) => {
      listeners.add(listener)
      if (listeners.size === 1) {
        unsubscribe = api.onPlatformLinksChanged(() => void reload())
        void reload()
        void api.platformRefreshWorkspaceLinks().catch(() => {})
      }
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) {
          unsubscribe?.()
          unsubscribe = undefined
          revision++
        }
      }
    },
  }
}

function storeOf(hostId: HostId): KanbanStore {
  let store = stores.get(hostId)
  if (!store) {
    store = createStore(hostId)
    stores.set(hostId, store)
  }
  return store
}

/** The Kanban project linked to a workspace of the surrounding host. */
export function useWorkspaceKanban(workspaceId: string) {
  const store = storeOf(useHostId())
  return useSyncExternalStore(store.subscribe, store.links).find((link) => link.workspaceId === workspaceId)
}
