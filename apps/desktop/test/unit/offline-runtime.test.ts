import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBundledRuntimeDownloader } from '../../src/main/runtime-assets/downloader'
import type { RuntimeAssetTarget } from '../../src/main/runtime-assets/registry'

const directories: string[] = []
afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('bundled runtime installation without network access', () => {
  async function fixture(maxDownloadBytes = 1024) {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'maestrly-bundled-runtime-'))
    directories.push(directory)
    const bytes = Buffer.from('an immutable bundled archive fixture')
    const name = 'local-ml-runtime-1-test.tar.gz'
    await writeFile(path.join(directory, name), bytes)
    const target: RuntimeAssetTarget = {
      id: 'mac-arm64',
      url: `bundled:${name}`,
      archive: 'tar.gz',
      hash: { algorithm: 'sha256', digest: createHash('sha256').update(bytes).digest('hex'), encoding: 'hex' },
      downloadBytes: bytes.length,
      maxDownloadBytes,
      unpackedBytes: bytes.length,
      criticalPaths: [],
    }
    const network = vi.fn(() => {
      throw new Error('Network must not be used')
    })
    vi.stubGlobal('fetch', network)
    return { directory, bytes, target, network, destination: path.join(directory, 'copy.tar.gz') }
  }

  it('copies the archive with progress and an integrity digest using only local files', async () => {
    const { directory, bytes, target, network, destination } = await fixture()
    const progress = vi.fn()
    const result = await createBundledRuntimeDownloader(directory)(target, destination, {
      signal: new AbortController().signal,
      onProgress: progress,
    })
    expect(await readFile(destination)).toEqual(bytes)
    expect(result.digest).toBe(target.hash.digest)
    expect(result.bytes).toBe(bytes.length)
    expect(progress).toHaveBeenLastCalledWith(bytes.length, bytes.length)
    expect(network).not.toHaveBeenCalled()
  })

  it('rejects oversized archives and path traversal without fetching a replacement', async () => {
    const { directory, target, network, destination } = await fixture(1)
    const download = createBundledRuntimeDownloader(directory)
    await expect(download(target, destination, { signal: new AbortController().signal })).rejects.toThrow(
      'declared size'
    )
    await expect(
      download({ ...target, url: 'bundled:../outside.tar.gz' }, destination, {
        signal: new AbortController().signal,
      })
    ).rejects.toThrow('Invalid bundled runtime archive name')
    expect(network).not.toHaveBeenCalled()
  })

  it('reports missing installation media without falling back to a hosted service', async () => {
    const { directory, target, network, destination } = await fixture()
    await expect(
      createBundledRuntimeDownloader(directory)(
        {
          ...target,
          url: 'bundled:local-ml-runtime-missing.tar.gz',
        },
        destination,
        { signal: new AbortController().signal }
      )
    ).rejects.toThrow('Local ML archive is missing')
    expect(network).not.toHaveBeenCalled()
  })
})
