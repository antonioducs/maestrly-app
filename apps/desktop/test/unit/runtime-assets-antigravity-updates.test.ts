import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ANTIGRAVITY_RELEASE_PROFILE,
  createAntigravityTarget,
} from '../../src/main/runtime-assets/antigravity-releases'
import { RUNTIME_ASSET_REGISTRY, type RuntimeAssetDefinition } from '../../src/main/runtime-assets/registry'
import { RuntimeReleaseStore } from '../../src/main/runtime-assets/release-store'
import { RuntimeAssetService } from '../../src/main/runtime-assets/service'
import { RuntimeUpdateController } from '../../src/main/runtime-assets/runtime-updates'
let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'agy-updates-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})
function pending(version = '1.3.0'): RuntimeAssetDefinition {
  return {
    id: 'antigravity-acp-runtime',
    version,
    targets: {
      'mac-arm64': createAntigravityTarget('mac-arm64', version, {
        googleIntegrity: { pending: true },
        downloadBytes: 100,
        maxDownloadBytes: 200,
        unpackedBytes: 500,
      }),
    },
  }
}
function harness() {
  const id = 'antigravity-acp-runtime' as const
  let persisted: string | null = null
  const store = new RuntimeReleaseStore({
    profile: ANTIGRAVITY_RELEASE_PROFILE,
    target: 'mac-arm64',
    embedded: RUNTIME_ASSET_REGISTRY[id],
    storage: {
      read: () => persisted,
      write: (value) => {
        persisted = value
      },
    },
  })
  let digest = 'a'.repeat(64)
  const downloader = vi.fn(async (target, destination) => {
    await writeFile(destination, 'archive')
    return { bytes: 7, digest: target.url.includes('1.2.1') ? target.hash.digest : digest, finalUrl: target.url }
  })
  const service = new RuntimeAssetService({
    userDataPath: root,
    target: 'mac-arm64',
    acceptedDefinition: (_id, version) => store.acceptedDefinition(version),
    downloader,
    availableBytes: async () => 10_000_000_000,
    extract: async (_archive, destination) => {
      await mkdir(destination, { recursive: true })
      for (const name of ['agy_acp_server.par', 'localharness_external'])
        await writeFile(path.join(destination, name), 'binary', { mode: 0o700 })
    },
  })
  const validate = vi.fn(async () => undefined)
  const discover = vi.fn(async () => pending())
  const controller = new RuntimeUpdateController({
    profile: ANTIGRAVITY_RELEASE_PROFILE,
    compatibilityRevision: 1,
    target: 'mac-arm64',
    embedded: RUNTIME_ASSET_REGISTRY[id],
    store,
    service,
    validate,
    discover,
    log: () => undefined,
  })
  return {
    id,
    service,
    store,
    controller,
    validate,
    downloader,
    discover,
    changeDigest: () => {
      digest = 'b'.repeat(64)
    },
  }
}

describe('Antigravity pending installation and activation', () => {
  it('checks without downloading, pins after validation, preserves leases and rolls back', async () => {
    const h = harness()
    await h.service.install(h.id)
    const lease = await h.service.acquireLease(h.id)
    await h.controller.check()
    expect(h.downloader).toHaveBeenCalledTimes(1)
    expect(h.store.acceptedDefinition('1.3.0')).toBeNull()
    await h.controller.update()
    expect(h.validate).toHaveBeenCalledTimes(1)
    expect(h.store.acceptedDefinition('1.3.0')?.targets['mac-arm64']?.hash.digest).toBe('a'.repeat(64))
    expect((await h.controller.snapshot()).restartRequired).toBe(true)
    expect((await h.service.status(h.id)).version).toBe('1.3.0')
    await h.controller.rollback()
    expect((await h.service.status(h.id)).version).toBe('1.2.1')
    lease.release()
    h.controller.dispose()
  })
  it('rejects changed bytes when rediscovering an accepted Google release', async () => {
    const h = harness()
    await h.service.install(h.id)
    await h.controller.update()
    await h.controller.rollback()
    h.changeDigest()
    expect((await h.controller.update()).error).toBe('integrity')
    expect((await h.service.status(h.id)).version).toBe('1.2.1')
    expect(h.store.acceptedDefinition('1.3.0')?.targets['mac-arm64']?.hash.digest).toBe('a'.repeat(64))
    h.controller.dispose()
  })
  it('repairs an accepted version with its persisted digest and rejects changed bytes', async () => {
    const h = harness()
    const installed = await h.controller.installInitial()
    expect(installed.version).toBe('1.3.0')
    await rm(path.join(installed.path!, 'localharness_external'))
    h.changeDigest()
    const repaired = await h.service.repair(h.id)
    expect(repaired.state).toBe('failed')
    expect(h.downloader.mock.calls.at(-1)?.[0].hash.digest).toBe('a'.repeat(64))
    expect(h.store.acceptedDefinition('1.3.0')?.targets['mac-arm64']?.hash.digest).toBe('a'.repeat(64))
    h.controller.dispose()
  })

  it('does not accept a failed or cancelled compatibility check', async () => {
    const h = harness()
    await h.service.install(h.id)
    h.validate.mockRejectedValueOnce(new Error('incompatible'))
    expect((await h.controller.update()).error).toBe('incompatible')
    expect(h.store.acceptedDefinition('1.3.0')).toBeNull()
    h.validate.mockImplementationOnce(async () => {
      h.controller.cancel()
      throw new Error('cancelled')
    })
    expect((await h.controller.update()).error).toBe('cancelled')
    expect(h.store.acceptedDefinition('1.3.0')).toBeNull()
    expect((await h.service.status(h.id)).version).toBe('1.2.1')
    h.controller.dispose()
  })
  it('restricts hashless service updates to canonical Google artifacts with validation and commit', async () => {
    const h = harness()
    const candidate = pending()
    const target = candidate.targets['mac-arm64']!
    for (const definition of [
      candidate,
      { ...candidate, id: 'codex-runtime' as const },
      { ...candidate, targets: { 'mac-arm64': { ...target, url: 'https://evil.test/archive' } } },
    ]) {
      await expect(h.service.update(definition)).rejects.toMatchObject({ code: 'integrity' })
    }
    await expect(
      h.service.update(
        { ...candidate, targets: { 'mac-arm64': { ...target, criticalPaths: ['other'] } } },
        { validate: h.validate, commit: () => undefined }
      )
    ).rejects.toMatchObject({ code: 'integrity' })
    expect(h.downloader).not.toHaveBeenCalled()
    h.controller.dispose()
  })
})
