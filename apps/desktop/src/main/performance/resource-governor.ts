/**
 * Decide when a visual surface needs an unthrottled renderer. The governor does not depend on Electron
 * drawers, React, MCP, or lifecycle managers; callers report visibility/placement/activity and
 * registered targets receive throttling decisions.
 */

export type ResourceKind = 'browser' | 'chatgpt' | 'vscode' | 'panel'
export type WakeReason = 'visible' | 'agent' | 'floating' | 'popup'

export type ResourceState = {
  reasons: Set<WakeReason>
  agentActivityCount?: number
  agentLeaseUntil?: number
  lastUsedAt: number
}

export const AGENT_LEASE_GRACE_MS = 30_000

export interface ThrottleTarget {
  setBackgroundThrottling: (throttled: boolean) => void
  isDestroyed?: () => boolean
  once?: (event: 'destroyed', listener: () => void) => unknown
  /** Optional side effect for domains/capture that must follow the same full-speed decision. */
  onFullSpeedChange?: (fullSpeed: boolean) => void | Promise<void>
}

type ResourceRecord = ResourceState & {
  kind: ResourceKind
  convId: string
  resourceId?: string
  target?: ThrottleTarget
  fullSpeed?: boolean
}

export interface ResourceGovernorDiagnostics {
  total: number
  fullSpeed: number
  throttled: number
  activeAgentLeases: number
  byKind: Record<ResourceKind, { total: number; fullSpeed: number; throttled: number }>
}

const resources = new Map<string, ResourceRecord>()
let expiryTimer: ReturnType<typeof setTimeout> | null = null
let scheduledExpiryAt: number | null = null

const keyFor = (kind: ResourceKind, convId: string, resourceId?: string): string =>
  `${kind}:${convId}:${resourceId ?? ''}`

function getOrCreate(kind: ResourceKind, convId: string, resourceId?: string): ResourceRecord {
  const key = keyFor(kind, convId, resourceId)
  let record = resources.get(key)
  if (!record) {
    record = {
      kind,
      convId,
      ...(resourceId ? { resourceId } : {}),
      reasons: new Set<WakeReason>(),
      lastUsedAt: Date.now(),
    }
    resources.set(key, record)
  }
  return record
}

function hasActiveLease(record: ResourceRecord, now = Date.now()): boolean {
  return (record.agentActivityCount ?? 0) > 0 || (record.agentLeaseUntil !== undefined && record.agentLeaseUntil > now)
}

export function resourceNeedsFullSpeed(
  kind: ResourceKind,
  convId: string,
  resourceId?: string,
  now = Date.now()
): boolean {
  const record = resources.get(keyFor(kind, convId, resourceId))
  if (!record) return false
  return record.reasons.size > 0 || hasActiveLease(record, now)
}

/** True only while the renderer is actually presented in a slot, popup or floating window.
 * Agent leases are deliberately excluded so memory lifecycle can distinguish work from visibility. */
export function resourceHasVisibleSurface(kind: ResourceKind, convId: string, resourceId?: string): boolean {
  const reasons = resources.get(keyFor(kind, convId, resourceId))?.reasons
  return !!reasons && (reasons.has('visible') || reasons.has('popup') || reasons.has('floating'))
}

function safelyApply(record: ResourceRecord, throttled: boolean): void {
  const target = record.target
  if (!target) return
  try {
    if (target.isDestroyed?.()) {
      record.target = undefined
      return
    }
    target.setBackgroundThrottling(throttled)
    record.fullSpeed = !throttled
    void Promise.resolve(target.onFullSpeedChange?.(!throttled)).catch(() => {})
  } catch {
    // A destroyed WebContents can race this call during shutdown. Drop the target;
    // the governor must never take down the main process.
    record.target = undefined
  }
}

function apply(record: ResourceRecord, now = Date.now()): void {
  const fullSpeed = record.reasons.size > 0 || hasActiveLease(record, now)
  if (record.fullSpeed === fullSpeed && record.target) return
  safelyApply(record, !fullSpeed)
}

function scheduleExpiry(): void {
  let next: number | null = null
  const now = Date.now()
  for (const record of resources.values()) {
    if (record.agentLeaseUntil !== undefined && record.agentLeaseUntil > now) {
      next = next === null ? record.agentLeaseUntil : Math.min(next, record.agentLeaseUntil)
    }
  }

  if (next === null) {
    if (expiryTimer) clearTimeout(expiryTimer)
    expiryTimer = null
    scheduledExpiryAt = null
    return
  }
  if (expiryTimer && scheduledExpiryAt === next) return
  if (expiryTimer) clearTimeout(expiryTimer)
  scheduledExpiryAt = next
  expiryTimer = setTimeout(
    () => {
      expiryTimer = null
      scheduledExpiryAt = null
      const current = Date.now()
      for (const record of resources.values()) {
        if (record.agentLeaseUntil !== undefined && record.agentLeaseUntil <= current) {
          if ((record.agentActivityCount ?? 0) > 0) {
            // An in-flight tool owns the resource independently of the grace timer. This branch is
            // defensive for a clock jump or a timer scheduled before acquire; release starts a fresh
            // grace period after the tool actually finishes.
            record.agentLeaseUntil = undefined
          } else {
            record.agentLeaseUntil = undefined
            record.reasons.delete('agent')
          }
          apply(record, current)
        }
      }
      scheduleExpiry()
    },
    Math.max(0, next - now)
  )
}

export function registerThrottleTarget(
  kind: ResourceKind,
  convId: string,
  resourceId: string | undefined,
  target: ThrottleTarget
): void {
  const record = getOrCreate(kind, convId, resourceId)
  const previousTarget = record.target
  record.target = target
  // A view can be recreated for the same logical resource after a renderer crash. Force the new
  // WebContents to receive the current decision even when the previous target had the same state.
  record.fullSpeed = undefined
  if (target.once && previousTarget !== target) {
    target.once('destroyed', () => {
      // Do not let a late destroyed event from an old renderer delete a replacement target that
      // already owns this logical resource.
      if (resources.get(keyFor(kind, convId, resourceId))?.target === target) {
        unregisterThrottleTarget(kind, convId, resourceId)
      }
    })
  }
  // New Electron WebContents use normal Chromium defaults, so apply the current
  // decision immediately instead of relying on construction-time preferences.
  apply(record)
  scheduleExpiry()
}

export function unregisterThrottleTarget(kind: ResourceKind, convId: string, resourceId?: string): void {
  const key = keyFor(kind, convId, resourceId)
  resources.delete(key)
  scheduleExpiry()
}

function setReason(
  kind: ResourceKind,
  convId: string,
  resourceId: string | undefined,
  reason: WakeReason,
  active: boolean
): void {
  const record = getOrCreate(kind, convId, resourceId)
  if (active) {
    record.reasons.add(reason)
    record.lastUsedAt = Date.now()
  } else {
    record.reasons.delete(reason)
    if (reason === 'agent') {
      record.agentActivityCount = 0
      record.agentLeaseUntil = undefined
    }
  }
  apply(record)
  scheduleExpiry()
}

export function setResourceVisible(
  kind: ResourceKind,
  convId: string,
  resourceId: string | undefined,
  visible: boolean
): void {
  setReason(kind, convId, resourceId, 'visible', visible)
}

export function setResourcePlacementActive(
  kind: ResourceKind,
  convId: string,
  resourceId: string | undefined,
  reason: 'floating' | 'popup',
  active: boolean
): void {
  setReason(kind, convId, resourceId, reason, active)
}

export function touchAgentActivity(kind: ResourceKind, convId: string, resourceId?: string): void {
  const record = getOrCreate(kind, convId, resourceId)
  const now = Date.now()
  if ((record.agentActivityCount ?? 0) === 0) record.agentLeaseUntil = now + AGENT_LEASE_GRACE_MS
  record.reasons.add('agent')
  record.lastUsedAt = now
  apply(record, now)
  scheduleExpiry()
}

/**
 * Owns a resource for the duration of an in-flight agent operation. Unlike a plain touch, this
 * cannot expire while the awaited browser/tool promise is still running. The returned release starts
 * the normal think-time grace period.
 */
export function acquireAgentActivity(kind: ResourceKind, convId: string, resourceId?: string): () => void {
  const record = getOrCreate(kind, convId, resourceId)
  record.agentActivityCount = (record.agentActivityCount ?? 0) + 1
  record.agentLeaseUntil = undefined
  record.reasons.add('agent')
  record.lastUsedAt = Date.now()
  apply(record)
  scheduleExpiry()

  let released = false
  return () => {
    if (released) return
    released = true
    const current = resources.get(keyFor(kind, convId, resourceId))
    // A resource can be disposed and recreated under the same logical key while an old tool is
    // still awaiting. Never let that stale release decrement the replacement's activity count.
    if (!current || current !== record) return
    const count = Math.max(0, (current.agentActivityCount ?? 0) - 1)
    current.agentActivityCount = count
    if (count === 0) {
      const now = Date.now()
      current.agentLeaseUntil = now + AGENT_LEASE_GRACE_MS
      current.reasons.add('agent')
      current.lastUsedAt = now
      apply(current, now)
      scheduleExpiry()
    } else {
      apply(current)
    }
  }
}

export function disposeConversationResources(convId: string): void {
  for (const [key, record] of resources) {
    if (record.convId === convId) resources.delete(key)
  }
  scheduleExpiry()
}

export function getResourceGovernorDiagnostics(): ResourceGovernorDiagnostics {
  const byKind: ResourceGovernorDiagnostics['byKind'] = {
    browser: { total: 0, fullSpeed: 0, throttled: 0 },
    chatgpt: { total: 0, fullSpeed: 0, throttled: 0 },
    vscode: { total: 0, fullSpeed: 0, throttled: 0 },
    panel: { total: 0, fullSpeed: 0, throttled: 0 },
  }
  const now = Date.now()
  let fullSpeed = 0
  let activeAgentLeases = 0
  for (const record of resources.values()) {
    const state = byKind[record.kind]
    const isFullSpeed = record.reasons.size > 0 || hasActiveLease(record, now)
    state.total++
    if (isFullSpeed) {
      state.fullSpeed++
      fullSpeed++
    } else state.throttled++
    if (hasActiveLease(record, now)) activeAgentLeases++
  }
  return {
    total: resources.size,
    fullSpeed,
    throttled: resources.size - fullSpeed,
    activeAgentLeases,
    byKind,
  }
}

/** Test/quit seam: cancel the single agenda and forget all targets. */
export function disposeResourceGovernor(): void {
  if (expiryTimer) clearTimeout(expiryTimer)
  expiryTimer = null
  scheduledExpiryAt = null
  resources.clear()
}
