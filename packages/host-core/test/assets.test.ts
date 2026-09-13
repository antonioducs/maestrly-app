import { afterEach, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, realpath, readFile, readdir, rm, writeFile, symlink, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
const skipWindows = process.platform === 'win32'
import { stageAsset, verifyAsset } from '../src/index.js'
const directories: string[] = []
afterEach(async () => {
  vi.unstubAllGlobals()
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true })
})
async function config() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'mh-assets-')))
  directories.push(dir)
  return {
    dir,
    url: 'https://cloud-images.ubuntu.com/image',
    destination: join(dir, 'image'),
    maxBytes: 32,
    sha256: createHash('sha256').update('verified').digest('hex'),
  }
}
// Successful publication fsyncs the parent directory (POSIX durability).
it.skipIf(skipWindows)('reuses only verified existing data and never overwrites corruption', async () => {
  const options = await config()
  const fetch = vi.fn(async () => new Response('verified'))
  vi.stubGlobal('fetch', fetch)
  await stageAsset(options)
  await stageAsset(options)
  expect(fetch).toHaveBeenCalledTimes(1)
  await writeFile(options.destination, 'corrupted')
  await expect(stageAsset(options)).rejects.toThrow('checksum')
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(await readFile(options.destination, 'utf8')).toBe('corrupted')
})
it('rejects unlisted hosts and disk requests beyond free space', async () => {
  const options = await config()
  await expect(stageAsset({ ...options, url: 'https://attacker.invalid/image' })).rejects.toThrow(
    'configuration'
  )
  await expect(stageAsset({ ...options, maxBytes: Number.MAX_SAFE_INTEGER })).rejects.toThrow('disk capacity')
})
it('cancellation leaves no published or partial file even if fetch ignores abort', async () => {
  const options = await config()
  const controller = new AbortController()
  vi.stubGlobal('fetch', async () => {
    controller.abort()
    return new Response('verified')
  })
  await expect(stageAsset({ ...options, signal: controller.signal })).rejects.toThrow()
  expect(await readdir(options.dir)).toEqual([])
  await expect(verifyAsset({ path: options.destination, sha256: options.sha256 })).rejects.toThrow()
})
it('never replaces a destination created concurrently during download', async () => {
  const options = await config()
  vi.stubGlobal('fetch', async () => {
    await writeFile(options.destination, 'foreign')
    return new Response('verified')
  })
  await expect(stageAsset(options)).rejects.toMatchObject({ code: 'EEXIST' })
  expect(await readFile(options.destination, 'utf8')).toBe('foreign')
  expect(await readdir(options.dir)).toEqual(['image'])
})

it('rejects parent symlinks when supported', async (context) => {
  const options = await config()
  await mkdir(join(options.dir, 'actual'))
  try {
    await symlink(join(options.dir, 'actual'), join(options.dir, 'link'), 'dir')
  } catch (error) {
    if (skipWindows && ['EPERM', 'EACCES', 'ENOSYS'].includes((error as NodeJS.ErrnoException).code ?? ''))
      return context.skip('Windows symlink capability is unavailable')
    throw error
  }
  await expect(stageAsset({ ...options, destination: join(options.dir, 'link', 'image') })).rejects.toThrow('Symlink')
})
