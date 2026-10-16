import type { CwdActivityKind } from '../../shared/local-conversation'
import { type LongCwdLease, restoreLongCwdLease, tryAcquireLongCwdLease } from '../cwd-activity-coordinator'
import { listActiveMoveEndpoints, type MoveEndpointRole } from './endpoint-store'

/**
 * The exclusive cwd leases a host's move endpoints hold: the source's checkout while it is frozen and exported, the
 * target's new worktree until the coordinator commits it. No chat turn, terminal or other exclusive operation starts
 * in a leased folder.
 */
const leases = new Map<string, LongCwdLease>()

export const moveLeaseOwner = (operationId: string): string => `conversation-move:${operationId}`
const key = (operationId: string, role: MoveEndpointRole): string => `${operationId}:${role}`

export function acquireMoveLease(
  operationId: string,
  role: MoveEndpointRole,
  cwd: string,
  drainableKinds: CwdActivityKind[] = []
): boolean {
  if (leases.has(key(operationId, role))) return true
  const lease = tryAcquireLongCwdLease(cwd, moveLeaseOwner(operationId), [], drainableKinds)
  if (!lease) return false
  leases.set(key(operationId, role), lease)
  return true
}

/** Takes the lease again after a restart; false when another owner holds the folder now. */
export function ensureMoveLease(operationId: string, role: MoveEndpointRole, cwd: string): boolean {
  if (leases.has(key(operationId, role))) return true
  const lease = restoreLongCwdLease(cwd, moveLeaseOwner(operationId))
  if (!lease) return false
  leases.set(key(operationId, role), lease)
  return true
}

export function releaseMoveLease(operationId: string, role: MoveEndpointRole): void {
  leases.get(key(operationId, role))?.release()
  leases.delete(key(operationId, role))
}

/** Restores the leases of every endpoint still holding a conversation, before any turn can resume after a restart. */
export function restoreMoveEndpointLeases(): void {
  for (const endpoint of listActiveMoveEndpoints()) {
    if (!endpoint.cwd || ensureMoveLease(endpoint.operationId, endpoint.role, endpoint.cwd)) continue
    console.warn(
      `[conversation-move] could not restore the ${endpoint.role} lease of ${endpoint.operationId} on ${endpoint.cwd}.`
    )
  }
}

export function __resetMoveLeasesForTests(): void {
  for (const lease of leases.values()) lease.release()
  leases.clear()
}
