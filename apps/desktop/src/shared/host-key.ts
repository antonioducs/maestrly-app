/**
 * A host is a Maestrly main process with its own profile: this computer, or a workspaces host on a server. One window
 * shows conversations of several hosts, whose ids are only unique within their host.
 */

/** This computer's own Maestrly profile, among the hosts a window can show. */
export const LOCAL_HOST_ID = 'local'

/** `'local'`, or `<serverId>/<environmentId>` for a workspaces host on a server. */
export type HostId = string

const HOST_KEY_SEPARATOR = '#'
// Neither part can hold the key separator, so a host key always splits at its first `#`.
const REMOTE_HOST_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}\/[a-z0-9][a-z0-9-]{0,62}$/

export const isRemoteHostId = (hostId: HostId): boolean => hostId !== LOCAL_HOST_ID

export const isValidHostId = (hostId: string): boolean => hostId === LOCAL_HOST_ID || REMOTE_HOST_ID_RE.test(hostId)

export const remoteHostId = (serverId: string, environmentId: string): HostId => `${serverId}/${environmentId}`

/** An id made unique across hosts: this computer's ids stay as they are, so local state and storage keys do not move. */
export const hostKey = (hostId: HostId, id: string): string =>
  hostId === LOCAL_HOST_ID ? id : `${hostId}${HOST_KEY_SEPARATOR}${id}`

export function parseHostKey(key: string): { hostId: HostId; id: string } {
  const at = key.indexOf(HOST_KEY_SEPARATOR)
  return at < 0 ? { hostId: LOCAL_HOST_ID, id: key } : { hostId: key.slice(0, at), id: key.slice(at + 1) }
}
