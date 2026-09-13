import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, join, resolve, parse, sep } from 'node:path'
import type { Asset } from './catalog.js'
export async function verifyAsset(asset: Asset, executable = false): Promise<string> {
  if (!isAbsolute(asset.path) || !/^[a-f0-9]{64}$/i.test(asset.sha256))
    throw new Error('Asset requires an absolute path and SHA256')
  await assertNoSymlinks(asset.path)
  const resolved = await realpath(asset.path)
  const stat = await lstat(asset.path)
  if (stat.isSymbolicLink() || !stat.isFile() || (executable && !(stat.mode & 0o111)))
    throw new Error('Asset must be a regular verified file')
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(resolved)) hash.update(chunk)
  if (hash.digest('hex') !== asset.sha256.toLowerCase()) throw new Error('Asset checksum mismatch')
  return resolved
}

export async function assertNoSymlinks(path: string, allowMissing = false) {
  const absolute = resolve(path)
  let current = parse(absolute).root
  for (const part of absolute.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, part)
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error('Symlink asset path is forbidden')
    } catch (error) {
      if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
  }
}
