import { createContext, type ReactNode, useContext } from 'react'
import type { HostApi } from '../../../preload'
import { type HostId, LOCAL_HOST_ID } from '../../../shared/host-key'

const preloadApis = new Map<HostId, HostApi>()
const apis = new Map<HostId, HostApi>()

/**
 * The host API of a host: one object per host, the same on every call. It reaches the preload when a member is first
 * used, not when it is obtained: components obtain it while rendering, and rendering must not touch the bridge (they
 * also render where there is no window, as in static markup). The preload's object is then kept, because
 * `window.api.hostApi` copies the whole API across the context bridge on every call.
 */
export function hostApi(hostId: HostId): HostApi {
  let api = apis.get(hostId)
  if (!api) {
    const preloadApi = (): HostApi => {
      let value = preloadApis.get(hostId)
      if (!value) {
        value = window.api.hostApi(hostId)
        preloadApis.set(hostId, value)
      }
      return value
    }
    api = new Proxy({} as HostApi, { get: (_target, member) => preloadApi()[member as keyof HostApi] })
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

export const useHostApi = (): HostApi => hostApi(useHostId())
