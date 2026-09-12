import { app, type WebContents } from 'electron'
import { getResourceGovernorDiagnostics } from './resource-governor'
import { collectOwnedProcessSnapshots, ownedProcessRegistryFingerprint } from './owned-processes'
import { EXTERNAL_RSS_SAMPLE_INTERVAL_MS } from './policy'
import {
  describeReclaimableResources,
  getMemoryReclaimerSnapshot,
  noteMemorySample,
  registerPressureSampleSource,
  type MemoryPressureSample,
} from './memory-reclaimer'
import type {
  OwnedProcessSnapshot,
  PerformanceCacheSnapshot,
  PerformanceCounterName,
  PerformanceDiagnostics,
  PerformanceProcessMetric,
  PerformanceRates,
  PerformanceTotals,
  PerformanceWebContentsEntry,
} from '../../shared/performance'

export type { PerformanceDiagnostics, PerformanceCounterName } from '../../shared/performance'

const counters: Record<PerformanceCounterName, number> = {
  ptyChunks: 0,
  ipcSends: 0,
  screenEvaluates: 0,
  browserCdpEvents: 0,
}

const snapshotStartedAt = Date.now()
let countersSince = snapshotStartedAt
const cacheCollectors = new Map<string, () => PerformanceCacheSnapshot>()

export function incrementPerformanceCounter(name: PerformanceCounterName, amount = 1): void {
  counters[name] += amount
}

export function recordIpcSend(): void {
  incrementPerformanceCounter('ipcSends')
}

const webContentsRegistry = new Map<WebContents, { kind: string; convId?: string; resourceId?: string }>()

export function registerPerformanceWebContents(
  wc: WebContents,
  metadata: { kind: string; convId?: string; resourceId?: string }
): void {
  webContentsRegistry.set(wc, metadata)
  wc.once('destroyed', () => webContentsRegistry.delete(wc))
}

export function unregisterPerformanceWebContents(wc: WebContents): void {
  webContentsRegistry.delete(wc)
}

export function registerPerformanceCache(id: string, collect: () => PerformanceCacheSnapshot): void {
  cacheCollectors.set(id, collect)
}

export function unregisterPerformanceCache(id: string): void {
  cacheCollectors.delete(id)
}

function collectCaches(): PerformanceCacheSnapshot[] {
  const out: PerformanceCacheSnapshot[] = []
  for (const collect of cacheCollectors.values()) {
    try {
      out.push(collect())
    } catch {
      /* a cache collector must never take down diagnostics */
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id))
}

function ratesSince(elapsedMs: number): PerformanceRates {
  const seconds = Math.max(0.001, elapsedMs / 1000)
  return {
    ptyChunksPerSec: counters.ptyChunks / seconds,
    ipcSendsPerSec: counters.ipcSends / seconds,
    screenEvaluatesPerSec: counters.screenEvaluates / seconds,
    browserCdpEventsPerSec: counters.browserCdpEvents / seconds,
  }
}

function workingSetByPid(metrics: readonly PerformanceProcessMetric[]): Map<number, number> {
  const out = new Map<number, number>()
  for (const metric of metrics) out.set(metric.pid, metric.memory.workingSetSize)
  return out
}

function buildTotals(
  metrics: readonly PerformanceProcessMetric[],
  webContents: readonly PerformanceWebContentsEntry[],
  caches: readonly PerformanceCacheSnapshot[],
  owned: readonly OwnedProcessSnapshot[]
): PerformanceTotals {
  let workingSetTotal = 0
  let peakWorkingSetTotal = 0
  const electronPids = new Set<number>()
  const byProcessType: PerformanceTotals['byProcessType'] = {}
  for (const metric of metrics) {
    electronPids.add(metric.pid)
    workingSetTotal += metric.memory.workingSetSize
    peakWorkingSetTotal += metric.memory.peakWorkingSetSize
    const type = metric.type || 'unknown'
    const bucket = byProcessType[type] ?? { count: 0, workingSet: 0, peakWorkingSet: 0 }
    bucket.count += 1
    bucket.workingSet += metric.memory.workingSetSize
    bucket.peakWorkingSet += metric.memory.peakWorkingSetSize
    byProcessType[type] = bucket
  }
  const byWebContentsKind: PerformanceTotals['byWebContentsKind'] = {}
  for (const entry of webContents) {
    const bucket = byWebContentsKind[entry.kind] ?? { count: 0, workingSet: 0 }
    bucket.count += 1
    bucket.workingSet += entry.workingSet ?? 0
    byWebContentsKind[entry.kind] = bucket
  }
  // Deduplicate RSS by PID. Electron utility processes already count in app metrics, so do not add them as
  // external memory. For tree snapshots without a safe breakdown, exclude overlapping Electron trees
  // conservatively. With rssByPid, count each external descendant once even across overlapping roots.
  const externalByPid = new Map<number, number>()
  let sampledCount = 0
  for (const process of owned) {
    if (typeof process.rss !== 'number') continue
    sampledCount++
    const pids = process.pids ?? (process.pid != null ? [process.pid] : [])
    if (pids.some((pid) => electronPids.has(pid))) continue
    if (process.rssByPid) {
      for (const pid of pids) {
        const rss = process.rssByPid[pid]
        if (typeof rss === 'number' && !externalByPid.has(pid)) externalByPid.set(pid, rss)
      }
    } else {
      // Root-only snapshots attribute RSS to the root/first PID.
      const keyPid = pids[0]
      if (keyPid != null && !externalByPid.has(keyPid)) externalByPid.set(keyPid, process.rss)
    }
  }
  return {
    workingSetTotal,
    peakWorkingSetTotal,
    externalRssTotal:
      sampledCount === 0 && owned.length > 0
        ? null
        : [...externalByPid.values()].reduce((sum, value) => sum + value, 0),
    cacheBytesTotal: caches.reduce((sum, cache) => sum + cache.bytes, 0),
    byProcessType,
    byWebContentsKind,
  }
}

// `app.getAppMetrics()` reports memory in KiB; every other memory source in this module (owned-process RSS,
// cache sizes, memory-policy thresholds) is in bytes. Normalize HERE, at the single boundary, so totals,
// webContents attribution and `noteMemorySample` all operate on bytes.
const ELECTRON_KIB = 1024

function toBytes(value: number): number {
  return value * ELECTRON_KIB
}

function processMetricsFromApp(collectedAt: number): PerformanceProcessMetric[] {
  return app.getAppMetrics().map((metric) => ({
    pid: metric.pid,
    name: metric.name,
    serviceName: metric.serviceName,
    type: metric.type,
    creationTime: metric.creationTime,
    ageMs: Math.max(0, collectedAt - metric.creationTime),
    sandboxed: metric.sandboxed,
    cpu: metric.cpu,
    memory: {
      workingSetSize: toBytes(metric.memory.workingSetSize),
      peakWorkingSetSize: toBytes(metric.memory.peakWorkingSetSize),
      ...(metric.memory.privateBytes != null ? { privateBytes: toBytes(metric.memory.privateBytes) } : {}),
    },
  }))
}

/**
 * Pressure equals Electron working set plus deduplicated external RSS. Do not add cacheBytesTotal
 * because caches already reside in main's working set; expose that breakdown only for attribution.
 */
function aggregateWorkingSetBytes(totals: PerformanceTotals): number {
  return totals.workingSetTotal + (typeof totals.externalRssTotal === 'number' ? totals.externalRssTotal : 0)
}

// Cache last-known external RSS to avoid spawning ps/PowerShell every pressure tick. Manual snapshots
// refresh it; slow cadence resamples otherwise. Root identity changes invalidate immediately, while
// descendants update on the next tree enumeration. Ordinary ticks stay in-process.
let cachedOwnedSnapshots: OwnedProcessSnapshot[] | null = null
let cachedOwnedAt = 0
let cachedOwnedFingerprint = ''

async function ownedSnapshotsForPressure(force: boolean): Promise<OwnedProcessSnapshot[]> {
  const at = Date.now()
  if (!force && cachedOwnedSnapshots !== null) {
    // Read root/known-tree fingerprints in-process; enumerate trees only during slow collection.
    const fingerprint = ownedProcessRegistryFingerprint()
    if (fingerprint === cachedOwnedFingerprint && at - cachedOwnedAt < EXTERNAL_RSS_SAMPLE_INTERVAL_MS) {
      return cachedOwnedSnapshots
    }
  }
  const snapshots = await collectOwnedProcessSnapshots()
  cachedOwnedSnapshots = snapshots
  cachedOwnedAt = at
  // Record the fingerprint after collection updates known descendants so the next comparison matches the
  // snapshot's identity.
  cachedOwnedFingerprint = ownedProcessRegistryFingerprint()
  return snapshots
}

/**
 * Periodic pressure uses actual Electron working set plus deduplicated external RSS independently of
 * Settings. Electron metrics are in-process; external sampling follows the slow cache cadence.
 */
async function collectPressureSample(): Promise<MemoryPressureSample> {
  const processMetrics = processMetricsFromApp(Date.now())
  const caches = collectCaches()
  const ownedProcesses = await ownedSnapshotsForPressure(false)
  const totals = buildTotals(processMetrics, [], caches, ownedProcesses)
  return { workingSetBytes: aggregateWorkingSetBytes(totals) }
}

registerPressureSampleSource(collectPressureSample)

export async function getPerformanceDiagnostics(): Promise<PerformanceDiagnostics> {
  const collectedAt = Date.now()
  const processMetrics = processMetricsFromApp(collectedAt)
  const memoryByPid = workingSetByPid(processMetrics)
  const webContents: PerformanceWebContentsEntry[] = [...webContentsRegistry.entries()]
    .filter(([wc]) => !wc.isDestroyed())
    .map(([wc, metadata]) => {
      const pid = wc.getOSProcessId()
      return {
        ...metadata,
        pid,
        ...(memoryByPid.has(pid) ? { workingSet: memoryByPid.get(pid) } : {}),
      }
    })
  const caches = collectCaches()
  const ownedProcesses = await ownedSnapshotsForPressure(true)
  const totals = buildTotals(processMetrics, webContents, caches, ownedProcesses)
  noteMemorySample({ workingSetBytes: aggregateWorkingSetBytes(totals) })
  const reclaimer = getMemoryReclaimerSnapshot()
  const resources = await describeReclaimableResources()
  const protectedCount = resources.filter((resource) => resource.protected).length
  return {
    collectedAt,
    snapshotStartedAt,
    countersSince,
    appUptimeMs: Math.max(0, collectedAt - snapshotStartedAt),
    counters: { ...counters },
    rates: ratesSince(collectedAt - countersSince),
    totals,
    processMetrics,
    governor: getResourceGovernorDiagnostics(),
    webContents,
    reclaimer: {
      ...reclaimer,
      resources,
      hot: resources.filter((resource) => resource.state === 'hot').length,
      cold: resources.filter((resource) => resource.state === 'cold').length,
      protectedCount,
    },
    caches,
    ownedProcesses,
  }
}

export function resetPerformanceCounters(): void {
  for (const name of Object.keys(counters) as PerformanceCounterName[]) counters[name] = 0
  countersSince = Date.now()
}
