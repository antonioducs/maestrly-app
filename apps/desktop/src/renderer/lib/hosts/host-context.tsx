import { createContext, type ReactNode, useContext, useMemo } from 'react'
import type { HostApi } from '../../../preload'
import { type HostId, LOCAL_HOST_ID } from '../../../shared/host-key'

const apis = new Map<HostId, HostApi>()

/** The host API of a host, cached: `window.api.hostApi` copies the whole object across the context bridge. */
export function hostApi(hostId: HostId): HostApi {
  let api = apis.get(hostId)
  if (!api) {
    api = window.api.hostApi(hostId)
    apis.set(hostId, api)
  }
  return api
}

const HostContext = createContext<HostId>(LOCAL_HOST_ID)

/** Everything rendered inside talks to this host's backend; outside any provider, the host is this computer. */
export function HostProvider({ hostId, children }: { hostId: HostId; children: ReactNode }) {
  return <HostContext.Provider value={hostId}>{children}</HostContext.Provider>
}

export const useHostId = (): HostId => useContext(HostContext)

export function useHostApi(): HostApi {
  const hostId = useHostId()
  return useMemo(() => hostApi(hostId), [hostId])
}
