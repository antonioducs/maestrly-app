import { constants } from 'node:fs'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import path from 'node:path'
import { contentTypeFor } from './bundle-paths.js'
import { ArtifactHostError } from './errors.js'
import { MAX_FILE_BYTES, MAX_FILES_PER_VERSION, MAX_VERSION_BYTES } from './limits.js'
import type { BundleFile } from './schemas.js'

/**
 * Reads a folder (such as a build output) as a bundle. Hidden entries and `node_modules` are skipped, files of an
 * unknown type are reported in `skipped`, and symbolic links or special files abort the read: nothing outside the
 * folder can be published through it.
 */
export async function readBundleDirectory(root: string): Promise<{ files: BundleFile[]; skipped: string[] }> {
  let base: string
  try {
    base = await realpath(root)
    if (!(await lstat(base)).isDirectory()) throw Object.assign(new Error('not a directory'), { code: 'ENOTDIR' })
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR')
      throw new ArtifactHostError('not_found', 'The directory does not exist')
    throw new ArtifactHostError('storage', 'The directory cannot be read')
  }

  const files: BundleFile[] = []
  const skipped: string[] = []
  let total = 0

  const walk = async (dir: string, relative: string): Promise<void> => {
    const entries = (await readdir(dir)).sort()
    for (const name of entries) {
      if (name.startsWith('.') || name === 'node_modules') continue
      const absolute = path.join(dir, name)
      const bundlePath = relative ? `${relative}/${name}` : name
      const stat = await lstat(absolute)
      if (stat.isSymbolicLink())
        throw new ArtifactHostError('invalid_path', `Symbolic links are not published: ${bundlePath}`, {
          path: bundlePath,
        })
      if (stat.isDirectory()) {
        await walk(absolute, bundlePath)
        continue
      }
      if (!stat.isFile())
        throw new ArtifactHostError('invalid_path', `Special files are not published: ${bundlePath}`, {
          path: bundlePath,
        })
      if (!contentTypeFor(bundlePath)) {
        skipped.push(bundlePath)
        continue
      }
      if (files.length >= MAX_FILES_PER_VERSION)
        throw new ArtifactHostError('too_many_files', `At most ${MAX_FILES_PER_VERSION} files per version`)
      if (stat.size > MAX_FILE_BYTES)
        throw new ArtifactHostError('file_too_large', `${bundlePath} exceeds 10 MiB`, { path: bundlePath })
      total += stat.size
      if (total > MAX_VERSION_BYTES) throw new ArtifactHostError('bundle_too_large', 'A version cannot exceed 50 MiB')
      files.push({ path: bundlePath, bytes: await readRegularFile(absolute, stat) })
    }
  }

  await walk(base, '')
  return { files, skipped }
}

/** Opens without following links and checks that the file is still the one that was listed. */
async function readRegularFile(file: string, listed: { ino: number; dev: number }): Promise<Uint8Array> {
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.ino !== listed.ino || opened.dev !== listed.dev)
      throw new ArtifactHostError('invalid_path', 'A file changed while it was being read')
    return new Uint8Array(await handle.readFile())
  } finally {
    await handle.close()
  }
}
