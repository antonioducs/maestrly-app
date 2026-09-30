import { LOCAL_HOST_ID } from '../shared/host-key'
import { type HostApi, localHostApi } from './host-api'

export const hostsApi = {
  /** The host API of a host; this computer is `'local'`. */
  hostApi: (hostId: string): HostApi => {
    if (hostId === LOCAL_HOST_ID) return localHostApi
    throw new Error('Unknown host')
  },
}
