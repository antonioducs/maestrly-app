import { createReadStream, createWriteStream } from 'node:fs'
import {
  chmod,
  type FileHandle,
  lstat,
  mkdir,
  open,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  utimes,
} from 'node:fs/promises'
import path from 'node:path'
import { Readable, Transform, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createZstdCompress, createZstdDecompress } from 'node:zlib'
import tar from 'tar-stream'
import { writeAt } from './transfer-io'

/**
 * A folder as one file: a zstd-compressed tar of everything under it, which is how the host and this computer move
 * whole folders through the file transfer routes. Packing never follows links: a link is kept as a link when it
 * resolves inside the folder, and left out otherwise, as are devices, FIFOs and sockets. Extracting trusts nothing in
 * the archive: an entry that would land outside the destination, a link that would point out of it, or an entry of
 * another kind refuses the whole archive. Links are created last, so no file is ever written through one.
 */

export type FolderEntryKind = 'directory' | 'file' | 'symlink'
export interface FolderEntry {
  /** Under the folder, with `/` between segments whatever the platform. */
  relative: string
  kind: FolderEntryKind
  size: number
  mode: number
  mtimeMs: number
  /** Where a link points, as it was written. */
  target?: string
}
export interface FolderScan {
  root: string
  entries: FolderEntry[]
  /** Bytes of the folder's files. */
  bytes: number
  /** Entries left out: unreadable, of another kind, or links that leave the folder. */
  skipped: number
}
export interface FolderArchiveProgress {
  entries: number
  bytes: number
}
export interface FolderArchiveResult {
  entries: number
  bytes: number
  skipped: number
}

/** The archive holds an entry that cannot be extracted safely: nothing of it is kept. */
export class UnsafeArchiveError extends Error {}

const READ_BYTES = 1024 * 1024
const MAX_LINK_HOPS = 40
// What a folder may hold that cannot be read now: left out, not a reason to refuse the whole folder.
const UNREADABLE = new Set(['ENOENT', 'EACCES', 'EPERM', 'ELOOP', 'ENOTDIR', 'EBUSY'])
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

const errno = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | null)?.code
const unreadable = (error: unknown): boolean => UNREADABLE.has(errno(error) ?? '')
const unsafe = (detail: string): UnsafeArchiveError => new UnsafeArchiveError(`Unsafe archive entry: ${detail}`)

function targetSegments(target: string, platform: NodeJS.Platform): string[] | null {
  if (!target || target.includes('\0') || target.startsWith('/')) return null
  if (platform === 'win32' && (/^[A-Za-z]:/.test(target) || target.startsWith('\\'))) return null
  return target.split(platform === 'win32' ? /[\\/]/ : '/')
}

/**
 * Where a link at `link` pointing to `target` resolves under the folder, following the folder's other links, or null
 * when it would leave the folder (or loops). Paths it reaches need not exist.
 */
export function resolveFolderLink(
  link: string,
  target: string,
  links: ReadonlyMap<string, string>,
  platform: NodeJS.Platform = process.platform
): string | null {
  const first = targetSegments(target, platform)
  if (!first) return null
  const parts: string[] = []
  // The link's own folder is resolved too: it may sit under another link.
  let pending = [...link.split('/').slice(0, -1), ...first]
  let hops = 0
  while (pending.length) {
    const segment = pending.shift()!
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (!parts.length) return null
      parts.pop()
      continue
    }
    parts.push(segment)
    const next = links.get(parts.join('/'))
    if (next === undefined) continue
    const segments = targetSegments(next, platform)
    if (!segments || ++hops > MAX_LINK_HOPS) return null
    parts.pop()
    pending = [...segments, ...pending]
  }
  return parts.join('/')
}

const windowsUnfit = (segment: string): boolean =>
  /[<>:"|?*\\\u0000-\u001f]/.test(segment) || /[ .]$/.test(segment) || WINDOWS_RESERVED.test(segment)

/** The entry's path under the destination; null when this platform cannot name it, so it is left out. */
export function folderEntryRelative(name: string, platform: NodeJS.Platform = process.platform): string | null {
  const trimmed = name.replace(/\/+$/, '')
  if (!trimmed || trimmed.includes('\0') || trimmed.startsWith('/')) throw unsafe(name)
  const segments = trimmed.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) throw unsafe(name)
  if (platform === 'win32' && segments.some(windowsUnfit)) return null
  return trimmed
}

/** Every entry under `root`, links unfollowed; `exclude` names absolute paths left out with what they hold. */
export async function scanFolder(
  root: string,
  options: { signal?: AbortSignal; exclude?: readonly string[] } = {}
): Promise<FolderScan> {
  const excluded = new Set((options.exclude ?? []).map((item) => path.resolve(item)))
  const entries: FolderEntry[] = []
  let bytes = 0
  let skipped = 0
  const visit = async (directory: string, prefix: string): Promise<void> => {
    options.signal?.throwIfAborted()
    let names: string[]
    try {
      names = (await readdir(directory)).sort()
    } catch (error) {
      if (prefix && unreadable(error)) {
        skipped++
        return
      }
      throw error
    }
    for (const name of names) {
      const absolute = path.join(directory, name)
      if (excluded.has(absolute)) continue
      const relative = prefix ? `${prefix}/${name}` : name
      const info = await lstat(absolute).catch((error: unknown) => {
        if (unreadable(error)) return null
        throw error
      })
      const base = info && { relative, size: 0, mode: info.mode & 0o777, mtimeMs: info.mtimeMs }
      if (!info || !base) skipped++
      else if (info.isDirectory()) {
        entries.push({ ...base, kind: 'directory' })
        await visit(absolute, relative)
      } else if (info.isFile()) {
        entries.push({ ...base, kind: 'file', size: info.size })
        bytes += info.size
      } else if (info.isSymbolicLink()) {
        const target = await readlink(absolute).catch(() => null)
        if (target === null) skipped++
        else
          entries.push({
            ...base,
            kind: 'symlink',
            target: process.platform === 'win32' ? target.replaceAll('\\', '/') : target,
          })
      } else skipped++
    }
  }
  await visit(root, '')
  const links = new Map(entries.flatMap((entry) => (entry.kind === 'symlink' ? [[entry.relative, entry.target!]] : [])))
  const kept = entries.filter(
    (entry) => entry.kind !== 'symlink' || resolveFolderLink(entry.relative, entry.target!, links) !== null
  )
  return { root, entries: kept, bytes, skipped: skipped + entries.length - kept.length }
}

/** Exactly `size` bytes of the file: a file that shrank since is padded with zeros, one that grew is cut. */
export async function* exactly(
  handle: FileHandle,
  size: number,
  read: (bytes: number) => void
): AsyncGenerator<Buffer> {
  let position = 0
  while (position < size) {
    const length = Math.min(READ_BYTES, size - position)
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, position)
    if (!bytesRead) {
      yield Buffer.alloc(size - position)
      read(size - position)
      return
    }
    position += bytesRead
    read(bytesRead)
    yield bytesRead === length ? buffer : buffer.subarray(0, bytesRead)
  }
}

/**
 * Packs the folder into `outFile`, which must not exist. A file that changes while it is packed goes in as it was
 * when its entry began; one that went away since the scan is left out.
 */
export async function packFolder(
  root: string,
  outFile: string,
  options: {
    signal?: AbortSignal
    exclude?: readonly string[]
    scan?: FolderScan
    onProgress?: (progress: FolderArchiveProgress) => void
  } = {}
): Promise<FolderArchiveResult> {
  const { signal } = options
  const scan = options.scan ?? (await scanFolder(root, options))
  const pack = tar.pack()
  const written = pipeline(
    pack,
    createZstdCompress(),
    createWriteStream(outFile, { flags: 'wx', mode: 0o600 }),
    signal ? { signal } : {}
  )
  written.catch(() => undefined)
  const done = { entries: 0, bytes: 0 }
  let skipped = scan.skipped
  const add = (header: Partial<tar.Header> & Pick<tar.Header, 'name'>, content?: Buffer) =>
    new Promise<void>((resolve, reject) => {
      const callback = (error?: Error | null) => (error ? reject(error) : resolve())
      if (content) pack.entry(header, content, callback)
      else pack.entry(header, callback)
    })
  try {
    for (const entry of scan.entries) {
      signal?.throwIfAborted()
      const mtime = new Date(entry.mtimeMs)
      if (entry.kind === 'directory') await add({ name: entry.relative, type: 'directory', mode: entry.mode, mtime })
      else if (entry.kind === 'symlink')
        await add({ name: entry.relative, type: 'symlink', linkname: entry.target!, mode: 0o777, mtime })
      else {
        const handle = await open(path.join(root, ...entry.relative.split('/')), 'r').catch((error: unknown) => {
          if (unreadable(error)) return null
          throw error
        })
        if (!handle) {
          skipped++
          continue
        }
        try {
          const info = await handle.stat()
          if (!info.isFile()) {
            skipped++
            continue
          }
          const header = { name: entry.relative, type: 'file' as const, size: info.size, mode: info.mode & 0o777 }
          if (!info.size) await add({ ...header, mtime: info.mtime }, Buffer.alloc(0))
          else
            await new Promise<void>((resolve, reject) => {
              const sink = pack.entry({ ...header, mtime: info.mtime }, (error) => (error ? reject(error) : resolve()))
              const source = Readable.from(
                exactly(handle, info.size, (bytes) => {
                  done.bytes += bytes
                  options.onProgress?.({ ...done })
                })
              )
              // tar-stream's entries are streamx streams, which Node's pipeline accepts.
              pipeline(source, sink as unknown as Writable).catch(reject)
            })
        } finally {
          await handle.close()
        }
      }
      done.entries++
      options.onProgress?.({ ...done })
    }
    pack.finalize()
    await written
  } catch (error) {
    pack.destroy()
    await written.catch(() => undefined)
    await rm(outFile, { force: true })
    throw error
  }
  return { ...done, skipped }
}

function within(root: string, relative: string): string {
  const absolute = path.join(root, ...relative.split('/'))
  if (!absolute.startsWith(root + path.sep)) throw unsafe(relative)
  return absolute
}

/**
 * Extracts an archive made by `packFolder` into `destination`, a folder this creates (its parent must exist). On any
 * failure nothing of it is kept. `onProgress` reports the bytes of the archive read so far.
 */
export async function extractArchive(
  file: string,
  destination: string,
  options: { signal?: AbortSignal; onProgress?: (archiveBytes: number) => void } = {}
): Promise<FolderArchiveResult> {
  const { signal } = options
  await mkdir(destination)
  try {
    const root = await realpath(destination)
    const seen = new Set<string>()
    const parents = new Set<string>()
    const links: Array<{ relative: string; target: string }> = []
    const directories: Array<{ relative: string; mode: number; mtime: Date | undefined }> = []
    const done = { entries: 0, bytes: 0, skipped: 0 }

    const write = async (absolute: string, header: tar.Header, stream: Readable): Promise<boolean> => {
      await mkdir(path.dirname(absolute), { recursive: true })
      // A name taken by another that differs only in case, on a file system that does not tell them apart.
      const handle = await open(absolute, 'wx', 0o600).catch((error: unknown) => {
        if (errno(error) === 'EEXIST') return null
        throw error
      })
      if (!handle) return false
      try {
        const expected = header.size ?? 0
        let size = 0
        const sink = new Writable({
          write(chunk: Buffer, _encoding, callback) {
            const position = size
            size += chunk.length
            if (size > expected) return callback(unsafe(`${header.name} is larger than declared`))
            writeAt(handle, chunk, position).then(() => callback(), callback)
          },
        })
        await pipeline(stream, sink)
        if (size !== expected) throw unsafe(`${header.name} is shorter than declared`)
        await handle.chmod(((header.mode ?? 0o644) & 0o777) | 0o600)
        if (header.mtime) await handle.utimes(header.mtime, header.mtime)
        done.bytes += size
      } finally {
        await handle.close()
      }
      return true
    }

    const consume = async (header: tar.Header, stream: Readable): Promise<void> => {
      signal?.throwIfAborted()
      const relative = folderEntryRelative(header.name)
      if (relative === null) {
        done.skipped++
        return
      }
      if (seen.has(relative)) throw unsafe(`${header.name} appears twice`)
      seen.add(relative)
      const segments = relative.split('/')
      for (let index = 1; index < segments.length; index++) parents.add(segments.slice(0, index).join('/'))
      const absolute = within(root, relative)
      switch (header.type) {
        case 'directory':
          await mkdir(absolute, { recursive: true })
          directories.push({ relative, mode: header.mode ?? 0o755, mtime: header.mtime })
          done.entries++
          return
        case 'file':
        case 'contiguous-file':
          if (await write(absolute, header, stream)) done.entries++
          else done.skipped++
          return
        case 'symlink':
          links.push({ relative, target: header.linkname ?? '' })
          return
        default:
          throw unsafe(`${header.name} is a ${header.type ?? 'unknown'} entry`)
      }
    }

    const extract = tar.extract()
    extract.on('entry', (header, stream, next) => {
      const entry = stream as unknown as Readable
      consume(header, entry).then(
        () => {
          entry.resume()
          next()
        },
        (error: unknown) => {
          entry.resume()
          next(error as Error)
        }
      )
    })
    let read = 0
    const counted = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        read += chunk.length
        options.onProgress?.(read)
        callback(null, chunk)
      },
    })
    try {
      await pipeline(
        createReadStream(file),
        counted,
        createZstdDecompress(),
        extract as unknown as Writable,
        signal ? { signal } : {}
      )
    } catch (error) {
      // The file system's own failures (no space, no permission) say what they are; the rest is a broken archive.
      if (error instanceof UnsafeArchiveError || signal?.aborted || /^E[A-Z]+$/.test(errno(error) ?? '')) throw error
      throw new UnsafeArchiveError(`The archive cannot be read: ${(error as Error).message}`)
    }

    const linkTargets = new Map(links.map((link) => [link.relative, link.target]))
    const isDirectory = new Set([...parents, ...directories.map((directory) => directory.relative)])
    const resolved = links.map((link) => {
      // Nothing may sit under a link: writing it would have gone through the link.
      if (parents.has(link.relative)) throw unsafe(`${link.relative} is a link with entries under it`)
      const target = resolveFolderLink(link.relative, link.target, linkTargets)
      if (target === null) throw unsafe(`${link.relative} points outside the folder`)
      return { ...link, directory: isDirectory.has(target) }
    })
    for (const link of resolved) {
      signal?.throwIfAborted()
      const absolute = within(root, link.relative)
      await mkdir(path.dirname(absolute), { recursive: true })
      try {
        await symlink(
          process.platform === 'win32' ? link.target.replaceAll('/', '\\') : link.target,
          absolute,
          process.platform === 'win32' ? (link.directory ? 'dir' : 'file') : undefined
        )
        done.entries++
      } catch (error) {
        // Windows creates links only with developer mode or elevation: the folder arrives without them.
        const refused = process.platform === 'win32' && (errno(error) === 'EPERM' || errno(error) === 'EACCES')
        if (errno(error) !== 'EEXIST' && !refused) throw error
        done.skipped++
      }
    }
    // Deepest first, once what they hold is in: a folder without write permission no longer blocks its entries.
    directories.sort((a, b) => b.relative.split('/').length - a.relative.split('/').length)
    for (const directory of directories) {
      const absolute = within(root, directory.relative)
      if (process.platform !== 'win32') await chmod(absolute, (directory.mode & 0o777) | 0o700)
      if (directory.mtime) await utimes(absolute, directory.mtime, directory.mtime)
    }
    return done
  } catch (error) {
    await rm(destination, { recursive: true, force: true })
    throw error
  }
}

/**
 * Moves a finished folder into `directory` under `name`, or `name (2)`, `name (3)`… when it is taken, never replacing
 * what is there; returns where it landed.
 */
export async function publishFolderExclusive(
  folder: string,
  directory: string,
  name: string,
  signal?: AbortSignal
): Promise<string> {
  for (let suffix = 1; suffix < 10_000; suffix++) {
    signal?.throwIfAborted()
    const destination = path.join(directory, suffix > 1 ? `${name} (${suffix})` : name)
    if (await lstat(destination).catch(() => null)) continue
    try {
      // POSIX replaces an empty folder that appeared meanwhile; anything with entries refuses, as does Windows.
      await rename(folder, destination)
      return destination
    } catch (error) {
      if (!['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(errno(error) ?? '')) throw error
      if (!(await lstat(destination).catch(() => null))) throw error
    }
  }
  throw new Error('Too many folder name collisions')
}
