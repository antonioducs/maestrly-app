import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeAssetId } from '../../src/shared/runtime-assets'
import type { RuntimeDownloader } from '../../src/main/runtime-assets/downloader'
import type { RuntimeAssetDefinition } from '../../src/main/runtime-assets/registry'
import { RuntimeAssetService } from '../../src/main/runtime-assets/service'

let userData: string
beforeEach(async () => {
  userData = await mkdtemp(path.join(os.tmpdir(), 'runtime-service-'))
})
afterEach(async () => {
  await rm(userData, { recursive: true, force: true })
})

function definition(version = '1.0.0', sizes = { downloadBytes: 100, unpackedBytes: 200 }): RuntimeAssetDefinition {
  return {
    id: 'tunnel-client',
    version,
    targets: {
      'mac-arm64': {
        id: 'mac-arm64',
        url: 'https://fixture.test/runtime.zip',
        archive: 'zip',
        hash: { algorithm: 'sha256', encoding: 'hex', digest: `archive-${version}` },
        downloadBytes: sizes.downloadBytes,
        maxDownloadBytes: sizes.downloadBytes,
        unpackedBytes: sizes.unpackedBytes,
        criticalPaths: ['bin/tool'],
      },
    },
  }
}

function registry(version = '1.0.0', sizes = { downloadBytes: 100, unpackedBytes: 200 }) {
  const empty = (id: RuntimeAssetId): RuntimeAssetDefinition => ({ id, version: 'none', targets: {} })
  return {
    'codex-runtime': empty('codex-runtime'),
    'github-copilot-runtime': empty('github-copilot-runtime'),
    'tunnel-client': definition(version, sizes),
    'local-ml-runtime': empty('local-ml-runtime'),
  }
}

function fixtureDependencies(options: { delayDownload?: boolean; available?: number; version?: string } = {}) {
  let unblock: (() => void) | undefined
  const blocked = new Promise<void>((resolve) => {
    unblock = resolve
  })
  const downloader = vi.fn<RuntimeDownloader>(async (target, destination, downloadOptions) => {
    if (options.delayDownload) {
      await Promise.race([
        blocked,
        new Promise<never>((_, reject) =>
          downloadOptions.signal.addEventListener('abort', () => reject(downloadOptions.signal.reason), { once: true })
        ),
      ])
    }
    await writeFile(destination, 'fixture')
    downloadOptions.onProgress?.(7, 7)
    return { bytes: 7, digest: target.hash.digest, finalUrl: target.url }
  })
  const extract = vi.fn(async (_archive: string, destination: string) => {
    await mkdir(path.join(destination, 'bin'), { recursive: true })
    await writeFile(path.join(destination, 'bin/tool'), `binary-${options.version ?? '1.0.0'}`)
    await writeFile(path.join(destination, 'README'), 'layout')
  })
  return {
    downloader,
    extract,
    availableBytes: vi.fn(async () => options.available ?? 100_000_000),
    unblock: () => unblock?.(),
  }
}

describe('RuntimeAssetService', () => {
  it('installs under injected userData, writes a complete marker, and verifies ready status', async () => {
    const deps = fixtureDependencies()
    const service = new RuntimeAssetService({
      userDataPath: userData,
      registry: registry(),
      target: 'mac-arm64',
      ...deps,
    })
    expect(await service.status('tunnel-client')).toEqual({ id: 'tunnel-client', state: 'not-installed' })

    const installed = await service.install('tunnel-client')
    expect(installed).toMatchObject({ state: 'ready', version: '1.0.0', target: 'mac-arm64' })
    expect(installed.path).toContain(path.join(userData, 'runtime-assets', 'tunnel-client', 'versions'))
    const marker = JSON.parse(await readFile(path.join(installed.path!, '.runtime-asset.json'), 'utf8'))
    expect(marker).toMatchObject({ schema: 1, id: 'tunnel-client', version: '1.0.0', criticalPaths: ['bin/tool'] })
    expect(marker.files.map((file: { path: string }) => file.path)).toEqual(['bin/tool', 'README'])
    expect(marker.files[0].sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(await service.list()).toHaveLength(4)
  })

  it('is single-flight, exposes progress, and supports cancellation with temp cleanup', async () => {
    const deps = fixtureDependencies({ delayDownload: true })
    const service = new RuntimeAssetService({
      userDataPath: userData,
      registry: registry(),
      target: 'mac-arm64',
      ...deps,
    })
    const first = service.install('tunnel-client')
    const second = service.install('tunnel-client')
    expect(second).not.toBe(first)
    await vi.waitFor(async () => expect((await service.status('tunnel-client')).state).toBe('downloading'))
    expect(service.cancel('tunnel-client')).toBe(true)
    await expect(first).resolves.toMatchObject({ state: 'failed', error: expect.stringMatching(/cancel/i) })
    await expect(second).resolves.toMatchObject({ state: 'failed', error: expect.stringMatching(/cancel/i) })
    expect(deps.downloader).toHaveBeenCalledTimes(1)
    const rootEntries = await readdir(path.join(userData, 'runtime-assets'))
    expect(rootEntries.some((entry) => entry.startsWith('.tmp-'))).toBe(false)
  })

  it('cancels one waiter without aborting a shared install needed by another waiter', async () => {
    const deps = fixtureDependencies({ delayDownload: true })
    const service = new RuntimeAssetService({
      userDataPath: userData,
      registry: registry(),
      target: 'mac-arm64',
      ...deps,
    })
    const firstController = new AbortController()
    const first = service.install('tunnel-client', firstController.signal)
    const second = service.install('tunnel-client')
    await vi.waitFor(async () => expect((await service.status('tunnel-client')).state).toBe('downloading'))

    firstController.abort(new Error('first waiter stopped'))
    await expect(first).rejects.toThrow('first waiter stopped')
    expect(deps.downloader.mock.calls[0][2].signal.aborted).toBe(false)

    deps.unblock()
    await expect(second).resolves.toMatchObject({ state: 'ready' })
    expect(deps.downloader).toHaveBeenCalledTimes(1)
  })

  it('waits for an abandoned install to finish before starting an immediate retry', async () => {
    const deps = fixtureDependencies()
    let attempts = 0
    let releaseOldDownload!: () => void
    const oldDownloadReleased = new Promise<void>((resolve) => {
      releaseOldDownload = resolve
    })
    let oldDownloadAborted!: () => void
    const oldDownloadAbortObserved = new Promise<void>((resolve) => {
      oldDownloadAborted = resolve
    })
    const downloader = vi.fn<RuntimeDownloader>(async (target, destination, downloadOptions) => {
      attempts += 1
      if (attempts === 1) {
        downloadOptions.signal.addEventListener('abort', oldDownloadAborted, { once: true })
        await oldDownloadReleased
        throw downloadOptions.signal.reason ?? new Error('Old download cancelled')
      }
      await writeFile(destination, 'fixture')
      downloadOptions.onProgress?.(7, 7)
      return { bytes: 7, digest: target.hash.digest, finalUrl: target.url }
    })
    const service = new RuntimeAssetService({
      userDataPath: userData,
      registry: registry(),
      target: 'mac-arm64',
      ...deps,
      downloader,
    })
    const firstController = new AbortController()
    const first = service.install('tunnel-client', firstController.signal)
    await vi.waitFor(async () => expect((await service.status('tunnel-client')).state).toBe('downloading'))

    firstController.abort(new Error('first waiter stopped'))
    await expect(first).rejects.toThrow('first waiter stopped')
    await oldDownloadAbortObserved

    const retry = service.install('tunnel-client')
    expect(downloader).toHaveBeenCalledTimes(1)

    releaseOldDownload()
    await expect(retry).resolves.toMatchObject({ state: 'ready' })
    expect(downloader).toHaveBeenCalledTimes(2)
  })

  it('notifies explicit mutations while passive status probes stay silent', async () => {
    const deps = fixtureDependencies()
    const onStatusChanged = vi.fn()
    const service = new RuntimeAssetService({
      userDataPath: userData,
      registry: registry(),
      target: 'mac-arm64',
      onStatusChanged,
      ...deps,
    })

    await service.status('tunnel-client')
    expect(onStatusChanged).not.toHaveBeenCalled()

    await service.install('tunnel-client')
    expect(onStatusChanged.mock.calls.map(([status]) => status.state)).toEqual([
      'downloading',
      'downloading',
      'verifying',
      'installing',
      'ready',
    ])

    onStatusChanged.mockClear()
    await service.status('tunnel-client')
    expect(onStatusChanged).not.toHaveBeenCalled()

    await service.remove('tunnel-client')
    expect(onStatusChanged.mock.calls.map(([status]) => status.state)).toEqual(['removing', 'not-installed'])
  })

  it('fails statfs preflight before downloading when disk space is insufficient', async () => {
    const deps = fixtureDependencies({ available: 199 })
    const service = new RuntimeAssetService({
      userDataPath: userData,
      registry: registry(),
      target: 'mac-arm64',
      ...deps,
    })
    await expect(service.install('tunnel-client')).resolves.toMatchObject({
      state: 'failed',
      error: expect.stringMatching(/disk space/i),
    })
    expect(deps.downloader).not.toHaveBeenCalled()
  })

  it('uses the unpacked footprint when the archive estimate is much smaller', async () => {
    const deps = fixtureDependencies({ available: 1_000_000 })
    const service = new RuntimeAssetService({
      userDataPath: userData,
      registry: registry('1.0.0', { downloadBytes: 100, unpackedBytes: 900_000 }),
      target: 'mac-arm64',
      ...deps,
    })

    await expect(service.install('tunnel-client')).resolves.toMatchObject({
      state: 'failed',
      error: expect.stringMatching(/need .* bytes/i),
    })
    expect(deps.downloader).not.toHaveBeenCalled()
  })

  it('detects changed and missing files as corrupt and repairs atomically', async () => {
    const deps = fixtureDependencies()
    const service = new RuntimeAssetService({
      userDataPath: userData,
      registry: registry(),
      target: 'mac-arm64',
      ...deps,
    })
    const installed = await service.install('tunnel-client')
    await writeFile(path.join(installed.path!, 'bin/tool'), 'tampered')
    expect(await service.status('tunnel-client')).toMatchObject({
      state: 'corrupt',
      error: expect.stringMatching(/verification/i),
    })
    const repaired = await service.repair('tunnel-client')
    expect(repaired.state).toBe('ready')
    expect(await readFile(path.join(repaired.path!, 'bin/tool'), 'utf8')).toBe('binary-1.0.0')
    expect(existsSync(`${repaired.path}.partial`)).toBe(false)
  })

  it('keeps passive status cheap and defers non-critical tamper detection to lease acquisition', async () => {
    const deps = fixtureDependencies()
    const service = new RuntimeAssetService({
      userDataPath: userData,
      registry: registry(),
      target: 'mac-arm64',
      ...deps,
    })
    const installed = await service.install('tunnel-client')
    await writeFile(path.join(installed.path!, 'README'), 'tampered')

    await expect(service.status('tunnel-client')).resolves.toMatchObject({ state: 'ready' })
    await expect(service.acquireLease('tunnel-client')).rejects.toThrow(/verification/i)
    await expect(service.status('tunnel-client')).resolves.toMatchObject({ state: 'corrupt' })
  })

  it('does not hash same-size critical tamper passively but rejects it at lease acquisition', async () => {
    const deps = fixtureDependencies()
    const service = new RuntimeAssetService({
      userDataPath: userData,
      registry: registry(),
      target: 'mac-arm64',
      ...deps,
    })
    const installed = await service.install('tunnel-client')
    await writeFile(path.join(installed.path!, 'bin/tool'), 'xxxxxxxxxxxx')

    await expect(service.status('tunnel-client')).resolves.toMatchObject({ state: 'ready' })
    await expect(service.acquireLease('tunnel-client')).rejects.toThrow(/verification/i)
  })

  it('revalidates a generation for a new lease session after the previous lease is released', async () => {
    const deps = fixtureDependencies()
    const service = new RuntimeAssetService({
      userDataPath: userData,
      registry: registry(),
      target: 'mac-arm64',
      ...deps,
    })
    const installed = await service.install('tunnel-client')
    const lease = await service.acquireLease('tunnel-client')
    lease.release()
    await writeFile(path.join(installed.path!, 'README'), 'tampered')

    await expect(service.acquireLease('tunnel-client')).rejects.toThrow(/verification/i)
  })

  it('does not retain a full verification from a ready no-op install', async () => {
    const deps = fixtureDependencies()
    const service = new RuntimeAssetService({
      userDataPath: userData,
      registry: registry(),
      target: 'mac-arm64',
      ...deps,
    })
    const installed = await service.install('tunnel-client')
    await expect(service.install('tunnel-client')).resolves.toMatchObject({ state: 'ready' })
    await writeFile(path.join(installed.path!, 'README'), 'tampered')

    await expect(service.acquireLease('tunnel-client')).rejects.toThrow(/verification/i)
  })

  it('single-flights full verification for concurrent leases of one generation', async () => {
    const deps = fixtureDependencies()
    let fullManifestCalls = 0
    const service = new RuntimeAssetService({
      userDataPath: userData,
      registry: registry(),
      target: 'mac-arm64',
      ...deps,
      fullManifestFiles: async (root) => {
        fullManifestCalls += 1
        const marker = JSON.parse(await readFile(path.join(root, '.runtime-asset.json'), 'utf8')) as {
          files: readonly { path: string; size: number; sha256: string }[]
        }
        return marker.files
      },
    })
    const installed = await service.install('tunnel-client')
    const first = service.acquireLease('tunnel-client')
    const second = service.acquireLease('tunnel-client')
    const [firstLease, secondLease] = await Promise.all([first, second])

    expect(fullManifestCalls).toBe(1)
    expect(firstLease.path).toBe(installed.path)
    expect(secondLease.path).toBe(installed.path)
    firstLease.release()
    secondLease.release()
  })

  it('blocks removal while leased and releases idempotently', async () => {
    const deps = fixtureDependencies()
    const service = new RuntimeAssetService({
      userDataPath: userData,
      registry: registry(),
      target: 'mac-arm64',
      ...deps,
    })
    await service.install('tunnel-client')
    const lease = await service.acquireLease('tunnel-client')
    await expect(service.remove('tunnel-client')).rejects.toThrow(/leased/i)
    lease.release()
    lease.release()
    await expect(service.remove('tunnel-client')).resolves.toEqual({ id: 'tunnel-client', state: 'not-installed' })
    expect(await service.status('tunnel-client')).toEqual({ id: 'tunnel-client', state: 'not-installed' })
  })

  it('does not replace a leased installation during repair', async () => {
    const deps = fixtureDependencies()
    const service = new RuntimeAssetService({
      userDataPath: userData,
      registry: registry(),
      target: 'mac-arm64',
      ...deps,
    })
    const installed = await service.install('tunnel-client')
    expect(await service.status('tunnel-client')).toMatchObject({ state: 'ready', path: installed.path })
    const lease = await service.acquireLease('tunnel-client')

    await expect(service.repair('tunnel-client')).rejects.toThrow(/leased/i)

    expect(await service.status('tunnel-client')).toMatchObject({ state: 'ready', path: installed.path })
    expect(deps.downloader).toHaveBeenCalledTimes(1)
    expect(await readFile(path.join(installed.path!, 'bin/tool'), 'utf8')).toBe('binary-1.0.0')
    await expect(service.remove('tunnel-client')).rejects.toThrow(/leased/i)

    lease.release()
    expect(await service.status('tunnel-client')).toMatchObject({ state: 'ready', path: installed.path })
    await expect(service.remove('tunnel-client')).resolves.toEqual({ id: 'tunnel-client', state: 'not-installed' })
  })

  it('aborts repair when a lease wins after the initial repair check', async () => {
    const deps = fixtureDependencies()
    const service = new RuntimeAssetService({
      userDataPath: userData,
      registry: registry(),
      target: 'mac-arm64',
      ...deps,
    })
    const installed = await service.install('tunnel-client')
    deps.downloader.mockClear()

    type StartInstall = (
      id: RuntimeAssetId,
      force: boolean
    ) => Promise<Awaited<ReturnType<RuntimeAssetService['status']>>>
    const internals = service as unknown as { startInstall: StartInstall }
    const originalStartInstall = internals.startInstall.bind(service)
    let allowStartInstall!: () => void
    const startInstallReached = new Promise<void>((resolve) => {
      vi.spyOn(internals, 'startInstall').mockImplementation(async (id, force) => {
        resolve()
        await new Promise<void>((resume) => {
          allowStartInstall = resume
        })
        return originalStartInstall(id, force)
      })
    })

    const repair = service.repair('tunnel-client')
    await startInstallReached

    const lease = await service.acquireLease('tunnel-client')
    allowStartInstall()

    await expect(repair).rejects.toThrow(/leased/i)
    expect(deps.downloader).not.toHaveBeenCalled()
    expect(await readFile(path.join(installed.path!, 'bin/tool'), 'utf8')).toBe('binary-1.0.0')
    expect(await service.status('tunnel-client')).toMatchObject({ state: 'ready', path: installed.path })
    expect(
      JSON.parse(await readFile(path.join(userData, 'runtime-assets/tunnel-client/current.json'), 'utf8')).directory
    ).toBe(path.basename(installed.path!))

    lease.release()
  })

  it('keeps an obsolete leased generation until its lease is released', async () => {
    const mutableRegistry = registry()
    const deps = fixtureDependencies({ version: 'dynamic' })
    const service = new RuntimeAssetService({
      userDataPath: userData,
      registry: mutableRegistry,
      target: 'mac-arm64',
      ...deps,
    })
    mutableRegistry['tunnel-client'] = definition('1.0.0')
    const first = await service.install('tunnel-client')
    const lease = await service.acquireLease('tunnel-client')
    mutableRegistry['tunnel-client'] = definition('2.0.0')
    await service.install('tunnel-client')
    mutableRegistry['tunnel-client'] = definition('3.0.0')
    await service.install('tunnel-client')

    expect(existsSync(first.path!)).toBe(true)
    lease.release()
    await vi.waitFor(() => expect(existsSync(first.path!)).toBe(false))
  })

  it('serializes lease-release GC behind the side-by-side install pointer commit', async () => {
    const mutableRegistry = registry()
    const deps = fixtureDependencies({ version: 'dynamic' })
    const service = new RuntimeAssetService({
      userDataPath: userData,
      registry: mutableRegistry,
      target: 'mac-arm64',
      ...deps,
    })
    mutableRegistry['tunnel-client'] = definition('1.0.0')
    await service.install('tunnel-client')
    const lease = await service.acquireLease('tunnel-client')

    mutableRegistry['tunnel-client'] = definition('2.0.0')
    type WritePointer = (id: RuntimeAssetId, name: string, pointer: { readonly directory: string }) => Promise<void>
    const internals = service as unknown as { writePointer: WritePointer }
    const originalWritePointer = internals.writePointer.bind(service)
    let allowCurrentWrite!: () => void
    let currentWriteReached!: () => void
    const currentWriteStarted = new Promise<void>((resolve) => {
      currentWriteReached = resolve
    })
    const currentWriteAllowed = new Promise<void>((resolve) => {
      allowCurrentWrite = resolve
    })
    vi.spyOn(internals, 'writePointer').mockImplementation(async (id, name, pointer) => {
      if (name === 'current.json' && pointer.directory === '2.0.0-mac-arm64') {
        currentWriteReached()
        await currentWriteAllowed
      }
      return originalWritePointer(id, name, pointer)
    })

    const install = service.install('tunnel-client')
    await currentWriteStarted
    const newGeneration = path.join(userData, 'runtime-assets/tunnel-client/versions/2.0.0-mac-arm64')
    expect(existsSync(newGeneration)).toBe(true)

    lease.release()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(existsSync(newGeneration)).toBe(true)

    allowCurrentWrite()
    await expect(install).resolves.toMatchObject({ state: 'ready', version: '2.0.0' })
    expect(existsSync(newGeneration)).toBe(true)
  })

  it('keeps only current and previous versions across side-by-side updates', async () => {
    const mutableRegistry = registry()
    const deps = fixtureDependencies({ version: 'dynamic' })
    const service = new RuntimeAssetService({
      userDataPath: userData,
      registry: mutableRegistry,
      target: 'mac-arm64',
      ...deps,
    })
    for (const version of ['1.0.0', '2.0.0', '3.0.0']) {
      mutableRegistry['tunnel-client'] = definition(version)
      await service.install('tunnel-client')
    }
    const versions = await readdir(path.join(userData, 'runtime-assets/tunnel-client/versions'))
    expect(versions.sort()).toEqual(['2.0.0-mac-arm64', '3.0.0-mac-arm64'])
    expect(await service.status('tunnel-client')).toMatchObject({ state: 'ready', version: '3.0.0' })
  })

  it('promotes a verified previous generation for an offline registry downgrade', async () => {
    const mutableRegistry = registry()
    const deps = fixtureDependencies({ version: 'dynamic' })
    const service = new RuntimeAssetService({
      userDataPath: userData,
      registry: mutableRegistry,
      target: 'mac-arm64',
      ...deps,
    })

    mutableRegistry['tunnel-client'] = definition('1.0.0')
    const first = await service.install('tunnel-client')
    mutableRegistry['tunnel-client'] = definition('2.0.0')
    const second = await service.install('tunnel-client')
    deps.downloader.mockClear()

    mutableRegistry['tunnel-client'] = definition('1.0.0')
    await expect(service.status('tunnel-client')).resolves.toMatchObject({
      state: 'ready',
      version: '1.0.0',
      path: first.path,
    })
    expect(deps.downloader).not.toHaveBeenCalled()

    const current = JSON.parse(await readFile(path.join(userData, 'runtime-assets/tunnel-client/current.json'), 'utf8'))
    const previous = JSON.parse(
      await readFile(path.join(userData, 'runtime-assets/tunnel-client/previous.json'), 'utf8')
    )
    expect(current.directory).toBe(path.basename(first.path!))
    expect(previous.directory).toBe(path.basename(second.path!))
  })

  it('serializes previous promotion with a concurrent filesystem mutation', async () => {
    const mutableRegistry = registry()
    const deps = fixtureDependencies({ version: 'dynamic' })
    const service = new RuntimeAssetService({
      userDataPath: userData,
      registry: mutableRegistry,
      target: 'mac-arm64',
      ...deps,
    })

    mutableRegistry['tunnel-client'] = definition('1.0.0')
    const first = await service.install('tunnel-client')
    mutableRegistry['tunnel-client'] = definition('2.0.0')
    await service.install('tunnel-client')
    mutableRegistry['tunnel-client'] = definition('1.0.0')

    type WritePointer = (id: RuntimeAssetId, name: string, pointer: { readonly directory: string }) => Promise<void>
    const internals = service as unknown as { writePointer: WritePointer }
    const originalWritePointer = internals.writePointer.bind(service)
    let allowCurrentWrite!: () => void
    let currentWriteReached!: () => void
    const currentWriteStarted = new Promise<void>((resolve) => {
      currentWriteReached = resolve
    })
    const currentWriteAllowed = new Promise<void>((resolve) => {
      allowCurrentWrite = resolve
    })
    vi.spyOn(internals, 'writePointer').mockImplementation(async (id, name, pointer) => {
      if (name === 'current.json' && pointer.directory === path.basename(first.path!)) {
        currentWriteReached()
        await currentWriteAllowed
      }
      return originalWritePointer(id, name, pointer)
    })

    const promotion = service.status('tunnel-client')
    await currentWriteStarted

    let removalSettled = false
    const removal = service.remove('tunnel-client').then((result) => {
      removalSettled = true
      return result
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(removalSettled).toBe(false)

    allowCurrentWrite()
    await expect(promotion).resolves.toMatchObject({ state: 'ready', path: first.path })
    await expect(removal).resolves.toEqual({ id: 'tunnel-client', state: 'not-installed' })
  })

  it('does not use an invalid previous generation as a downgrade fallback', async () => {
    const mutableRegistry = registry()
    const deps = fixtureDependencies({ version: 'dynamic' })
    const service = new RuntimeAssetService({
      userDataPath: userData,
      registry: mutableRegistry,
      target: 'mac-arm64',
      ...deps,
    })

    mutableRegistry['tunnel-client'] = definition('1.0.0')
    await service.install('tunnel-client')
    mutableRegistry['tunnel-client'] = definition('2.0.0')
    const current = await service.install('tunnel-client')
    await writeFile(path.join(userData, 'runtime-assets/tunnel-client/versions/1.0.0-mac-arm64/bin/tool'), 'tampered')
    deps.downloader.mockClear()

    mutableRegistry['tunnel-client'] = definition('1.0.0')
    await expect(service.status('tunnel-client')).resolves.toMatchObject({
      state: 'corrupt',
      path: current.path,
      error: expect.stringMatching(/pinned registry/i),
    })
    expect(deps.downloader).not.toHaveBeenCalled()
  })

  it('reports unsupported local ML runtime without network work', async () => {
    const deps = fixtureDependencies()
    const service = new RuntimeAssetService({
      userDataPath: userData,
      registry: registry(),
      target: 'mac-arm64',
      ...deps,
    })
    await expect(service.install('local-ml-runtime')).resolves.toMatchObject({
      state: 'failed',
      error: expect.stringMatching(/not configured|configured for/i),
    })
    expect(deps.downloader).not.toHaveBeenCalled()
  })
})
