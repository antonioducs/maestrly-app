import { createHash, randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, open, link, rm, statfs } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'

import type { Asset } from './catalog.js'
import { verifyAsset, assertNoSymlinks } from './verify.js'
/** Downloads into a unique staging file; only a complete checksum match is published.
 * Redirects are deliberately disabled; caller supplies the final HTTPS asset URL. */
export async function stageAsset(options: {
  url: string
  destination: string
  sha256: string
  maxBytes: number
  signal?: AbortSignal
  executable?: boolean
  allowedHosts?: readonly string[]
}): Promise<Asset> {
  const url = new URL(options.url)
  if (
    url.protocol !== 'https:' ||
    !(options.allowedHosts ?? ['cloud-images.ubuntu.com', 'download.qemu.org']).includes(url.hostname) ||
    (url.port !== '' && url.port !== '443') ||
    url.username ||
    url.password ||
    !isAbsolute(options.destination) ||
    !/^[a-f0-9]{64}$/i.test(options.sha256) ||
    !Number.isSafeInteger(options.maxBytes) ||
    options.maxBytes < 1
  )
    throw new Error('Invalid asset download configuration')
  options.signal?.throwIfAborted()
  await assertNoSymlinks(options.destination, true)
  const asset = {
    path: options.destination,
    sha256: options.sha256.toLowerCase(),
  }
  try {
    if ((await lstat(options.destination)).size > options.maxBytes)
      throw new Error('Asset exceeds size limit')
    await verifyAsset(asset, options.executable)
    return asset
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  await mkdir(dirname(options.destination), { recursive: true, mode: 0o700 })
  await assertNoSymlinks(dirname(options.destination))
  const space = await statfs(dirname(options.destination))
  if (space.bavail * space.bsize < options.maxBytes + 2 * 1024 ** 3)
    throw new Error('Insufficient download disk capacity')
  const staging = join(dirname(options.destination), `.asset-${randomUUID()}.partial`)
  const signal = AbortSignal.any([AbortSignal.timeout(300_000), ...(options.signal ? [options.signal] : [])])
  const handle = await open(staging, 'wx', 0o600)
  try {
    const response = await fetch(url, { redirect: 'error', signal })
    if (!response.ok || !response.body) throw new Error(`Asset download failed: ${response.status}`)
    const hash = createHash('sha256')
    let bytes = 0
    for await (const chunk of response.body) {
      signal.throwIfAborted()
      bytes += chunk.length
      if (bytes > options.maxBytes) throw new Error('Asset exceeds size limit')
      hash.update(chunk)
      await handle.writeFile(chunk)
    }
    if (hash.digest('hex') !== options.sha256.toLowerCase()) throw new Error('Asset checksum mismatch')
    await handle.sync()
    await handle.close()
    await chmod(staging, options.executable ? 0o700 : 0o600)
    signal.throwIfAborted()
    await assertNoSymlinks(dirname(options.destination))
    // Hard-link publication is atomic and never overwrites an existing destination.
    await link(staging, options.destination)
    const directory = await open(dirname(options.destination), 'r')
    try {
      await directory.sync()
    } finally {
      await directory.close()
    }
    return { path: options.destination, sha256: options.sha256.toLowerCase() }
  } finally {
    await handle.close().catch(() => {})
    await rm(staging, { force: true })
  }
}
