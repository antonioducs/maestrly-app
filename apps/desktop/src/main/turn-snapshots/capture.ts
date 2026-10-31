import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { nulRecords, SnapshotGitError } from './git'
import { renameWithRetry, SnapshotUnavailableError, type SnapshotDir } from './store'

/**
 * Captures a folder as a tree in its shadow store. Each capture reconciles the folder's index against the disk: Git
 * lists what changed since the index last saw it (tracked files by stat, new files that no ignore rule hides), only
 * those are hashed, and the index becomes a tree. The first capture of a repository folder starts from a copy of
 * the user's index when its blobs are exactly the bytes on disk, so tracked files are neither hashed nor stored again.
 */

export const MAX_SNAPSHOT_FILE_BYTES = 10 * 1024 * 1024
export const MAX_NEW_FILES = 100_000
const TOO_LARGE_RETRY_MS = 24 * 60 * 60 * 1000
const SCAN_TIMEOUT_MS = 10 * 60_000
const STAT_CONCURRENCY = 32
const MAX_UNREADABLE_RETRIES = 20

export interface SkippedFile {
  path: string
  size: number
  mtimeMs: number
  reason?: 'unreadable'
}

export interface CaptureResult {
  tree: string
  skipped: SkippedFile[]
}

const lastTrees = new Map<string, { fingerprint: string; tree: string }>()

async function indexFingerprint(file: string): Promise<string | null> {
  try {
    const info = await fsp.stat(file, { bigint: true })
    return `${info.ino}:${info.size}:${info.mtimeNs}`
  } catch {
    return null
  }
}

async function mapLimit<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++
        results[index] = await work(items[index]!)
      }
    })
  )
  return results
}

/** One second after the epoch: Git treats an index time of zero as unknown rather than old. */
const RACY_INDEX_TIME = 1

/**
 * Starts this folder's index from a copy of the user's, so tracked files are not stored again. The user's blobs are
 * what Git stored after its own conversions (line endings, Git LFS, `ident`), which may differ from the bytes on
 * disk, so the copy is dated to the epoch: every entry becomes racily clean and one refresh compares its content
 * with the file under this store's neutral attributes. Matching entries keep the user's blob; any other is smudged
 * and hashed from the disk by the capture. A split index, a conflict, or sparse or assume-unchanged entries start
 * empty instead.
 */
async function seedIndex(dir: SnapshotDir, index: string): Promise<boolean> {
  const user = dir.user
  if (!user || !existsSync(user.index)) return false
  const entries = await fsp.readdir(path.dirname(user.index)).catch(() => [] as string[])
  if (entries.some((entry) => entry.startsWith('sharedindex.'))) return false
  const tmp = `${index}.seed-${randomUUID()}`
  const scan = {
    cwd: dir.workTree,
    workTree: dir.workTree,
    index: tmp,
    config: dir.scanConfig,
    timeoutMs: SCAN_TIMEOUT_MS,
  }
  try {
    await fsp.copyFile(user.index, tmp)
    await fsp.utimes(tmp, RACY_INDEX_TIME, RACY_INDEX_TIME)
    const listed = await dir.store.write(['ls-files', '-v', '-z'], { ...scan, maxStdoutBytes: 512 * 1024 * 1024 })
    for (const record of nulRecords(listed.stdout)) if (!record.startsWith('H ')) return false
    // Exit 1 only reports entries that need an update; they are left for the capture to hash. The index is written
    // even when no stat changed, so it stops being dated to the epoch and later scans trust the verified entries.
    await dir.store.write(['update-index', '-q', '--refresh', '--force-write-index'], { ...scan, okCodes: [1] })
    await renameWithRetry(tmp, index)
    return true
  } catch {
    return false
  } finally {
    await fsp.rm(tmp, { force: true }).catch(() => undefined)
  }
}

interface Changes {
  /** Paths to drop from the index: gone, now a directory, or too large to keep. */
  remove: string[]
  /** Paths to hash into the index. */
  add: string[]
  skipped: SkippedFile[]
}

async function listChanges(dir: SnapshotDir, index: string): Promise<{ tracked: string[]; untracked: string[] }> {
  const scan = { cwd: dir.workTree, workTree: dir.workTree, index, config: dir.scanConfig, timeoutMs: SCAN_TIMEOUT_MS }
  const [tracked, untracked] = await Promise.all([
    dir.store.write(['diff-files', '-z', '--ignore-submodules=all'], { ...scan, maxStdoutBytes: 512 * 1024 * 1024 }),
    dir.store.write(
      [
        'ls-files',
        '-z',
        '--others',
        '--exclude-standard',
        ...(dir.excludeFrom ? [`--exclude-from=${dir.excludeFrom}`] : []),
      ],
      { ...scan, maxStdoutBytes: 512 * 1024 * 1024 }
    ),
  ])
  // Raw diff-files records alternate between `:<modes> <oids> <status>` and the path.
  const trackedPaths: string[] = []
  const records = nulRecords(tracked.stdout)
  for (let i = 0; i + 1 < records.length; i += 2) trackedPaths.push(records[i + 1]!)
  // An embedded repository is listed as `dir/`: it is neither captured nor restored.
  const untrackedPaths = nulRecords(untracked.stdout).filter((file) => !file.endsWith('/'))
  return { tracked: trackedPaths, untracked: untrackedPaths }
}

async function classify(dir: SnapshotDir, tracked: string[], untracked: string[]): Promise<Changes> {
  const changes: Changes = { remove: [], add: [], skipped: [] }
  const all = [
    ...tracked.map((file) => ({ file, tracked: true })),
    ...untracked.map((file) => ({ file, tracked: false })),
  ]
  const seen = new Set<string>()
  const unique = all.filter((item) => {
    if (seen.has(item.file)) return false
    seen.add(item.file)
    return true
  })
  const stats = await mapLimit(unique, STAT_CONCURRENCY, (item) =>
    fsp.lstat(path.join(dir.workTree, item.file)).catch(() => null)
  )
  unique.forEach((item, index) => {
    const info = stats[index]
    if (!info || info.isDirectory() || (!info.isFile() && !info.isSymbolicLink())) {
      if (item.tracked) changes.remove.push(item.file)
      return
    }
    if (info.isFile() && info.size > MAX_SNAPSHOT_FILE_BYTES) {
      changes.skipped.push({ path: item.file, size: info.size, mtimeMs: Math.trunc(info.mtimeMs) })
      if (item.tracked) changes.remove.push(item.file)
      return
    }
    changes.add.push(item.file)
  })
  return changes
}

const UNPROCESSABLE = /Unable to process path (.+)$/m

async function updateIndex(dir: SnapshotDir, index: string, changes: Changes): Promise<void> {
  const options = {
    cwd: dir.workTree,
    workTree: dir.workTree,
    index,
    config: dir.scanConfig,
    timeoutMs: SCAN_TIMEOUT_MS,
  }
  if (changes.remove.length)
    await dir.store.write(['update-index', '--force-remove', '-z', '--stdin'], {
      ...options,
      input: changes.remove.join('\0') + '\0',
    })
  let add = changes.add
  for (let attempt = 0; add.length; attempt++) {
    try {
      // update-index takes literal paths, and the whole batch is written or none of it.
      await dir.store.write(['update-index', '--add', '--remove', '--replace', '-z', '--stdin'], {
        ...options,
        input: add.join('\0') + '\0',
      })
      return
    } catch (error) {
      const failed = error instanceof SnapshotGitError ? UNPROCESSABLE.exec(error.stderr)?.[1]?.trim() : undefined
      if (!failed || attempt >= MAX_UNREADABLE_RETRIES || !add.includes(failed)) throw error
      const info = await fsp.lstat(path.join(dir.workTree, failed)).catch(() => null)
      changes.skipped.push({
        path: failed,
        size: info?.size ?? -1,
        mtimeMs: Math.trunc(info?.mtimeMs ?? 0),
        reason: 'unreadable',
      })
      add = add.filter((file) => file !== failed)
    }
  }
}

async function attempt(dir: SnapshotDir, allowSeed: boolean): Promise<CaptureResult> {
  const index = dir.store.indexPath(dir.dirKey)
  // Only this process writes the store, and it holds the store's queue: a leftover lock is from a crash.
  await fsp.rm(`${index}.lock`, { force: true }).catch(() => undefined)
  const meta = dir.store.meta.dirs[dir.dirKey]
  if (!existsSync(index)) {
    lastTrees.delete(index)
    const seeded = allowSeed && (await seedIndex(dir, index))
    dir.store.meta.dirs[dir.dirKey] = {
      ...(meta ?? { path: dir.workTree }),
      path: dir.workTree,
      lastUsedAt: Date.now(),
      seeded,
    }
  }
  const before = await indexFingerprint(index)
  const { tracked, untracked } = await listChanges(dir, index)
  if (untracked.length > MAX_NEW_FILES) throw new SnapshotUnavailableError('too-many-files')
  const changes = await classify(dir, tracked, untracked)
  const cached = lastTrees.get(index)
  if (!changes.add.length && !changes.remove.length && cached && before && cached.fingerprint === before)
    return { tree: cached.tree, skipped: changes.skipped }
  await updateIndex(dir, index, changes)
  // Blobs a seeded index names may live only in the user's repository, which writes never see.
  const written = await dir.store.write(['write-tree', '--missing-ok'], {
    cwd: dir.workTree,
    workTree: dir.workTree,
    index,
    timeoutMs: SCAN_TIMEOUT_MS,
  })
  const tree = written.stdout.toString('utf8').trim()
  if (!/^[0-9a-f]{40,64}$/.test(tree)) throw new Error(`Invalid tree id: ${tree}`)
  const after = await indexFingerprint(index)
  if (after) lastTrees.set(index, { fingerprint: after, tree })
  return { tree, skipped: changes.skipped }
}

export interface CaptureOptions {
  /** Ref that keeps the captured tree alive, written in the same exclusive section. */
  ref?: string
}

/** Captures the folder now, after every operation already queued on its store. */
export function captureTree(dir: SnapshotDir, opts: CaptureOptions = {}): Promise<CaptureResult> {
  return dir.store.exclusive(async () => {
    const meta = dir.store.meta.dirs[dir.dirKey]
    if (meta?.tooLargeAt && Date.now() - meta.tooLargeAt < TOO_LARGE_RETRY_MS)
      throw new SnapshotUnavailableError('too-many-files')
    let result: CaptureResult
    try {
      result = await attempt(dir, true)
    } catch (error) {
      if (error instanceof SnapshotUnavailableError) {
        if (error.reason === 'too-many-files') {
          dir.store.meta.dirs[dir.dirKey] = {
            ...(dir.store.meta.dirs[dir.dirKey] ?? { path: dir.workTree, lastUsedAt: Date.now() }),
            tooLargeAt: Date.now(),
          }
          await dir.store.saveMeta().catch(() => undefined)
        }
        throw error
      }
      if (error instanceof SnapshotGitError && error.kind !== 'failed') throw error
      // An index Git cannot read (or a seed it rejects) is only a cache: start over from the disk.
      const index = dir.store.indexPath(dir.dirKey)
      if (!existsSync(index)) throw error
      await fsp.rm(index, { force: true })
      lastTrees.delete(index)
      result = await attempt(dir, false)
    }
    if (opts.ref) await dir.store.write(['update-ref', opts.ref, result.tree])
    const now = Date.now()
    const entry = dir.store.meta.dirs[dir.dirKey]
    dir.store.meta.dirs[dir.dirKey] = { ...(entry ?? { path: dir.workTree }), path: dir.workTree, lastUsedAt: now }
    delete dir.store.meta.dirs[dir.dirKey]!.tooLargeAt
    dir.store.meta.lastUsedAt = now
    await dir.store.saveMeta().catch(() => undefined)
    return result
  })
}

export function forgetCapturedTreesForTests(): void {
  lastTrees.clear()
}
