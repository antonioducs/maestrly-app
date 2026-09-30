import type { HostView } from '../../../shared/hosts'

/**
 * Why a remote host shows no live lists: how this computer reaches it and, while it is not reached at all, what its
 * environment does on the server.
 */
export type HostSectionStatus =
  | 'online'
  | 'connecting'
  | 'reconnecting'
  | 'incompatible'
  | 'stopped'
  | 'starting'
  | 'failed'
  | 'offline'

export function hostSectionStatus(host: HostView): HostSectionStatus {
  if (host.state !== 'offline') return host.state
  const lifecycle = host.environment?.lifecycle
  if (lifecycle === 'stopped' || lifecycle === 'stopping') return 'stopped'
  if (lifecycle === 'creating' || lifecycle === 'starting' || lifecycle === 'restarting') return 'starting'
  if (lifecycle === 'failed') return 'failed'
  return 'offline'
}
