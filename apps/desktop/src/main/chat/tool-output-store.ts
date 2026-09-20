/** Bounded, temporary storage for full chat tool results. Scanning is asynchronous;
 * saves and eviction are synchronous so a cleanup cannot unlink a newer replacement.
 * Capacity is reserved before writing. Failed deletions keep their bytes reserved.
 */
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { app } from 'electron'

export interface ToolOutputLimits {
  /** Aggregate cap for managed spill files. */
  maxTotalBytes: number
  /** Largest single spill accepted; a bigger one is refused outright instead of truncated. */
  maxFileBytes: number
  /** Spills older than this are pruned by cleanup. */
  maxAgeMs: number
  /** File-count cap, so many tiny spills cannot fill the profile with inodes. */
  maxFiles: number
}

export const DEFAULT_TOOL_OUTPUT_LIMITS: ToolOutputLimits = {
  maxTotalBytes: 256 * 1024 * 1024,
  maxFileBytes: 16 * 1024 * 1024,
  maxAgeMs: 7 * 24 * 60 * 60 * 1000,
  maxFiles: 2000,
}

let limits: ToolOutputLimits = { ...DEFAULT_TOOL_OUTPUT_LIMITS }

/** Tool call ids that are already safe in a file name keep their readable spill name. */
const SAFE_TOOL_CALL_ID = /^[A-Za-z0-9_-]{1,64}$/
/** Includes legacy tool ids, which were not restricted to the current safe-id format. */
const MANAGED_FILE = /^tool_.+\.txt$/
const MANAGED_TEMP = /^\.tool_[A-Za-z0-9_-]{1,64}\.txt\.[a-f0-9]{16}\.tmp$/
/** Temp files younger than this may belong to an in-flight write in another window/process. */
const TEMP_GRACE_MS = 60 * 60 * 1000

interface ManagedFile {
  name: string
  size: number
  mtimeMs: number
}

/**
 * Accounting for managed files. `null` means "not initialized yet": the first save scans the
 * directory once (startup cleanup normally does it first, off the synchronous path) so later saves
 * cost one write instead of a full directory scan.
 */
let index: Map<string, ManagedFile> | null = null
let totalBytes = 0
/**
 * Bumped whenever the directory disappears (fresh profile or local-data reset) and the accounting
 * restarts. An asynchronous cleanup that started before the bump discards its stale snapshot.
 */
let generation = 0
let cleanupInFlight: Promise<void> | null = null

function storeDir(): string {
  return path.join(app.getPath('userData'), 'chat-tool-output')
}

/** Unsafe ids are hashed rather than rejected: every spill must still be addressable. */
function managedName(toolCallId: string): string {
  const id = typeof toolCallId === 'string' ? toolCallId : ''
  const safe = SAFE_TOOL_CALL_ID.test(id)
    ? id
    : `sha256-${createHash('sha256').update(id, 'utf8').digest('hex').slice(0, 32)}`
  return `tool_${safe}.txt`
}

function adopt(files: Map<string, ManagedFile>): void {
  index = files
  totalBytes = 0
  for (const file of files.values()) totalBytes += file.size
}

/** Fallback initialization when a save runs before the first cleanup finished. */
function scanSync(dir: string): Map<string, ManagedFile> {
  const files = new Map<string, ManagedFile>()
  const names = fs.readdirSync(dir)
  for (const name of names) {
    if (!MANAGED_FILE.test(name) && !MANAGED_TEMP.test(name)) continue
    try {
      // lstat, not stat: a symlink is not a regular file here, so it is left untouched.
      const stat = fs.lstatSync(path.join(dir, name))
      if (!stat.isFile()) continue
      if (MANAGED_TEMP.test(name)) throw new Error('Tool output temporary file requires cleanup')
      files.set(name, { name, size: stat.size, mtimeMs: stat.mtimeMs })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return files
}

/** Removes one managed file and releases its bytes. Returns false when the file survives. */
function deleteManagedSync(dir: string, entry: ManagedFile, files: Map<string, ManagedFile>): boolean {
  try {
    fs.unlinkSync(path.join(dir, entry.name))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false
  }
  if (files.get(entry.name) === entry) {
    files.delete(entry.name)
    totalBytes -= entry.size
  }
  return true
}

/**
 * Evicts oldest-first until the pending write fits. The pending bytes are counted WITHOUT crediting
 * an existing file with the same name: over-reserving is harmless, while crediting bytes that a
 * failed write would not actually release is not.
 */
function reserveCapacity(dir: string, files: Map<string, ManagedFile>, name: string, size: number): boolean {
  const fits = (): boolean =>
    totalBytes + size <= limits.maxTotalBytes && files.size + (files.has(name) ? 0 : 1) <= limits.maxFiles
  if (fits()) return true
  const candidates = [...files.values()].sort((a, b) => a.mtimeMs - b.mtimeMs)
  for (const entry of candidates) {
    // A failed deletion keeps the entry counted, so capacity stays conservative; try the next one.
    if (!deleteManagedSync(dir, entry, files)) continue
    if (fits()) return true
  }
  return fits()
}

/**
 * Persists the full tool output and returns its absolute path, or `null` when it was not stored.
 * Never throws: a failed spill must degrade the marker, not the tool call.
 */
export function saveToolOutput(text: string, toolCallId: string): string | null {
  const size = Buffer.byteLength(text, 'utf8')
  // Oversized output is refused entirely: a partial file would misrepresent the marker's promise.
  if (size > limits.maxFileBytes) return null

  const dir = storeDir()
  try {
    // `recursive` returns the first path created, so a truthy result means the directory was
    // missing (fresh profile or local-data reset) and any cached accounting describes deleted files.
    const created = fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    if (!fs.lstatSync(dir).isDirectory()) return null
    if (created !== undefined) {
      generation++
      adopt(new Map())
    } else if (index === null) {
      adopt(scanSync(dir))
    }
  } catch {
    return null
  }

  const files = index as Map<string, ManagedFile>
  const cutoff = Date.now() - limits.maxAgeMs
  for (const entry of files.values()) {
    if (entry.mtimeMs < cutoff) deleteManagedSync(dir, entry, files)
  }
  const name = managedName(toolCallId)
  if (!reserveCapacity(dir, files, name, size)) return null

  const target = path.join(dir, name)
  const temp = path.join(dir, `.${name}.${randomBytes(8).toString('hex')}.tmp`)
  try {
    // `wx` never clobbers, and rename replaces the target entry itself instead of writing through
    // a symlink planted there.
    fs.writeFileSync(temp, text, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    fs.renameSync(temp, target)
  } catch {
    generation++ // An in-flight scan must not hide an unlisted partial file.
    index = null // Reconcile any partial temporary file before accepting another write.
    try {
      fs.rmSync(temp, { force: true })
    } catch {
      // The next cleanup removes the orphan temp file.
    }
    return null
  }

  // Commit only after the bytes are durable, so a failed write leaves the accounting untouched.
  // Re-read: the eviction above may already have dropped a same-name file and released its bytes.
  const replaced = files.get(name)
  files.set(name, { name, size, mtimeMs: Date.now() })
  totalBytes += size - (replaced?.size ?? 0)
  return target
}

async function runCleanup(): Promise<void> {
  const dir = storeDir()
  const snapshot = generation
  const startedAt = Date.now()
  let names: string[]
  try {
    if (!(await fsp.lstat(dir)).isDirectory()) return
    names = await fsp.readdir(dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && generation === snapshot) adopt(new Map())
    return
  }

  const scanned = new Map<string, ManagedFile>()
  const orphanTemps: ManagedFile[] = []
  for (const name of names) {
    const isTemp = MANAGED_TEMP.test(name)
    // Anything else (including directories and symlinks) belongs to someone else: leave it.
    if (!isTemp && !MANAGED_FILE.test(name)) continue
    let stat: fs.Stats
    try {
      stat = await fsp.lstat(path.join(dir, name))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      continue
    }
    if (!stat.isFile()) continue
    if (isTemp) {
      orphanTemps.push({ name, size: stat.size, mtimeMs: stat.mtimeMs })
      continue
    }
    scanned.set(name, { name, size: stat.size, mtimeMs: stat.mtimeMs })
  }
  // The directory was recreated while scanning; the snapshot describes deleted files. The saves
  // that recreated it already rebuilt the accounting, and the next run prunes anything left.
  if (generation !== snapshot || !fs.lstatSync(dir).isDirectory()) return

  // Saves that landed during the scan are authoritative; entries whose file vanished are dropped.
  if (index) {
    for (const [name, entry] of index) {
      if (entry.mtimeMs >= startedAt) scanned.set(name, entry)
    }
  }
  adopt(scanned)

  const cutoff = startedAt - limits.maxAgeMs
  // Scan asynchronously, then evict without yielding so a save cannot replace a file
  // between the eviction decision and unlink. Failed deletes remain in the budget.
  for (const entry of [...scanned.values()].sort((a, b) => a.mtimeMs - b.mtimeMs)) {
    if (
      entry.mtimeMs < cutoff ||
      entry.size > limits.maxFileBytes ||
      scanned.size > limits.maxFiles ||
      totalBytes > limits.maxTotalBytes
    ) {
      deleteManagedSync(dir, entry, scanned)
    }
  }

  for (const entry of orphanTemps) {
    if (startedAt - entry.mtimeMs > TEMP_GRACE_MS) {
      try {
        fs.unlinkSync(path.join(dir, entry.name))
        continue
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      }
    }
    // Do not accumulate more partial writes while a previous one cannot be removed.
    index = null
  }
}

/**
 * Prunes expired and excess spills. Safe to call at startup and periodically; concurrent calls
 * share one pass. Filesystem failures are best effort and do not interrupt tools.
 */
export function cleanupToolOutputs(): Promise<void> {
  if (cleanupInFlight) return cleanupInFlight
  const run = runCleanup()
    .catch(() => {
      // Cleanup is best effort; a failed pass retries on the next interval.
    })
    .finally(() => {
      if (cleanupInFlight === run) cleanupInFlight = null
    })
  cleanupInFlight = run
  return run
}

/** TEST ONLY: drop cached accounting and optionally shrink limits for synthetic directories. */
export function __resetToolOutputStoreForTests(overrides?: Partial<ToolOutputLimits>): void {
  limits = { ...DEFAULT_TOOL_OUTPUT_LIMITS, ...overrides }
  index = null
  totalBytes = 0
  cleanupInFlight = null
  generation++
}

/** TEST ONLY: current managed byte total, for accounting assertions. */
export function __toolOutputStoreBytesForTests(): number {
  return totalBytes
}
