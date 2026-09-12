import os from 'node:os'
import { getAppFlag, setAppFlag } from '../store'
import type {
  MemoryPressureEvent,
  MemoryAutoReclaimChangedEvent,
  MemoryReclaimKind,
  MemoryReclaimResult,
  MemoryReclaimerResourceSnapshot,
  MemoryReclaimerSnapshot,
  MemoryResourceState,
} from '../../shared/performance'
import {
  classifyMemoryPressure,
  MEMORY_AUTO_RECLAIM_KEY,
  MEMORY_RECLAIM_RETRY_MS,
  PRESSURE_SAMPLE_INTERVAL_MS,
  memoryPressureLimits,
} from './policy'

export interface ReclaimProtection {
  protected: boolean
  reasons: string[]
}

export interface ReclaimableResource {
  key: string
  kind: MemoryReclaimKind
  lastActiveAt: () => number
  coldTtlMs: number
  priority: number
  estimatedBytes?: () => number | undefined
  protection: () => Promise<ReclaimProtection> | ReclaimProtection
  prepare: () => Promise<{ ok: boolean; reason?: string }>
  /** Effective scan mode: normal/soft uses TTL; hard means pressure or manual reclamation. */
  evict: (mode?: PressureLevel) => Promise<void> | void
}

export interface MemoryPressureSample {
  workingSetBytes: number
  physicalRamBytes?: number
}

/**
 * Registered pressure-sample source may be async. Single-flight sampling skips overlapping ticks
 * instead of queueing them.
 */
export type PressureSampleSource = () => MemoryPressureSample | null | Promise<MemoryPressureSample | null>

type PressureLevel = MemoryReclaimerSnapshot['pressure']

const resources = new Map<string, ReclaimableResource>()
const listeners = new Set<(event: MemoryPressureEvent) => void>()

let enabledOverride: boolean | null = null
let agendaTimer: ReturnType<typeof setTimeout> | null = null
let scheduledAt: number | null = null
let lastSweepAt: number | null = null
let lastWorkingSet = 0
let lastPressure: PressureLevel = 'normal'
let lastLimits = memoryPressureLimits(os.totalmem())
let sweeping = false
let pressureSampleSource: PressureSampleSource | null = null
let samplerTimer: ReturnType<typeof setInterval> | null = null
let samplerBusy = false

function now(): number {
  return Date.now()
}

export function isMemoryAutoReclaimEnabled(): boolean {
  if (enabledOverride != null) return enabledOverride
  try {
    return getAppFlag(MEMORY_AUTO_RECLAIM_KEY, true)
  } catch {
    return true
  }
}

export function setMemoryAutoReclaimEnabled(enabled: boolean): void {
  enabledOverride = null
  const nextEnabled = enabled === true
  setAppFlag(MEMORY_AUTO_RECLAIM_KEY, nextEnabled)
  if (nextEnabled) {
    scheduleMemoryReclaim()
  } else {
    clearAgenda()
    normalizePressureSignal()
  }
  syncPressureSampler()
  emitAutoReclaimChanged(nextEnabled)
  if (nextEnabled) void runPressureSample()
}

/** Test seam: force the kill switch without touching app_settings. */
export function setMemoryAutoReclaimEnabledForTests(enabled: boolean | null): void {
  enabledOverride = enabled
  if (enabled) {
    scheduleMemoryReclaim()
  } else {
    clearAgenda()
    normalizePressureSignal()
  }
  syncPressureSampler()
  if (enabled) void runPressureSample()
}

export function onMemoryPressure(listener: (event: MemoryPressureEvent) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function emitPressure(event: MemoryPressureEvent): void {
  for (const listener of listeners) {
    try {
      listener(event)
    } catch {
      /* a diagnostic subscriber must never take down reclaim */
    }
  }
  void import('../window-ipc').then(({ broadcast }) => broadcast('performance:memory-pressure', event)).catch(() => {})
}

function emitAutoReclaimChanged(enabled: boolean): void {
  const event: MemoryAutoReclaimChangedEvent = { enabled }
  void import('../window-ipc')
    .then(({ broadcast }) => broadcast('performance:auto-reclaim-changed', event))
    .catch(() => {})
}

function normalizePressureSignal(): void {
  if (lastPressure === 'normal') return
  lastPressure = 'normal'
  emitPressure({
    level: 'normal',
    workingSetBytes: lastWorkingSet,
    softLimitBytes: lastLimits.soft,
    hardLimitBytes: lastLimits.hard,
  })
}

function clearAgenda(): void {
  if (agendaTimer) clearTimeout(agendaTimer)
  agendaTimer = null
  scheduledAt = null
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  const maybe = timer as unknown as { unref?: () => void }
  maybe.unref?.()
}

/**
 * The reclaimer owns one unreferenced 30-second pressure interval, plus an initial sample on
 * registration. This updates pressure/eviction independently of manual Settings snapshots.
 */
function syncPressureSampler(): void {
  if (samplerTimer) {
    clearInterval(samplerTimer)
    samplerTimer = null
  }
  if (!pressureSampleSource || !isMemoryAutoReclaimEnabled()) return
  samplerTimer = setInterval(() => {
    void runPressureSample()
  }, PRESSURE_SAMPLE_INTERVAL_MS)
  unrefTimer(samplerTimer)
}

async function runPressureSample(): Promise<void> {
  if (samplerBusy || !pressureSampleSource) return
  samplerBusy = true
  try {
    const sample = await pressureSampleSource()
    if (sample) noteMemorySample(sample)
  } catch {
    /* sampling must never terminate the reclaimer */
  } finally {
    samplerBusy = false
  }
}

export function registerPressureSampleSource(source: PressureSampleSource | null): void {
  pressureSampleSource = source
  syncPressureSampler()
  if (source) void runPressureSample()
}

function deadlineOf(resource: ReclaimableResource, at = now()): number {
  return resource.lastActiveAt() + resource.coldTtlMs
}

function isExpired(resource: ReclaimableResource, at = now()): boolean {
  return at - resource.lastActiveAt() >= resource.coldTtlMs
}

async function resolveProtection(resource: ReclaimableResource): Promise<ReclaimProtection> {
  try {
    const result = await resource.protection()
    if (!result || typeof result.protected !== 'boolean') {
      return { protected: true, reasons: ['unknown'] }
    }
    return {
      protected: result.protected,
      reasons: Array.isArray(result.reasons) ? result.reasons : [],
    }
  } catch {
    return { protected: true, reasons: ['protection-failed'] }
  }
}

function stateOf(resource: ReclaimableResource, protection: ReclaimProtection, at = now()): MemoryResourceState {
  if (protection.protected) return 'protected'
  return isExpired(resource, at) ? 'cold' : 'hot'
}

export function registerReclaimable(resource: ReclaimableResource): void {
  resources.set(resource.key, resource)
  scheduleMemoryReclaim()
}

export function unregisterReclaimable(key: string): void {
  resources.delete(key)
  scheduleMemoryReclaim()
}

export function touchReclaimable(key: string): void {
  if (resources.has(key)) scheduleMemoryReclaim()
}

export function listReclaimableKeys(): string[] {
  return [...resources.keys()]
}

function currentLimits(physicalRamBytes?: number): { soft: number; hard: number } {
  lastLimits = memoryPressureLimits(physicalRamBytes ?? os.totalmem())
  return lastLimits
}

export function noteMemorySample(sample: MemoryPressureSample): PressureLevel {
  lastWorkingSet = Math.max(0, sample.workingSetBytes)
  const limits = currentLimits(sample.physicalRamBytes)
  const next = isMemoryAutoReclaimEnabled() ? classifyMemoryPressure(lastWorkingSet, limits) : 'normal'
  if (next !== lastPressure) {
    lastPressure = next
    emitPressure({
      level: next,
      workingSetBytes: lastWorkingSet,
      softLimitBytes: limits.soft,
      hardLimitBytes: limits.hard,
    })
  } else {
    lastPressure = next
  }
  if (next !== 'normal' && isMemoryAutoReclaimEnabled()) void runMemoryReclaim(next)
  else scheduleMemoryReclaim()
  return next
}

async function evictOne(
  resource: ReclaimableResource,
  generation: ReclaimableResource,
  mode: PressureLevel
): Promise<{ evicted: boolean; reasons: string[] }> {
  const first = await resolveProtection(resource)
  if (first.protected) return { evicted: false, reasons: first.reasons.length ? first.reasons : ['protected'] }
  let prepared: { ok: boolean; reason?: string }
  try {
    prepared = await resource.prepare()
  } catch {
    return { evicted: false, reasons: ['prepare-failed'] }
  }
  if (!prepared?.ok) return { evicted: false, reasons: [prepared?.reason || 'prepare-denied'] }
  if (resources.get(resource.key) !== generation) return { evicted: false, reasons: ['stale-owner'] }
  const second = await resolveProtection(resource)
  if (second.protected) return { evicted: false, reasons: second.reasons.length ? second.reasons : ['protected'] }
  try {
    await resource.evict(mode)
  } catch {
    return { evicted: false, reasons: ['evict-failed'] }
  }
  return { evicted: true, reasons: [] }
}

function candidatesFor(mode: PressureLevel, at = now()): ReclaimableResource[] {
  const list = [...resources.values()]
  if (mode === 'normal' || mode === 'soft') {
    return list
      .filter((resource) => isExpired(resource, at))
      .sort((a, b) => {
        if (a.priority !== b.priority) return a.priority - b.priority
        return a.lastActiveAt() - b.lastActiveAt()
      })
  }
  return list.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority
    return a.lastActiveAt() - b.lastActiveAt()
  })
}

export async function runMemoryReclaim(mode: PressureLevel | 'manual' = 'normal'): Promise<MemoryReclaimResult> {
  const autoEnabled = isMemoryAutoReclaimEnabled()
  if (!autoEnabled && mode !== 'manual' && mode !== 'hard') {
    return { ok: true, evicted: [], skipped: [], pressure: lastPressure }
  }
  if (sweeping) {
    return { ok: true, evicted: [], skipped: [], pressure: lastPressure }
  }
  sweeping = true
  lastSweepAt = now()
  const evicted: string[] = []
  const skipped: Array<{ key: string; reasons: string[] }> = []
  const effective: PressureLevel = mode === 'manual' ? 'hard' : mode
  let estimatedWorkingSet = lastWorkingSet
  try {
    const at = now()
    for (const resource of candidatesFor(effective, at)) {
      if (effective !== 'hard' && !isExpired(resource, at)) continue
      const generation = resources.get(resource.key)
      if (!generation) continue
      const beforeBytes = Math.max(0, resource.estimatedBytes?.() ?? 0)
      const result = await evictOne(resource, generation, effective)
      if (result.evicted) {
        evicted.push(resource.key)
        // Credit actual before/after bytes evicted, not the resource's total estimate: partial cache
        // trimming may leave resident bytes. Resources without estimates retain zero byte credit.
        const afterBytes = Math.max(0, resource.estimatedBytes?.() ?? 0)
        estimatedWorkingSet = Math.max(0, estimatedWorkingSet - Math.max(0, beforeBytes - afterBytes))
      } else skipped.push({ key: resource.key, reasons: result.reasons })
      if (
        effective === 'hard' &&
        estimatedWorkingSet > 0 &&
        estimatedWorkingSet < lastLimits.soft &&
        mode !== 'manual'
      ) {
        break
      }
    }
  } finally {
    sweeping = false
    scheduleMemoryReclaim()
  }
  return { ok: true, evicted, skipped, pressure: lastPressure }
}

export function scheduleMemoryReclaim(): void {
  if (!isMemoryAutoReclaimEnabled()) {
    clearAgenda()
    return
  }
  const at = now()
  let nextAt: number | null = null
  for (const resource of resources.values()) {
    const due = deadlineOf(resource, at)
    const candidate = due > at ? due : at + MEMORY_RECLAIM_RETRY_MS
    nextAt = nextAt === null ? candidate : Math.min(nextAt, candidate)
  }
  if (nextAt === null) {
    clearAgenda()
    return
  }
  if (agendaTimer && scheduledAt === nextAt) return
  clearAgenda()
  scheduledAt = nextAt
  agendaTimer = setTimeout(
    () => {
      agendaTimer = null
      scheduledAt = null
      void runMemoryReclaim('normal')
    },
    Math.max(0, nextAt - at)
  )
  unrefTimer(agendaTimer)
}

export function getMemoryReclaimerSnapshot(): MemoryReclaimerSnapshot {
  const at = now()
  const snapshots: MemoryReclaimerResourceSnapshot[] = []
  let hot = 0
  let cold = 0
  let protectedCount = 0
  let nextDeadlineAt: number | null = null
  for (const resource of resources.values()) {
    const lastActiveAt = resource.lastActiveAt()
    const deadlineAt = lastActiveAt + resource.coldTtlMs
    nextDeadlineAt = nextDeadlineAt === null ? deadlineAt : Math.min(nextDeadlineAt, deadlineAt)
    const estimatedBytes = resource.estimatedBytes?.()
    snapshots.push({
      key: resource.key,
      kind: resource.kind,
      state: isExpired(resource, at) ? 'cold' : 'hot',
      lastActiveAt,
      deadlineAt,
      ...(estimatedBytes != null ? { estimatedBytes } : {}),
      protected: false,
      reasons: [],
    })
  }
  snapshots.sort((a, b) => a.key.localeCompare(b.key))
  for (const snapshot of snapshots) {
    if (snapshot.state === 'cold') cold++
    else hot++
  }
  return {
    enabled: isMemoryAutoReclaimEnabled(),
    pressure: lastPressure,
    softLimitBytes: lastLimits.soft,
    hardLimitBytes: lastLimits.hard,
    workingSetBytes: lastWorkingSet,
    lastSweepAt,
    nextDeadlineAt,
    resources: snapshots,
    hot,
    cold,
    protectedCount,
  }
}

export async function describeReclaimableResources(): Promise<MemoryReclaimerResourceSnapshot[]> {
  const at = now()
  const out: MemoryReclaimerResourceSnapshot[] = []
  for (const resource of resources.values()) {
    const protection = await resolveProtection(resource)
    const lastActiveAt = resource.lastActiveAt()
    const estimatedBytes = resource.estimatedBytes?.()
    const state = stateOf(resource, protection, at)
    out.push({
      key: resource.key,
      kind: resource.kind,
      state,
      lastActiveAt,
      deadlineAt: lastActiveAt + resource.coldTtlMs,
      ...(estimatedBytes != null ? { estimatedBytes } : {}),
      protected: protection.protected,
      reasons: protection.reasons,
    })
  }
  return out.sort((a, b) => a.key.localeCompare(b.key))
}

export function disposeMemoryReclaimer(): void {
  clearAgenda()
  if (samplerTimer) {
    clearInterval(samplerTimer)
    samplerTimer = null
  }
  pressureSampleSource = null
  samplerBusy = false
  resources.clear()
  listeners.clear()
  lastSweepAt = null
  lastWorkingSet = 0
  lastPressure = 'normal'
  sweeping = false
}
