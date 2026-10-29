import { FLEET_RUNNER_LIMITS, type FleetRunnerManifest } from '@maestrly/bot-fleet-protocol'
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { Readable, Transform, type Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { constants as zlibConstants, createZstdCompress } from 'node:zlib'
import tar from 'tar-stream'
import { exactly, resolveFolderLink } from '../folder-archive'
import { realFs } from '../real-fs'
import { hashFile } from '../transfer-io'
import { errnoOf, RunnerJobError } from './errors'
import { RUNNER_SCRATCH_DIR } from './executor'

/** One thing a job leaves for its bot: a file, or a link that stays inside the folder. Paths use `/`. */
export type RunnerOutputEntry =
  | { kind: 'file'; path: string; size: number; mode: number }
  | { kind: 'symlink'; path: string; target: string }

/** A file added to the output archive under a name of its own, such as the job's log. */
export interface RunnerOutputExtra {
  name: string
  file: string
}

export interface PackedRunnerOutputs {
  /** Bytes of the archive file. */
  bytes: number
  /** SHA-256 of the archive file. */
  sha256: string
  /** What was packed from the job folder (links count no bytes). */
  files: Array<{ path: string; size: number }>
}

type EntryHeader = Partial<tar.Header> & Pick<tar.Header, 'name'>

const escapeRegExp = (text: string): string => text.replace(/[\\^$.*+?()[\]{}|/-]/g, '\\$&')

/**
 * A pattern for paths relative to the job folder, as a regular expression: `*` and `?` stay inside one path segment,
 * `**` crosses segments (`a/**` is everything under `a`, `**\/b` is `b` at any depth), `[abc]` and `[!abc]` are
 * classes, and `{x,y}` picks one. Unlike a shell, dot files match.
 */
export function runnerGlobToRegExp(glob: string): RegExp {
  const pattern = glob.replace(/^(?:\.\/)+/, '').replace(/\/+$/, '')
  const opens = new Map<number, number>()
  const closes = new Set<number>()
  const pending: number[] = []
  for (let index = 0; index < pattern.length; index++) {
    if (pattern[index] === '{') pending.push(index)
    else if (pattern[index] === '}' && pending.length) {
      opens.set(pending.pop()!, index)
      closes.add(index)
    }
  }
  let source = ''
  let depth = 0
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index]!
    if (char === '*') {
      let end = index + 1
      while (pattern[end] === '*') end++
      const wholeSegment = end - index >= 2 && (index === 0 || pattern[index - 1] === '/')
      if (wholeSegment && pattern[end] === '/') {
        source += '(?:[^/]+/)*'
        index = end
      } else if (wholeSegment && end === pattern.length) {
        source += '.*'
        index = end - 1
      } else {
        source += '[^/]*'
        index = end - 1
      }
    } else if (char === '?') source += '[^/]'
    else if (char === '[') {
      const close = pattern.indexOf(']', index + 2)
      if (close < 0) source += '\\['
      else {
        const negated = pattern[index + 1] === '!' || pattern[index + 1] === '^'
        const members = pattern.slice(index + (negated ? 2 : 1), close).replace(/[\\^]/g, '\\$&')
        source += `(?!/)[${negated ? '^' : ''}${members}]`
        index = close
      }
    } else if (char === '{' && opens.has(index)) {
      depth++
      source += '(?:'
    } else if (char === '}' && closes.has(index)) {
      depth--
      source += ')'
    } else if (char === ',' && depth > 0) source += '|'
    else source += escapeRegExp(char)
  }
  return new RegExp(`^${source}$`)
}

/**
 * What a finished job leaves for its bot: the files and links under the job folder that the output globs name (a glob
 * that names a folder takes everything under it), without the files whose content is the input at the same path (same
 * size and SHA-256 in the manifest), and without links that point out of the folder. Links are not followed, so named
 * caches are never walked. Sorted by path.
 */
export async function collectRunnerOutputs(
  workDir: string,
  outputs: readonly string[],
  manifest: FleetRunnerManifest
): Promise<RunnerOutputEntry[]> {
  const patterns = outputs.map(runnerGlobToRegExp)
  const matches = (relative: string) => patterns.some((pattern) => pattern.test(relative))
  const inputs = new Map(manifest.entries.map((entry) => [entry.path, entry]))
  const links = new Map<string, string>()
  const files: Array<Extract<RunnerOutputEntry, { kind: 'file' }>> = []
  const candidates: Array<Extract<RunnerOutputEntry, { kind: 'symlink' }>> = []

  const visit = async (directory: string, prefix: string, inherited: boolean): Promise<void> => {
    // A folder the job made unreadable, or removed meanwhile, has nothing to take.
    const entries = await realFs.promises.readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
      if (prefix && ['EACCES', 'ENOENT', 'ENOTDIR'].includes(errnoOf(error) ?? '')) return []
      throw error
    })
    entries.sort((a, b) => (a.name < b.name ? -1 : 1))
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      // The job's temporary folder is the runner's, unless the inputs brought a folder of that name.
      if (!prefix && entry.name === RUNNER_SCRATCH_DIR && !inputs.has(relative)) continue
      const absolute = path.join(directory, entry.name)
      const selected = inherited || matches(relative)
      if (entry.isDirectory()) await visit(absolute, relative, selected)
      else if (entry.isSymbolicLink()) {
        const target = await realFs.promises.readlink(absolute).catch(() => null)
        if (target === null) continue
        links.set(relative, target)
        if (selected) candidates.push({ kind: 'symlink', path: relative, target })
      } else if (entry.isFile() && selected) {
        const info = await realFs.promises.lstat(absolute).catch(() => null)
        if (info?.isFile()) files.push({ kind: 'file', path: relative, size: info.size, mode: info.mode & 0o777 })
      }
    }
  }
  await visit(workDir, '', false)

  const kept: RunnerOutputEntry[] = []
  for (const file of files) {
    const input = inputs.get(file.path)
    if (input?.kind === 'file' && input.size === file.size) {
      const digest = await hashFile(path.join(workDir, ...file.path.split('/'))).catch((error: unknown) => {
        if (errnoOf(error) === 'ENOENT' || errnoOf(error) === 'EACCES') return null
        throw error
      })
      if (digest === null || digest === input.sha256) continue
    }
    kept.push(file)
  }
  for (const link of candidates) {
    const input = inputs.get(link.path)
    if (input?.kind === 'symlink' && input.target === link.target) continue
    if (resolveFolderLink(link.path, link.target, links) !== null) kept.push(link)
  }
  // A name with a backslash cannot be named in the environment's archive rules: it would refuse the whole archive.
  return kept.filter((entry) => !entry.path.includes('\\')).sort((a, b) => (a.path < b.path ? -1 : 1))
}

/**
 * Writes the entries into `outFile` as a tar compressed with zstd, at their paths relative to the job folder, with the
 * `extras` under their own names. A file that changed while it was read goes in as it was when its entry began; one
 * that went away is left out. Refuses, with code `outputs_too_large`, more than `FLEET_RUNNER_LIMITS.outputBytesMax`
 * bytes of files; the extras do not count.
 */
export async function packRunnerOutputs(
  workDir: string,
  entries: readonly RunnerOutputEntry[],
  outFile: string,
  options: { extras?: readonly RunnerOutputExtra[]; signal?: AbortSignal } = {}
): Promise<PackedRunnerOutputs> {
  const { signal } = options
  const limit = FLEET_RUNNER_LIMITS.outputBytesMax
  const tooLarge = () =>
    new RunnerJobError('outputs_too_large', `The job's outputs are larger than ${limit / 1024 ** 3} GiB`)
  if (entries.reduce((sum, entry) => sum + (entry.kind === 'file' ? entry.size : 0), 0) > limit) throw tooLarge()

  const pack = tar.pack()
  const hash = createHash('sha256')
  let bytes = 0
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk)
      bytes += chunk.length
      callback(null, chunk)
    },
  })
  const written = pipeline(
    pack,
    // Media barely compresses: the fastest level.
    createZstdCompress({ params: { [zlibConstants.ZSTD_c_compressionLevel]: 1 } }),
    meter,
    createWriteStream(outFile, { flags: 'w', mode: 0o600 }),
    signal ? { signal } : {}
  )
  written.catch(() => undefined)
  /** Bytes of output files read so far, which the limit bounds even when a file grows after it was listed. */
  let packed = 0
  const add = (header: EntryHeader, content?: Buffer) =>
    new Promise<void>((resolve, reject) => {
      const callback = (error?: Error | null) => (error ? reject(error) : resolve())
      if (content) pack.entry(header, content, callback)
      else pack.entry(header, callback)
    })
  const addFile = async (name: string, absolute: string, count: boolean): Promise<{ size: number } | null> => {
    const handle = await realFs.promises.open(absolute, 'r').catch((error: unknown) => {
      if (errnoOf(error) === 'ENOENT' || errnoOf(error) === 'EACCES') return null
      throw error
    })
    if (!handle) return null
    try {
      const info = await handle.stat()
      if (!info.isFile()) return null
      const header: EntryHeader = { name, type: 'file', size: info.size, mode: info.mode & 0o777, mtime: info.mtime }
      if (!info.size) await add(header, Buffer.alloc(0))
      else
        await new Promise<void>((resolve, reject) => {
          const sink = pack.entry(header, (error) => (error ? reject(error) : resolve()))
          const source: Readable = Readable.from(
            exactly(handle, info.size, (chunk) => {
              if (!count) return
              packed += chunk
              if (packed > limit) source.destroy(tooLarge())
            })
          )
          // tar-stream's entries are streamx streams, which Node's pipeline accepts.
          pipeline(source, sink as unknown as Writable).catch(reject)
        })
      return { size: info.size }
    } finally {
      await handle.close()
    }
  }

  const files: PackedRunnerOutputs['files'] = []
  try {
    for (const entry of entries) {
      signal?.throwIfAborted()
      if (entry.kind === 'symlink') {
        await add({ name: entry.path, type: 'symlink', linkname: entry.target, mode: 0o777 })
        files.push({ path: entry.path, size: 0 })
        continue
      }
      const added = await addFile(entry.path, path.join(workDir, ...entry.path.split('/')), true)
      if (added) files.push({ path: entry.path, size: added.size })
    }
    for (const extra of options.extras ?? []) await addFile(extra.name, extra.file, false)
    pack.finalize()
    await written
  } catch (error) {
    pack.destroy()
    await written.catch(() => undefined)
    await rm(outFile, { force: true })
    throw error
  }
  return { bytes, sha256: hash.digest('hex'), files }
}
