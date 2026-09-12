import { restoreLongCwdLease, tryAcquireLongCwdLease, type LongCwdLease } from '../cwd-activity-coordinator'

export interface MigrationRuntimeLease {
  owner: string
  source: LongCwdLease
  destination?: LongCwdLease
  release(): void
}

const leases = new Map<string, MigrationRuntimeLease>()

export function acquireMigrationLease(
  operationId: string,
  conversationId: string,
  sourceCwd: string
): MigrationRuntimeLease | null {
  // Idle siblings do not block: the exclusive cwd lease prevents new turns/spawns during migration, and
  // preparation rejects active sibling turns. Only existing exclusive leases prevent acquisition here.
  void conversationId
  const owner = `migration:${operationId}`
  const source = tryAcquireLongCwdLease(
    sourceCwd,
    owner,
    [],
    // The barrier stops this conversation's PTY, Chat, and terminal resources.
    ['pty', 'chat', 'terminal']
  )
  if (!source) return null
  const lease: MigrationRuntimeLease = {
    owner,
    source,
    release() {
      source.release()
      this.destination?.release()
      leases.delete(operationId)
    },
  }
  leases.set(operationId, lease)
  return lease
}

export function attachMigrationDestinationLease(operationId: string, destinationCwd: string): boolean {
  const lease = leases.get(operationId)
  if (!lease) return false
  const destination = tryAcquireLongCwdLease(destinationCwd, lease.owner)
  if (!destination) return false
  lease.destination = destination
  return true
}

export function restoreMigrationLease(
  operationId: string,
  sourceCwd: string,
  destinationCwd?: string
): MigrationRuntimeLease | null {
  const existing = leases.get(operationId)
  if (existing) return existing
  const owner = `migration:${operationId}`
  const source = restoreLongCwdLease(sourceCwd, owner)
  if (!source) return null
  const destination = destinationCwd ? (restoreLongCwdLease(destinationCwd, owner) ?? undefined) : undefined
  if (destinationCwd && !destination) {
    source.release()
    return null
  }
  const lease: MigrationRuntimeLease = {
    owner,
    source,
    destination,
    release() {
      source.release()
      destination?.release()
      leases.delete(operationId)
    },
  }
  leases.set(operationId, lease)
  return lease
}

export function getMigrationLease(operationId: string): MigrationRuntimeLease | undefined {
  return leases.get(operationId)
}

export function __resetMigrationLeasesForTests(): void {
  for (const lease of leases.values()) lease.release()
  leases.clear()
}
