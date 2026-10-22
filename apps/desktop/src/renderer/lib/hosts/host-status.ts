import type { HostView } from '../../../shared/hosts'

/**
 * Why a remote host shows no live lists: how this computer reaches it and, while it is not reached at all, what its
 * environment does on the server, or what the paired computer said when it refused this one.
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
  | 'not-hosting'
  | 'removed'
  | 'disconnected'
  | 'identity-changed'

export function hostSectionStatus(host: Pick<HostView, 'state' | 'environment' | 'peer'>): HostSectionStatus {
  if (host.state === 'online' || host.state === 'incompatible') return host.state
  // A paired computer's refusal says more than the connection's state: it stands until the computer answers again.
  const problem = host.peer?.problem
  if (problem) return problem
  if (host.state !== 'offline') return host.state
  const lifecycle = host.environment?.lifecycle
  if (lifecycle === 'stopped' || lifecycle === 'stopping') return 'stopped'
  if (lifecycle === 'creating' || lifecycle === 'starting' || lifecycle === 'restarting') return 'starting'
  if (lifecycle === 'failed') return 'failed'
  return 'offline'
}

/** Whether dialing the host again may help: it was reached before, or only refused this computer for now. */
export function hostRetryable(status: HostSectionStatus): boolean {
  return (
    status === 'connecting' ||
    status === 'reconnecting' ||
    status === 'incompatible' ||
    status === 'offline' ||
    status === 'not-hosting' ||
    status === 'disconnected'
  )
}
