import type { FleetRunnerManifest, FleetRunnerManifestEntry } from '@maestrly/bot-fleet-protocol'
import path from 'node:path'
import { resolveFolderLink } from '../folder-archive'
import { realFs } from '../real-fs'
import { errnoOf, RunnerJobError } from './errors'

// Files copied at once: clones are quick, and plain copies of many small files gain little from more.
const COPY_CONCURRENCY = 16

/** Where the blobs of a manifest are. */
export interface BlobSource {
  path(digest: string): string
}

const unsafe = (entry: string): RunnerJobError =>
  new RunnerJobError(
    'transfer_failed',
    `The job folder holds an entry that cannot be placed safely: ${entry.slice(0, 200)}`
  )

function entryLocation(root: string, entry: FleetRunnerManifestEntry): string {
  const segments = entry.path.split('/')
  if (
    entry.path.startsWith('/') ||
    entry.path.includes('\\') ||
    entry.path.includes('\0') ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  )
    throw unsafe(entry.path)
  const absolute = path.join(root, ...segments)
  if (!absolute.startsWith(root + path.sep)) throw unsafe(entry.path)
  return absolute
}

/**
 * Builds a job's folder from its manifest and the blob cache. Files are cloned from the blobs where the file system
 * can (APFS, Btrfs, XFS) and copied elsewhere, so a job that changes a file never changes the cache; each gets its
 * manifest mode. The manifest schema already keeps entries inside the folder; this refuses again any entry that would
 * land outside it, sit under a link, or repeat, and any link that points out.
 */
export async function assembleJobFolder(
  manifest: FleetRunnerManifest,
  blobs: BlobSource,
  workDir: string
): Promise<void> {
  await realFs.promises.mkdir(workDir, { recursive: true })
  const root = await realFs.promises.realpath(workDir)
  const links = new Map(
    manifest.entries.flatMap((entry) => (entry.kind === 'symlink' ? [[entry.path, entry.target] as const] : []))
  )
  const seen = new Set<string>()
  const directories: Array<{ absolute: string; mode: number; depth: number }> = []
  const copies = new Set<Promise<void>>()
  let failure: unknown = null

  const queue = async (copy: () => Promise<void>): Promise<void> => {
    if (failure) throw failure
    const running: Promise<void> = copy().then(
      () => void copies.delete(running),
      (error: unknown) => {
        failure ??= error
        copies.delete(running)
      }
    )
    copies.add(running)
    if (copies.size >= COPY_CONCURRENCY) await Promise.race(copies)
    if (failure) throw failure
  }

  try {
    for (const entry of manifest.entries) {
      const absolute = entryLocation(root, entry)
      if (seen.has(entry.path)) throw unsafe(entry.path)
      seen.add(entry.path)
      const segments = entry.path.split('/')
      // Nothing may sit under a link: writing it would go through the link.
      for (let end = 1; end < segments.length; end++)
        if (links.has(segments.slice(0, end).join('/'))) throw unsafe(entry.path)
      if (entry.kind === 'directory') {
        await realFs.promises.mkdir(absolute, { recursive: true })
        directories.push({ absolute, mode: entry.mode, depth: segments.length })
      } else if (entry.kind === 'file') {
        const source = blobs.path(entry.sha256)
        await realFs.promises.mkdir(path.dirname(absolute), { recursive: true })
        await queue(async () => {
          try {
            // EXCL: a name taken by an earlier entry is never written through.
            await realFs.promises.copyFile(
              source,
              absolute,
              realFs.constants.COPYFILE_FICLONE | realFs.constants.COPYFILE_EXCL
            )
          } catch (error) {
            if (errnoOf(error) === 'ENOENT')
              throw new RunnerJobError('transfer_failed', 'A file of the job is missing from the blob cache')
            throw error
          }
          await realFs.promises.chmod(absolute, entry.mode & 0o777)
        })
      } else {
        if (resolveFolderLink(entry.path, entry.target, links) === null) throw unsafe(entry.path)
        await realFs.promises.mkdir(path.dirname(absolute), { recursive: true })
        await realFs.promises.symlink(entry.target, absolute)
      }
    }
    await Promise.all(copies)
    if (failure) throw failure
  } catch (error) {
    await Promise.all(copies)
    throw error
  }
  // Deepest first, once what they hold is in. The owner keeps full access: the folder must stay writable and removable.
  directories.sort((a, b) => b.depth - a.depth)
  for (const directory of directories) await realFs.promises.chmod(directory.absolute, (directory.mode & 0o777) | 0o700)
}
