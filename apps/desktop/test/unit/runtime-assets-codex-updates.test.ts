import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeAssetId } from '../../src/shared/runtime-assets'
import { CODEX_COMPATIBILITY_REVISION } from '../../src/main/runtime-assets/codex-compatibility'
import { CodexReleaseStore, type CodexReleaseStorage } from '../../src/main/runtime-assets/codex-release-store'
import { CodexUpdateController } from '../../src/main/runtime-assets/codex-updates'
import type { RuntimeDownloader } from '../../src/main/runtime-assets/downloader'
import { createCodexTarget, type RuntimeAssetDefinition } from '../../src/main/runtime-assets/registry'
import { RuntimeAssetService } from '../../src/main/runtime-assets/service'

let userData: string
beforeEach(async () => {
  userData = await mkdtemp(path.join(os.tmpdir(), 'codex-updates-'))
})
afterEach(async () => {
  vi.useRealTimers()
  await rm(userData, { recursive: true, force: true })
})

function codexDefinition(version: string): RuntimeAssetDefinition {
  return {
    id: 'codex-runtime',
    version,
    targets: {
      'mac-arm64': createCodexTarget('mac-arm64', version, {
        sha512Base64: createHash('sha512').update(version).digest('base64'),
        downloadBytes: 100,
        maxDownloadBytes: 100,
        unpackedBytes: 200,
      }),
    },
  }
}

function memoryStorage(): CodexReleaseStorage & { value: () => string | null } {
  let value: string | null = null
  return {
    read: () => value,
    write: (next) => {
      value = next
    },
    value: () => value,
  }
}

function harness(options: { schedule?: boolean; storage?: ReturnType<typeof memoryStorage> } = {}) {
  const storage = options.storage ?? memoryStorage()
  const embedded = codexDefinition('1.0.0')
  const empty = (id: RuntimeAssetId): RuntimeAssetDefinition => ({ id, version: 'none', targets: {} })
  const store = new CodexReleaseStore({ storage, target: 'mac-arm64', embedded })
  const downloader = vi.fn<RuntimeDownloader>(async (target, destination, download) => {
    await writeFile(destination, 'archive')
    download.onProgress?.(7, 7)
    return { bytes: 7, digest: target.hash.digest, finalUrl: target.url }
  })
  const extract = vi.fn(async (_archive: string, destination: string) => {
    await mkdir(path.join(destination, 'bin'), { recursive: true })
    await writeFile(path.join(destination, 'bin/codex'), 'binary')
    await writeFile(path.join(destination, 'codex-package.json'), '{}')
  })
  const service = new RuntimeAssetService({
    userDataPath: userData,
    registry: {
      'codex-runtime': embedded,
      'github-copilot-runtime': empty('github-copilot-runtime'),
      'tunnel-client': empty('tunnel-client'),
      'local-ml-runtime': empty('local-ml-runtime'),
    },
    target: 'mac-arm64',
    downloader,
    extract,
    availableBytes: async () => 1_000_000_000,
    acceptedDefinition: (id, version) => (id === 'codex-runtime' ? store.acceptedDefinition(version) : null),
  })
  const latest = { version: '2.0.0' }
  const discover = vi.fn(async () => codexDefinition(latest.version))
  const validate = vi.fn(async (_path: string, _definition: RuntimeAssetDefinition, _signal: AbortSignal) => undefined)
  const onChanged = vi.fn()
  const controller = new CodexUpdateController({
    service,
    store,
    target: 'mac-arm64',
    embedded,
    discover,
    validate,
    onChanged,
    schedule: options.schedule ?? false,
    initialDelayMs: 1_000,
    intervalMs: 10_000,
    log: () => undefined,
  })
  return { storage, store, service, downloader, discover, validate, onChanged, controller, latest, embedded }
}

describe('CodexUpdateController', () => {
  it('defaults to notify-only and persists the automatic preference', async () => {
    const first = harness()
    expect((await first.controller.snapshot()).automatic).toBe(false)
    await first.controller.setAutomatic(true)

    const second = harness({ storage: first.storage })
    expect((await second.controller.snapshot()).automatic).toBe(true)
  })

  it('never checks or downloads for a component the user has not installed', async () => {
    const { controller, discover, downloader, store } = harness({ schedule: true })
    store.setAutomatic(true)
    await controller.cycle(true)
    expect(discover).not.toHaveBeenCalled()
    expect(downloader).not.toHaveBeenCalled()
    expect((await controller.snapshot()).state).toBe('idle')
  })

  it('checks without changing the active version and reports the newer release', async () => {
    const { controller, service, downloader } = harness()
    await service.install('codex-runtime')
    downloader.mockClear()

    const snapshot = await controller.check()
    expect(snapshot).toMatchObject({ state: 'available', availableVersion: '2.0.0', automatic: false })
    expect(snapshot.lastCheckedAt).toBeTruthy()
    expect(downloader).not.toHaveBeenCalled()
    expect(await service.status('codex-runtime')).toMatchObject({ state: 'ready', version: '1.0.0' })
  })

  it('updates manually through validation and offers the previous version for rollback', async () => {
    const { controller, service, validate, store, onChanged } = harness()
    await service.install('codex-runtime')
    onChanged.mockClear()

    const snapshot = await controller.update()
    expect(snapshot).toMatchObject({ state: 'up-to-date', rollbackVersion: '1.0.0', restartRequired: false })
    expect(snapshot.error).toBeUndefined()
    expect(validate).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ version: '2.0.0' }),
      expect.any(AbortSignal)
    )
    expect(await service.status('codex-runtime')).toMatchObject({ state: 'ready', version: '2.0.0' })
    expect(store.acceptedRelease('2.0.0')?.compatibilityRevision).toBe(CODEX_COMPATIBILITY_REVISION)
    expect(onChanged).toHaveBeenCalled()
  })

  it('deduplicates concurrent checks and updates', async () => {
    const { controller, service, discover, downloader } = harness()
    await service.install('codex-runtime')
    downloader.mockClear()

    await Promise.all([controller.check(), controller.check()])
    expect(discover).toHaveBeenCalledTimes(1)
    discover.mockClear()
    await Promise.all([controller.update(), controller.update()])
    expect(discover).toHaveBeenCalledTimes(1)
    expect(downloader).toHaveBeenCalledTimes(1)
  })

  it('preserves the installation and reports a check error when the registry is unreachable', async () => {
    const { controller, service, discover } = harness()
    await service.install('codex-runtime')
    discover.mockRejectedValue(new Error('offline'))

    const snapshot = await controller.update()
    expect(snapshot).toMatchObject({ state: 'failed', error: 'check-failed' })
    expect(snapshot.lastCheckedAt).toBeUndefined()
    expect(await service.status('codex-runtime')).toMatchObject({ state: 'ready', version: '1.0.0' })
  })

  it('rejects an incompatible release for automatic retries but allows an explicit retry', async () => {
    const { controller, service, validate, store } = harness({ schedule: true })
    await service.install('codex-runtime')
    store.setAutomatic(true)
    validate.mockRejectedValueOnce(new Error('handshake failed'))

    await controller.cycle(true)
    expect(await controller.snapshot()).toMatchObject({ error: 'incompatible', rejectedVersion: '2.0.0' })
    expect(await service.status('codex-runtime')).toMatchObject({ state: 'ready', version: '1.0.0' })

    validate.mockClear()
    await controller.cycle(true)
    expect(validate).not.toHaveBeenCalled()

    await controller.update()
    expect(await service.status('codex-runtime')).toMatchObject({ state: 'ready', version: '2.0.0' })
    expect(store.rejected()).toBeNull()
  })

  it('does not reject a release after a transient download failure', async () => {
    const { controller, service, downloader, store } = harness()
    await service.install('codex-runtime')
    downloader.mockRejectedValueOnce(new Error('ECONNRESET'))

    expect(await controller.update()).toMatchObject({ error: 'download-failed' })
    expect(store.rejected()).toBeNull()
  })

  it('does not reject a release when only its activation fails', async () => {
    const { controller, service, store } = harness()
    await service.install('codex-runtime')
    const accept = vi.spyOn(store, 'accept').mockImplementationOnce(() => {
      throw new Error('database is locked')
    })

    expect(await controller.update()).toMatchObject({ error: 'failed' })
    expect(accept).toHaveBeenCalled()
    expect(store.rejected()).toBeNull()
    expect(await service.status('codex-runtime')).toMatchObject({ state: 'ready', version: '1.0.0' })
  })

  it('keeps background cycles safe when release metadata is unavailable', async () => {
    const storage = memoryStorage()
    const { service } = harness({ schedule: true, storage })
    await service.install('codex-runtime')
    storage.read = () => {
      throw new Error('database closed')
    }
    const fresh = harness({ schedule: true, storage })
    await expect(fresh.controller.cycle(false)).resolves.toBeUndefined()
    // The check ran, but its result could not be recorded; nothing was installed.
    expect(fresh.discover).toHaveBeenCalledTimes(1)
    expect(fresh.downloader).not.toHaveBeenCalled()
    await expect(fresh.controller.snapshot()).resolves.toMatchObject({ automatic: false, error: 'check-failed' })
  })

  it('rolls back offline and never reinstalls the rejected version automatically', async () => {
    const { controller, service, store, downloader, latest } = harness({ schedule: true })
    await service.install('codex-runtime')
    await controller.update()
    downloader.mockClear()

    const rolledBack = await controller.rollback()
    expect(await service.status('codex-runtime')).toMatchObject({ state: 'ready', version: '1.0.0' })
    expect(rolledBack).toMatchObject({ availableVersion: '2.0.0', rejectedVersion: '2.0.0' })
    expect(rolledBack.rollbackVersion).toBeUndefined()
    expect(downloader).not.toHaveBeenCalled()

    store.setAutomatic(true)
    await controller.cycle(true)
    expect(downloader).not.toHaveBeenCalled()
    expect(await service.status('codex-runtime')).toMatchObject({ version: '1.0.0' })

    latest.version = '3.0.0'
    await controller.cycle(true)
    expect(await service.status('codex-runtime')).toMatchObject({ state: 'ready', version: '3.0.0' })
  })

  it('reports rollback as unavailable without a previous version', async () => {
    const { controller, service } = harness()
    await service.install('codex-runtime')
    expect(await controller.rollback()).toMatchObject({ state: 'failed', error: 'rollback-unavailable' })
  })

  it('reports a pending restart while a connection keeps the previous version', async () => {
    const { controller, service } = harness()
    await service.install('codex-runtime')
    const lease = await service.acquireLease('codex-runtime')

    expect(await controller.update()).toMatchObject({ restartRequired: true })
    expect(await service.status('codex-runtime')).toMatchObject({ version: '2.0.0' })
    lease.release()
    expect((await controller.snapshot()).restartRequired).toBe(false)
  })

  it('cancels a running update without touching the active installation', async () => {
    const { controller, service, downloader } = harness()
    await service.install('codex-runtime')
    downloader.mockImplementationOnce(
      (_target, _destination, download) =>
        new Promise((_resolve, reject) =>
          download.signal.addEventListener('abort', () => reject(download.signal.reason), { once: true })
        )
    )
    const pending = controller.update()
    await vi.waitFor(() => expect(downloader).toHaveBeenCalledTimes(2))
    expect((await controller.snapshot()).state).toBe('downloading')
    expect(controller.cancel()).toBe(true)

    expect(await pending).toMatchObject({ state: 'failed', error: 'cancelled' })
    expect(await service.status('codex-runtime')).toMatchObject({ state: 'ready', version: '1.0.0' })
  })

  it('schedules checks after startup and every interval, stopping on dispose', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] })
    const { controller, service, discover } = harness({ schedule: true })
    await service.install('codex-runtime')
    const cycle = vi.spyOn(controller, 'cycle')
    controller.start()
    controller.start()

    await vi.advanceTimersByTimeAsync(999)
    expect(cycle).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(cycle).toHaveBeenCalledWith(false)
    await cycle.mock.results[0].value
    expect(discover).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(10_000)
    expect(cycle).toHaveBeenLastCalledWith(true)
    await cycle.mock.results[1].value
    expect(discover).toHaveBeenCalledTimes(2)

    controller.dispose()
    await vi.advanceTimersByTimeAsync(50_000)
    expect(cycle).toHaveBeenCalledTimes(2)
  })

  it('stays manual in development and E2E builds', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] })
    const { controller, service, discover } = harness({ schedule: false })
    await service.install('codex-runtime')
    controller.start()
    await vi.advanceTimersByTimeAsync(100_000)
    expect(discover).not.toHaveBeenCalled()
  })

  it('reuses a recent check at startup instead of querying again', async () => {
    const { controller, service, discover } = harness({ schedule: true })
    await service.install('codex-runtime')
    await controller.check()
    discover.mockClear()
    await controller.cycle(false)
    expect(discover).not.toHaveBeenCalled()
  })

  it('installs automatically only when enabled', async () => {
    const { controller, service, store } = harness({ schedule: true })
    await service.install('codex-runtime')
    await controller.cycle(true)
    expect(await service.status('codex-runtime')).toMatchObject({ version: '1.0.0' })

    store.setAutomatic(true)
    await controller.cycle(true)
    expect(await service.status('codex-runtime')).toMatchObject({ version: '2.0.0' })
  })

  describe('installInitial', () => {
    it('prefers the latest validated release on an explicit first install', async () => {
      const { controller, validate, service } = harness()
      await expect(controller.installInitial()).resolves.toMatchObject({ state: 'ready', version: '2.0.0' })
      expect(validate).toHaveBeenCalledTimes(1)
      expect(await service.status('codex-runtime')).toMatchObject({ version: '2.0.0' })
    })

    it('falls back to the embedded version when discovery is unavailable', async () => {
      const { controller, discover } = harness()
      discover.mockRejectedValue(new Error('offline'))
      await expect(controller.installInitial()).resolves.toMatchObject({ state: 'ready', version: '1.0.0' })
    })

    it('falls back to the embedded version when the release fails validation', async () => {
      const { controller, validate, store } = harness()
      validate.mockRejectedValueOnce(new Error('incompatible'))
      await expect(controller.installInitial()).resolves.toMatchObject({ state: 'ready', version: '1.0.0' })
      expect(store.rejected()).toEqual({ version: '2.0.0', reason: 'failed' })
    })

    it('keeps an existing installation instead of switching releases', async () => {
      const { controller, service, discover } = harness()
      await service.install('codex-runtime')
      await expect(controller.installInitial()).resolves.toMatchObject({ version: '1.0.0' })
      expect(discover).not.toHaveBeenCalled()
    })
  })

  it('revalidates a release accepted under an older compatibility contract', async () => {
    const { controller, service, store, validate } = harness()
    await service.install('codex-runtime')
    await controller.update()
    store.accept(codexDefinition('2.0.0'), CODEX_COMPATIBILITY_REVISION - 1)
    validate.mockClear()

    await controller.revalidateIfStale()
    expect(validate).toHaveBeenCalledTimes(1)
    expect(store.acceptedRelease('2.0.0')?.compatibilityRevision).toBe(CODEX_COMPATIBILITY_REVISION)

    store.accept(codexDefinition('2.0.0'), CODEX_COMPATIBILITY_REVISION - 1)
    validate.mockRejectedValueOnce(new Error('contract changed'))
    await controller.revalidateIfStale()
    expect(await service.status('codex-runtime')).toMatchObject({ state: 'ready', version: '1.0.0' })
    expect(store.rejected()).toEqual({ version: '2.0.0', reason: 'failed' })
  })

  it('prunes metadata of versions that are no longer installed', async () => {
    const { controller, service, store, latest } = harness()
    await service.install('codex-runtime')
    await controller.update()
    latest.version = '3.0.0'
    await controller.update()
    latest.version = '4.0.0'
    await controller.update()

    expect(store.acceptedDefinition('2.0.0')).toBeNull()
    expect(store.acceptedDefinition('3.0.0')).not.toBeNull()
    expect(store.acceptedDefinition('4.0.0')).not.toBeNull()
  })
})
