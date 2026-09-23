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

describe('RuntimeAssetService independent updates', () => {
  const root = () => path.join(userData, 'runtime-assets/tunnel-client')
  const pointer = async (name: 'current' | 'previous') =>
    (JSON.parse(await readFile(path.join(root(), `${name}.json`), 'utf8')) as { directory: string }).directory

  function updatable(options: { available?: number; delayDownload?: boolean } = {}) {
    const accepted = new Map<string, RuntimeAssetDefinition>()
    let unavailable = false
    const deps = fixtureDependencies({ version: 'dynamic', ...options })
    const onStatusChanged = vi.fn()
    const create = () =>
      new RuntimeAssetService({
        userDataPath: userData,
        registry: registry('1.0.0'),
        target: 'mac-arm64',
        acceptedDefinition: (id, version) => {
          if (unavailable) throw new Error('metadata unavailable')
          return id === 'tunnel-client' ? (accepted.get(version) ?? null) : null
        },
        onStatusChanged,
        ...deps,
      })
    const commit = vi.fn((candidate: RuntimeAssetDefinition) => {
      accepted.set(candidate.version, candidate)
    })
    return {
      service: create(),
      restart: create,
      deps,
      accepted,
      commit,
      onStatusChanged,
      setUnavailable: (value: boolean) => {
        unavailable = value
      },
    }
  }

  async function tempEntries(): Promise<string[]> {
    return (await readdir(path.join(userData, 'runtime-assets'))).filter((entry) => entry.startsWith('.tmp-'))
  }

  it('keeps the active installation ready while a newer candidate is known or fails', async () => {
    const { service, deps, commit } = updatable()
    const installed = await service.install('tunnel-client')
    deps.downloader.mockImplementationOnce(async (_target, destination) => {
      await writeFile(destination, 'tampered')
      return { bytes: 8, digest: 'wrong', finalUrl: 'https://fixture.test/runtime.zip' }
    })

    const failure = await service.update(definition('2.0.0'), { commit }).catch((error) => error)
    expect(failure).toMatchObject({ name: 'RuntimeAssetUpdateError', code: 'integrity' })
    expect(commit).not.toHaveBeenCalled()
    expect(await service.status('tunnel-client')).toMatchObject({
      state: 'ready',
      version: '1.0.0',
      path: installed.path,
    })
    expect(await readdir(path.join(root(), 'versions'))).toEqual(['1.0.0-mac-arm64'])
    expect(await tempEntries()).toEqual([])
  })

  it('validates in staging, persists metadata, then swaps current and previous', async () => {
    const { service, commit, onStatusChanged } = updatable()
    const installed = await service.install('tunnel-client')
    onStatusChanged.mockClear()
    const validate = vi.fn(async (installation: string) => {
      expect(installation).not.toContain(`${path.sep}versions${path.sep}`)
      expect(await readFile(path.join(installation, 'bin/tool'), 'utf8')).toBe('binary-dynamic')
    })
    commit.mockImplementationOnce(async (candidate) => {
      // Metadata must be durable while the old version is still active.
      expect(await pointer('current')).toBe('1.0.0-mac-arm64')
      commit.getMockImplementation()?.(candidate)
    })
    const onProgress = vi.fn()

    const updated = await service.update(definition('2.0.0'), { validate, commit, onProgress })

    expect(updated).toMatchObject({ state: 'ready', version: '2.0.0' })
    expect(validate).toHaveBeenCalledTimes(1)
    expect(await pointer('current')).toBe('2.0.0-mac-arm64')
    expect(await pointer('previous')).toBe(path.basename(installed.path!))
    expect([...new Set(onProgress.mock.calls.map(([progress]) => progress.phase))]).toEqual([
      'downloading',
      'verifying',
      'installing',
      'validating',
    ])
    // The active installation's status is never replaced by update progress.
    expect(onStatusChanged.mock.calls.map(([status]) => status.state)).toEqual(['ready'])
    expect(await service.previousInstallation('tunnel-client')).toMatchObject({ version: '1.0.0' })
  })

  it('preserves the active installation on insufficient disk space', async () => {
    const { service, deps, commit } = updatable({ available: 199 })
    await writeFile(path.join(userData, 'marker'), '')
    // Install first with enough space, then update with too little.
    deps.availableBytes.mockResolvedValueOnce(100_000_000)
    await service.install('tunnel-client')
    deps.downloader.mockClear()

    await expect(service.update(definition('2.0.0'), { commit })).rejects.toMatchObject({ code: 'disk-space' })
    expect(deps.downloader).not.toHaveBeenCalled()
    expect(await service.status('tunnel-client')).toMatchObject({ state: 'ready', version: '1.0.0' })
  })

  it('cancels a download without touching the active installation or blocking leases', async () => {
    const { service, deps } = updatable({ delayDownload: true })
    deps.unblock()
    await service.install('tunnel-client')
    // A second instance over the same profile whose download stays blocked until cancelled.
    const blocked = updatable({ delayDownload: true })
    const commit = blocked.commit
    const controller = new AbortController()
    const pending = blocked.service.update(definition('2.0.0'), { commit, signal: controller.signal })
    // Same userData: the second instance sees the first installation.
    await vi.waitFor(() => expect(blocked.deps.downloader).toHaveBeenCalled())
    const lease = await blocked.service.acquireLease('tunnel-client')
    controller.abort(new Error('user cancelled'))

    await expect(pending).rejects.toMatchObject({ code: 'cancelled' })
    expect(await blocked.service.status('tunnel-client')).toMatchObject({ state: 'ready', version: '1.0.0' })
    expect(await tempEntries()).toEqual([])
    lease.release()
    expect(commit).not.toHaveBeenCalled()
  })

  it('rejects an incompatible candidate before it is activated', async () => {
    const { service, commit } = updatable()
    await service.install('tunnel-client')
    await expect(
      service.update(definition('2.0.0'), {
        commit,
        validate: async () => {
          throw new Error('app-server handshake failed')
        },
      })
    ).rejects.toMatchObject({ code: 'incompatible', message: expect.stringMatching(/handshake/) })
    expect(commit).not.toHaveBeenCalled()
    expect(await readdir(path.join(root(), 'versions'))).toEqual(['1.0.0-mac-arm64'])
    expect(await pointer('current')).toBe('1.0.0-mac-arm64')
  })

  it('keeps the previous pointer usable when metadata persistence fails', async () => {
    const { service, commit } = updatable()
    await service.install('tunnel-client')
    commit.mockImplementationOnce(() => {
      throw new Error('database is locked')
    })
    await expect(service.update(definition('2.0.0'), { commit })).rejects.toMatchObject({ code: 'failed' })
    expect(await pointer('current')).toBe('1.0.0-mac-arm64')
    expect(await readdir(path.join(root(), 'versions'))).toEqual(['1.0.0-mac-arm64'])
    expect(await service.status('tunnel-client')).toMatchObject({ state: 'ready', version: '1.0.0' })
  })

  it('recovers consistently when the process stops between pointer writes', async () => {
    const { service, commit, restart } = updatable()
    await service.install('tunnel-client')
    type WritePointer = (id: RuntimeAssetId, name: string, pointer: { readonly directory: string }) => Promise<void>
    const internals = service as unknown as { writePointer: WritePointer }
    const original = internals.writePointer.bind(service)
    vi.spyOn(internals, 'writePointer').mockImplementation(async (id, name, next) => {
      if (name === 'current.json') throw new Error('process stopped')
      return original(id, name, next)
    })
    await expect(service.update(definition('2.0.0'), { commit })).rejects.toMatchObject({ code: 'failed' })

    // A new process sees the old active version; accepted metadata without an installation is harmless.
    const restarted = restart()
    expect(await restarted.status('tunnel-client')).toMatchObject({ state: 'ready', version: '1.0.0' })
  })

  it('recognizes an activated dynamic version after an offline restart', async () => {
    const { service, commit, restart, deps } = updatable()
    await service.install('tunnel-client')
    await service.update(definition('2.0.0'), { commit })
    deps.downloader.mockClear()

    const restarted = restart()
    expect(await restarted.status('tunnel-client')).toMatchObject({ state: 'ready', version: '2.0.0' })
    const lease = await restarted.acquireLease('tunnel-client')
    expect(lease.path).toContain('2.0.0-mac-arm64')
    lease.release()
    expect(deps.downloader).not.toHaveBeenCalled()
  })

  it('rolls back offline after full verification and refuses a tampered previous version', async () => {
    const { service, commit, deps } = updatable()
    await service.install('tunnel-client')
    await service.update(definition('2.0.0'), { commit })
    deps.downloader.mockClear()

    await expect(service.rollback('tunnel-client')).resolves.toMatchObject({ state: 'ready', version: '1.0.0' })
    expect(await pointer('current')).toBe('1.0.0-mac-arm64')
    expect(await pointer('previous')).toBe('2.0.0-mac-arm64')
    expect(deps.downloader).not.toHaveBeenCalled()

    await writeFile(path.join(root(), 'versions/2.0.0-mac-arm64/README'), 'tampered')
    await expect(service.rollback('tunnel-client')).rejects.toMatchObject({ code: 'rollback-unavailable' })
    expect(await service.status('tunnel-client')).toMatchObject({ state: 'ready', version: '1.0.0' })
  })

  it('reports no rollback without a distinct previous installation', async () => {
    const { service } = updatable()
    await service.install('tunnel-client')
    expect(await service.previousInstallation('tunnel-client')).toBeNull()
    await expect(service.rollback('tunnel-client')).rejects.toMatchObject({ code: 'rollback-unavailable' })
  })

  it('serializes concurrent updates', async () => {
    const { service, commit, deps } = updatable()
    await service.install('tunnel-client')
    let active = 0
    let overlap = false
    const original = deps.downloader.getMockImplementation()!
    deps.downloader.mockImplementation(async (...args) => {
      active += 1
      if (active > 1) overlap = true
      await new Promise((resolve) => setTimeout(resolve, 10))
      try {
        return await original(...args)
      } finally {
        active -= 1
      }
    })

    const [second, third] = await Promise.all([
      service.update(definition('2.0.0'), { commit }),
      service.update(definition('3.0.0'), { commit }),
    ])
    expect(second.version).toBe('2.0.0')
    expect(third.version).toBe('3.0.0')
    expect(overlap).toBe(false)
    expect(await pointer('current')).toBe('3.0.0-mac-arm64')
    expect(await pointer('previous')).toBe('2.0.0-mac-arm64')
  })

  it('keeps a leased older version until its connection releases it', async () => {
    const { service, commit } = updatable()
    const first = await service.install('tunnel-client')
    const lease = await service.acquireLease('tunnel-client')
    await service.update(definition('2.0.0'), { commit })
    await service.update(definition('3.0.0'), { commit })

    expect(existsSync(first.path!)).toBe(true)
    expect(service.leasedInstallations('tunnel-client')).toEqual([{ version: '1.0.0', path: first.path }])
    lease.release()
    await vi.waitFor(() => expect(existsSync(first.path!)).toBe(false))
    expect(service.leasedInstallations('tunnel-client')).toEqual([])
  })

  it('repairs a dynamic version by reinstalling that accepted version, not the embedded pin', async () => {
    const { service, commit, deps } = updatable()
    await service.install('tunnel-client')
    const updated = await service.update(definition('2.0.0'), { commit })
    // Same-size tamper keeps passive status ready; an explicit repair still reinstalls 2.0.0.
    await writeFile(path.join(updated.path!, 'bin/tool'), 'tampered-bytes')
    deps.downloader.mockClear()
    await expect(service.repair('tunnel-client')).resolves.toMatchObject({ state: 'ready', version: '2.0.0' })
    expect(deps.downloader.mock.calls[0][0].hash.digest).toBe('archive-2.0.0')
  })

  it('reinstalls a corrupt dynamic version without a previous fallback instead of downgrading', async () => {
    const { service, commit, deps } = updatable()
    const updated = await service.update(definition('2.0.0'), { commit })
    await writeFile(path.join(updated.path!, 'bin/tool'), 'tampered: different size')
    expect(await service.status('tunnel-client')).toMatchObject({ state: 'corrupt', path: updated.path })
    deps.downloader.mockClear()

    await expect(service.install('tunnel-client')).resolves.toMatchObject({ state: 'ready', version: '2.0.0' })
    expect(deps.downloader.mock.calls[0][0].hash.digest).toBe('archive-2.0.0')
  })

  it('fails status without promotion when accepted metadata is unavailable', async () => {
    const { service, commit, setUnavailable, deps } = updatable()
    await service.install('tunnel-client')
    await service.update(definition('2.0.0'), { commit })
    deps.downloader.mockClear()

    setUnavailable(true)
    await expect(service.status('tunnel-client')).rejects.toThrow('metadata unavailable')
    await expect(service.install('tunnel-client')).rejects.toThrow('metadata unavailable')
    expect(await pointer('current')).toBe('2.0.0-mac-arm64')
    expect(deps.downloader).not.toHaveBeenCalled()
    setUnavailable(false)
    expect(await service.status('tunnel-client')).toMatchObject({ state: 'ready', version: '2.0.0' })
  })

  it('publishes first-install progress through status when nothing is installed', async () => {
    const { service, commit, onStatusChanged } = updatable()
    await expect(service.update(definition('2.0.0'), { commit })).resolves.toMatchObject({
      state: 'ready',
      version: '2.0.0',
    })
    const states = onStatusChanged.mock.calls.map(([status]) => status.state)
    expect(states[0]).toBe('downloading')
    expect(states.at(-1)).toBe('ready')
  })

  it('does not remove an asset while an update is active', async () => {
    const { service, deps } = updatable({ delayDownload: true })
    deps.unblock()
    await service.install('tunnel-client')
    const blocked = updatable({ delayDownload: true })
    const pending = blocked.service.update(definition('2.0.0'), { commit: blocked.commit })
    await vi.waitFor(() => expect(blocked.deps.downloader).toHaveBeenCalled())
    await expect(blocked.service.remove('tunnel-client')).rejects.toThrow(/active/)
    blocked.deps.unblock()
    await expect(pending).resolves.toMatchObject({ version: '2.0.0' })
  })
})
