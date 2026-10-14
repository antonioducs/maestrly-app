import { useSyncExternalStore } from 'react'
import { type HostId, LOCAL_HOST_ID } from '../../../shared/host-key'
import type { HostView } from '../../../shared/hosts'
import { useHostId } from './host-context'

const hasWindow = (): boolean => typeof window !== 'undefined' && !!window.api

/** This computer, as far as the renderer knows before the main process answers. */
function localHost(): HostView {
  return {
    id: LOCAL_HOST_ID,
    remote: false,
    label: '',
    server: '',
    tint: null,
    state: 'online',
    epoch: 0,
    os: hasWindow() ? window.api.platformInfo.os : 'mac',
    homeDir: '',
    desktopEffects: true,
    editor: true,
    browser: true,
    environment: null,
    hostVersion: null,
  }
}

let hosts: HostView[] | null = null
let started = false
const listeners = new Set<() => void>()

function set(next: HostView[]): void {
  hosts = next.length ? next : [localHost()]
  for (const listener of [...listeners]) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (!started && hasWindow()) {
    started = true
    window.api.onHostsChanged(set)
    void window.api
      .hostsList()
      .then(set)
      .catch(() => undefined)
  }
  return () => void listeners.delete(listener)
}

const snapshot = (): HostView[] => (hosts ??= [localHost()])

/** This computer first, then each remote host, with how each one is reached now. */
export const useHosts = (): HostView[] => useSyncExternalStore(subscribe, snapshot, snapshot)

/** What a host is: the one given, or the one the component renders in. A host that left is described as offline. */
export function useHostInfo(hostId?: HostId): HostView {
  const current = useHostId()
  const id = hostId ?? current
  const all = useHosts()
  return (
    all.find((host) => host.id === id) ??
    (id === LOCAL_HOST_ID ? all[0] : { ...localHost(), id, remote: true, state: 'offline', desktopEffects: false })
  )
}
