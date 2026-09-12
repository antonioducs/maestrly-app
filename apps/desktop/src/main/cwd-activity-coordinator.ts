import fs from 'node:fs'
import path from 'node:path'
import type { CwdActivityItem, CwdActivityKind } from '../shared/local-conversation'

interface CwdState {
  active: Map<CwdActivityKind, number>
  idle: Map<CwdActivityKind, number>
  exclusiveOwner: string | null
  allowedOwners: Set<string>
  drainWaiters: Set<ActivityDrainWaiter>
}

interface ActivityDrainWaiter {
  kinds: Set<CwdActivityKind>
  timer: NodeJS.Timeout
  resolve(value: boolean): void
}

const states = new Map<string, CwdState>()
const ownedActivities = new Map<string, { key: string; state: CwdState; kind: CwdActivityKind }>()

export function canonicalCwd(cwd: string): string {
  const resolved = path.resolve(cwd)
  try {
    return fs.realpathSync.native(resolved)
  } catch {
    return resolved
  }
}

function stateFor(cwd: string): { key: string; state: CwdState } {
  const key = canonicalCwd(cwd)
  let state = states.get(key)
  if (!state) {
    state = {
      active: new Map(),
      idle: new Map(),
      exclusiveOwner: null,
      allowedOwners: new Set(),
      drainWaiters: new Set(),
    }
    states.set(key, state)
  }
  return { key, state }
}

function cleanup(key: string, state: CwdState): void {
  if (!state.exclusiveOwner && state.active.size === 0 && state.idle.size === 0 && state.drainWaiters.size === 0)
    states.delete(key)
}

function isAllowed(state: CwdState, owner?: string): boolean {
  return !state.exclusiveOwner || (!!owner && state.allowedOwners.has(owner))
}

function releaseCount(key: string, state: CwdState, map: Map<CwdActivityKind, number>, kind: CwdActivityKind): void {
  const count = map.get(kind) ?? 0
  if (count <= 1) map.delete(kind)
  else map.set(kind, count - 1)
  for (const waiter of [...state.drainWaiters]) {
    if ([...waiter.kinds].some((value) => (state.active.get(value) ?? 0) > 0)) continue
    state.drainWaiters.delete(waiter)
    clearTimeout(waiter.timer)
    waiter.resolve(true)
  }
  cleanup(key, state)
}

/**
 * Await already-admitted activities after revoking new migration owners. Covers the interval between
 * PTY activity acquisition and writing cwd hooks/configuration.
 */
export function waitForCwdActivityDrain(cwd: string, kinds: CwdActivityKind[], timeoutMs = 10_000): Promise<boolean> {
  const { key, state } = stateFor(cwd)
  const wanted = new Set(kinds)
  if (![...wanted].some((kind) => (state.active.get(kind) ?? 0) > 0)) {
    cleanup(key, state)
    return Promise.resolve(true)
  }
  return new Promise<boolean>((resolve) => {
    const waiter: ActivityDrainWaiter = {
      kinds: wanted,
      timer: setTimeout(() => {
        state.drainWaiters.delete(waiter)
        cleanup(key, state)
        resolve(false)
      }, timeoutMs),
      resolve,
    }
    state.drainWaiters.add(waiter)
  })
}

/** Short execution/mutation lease; fail closed while a Git transition holds exclusivity. */
export function tryAcquireCwdActivity(cwd: string, kind: CwdActivityKind, owner?: string): (() => void) | null {
  const { key, state } = stateFor(cwd)
  if (!isAllowed(state, owner)) {
    cleanup(key, state)
    return null
  }
  state.active.set(kind, (state.active.get(kind) ?? 0) + 1)
  let released = false
  return () => {
    if (released) return
    released = true
    releaseCount(key, state, state.active, kind)
  }
}

/**
 * Long-lived activity with stable ownership, such as a PTY turn. Repeated owner registration is
 * idempotent; clearing the owner releases it even if ready arrives through another path.
 */
export function setOwnedCwdActivity(
  owner: string,
  cwd: string,
  kind: CwdActivityKind,
  active: boolean,
  leaseOwner?: string
): boolean {
  const existing = ownedActivities.get(owner)
  if (!active) {
    if (!existing) return true
    ownedActivities.delete(owner)
    releaseCount(existing.key, existing.state, existing.state.active, existing.kind)
    return true
  }
  const key = canonicalCwd(cwd)
  if (existing) return existing.key === key && existing.kind === kind
  const { state } = stateFor(key)
  if (!isAllowed(state, leaseOwner)) {
    cleanup(key, state)
    return false
  }
  state.active.set(kind, (state.active.get(kind) ?? 0) + 1)
  ownedActivities.set(owner, { key, state, kind })
  return true
}

/** An open idle shell appears in preview but does not block transition. */
export function registerIdleCwdResource(cwd: string, kind: 'pty' | 'terminal'): () => void {
  const { key, state } = stateFor(cwd)
  state.idle.set(kind, (state.idle.get(kind) ?? 0) + 1)
  let released = false
  return () => {
    if (released) return
    released = true
    releaseCount(key, state, state.idle, kind)
  }
}

export function inspectCwdActivity(cwd: string): CwdActivityItem[] {
  const state = states.get(canonicalCwd(cwd))
  if (!state) return []
  const kinds: CwdActivityKind[] = ['pty', 'chat', 'terminal']
  const out: CwdActivityItem[] = []
  for (const kind of kinds) {
    const blocking = state.active.get(kind) ?? 0
    const idle = state.idle.get(kind) ?? 0
    if (blocking > 0) out.push({ kind, count: blocking, blocking: true })
    if (idle > 0) out.push({ kind, count: idle, blocking: false })
  }
  return out
}

export function hasBlockingCwdActivity(cwd: string): boolean {
  return inspectCwdActivity(cwd).some((item) => item.blocking)
}

export type CwdExclusiveResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: 'active' | 'exclusive'; activity: CwdActivityItem[] }

/** Short fail-closed exclusion; do not hold it while the user reads a preview. */
export async function tryWithCwdExclusive<T>(
  cwd: string,
  fn: () => Promise<T>,
  options: { allowActivity?: boolean } = {}
): Promise<CwdExclusiveResult<T>> {
  const { key, state } = stateFor(cwd)
  const activity = inspectCwdActivity(cwd)
  if (state.exclusiveOwner) {
    cleanup(key, state)
    return { ok: false, reason: 'exclusive', activity }
  }
  if (!options.allowActivity && activity.some((item) => item.blocking)) {
    cleanup(key, state)
    return { ok: false, reason: 'active', activity }
  }
  state.exclusiveOwner = `short:${Date.now()}:${Math.random()}`
  try {
    return { ok: true, value: await fn() }
  } finally {
    state.exclusiveOwner = null
    state.allowedOwners.clear()
    cleanup(key, state)
  }
}

export interface LongCwdLease {
  owner: string
  cwd: string
  allow(owner: string): void
  disallow(owner: string): void
  release(): void
}

/** Long lease for operations spanning preview, restart, and asynchronous validation. */
export function tryAcquireLongCwdLease(
  cwd: string,
  owner: string,
  allowedOwners: string[] = [],
  drainableKinds: CwdActivityKind[] = []
): LongCwdLease | null {
  const { key, state } = stateFor(cwd)
  const drainable = new Set(drainableKinds)
  const hasUndrainableActivity = [...state.active.entries()].some(([kind, count]) => count > 0 && !drainable.has(kind))
  if (state.exclusiveOwner || hasUndrainableActivity) {
    cleanup(key, state)
    return null
  }
  state.exclusiveOwner = owner
  state.allowedOwners = new Set(allowedOwners)
  let released = false
  return {
    owner,
    cwd: key,
    allow(value) {
      if (!released && state.exclusiveOwner === owner) state.allowedOwners.add(value)
    },
    disallow(value) {
      if (!released && state.exclusiveOwner === owner) state.allowedOwners.delete(value)
    },
    release() {
      if (released) return
      released = true
      if (state.exclusiveOwner === owner) {
        state.exclusiveOwner = null
        state.allowedOwners.clear()
      }
      cleanup(key, state)
    },
  }
}

export function restoreLongCwdLease(cwd: string, owner: string, allowedOwners: string[] = []): LongCwdLease | null {
  return tryAcquireLongCwdLease(cwd, owner, allowedOwners)
}

export function cwdLeaseOwner(cwd: string): string | null {
  return states.get(canonicalCwd(cwd))?.exclusiveOwner ?? null
}

export function __resetCwdActivityForTests(): void {
  for (const state of states.values()) {
    for (const waiter of state.drainWaiters) {
      clearTimeout(waiter.timer)
      waiter.resolve(false)
    }
    state.drainWaiters.clear()
  }
  ownedActivities.clear()
  states.clear()
}
