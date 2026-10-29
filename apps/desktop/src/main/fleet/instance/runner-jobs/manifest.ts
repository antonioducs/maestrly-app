import { createHash } from 'node:crypto'
import path from 'node:path'
import {
  FLEET_RUNNER_DEFAULT_EXCLUDES,
  FLEET_RUNNER_LIMITS,
  type FleetRunnerJobSpec,
  type FleetRunnerManifest,
  type FleetRunnerManifestEntry,
  fleetRunnerManifestSchema,
} from '@maestrly/bot-fleet-protocol'
import { resolveFolderLink } from '../../../folder-archive'
import { realFs } from '../../../real-fs'
import { conflict, errno, invalid, mapLimit, RUNNER_FOLDER_STATE, unreadable, writeFileAtomically } from './shared'

const fs = realFs.promises

/** A blob of a job folder: where its bytes are (relative to the folder, with `/`) and how many there are. */
export type RunnerBlob = { path: string; size: number }
/** The blobs of a manifest by SHA-256, each at the first path that holds it. */
export type RunnerBlobs = Map<string, RunnerBlob>

const HASH_CONCURRENCY = 8
const INDEX_VERSION = 1

/**
 * Turns an exclude pattern into a test. A pattern ending in `/` names a directory: one without another `/` matches a
 * directory of that name at any depth, otherwise the path from the folder root. Any other pattern is a glob over the
 * path from the root (`*` and `?` stay within a segment, `**` crosses them) and, without a `/`, over the base name.
 */
function compileExclude(pattern: string): ((relative: string, name: string, directory: boolean) => boolean) | null {
  let source = pattern.replace(/^(?:\.\/)+/, '')
  const directoriesOnly = source.endsWith('/')
  source = source.replace(/\/+$/, '')
  if (!source) return null
  const hasSlash = source.includes('/')
  const expression = globExpression(source)
  if (directoriesOnly) return (relative, name, directory) => directory && expression.test(hasSlash ? relative : name)
  return (relative, name) => expression.test(relative) || (!hasSlash && expression.test(name))
}

function globExpression(glob: string): RegExp {
  let source = ''
  for (let index = 0; index < glob.length; index++) {
    const char = glob[index]
    if (char === '*') {
      if (glob[index + 1] === '*') {
        // `**/` also stands for no folder at all; any other `**` crosses separators.
        if (glob[index + 2] === '/') {
          source += '(?:.*/)?'
          index += 2
        } else {
          source += '.*'
          index += 1
        }
      } else source += '[^/]*'
    } else if (char === '?') source += '[^/]'
    else source += char.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&')
  }
  return new RegExp(`^${source}$`, 's')
}

/** A cache's path as the walk names paths: `/`-separated and plain, or null for one that names the whole folder. */
function cachePath(value: string): string | null {
  const normal = path.posix.normalize(value).replace(/\/+$/, '')
  return normal === '' || normal === '.' || normal.startsWith('../') || normal === '..' ? null : normal
}

interface IndexEntry {
  size: number
  mtimeMs: number
  ino: number
  sha256: string
}
type DigestIndex = Map<string, IndexEntry>

async function loadIndex(file: string): Promise<DigestIndex> {
  const index: DigestIndex = new Map()
  try {
    const value = JSON.parse(await fs.readFile(file, 'utf8')) as { version?: unknown; files?: unknown }
    if (value.version !== INDEX_VERSION || !Array.isArray(value.files)) return index
    for (const row of value.files as unknown[]) {
      if (!Array.isArray(row)) continue
      const [name, size, mtimeMs, ino, sha256] = row as unknown[]
      if (
        typeof name === 'string' &&
        typeof size === 'number' &&
        typeof mtimeMs === 'number' &&
        typeof ino === 'number' &&
        typeof sha256 === 'string' &&
        /^[a-f0-9]{64}$/.test(sha256)
      )
        index.set(name, { size, mtimeMs, ino, sha256 })
    }
  } catch {
    // No index yet, or one that cannot be read: every file is hashed.
  }
  return index
}

async function saveIndex(file: string, index: DigestIndex): Promise<void> {
  const files = [...index].map(([name, entry]) => [name, entry.size, entry.mtimeMs, entry.ino, entry.sha256])
  await writeFileAtomically(file, JSON.stringify({ version: INDEX_VERSION, files }))
}

/** SHA-256 and byte count of a file, read without following a link. */
async function hashFile(file: string, signal?: AbortSignal): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash('sha256')
  let bytes = 0
  const handle = await fs.open(file, realFs.constants.O_RDONLY | (realFs.constants.O_NOFOLLOW ?? 0))
  try {
    const stream = handle.createReadStream({ autoClose: false, ...(signal ? { signal } : {}) })
    for await (const chunk of stream) {
      hash.update(chunk as Buffer)
      bytes += (chunk as Buffer).length
    }
  } finally {
    await handle.close()
  }
  return { sha256: hash.digest('hex'), bytes }
}

const tooMany = (): Error =>
  invalid(`The job folder holds more than ${FLEET_RUNNER_LIMITS.inputFilesMax} files and folders to send.`)
const tooLarge = (): Error =>
  invalid(`The job folder holds more than ${FLEET_RUNNER_LIMITS.inputBytesMax} bytes of files to send.`)

/** The blobs a manifest names, each at the first path that holds it. */
export function runnerBlobsOf(manifest: FleetRunnerManifest): RunnerBlobs {
  const blobs: RunnerBlobs = new Map()
  for (const entry of manifest.entries)
    if (entry.kind === 'file' && !blobs.has(entry.sha256))
      blobs.set(entry.sha256, { path: entry.path, size: entry.size })
  return blobs
}

/**
 * Walks a job folder without following links and describes it for a runner, parents before children. Left out are
 * the excludes (`spec.exclude`, or the defaults when it names none), the named caches' paths, which stay on the
 * runner, and the folder's own `.maestrly/runner-jobs` where staging and logs go. Links that stay inside the folder
 * travel as links; links that leave it, devices, sockets and pipes are counted in `skipped`. A digest index at
 * `indexFile` (by path, size, modification time and inode) spares hashing a file that did not change; it is rewritten
 * after each build. A folder past the input limits is refused.
 */
export async function buildRunnerManifest(input: {
  jobId: string
  folder: string
  spec: FleetRunnerJobSpec
  indexFile: string
  signal?: AbortSignal
}): Promise<{ manifest: FleetRunnerManifest; blobs: RunnerBlobs }> {
  const { signal } = input
  const excludes = (input.spec.exclude ?? FLEET_RUNNER_DEFAULT_EXCLUDES).flatMap((pattern) => {
    const test = compileExclude(pattern)
    return test ? [test] : []
  })
  const caches = new Set(input.spec.caches.flatMap((cache) => cachePath(cache.path) ?? []))
  const root = input.folder
  const previous = await loadIndex(input.indexFile)

  interface Pending {
    entry: Extract<FleetRunnerManifestEntry, { kind: 'file' }>
    absolute: string
    size: number
    mtimeMs: number
    ino: number
    vanished: boolean
  }
  const entries: FleetRunnerManifestEntry[] = []
  const links = new Map<string, string>()
  const pending: Pending[] = []
  let bytes = 0
  let skipped = 0

  const visit = async (directory: string, prefix: string): Promise<void> => {
    signal?.throwIfAborted()
    let names: string[]
    try {
      names = (await fs.readdir(directory)).sort()
    } catch (error) {
      if (!prefix && (errno(error) === 'ENOENT' || errno(error) === 'ENOTDIR'))
        throw conflict('The job folder does not exist.')
      if (prefix && unreadable(error)) {
        skipped++
        return
      }
      throw error
    }
    for (const name of names) {
      const relative = prefix ? `${prefix}/${name}` : name
      if (relative === RUNNER_FOLDER_STATE || caches.has(relative)) continue
      const absolute = path.join(directory, name)
      const info = await fs.lstat(absolute).catch((error: unknown) => {
        if (unreadable(error)) return null
        throw error
      })
      if (!info) {
        skipped++
        continue
      }
      const directoryEntry = info.isDirectory()
      let target: string | null = null
      if (info.isSymbolicLink()) {
        target = await fs.readlink(absolute).catch(() => null)
        // Even a link that is left out can lead a kept link out of the folder.
        if (target !== null) links.set(relative, target)
      }
      if (excludes.some((excluded) => excluded(relative, name, directoryEntry))) continue
      if (relative.length > FLEET_RUNNER_LIMITS.pathMax || name.includes('\\')) {
        skipped++
        continue
      }
      const mode = info.mode & 0o7777
      if (directoryEntry) {
        entries.push({ kind: 'directory', path: relative, mode })
        if (entries.length > FLEET_RUNNER_LIMITS.inputFilesMax) throw tooMany()
        await visit(absolute, relative)
      } else if (info.isFile()) {
        bytes += info.size
        if (bytes > FLEET_RUNNER_LIMITS.inputBytesMax) throw tooLarge()
        const entry = { kind: 'file' as const, path: relative, mode, size: info.size, sha256: '' }
        entries.push(entry)
        if (entries.length > FLEET_RUNNER_LIMITS.inputFilesMax) throw tooMany()
        pending.push({ entry, absolute, size: info.size, mtimeMs: info.mtimeMs, ino: info.ino, vanished: false })
      } else if (info.isSymbolicLink() && target && target.length <= FLEET_RUNNER_LIMITS.pathMax) {
        entries.push({ kind: 'symlink', path: relative, target })
        if (entries.length > FLEET_RUNNER_LIMITS.inputFilesMax) throw tooMany()
      } else skipped++
    }
  }
  await visit(root, '')

  const index: DigestIndex = new Map()
  await mapLimit(pending, HASH_CONCURRENCY, async (item) => {
    signal?.throwIfAborted()
    const known = previous.get(item.entry.path)
    if (known && known.size === item.size && known.mtimeMs === item.mtimeMs && known.ino === item.ino) {
      item.entry.sha256 = known.sha256
      index.set(item.entry.path, known)
      return
    }
    try {
      const { sha256, bytes: read } = await hashFile(item.absolute, signal)
      item.entry.sha256 = sha256
      item.entry.size = read
      const after = await fs.lstat(item.absolute)
      // A file that changed while it was read is described as read, and hashed again next time.
      if (read === item.size && after.size === item.size && after.mtimeMs === item.mtimeMs && after.ino === item.ino)
        index.set(item.entry.path, { size: item.size, mtimeMs: item.mtimeMs, ino: item.ino, sha256 })
    } catch (error) {
      if (!unreadable(error)) throw error
      item.vanished = true
    }
  })

  const gone = new Set<FleetRunnerManifestEntry>(pending.filter((item) => item.vanished).map((item) => item.entry))
  // A link is kept when, followed through the folder's other links, it leads to a path inside the folder.
  const kept = entries.filter(
    (entry) =>
      !gone.has(entry) && (entry.kind !== 'symlink' || resolveFolderLink(entry.path, entry.target, links) !== null)
  )
  skipped += entries.length - kept.length
  const total = kept.reduce((sum, entry) => sum + (entry.kind === 'file' ? entry.size : 0), 0)
  if (total > FLEET_RUNNER_LIMITS.inputBytesMax) throw tooLarge()

  await saveIndex(input.indexFile, index).catch(() => undefined)
  const manifest: FleetRunnerManifest = { jobId: input.jobId, entries: kept, bytes: total, skipped }
  return { manifest, blobs: runnerBlobsOf(manifest) }
}

/** Keeps a job's manifest in its folder, so its blobs can be served after this process restarted. */
export async function saveRunnerManifest(file: string, manifest: FleetRunnerManifest): Promise<void> {
  await writeFileAtomically(file, JSON.stringify(manifest))
}

/** The manifest a job kept, or null when there is none. */
export async function loadRunnerManifest(
  file: string
): Promise<{ manifest: FleetRunnerManifest; blobs: RunnerBlobs } | null> {
  let text: string
  try {
    text = await fs.readFile(file, 'utf8')
  } catch (error) {
    if (errno(error) === 'ENOENT') return null
    throw error
  }
  try {
    const manifest = fleetRunnerManifestSchema.parse(JSON.parse(text))
    return { manifest, blobs: runnerBlobsOf(manifest) }
  } catch {
    return null
  }
}
