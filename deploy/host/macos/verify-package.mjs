import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
export async function sha256(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}
export async function verifyPackage(directory, manifestPath, expectedHash) {
  if (!/^[a-f0-9]{64}$/.test(expectedHash)) throw Error('Explicit manifest SHA256 required')
  const root = await lstat(directory)
  const info = await lstat(manifestPath)
  if (!root.isDirectory() || !info.isFile() || info.nlink !== 1 || info.size > 4 * 1024 * 1024) throw Error('Unsafe package manifest')
  if (await sha256(manifestPath) !== expectedHash) throw Error('Manifest checksum mismatch')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  if (manifest.version !== 1 || !Array.isArray(manifest.files) || !manifest.files.length) throw Error('Invalid manifest')
  const expected = new Map()
  for (const entry of manifest.files) {
    if (typeof entry.path !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9_./+-]*$/.test(entry.path) || entry.path.split('/').some(p => !p || p === '.' || p === '..') || entry.path === 'manifest.json' || expected.has(entry.path) || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw Error('Invalid manifest entry')
    expected.set(entry.path, entry.sha256)
  }
  async function walk(dir, prefix = '') {
    for (const name of await readdir(dir)) {
      const relative = prefix + name
      const path = resolve(dir, name)
      const stat = await lstat(path)
      if (stat.isDirectory()) await walk(path, relative + '/')
      else if (stat.isFile() && stat.nlink === 1) {
        const hash = relative === 'manifest.json' ? expectedHash : expected.get(relative)
        if (!hash || await sha256(path) !== hash) throw Error('Package checksum or inventory mismatch')
        expected.delete(relative)
      } else throw Error('Unsafe package entry')
    }
  }
  await walk(directory)
  if (expected.size || await sha256(resolve(directory, 'manifest.json')) !== expectedHash) throw Error('Incomplete package')
  return manifest
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await verifyPackage(...process.argv.slice(2))
}
