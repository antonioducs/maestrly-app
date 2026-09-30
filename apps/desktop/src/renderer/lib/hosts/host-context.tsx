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

const lazyApis = new Map<HostId, HostApi>()

/**
 * A host API that reaches the preload on first use, not when it is obtained: a component gets it while rendering,
 * and rendering must not touch the bridge (components also render where there is no window, as in static markup).
 */
function lazyHostApi(hostId: HostId): HostApi {
  let api = lazyApis.get(hostId)
  if (!api) {
    api = new Proxy({} as HostApi, {
      get: (_target, member) => hostApi(hostId)[member as keyof HostApi],
    })
    lazyApis.set(hostId, api)
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
  return useMemo(() => lazyHostApi(hostId), [hostId])
}
