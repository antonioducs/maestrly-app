import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { OwnedProcessKind, OwnedProcessSnapshot, OwnedProcessState } from '../../shared/performance'
import { listDescendantPids } from '../platform'
import { RSS_SAMPLE_TIMEOUT_MS } from './policy'

const execFileAsync = promisify(execFile)

export interface OwnedProcessRecord {
  key: string
  kind: OwnedProcessKind
  pid: () => number | null | undefined
  owner?: string
  state?: () => OwnedProcessState
  extra?: () => Record<string, number | string | boolean | null>
  /**
   * Sample root plus live-descendant RSS for launchers whose children hold most memory, such as
   * code/serve-web. See listDescendantPids.
   */
  includeDescendants?: boolean
}

const processes = new Map<string, OwnedProcessRecord>()

export function registerOwnedProcess(record: OwnedProcessRecord): void {
  processes.set(record.key, record)
}

export function unregisterOwnedProcess(key: string): void {
  processes.delete(key)
}

export function listOwnedProcessRecords(): OwnedProcessRecord[] {
  return [...processes.values()]
}

/**
 * Last enumerated process-tree identity supplies the RSS-cache fingerprint. Refresh/collection updates
 * it; pressure ticks only read the in-memory value.
 */
const cachedTreeByRoot = new Map<number, number[]>()

function treeRootPids(): number[] {
  return [...processes.values()]
    .filter((record) => record.includeDescendants)
    .map((record) => record.pid() ?? null)
    .filter((pid): pid is number => typeof pid === 'number' && pid > 0)
}

function mergeCachedTree(fresh: Map<number, number[]>, roots: readonly number[]): void {
  const rootSet = new Set(roots)
  for (const root of [...cachedTreeByRoot.keys()]) {
    if (!rootSet.has(root)) cachedTreeByRoot.delete(root) // discard tree identity when its root leaves the registry
  }
  for (const [root, descendants] of fresh) cachedTreeByRoot.set(root, descendants)
}

/**
 * Reenumerate all tree-aware roots in one ps/PowerShell call during explicit or slow-cadence
 * collection. Update cached tree identity; on failure retain the last known tree while RSS sampling
 * ignores dead PIDs.
 */
export async function refreshOwnedProcessTree(
  opts: { timeoutMs?: number; platform?: NodeJS.Platform } = {}
): Promise<Map<number, number[]>> {
  const roots = treeRootPids()
  if (roots.length === 0) return cachedTreeByRoot
  const fresh = await listDescendantPids(roots, opts)
  mergeCachedTree(fresh, roots)
  return cachedTreeByRoot
}

/**
 * Stable registry identity includes keys, current PIDs, and known descendants. Cache consumers
 * resample on root spawn/exit changes; descendant identity refreshes at slow enumeration cadence.
 */
export function ownedProcessRegistryFingerprint(): string {
  return [...processes.values()]
    .map((record) => {
      const pid = record.pid()
      const base = `${record.key}:${pid ?? ''}`
      if (record.includeDescendants && pid != null) {
        const descendants = cachedTreeByRoot.get(pid) ?? []
        return `${base}:[${descendants.join(',')}]`
      }
      return base
    })
    .sort()
    .join('|')
}

function parsePosixRss(stdout: string): Map<number, number> {
  const out = new Map<number, number>()
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line)
    if (!match) continue
    const pid = Number(match[1])
    const rssKb = Number(match[2])
    if (Number.isFinite(pid) && Number.isFinite(rssKb)) out.set(pid, Math.round(rssKb * 1024))
  }
  return out
}

function parseWindowsRss(stdout: string): Map<number, number> {
  const out = new Map<number, number>()
  const trimmed = stdout.trim()
  if (!trimmed) return out
  try {
    const parsed = JSON.parse(trimmed) as
      | Array<{ Id?: number; WorkingSet64?: number }>
      | { Id?: number; WorkingSet64?: number }
    const rows = Array.isArray(parsed) ? parsed : [parsed]
    for (const row of rows) {
      if (typeof row?.Id === 'number' && typeof row.WorkingSet64 === 'number') out.set(row.Id, row.WorkingSet64)
    }
  } catch {
    /* PowerShell can emit empty / non-JSON on failure; treat as best-effort miss. */
  }
  return out
}

export async function sampleOwnedProcessRss(
  pids: readonly number[],
  opts: { timeoutMs?: number; platform?: NodeJS.Platform } = {}
): Promise<Map<number, number | null>> {
  const unique = [...new Set(pids.filter((pid) => Number.isInteger(pid) && pid > 0))]
  const result = new Map<number, number | null>()
  for (const pid of unique) result.set(pid, null)
  if (unique.length === 0) return result

  const timeout = opts.timeoutMs ?? RSS_SAMPLE_TIMEOUT_MS
  const platform = opts.platform ?? process.platform
  try {
    if (platform === 'win32') {
      const { stdout } = await execFileAsync(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          `Get-Process -Id ${unique.join(',')} -ErrorAction SilentlyContinue | Select-Object Id,WorkingSet64 | ConvertTo-Json -Compress`,
        ],
        { timeout, windowsHide: true }
      )
      const sampled = parseWindowsRss(stdout)
      for (const pid of unique) result.set(pid, sampled.get(pid) ?? null)
      return result
    }
    const { stdout } = await execFileAsync('ps', ['-o', 'pid=,rss=', '-p', unique.join(',')], { timeout })
    const sampled = parsePosixRss(stdout)
    for (const pid of unique) result.set(pid, sampled.get(pid) ?? null)
    return result
  } catch {
    return result
  }
}

export async function collectOwnedProcessSnapshots(
  opts: { timeoutMs?: number; platform?: NodeJS.Platform } = {}
): Promise<OwnedProcessSnapshot[]> {
  const records = listOwnedProcessRecords()
  const pids = records.map((record) => record.pid() ?? null)
  const numeric = pids.filter((pid): pid is number => typeof pid === 'number' && pid > 0)
  const treeRoots = records.filter((record) => record.includeDescendants).map((record) => record.pid() ?? null)
  const treeNumeric = treeRoots.filter((pid): pid is number => typeof pid === 'number' && pid > 0)
  // Enumerate all root trees once; failure degrades to root-only sampling.
  const descendants = treeNumeric.length > 0 ? await listDescendantPids(treeNumeric, opts) : new Map<number, number[]>()
  if (treeNumeric.length > 0) mergeCachedTree(descendants, treeNumeric) // Tree identity used by the fingerprint.
  const sampledPids = [...new Set([...numeric, ...[...descendants.values()].flat()])]
  const rssByPid = await sampleOwnedProcessRss(sampledPids, opts)
  return records.map((record, index) => {
    const pid = pids[index] ?? null
    const tree = pid != null ? (descendants.get(pid) ?? []) : []
    // RSS includes root and live descendants; missing/dead PIDs contribute nothing.
    const treePids = record.includeDescendants && pid != null ? [pid, ...tree] : []
    let rss: number | null = null
    // Per-PID tree breakdown allows metrics to deduplicate processes reachable through multiple roots.
    const perPidRss: Record<string, number> = {}
    if (treePids.length > 0) {
      let sum = 0
      let sampled = 0
      for (const treePid of treePids) {
        const value = rssByPid.get(treePid)
        if (typeof value === 'number') {
          perPidRss[String(treePid)] = value
          sum += value
          sampled += 1
        }
      }
      rss = sampled > 0 ? sum : null
    } else if (pid != null) {
      rss = rssByPid.get(pid) ?? null
    }
    return {
      key: record.key,
      kind: record.kind,
      pid,
      ...(record.owner ? { owner: record.owner } : {}),
      state: record.state?.() ?? 'idle',
      rss,
      ...(treePids.length > 0 ? { pids: treePids } : {}),
      ...(treePids.length > 0 && Object.keys(perPidRss).length > 0 ? { rssByPid: perPidRss } : {}),
      ...(record.extra ? { extra: record.extra() } : {}),
    }
  })
}

/** Test/quit seam. */
export function disposeOwnedProcesses(): void {
  processes.clear()
  cachedTreeByRoot.clear()
}
