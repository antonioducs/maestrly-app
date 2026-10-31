import fsp from 'node:fs/promises'
import path from 'node:path'
import type { TurnSnapshotUsage } from '../../shared/turn-snapshots'
import { collectStore, directorySize, sweepStores } from './gc'
import { snapshotGitAvailable } from './git'
import { configureTurnSnapshotLifecycle, turnSnapshotsEnabled } from './lifecycle'
import {
  countLiveSnapshotRecords,
  expireSnapshotRecords,
  failInterruptedSnapshotRecords,
  liveSnapshotRecordsByStore,
} from './records'
import { forgetStore, openExistingStore, setTurnSnapshotsRoot, storesDir, turnSnapshotsRoot } from './store'

/**
 * Retention of turn snapshots: records older than seven days expire (their summary stays, their trees go), the
 * profile keeps at most 2 GiB of snapshots, oldest first, and stores no record uses are removed. Runs at startup, every
 * hour, soon after a conversation is deleted, and on demand.
 */

export const RETENTION_MS = 7 * 24 * 60 * 60 * 1000
export const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024
const STARTUP_DELAY_MS = 60_000
const INTERVAL_MS = 60 * 60 * 1000

export interface TurnSnapshotsOptions {
  userData: string
  notify: (conversationId: string) => void
}

/** Sets up turn snapshots for this profile; returns a function that stops the periodic collection. */
export function initTurnSnapshots(opts: TurnSnapshotsOptions): () => void {
  setTurnSnapshotsRoot(path.join(opts.userData, 'turn-snapshots'))
  configureTurnSnapshotLifecycle({ notify: opts.notify })
  try {
    // A turn the previous run left mid-way has no end snapshot.
    failInterruptedSnapshotRecords()
  } catch (error) {
    console.warn('[turn-snapshots] Could not settle interrupted turns:', (error as Error).message)
  }
  const run = () => void runTurnSnapshotMaintenance().catch(() => undefined)
  const startup = setTimeout(run, STARTUP_DELAY_MS)
  startup.unref()
  const interval = setInterval(run, INTERVAL_MS)
  interval.unref()
  return () => {
    clearTimeout(startup)
    clearInterval(interval)
    clearTimeout(deletionTimer)
  }
}

let running: Promise<void> | null = null

async function storeKeys(): Promise<string[]> {
  const entries = await fsp.readdir(storesDir(), { withFileTypes: true }).catch(() => [])
  return entries.filter((entry) => entry.isDirectory() && /^[0-9a-f]{64}$/.test(entry.name)).map((entry) => entry.name)
}

async function collectAll(force: boolean): Promise<void> {
  const live = liveSnapshotRecordsByStore()
  for (const key of await storeKeys()) {
    const store = await openExistingStore(key)
    if (!store) continue
    await collectStore(store, live.get(key) ?? new Set(), { indexMaxIdleMs: RETENTION_MS, force }).catch((error) =>
      console.warn('[turn-snapshots] Collection failed:', (error as Error).message)
    )
  }
  await sweepStores(new Set(live.keys()), { maxIdleMs: RETENTION_MS })
}

/** Expires, collects and keeps the total under the cap. Concurrent calls share one run. */
export function runTurnSnapshotMaintenance(now = Date.now()): Promise<void> {
  running ??= (async () => {
    try {
      expireSnapshotRecords({ olderThan: now - RETENTION_MS })
      await collectAll(false)
      for (let round = 0; round < 5; round++) {
        if ((await directorySize(turnSnapshotsRoot())) <= MAX_TOTAL_BYTES) break
        const live = countLiveSnapshotRecords()
        if (!live) break
        expireSnapshotRecords({ limit: Math.max(1, Math.ceil(live / 4)) })
        await collectAll(true)
      }
    } finally {
      running = null
    }
  })()
  return running
}

let deletionTimer: NodeJS.Timeout | undefined

/** After a conversation is deleted: its records went with it, so collect a little later, once. */
export function scheduleTurnSnapshotCleanup(): void {
  clearTimeout(deletionTimer)
  deletionTimer = setTimeout(() => void runTurnSnapshotMaintenance().catch(() => undefined), 5_000)
  deletionTimer.unref?.()
}

/** Expires every record and deletes every store. */
export async function clearTurnSnapshots(): Promise<void> {
  expireSnapshotRecords()
  for (const key of await storeKeys()) {
    const store = await openExistingStore(key)
    const remove = async () => {
      await fsp.rm(path.join(storesDir(), key), { recursive: true, force: true })
      forgetStore(key)
    }
    await (store ? store.exclusive(remove) : remove())
  }
}

let usageCache: { at: number; bytes: number } | null = null

export async function turnSnapshotUsage(): Promise<TurnSnapshotUsage> {
  if (!usageCache || Date.now() - usageCache.at > 30_000)
    usageCache = { at: Date.now(), bytes: await directorySize(turnSnapshotsRoot()) }
  return {
    enabled: turnSnapshotsEnabled(),
    gitAvailable: await snapshotGitAvailable(),
    bytes: usageCache.bytes,
    records: countLiveSnapshotRecords(),
  }
}

export function forgetTurnSnapshotUsage(): void {
  usageCache = null
}
