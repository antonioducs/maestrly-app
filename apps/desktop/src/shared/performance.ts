/** JSON-safe, on-demand performance snapshot exposed to the local diagnostics surface. */
export type PerformanceCounterName = 'ptyChunks' | 'ipcSends' | 'screenEvaluates' | 'browserCdpEvents'

export type MemoryReclaimKind = 'browser' | 'chatgpt' | 'panel' | 'vscode' | 'renderer-chat' | 'cache' | 'worker'

export type MemoryResourceState = 'hot' | 'cold' | 'protected'

export type OwnedProcessKind = 'pty' | 'vscode-serve-web' | 'tunnel-client' | 'asr' | 'embeddings' | 'provider'

export type OwnedProcessState = 'idle' | 'busy' | 'starting' | 'stopping' | 'ready' | 'error'

export interface PerformanceProcessMetric {
  pid: number
  name?: string
  serviceName?: string
  type?: string
  creationTime: number
  ageMs: number
  sandboxed?: boolean
  cpu: { cumulativeCPUUsage?: number; idleWakeupsPerSecond: number; percentCPUUsage: number }
  /** All fields are BYTES (normalized from Electron's KiB at the collection boundary in metrics.ts). */
  memory: { peakWorkingSetSize: number; privateBytes?: number; workingSetSize: number }
}

export interface PerformanceWebContentsEntry {
  kind: string
  convId?: string
  resourceId?: string
  pid: number
  workingSet?: number
}

export interface PerformanceTotals {
  /** All byte fields are BYTES (Electron KiB normalized at collection; external RSS and caches already bytes). */
  workingSetTotal: number
  peakWorkingSetTotal: number
  externalRssTotal: number | null
  cacheBytesTotal: number
  byProcessType: Record<string, { count: number; workingSet: number; peakWorkingSet: number }>
  byWebContentsKind: Record<string, { count: number; workingSet: number }>
}

export interface MemoryReclaimerResourceSnapshot {
  key: string
  kind: MemoryReclaimKind
  state: MemoryResourceState
  lastActiveAt: number
  deadlineAt: number | null
  estimatedBytes?: number
  protected: boolean
  reasons: string[]
}

export interface MemoryReclaimerSnapshot {
  enabled: boolean
  pressure: 'normal' | 'soft' | 'hard'
  softLimitBytes: number
  hardLimitBytes: number
  workingSetBytes: number
  lastSweepAt: number | null
  nextDeadlineAt: number | null
  resources: MemoryReclaimerResourceSnapshot[]
  hot: number
  cold: number
  protectedCount: number
}

export interface PerformanceCacheSnapshot {
  id: string
  kind: string
  entries: number
  bytes: number
  oldestAgeMs: number | null
  evictions?: Record<string, number>
}

export interface OwnedProcessSnapshot {
  key: string
  kind: OwnedProcessKind
  pid: number | null
  owner?: string
  state: OwnedProcessState
  rss: number | null

  pids?: number[]

  rssByPid?: Record<string, number>
  extra?: Record<string, number | string | boolean | null>
}

export interface PerformanceRates {
  ptyChunksPerSec: number
  ipcSendsPerSec: number
  screenEvaluatesPerSec: number
  browserCdpEventsPerSec: number
}

export interface PerformanceDiagnostics {
  collectedAt: number
  snapshotStartedAt: number
  countersSince: number
  appUptimeMs: number
  counters: Record<PerformanceCounterName, number>
  rates: PerformanceRates
  totals: PerformanceTotals
  processMetrics: PerformanceProcessMetric[]
  governor: {
    total: number
    fullSpeed: number
    throttled: number
    activeAgentLeases: number
    byKind: Record<'browser' | 'chatgpt' | 'vscode' | 'panel', { total: number; fullSpeed: number; throttled: number }>
  }
  webContents: PerformanceWebContentsEntry[]
  reclaimer: MemoryReclaimerSnapshot
  caches: PerformanceCacheSnapshot[]
  ownedProcesses: OwnedProcessSnapshot[]
}

export interface MemoryPressureEvent {
  level: 'normal' | 'soft' | 'hard'
  workingSetBytes: number
  softLimitBytes: number
  hardLimitBytes: number
}

export interface MemoryAutoReclaimChangedEvent {
  enabled: boolean
}

export interface MemoryReclaimResult {
  ok: boolean
  evicted: string[]
  skipped: Array<{ key: string; reasons: string[] }>
  pressure: MemoryReclaimerSnapshot['pressure']
}
