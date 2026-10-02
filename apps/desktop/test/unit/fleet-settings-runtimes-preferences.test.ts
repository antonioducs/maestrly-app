import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FLEET_SETTINGS_OPERATIONS } from '@maestrly/bot-fleet-protocol'
import type { RuntimeAssetInfo, RuntimeAssetUpdateInfo, UpdatableRuntimeAssetId } from '../../src/shared/runtime-assets'
import { closeDb, freshDb, restartDb } from '../helpers/db'

type TestInfo = Omit<{ -readonly [K in keyof RuntimeAssetInfo]: RuntimeAssetInfo[K] }, 'update'> & {
  update: { -readonly [K in keyof RuntimeAssetUpdateInfo]: RuntimeAssetUpdateInfo[K] }
}
const fake = vi.hoisted(() => ({
  infos: new Map<string, TestInfo>(),
  controllers: new Map<string, ReturnType<typeof controller>>(),
  inUse: [] as { version: string; source: 'managed' }[],
  read: vi.fn(),
}))
vi.mock('../../src/main/runtime-assets/app-service', () => ({
  runtimeAssetProgressInfo: (id: string) => {
    fake.read(id)
    return Promise.resolve(fake.infos.get(id))
  },
  runtimeUpdates: (id: string) => fake.controllers.get(id),
}))
vi.mock('../../src/main/fleet/instance/runtimes', () => ({ runtimesInUse: () => fake.inUse }))
vi.mock('../../src/main/fleet/instance/server', () => ({
  InstanceHttpError: class extends Error {
    constructor(
      readonly status: number,
      readonly code: string,
      message: string
    ) {
      super(message)
    }
  },
}))

import { preferences, setPreferences } from '../../src/main/fleet/instance/settings/preferences'
import { runtimeAction, runtimes, setRuntimeAutomatic } from '../../src/main/fleet/instance/settings/runtimes'
import { getAppFlag, setAppFlag } from '../../src/main/store/app-settings'
import { getDb } from '../../src/main/store/db'

function controller(id: UpdatableRuntimeAssetId) {
  return {
    check: vi.fn(async () => fake.infos.get(id)!.update!),
    update: vi.fn(async () => fake.infos.get(id)!.update!),
    rollback: vi.fn(async () => fake.infos.get(id)!.update!),
    installInitial: vi.fn(async () => fake.infos.get(id)!.status),
    cancel: vi.fn(() => true),
    setAutomatic: vi.fn(async (automatic: boolean) => {
      const info = fake.infos.get(id)!
      info.update = { ...info.update!, automatic }
      return info.update
    }),
  }
}
const ids = ['claude-code', 'codex', 'antigravity-acp'] as const
const assets = ['claude-code-runtime', 'codex-runtime', 'antigravity-acp-runtime'] as const
beforeEach(() => {
  freshDb()
  fake.infos.clear()
  fake.controllers.clear()
  fake.inUse = []
  fake.read.mockClear()
  for (const id of assets) {
    fake.infos.set(id, {
      id,
      displayName: id,
      requiredBy: 'test',
      availableVersion: '2.0.0',
      downloadBytes: 100,
      unpackedBytes: 100,
      status: { id, state: 'ready', version: '1.0.0', diskUsageBytes: 0 },
      update: { state: 'available', availableVersion: '2.0.0', automatic: false, restartRequired: false },
    })
    fake.controllers.set(id, controller(id))
  }
})
afterEach(closeDb)

async function row(id: (typeof ids)[number]) {
  return (await runtimes({})).runtimes.find((runtime) => runtime.id === id)!
}

describe('environment runtime settings', () => {
  it('lists all three directly with zero bots and offers installation for absent Google', async () => {
    fake.infos.get('antigravity-acp-runtime')!.status = {
      id: 'antigravity-acp-runtime',
      state: 'not-installed',
      diskUsageBytes: 0,
    }
    const result = await runtimes({})
    expect(FLEET_SETTINGS_OPERATIONS.runtimes.response.parse(result)).toEqual(result)
    expect(result.runtimes.map((runtime) => runtime.id)).toEqual(ids)
    expect(fake.read.mock.calls.flat()).toEqual(assets)
    expect(result.runtimes[2]).toMatchObject({
      currentVersion: null,
      state: 'idle',
      allowedActions: ['check', 'install'],
    })
    const google = result.runtimes[2]
    await runtimeAction({ id: google.id, expectedRevision: google.revision, action: 'install' })
    expect(fake.controllers.get('antigravity-acp-runtime')!.installInitial).toHaveBeenCalledOnce()
  })

  it.each(ids)('starts %s updates promptly and permits polling/cancellation', async (id) => {
    const assetId = assets[ids.indexOf(id)]
    const control = fake.controllers.get(assetId)!
    let finish!: () => void
    control.update.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => resolve(fake.infos.get(assetId)!.update!)
        })
    )
    const initial = await row(id)
    const accepted = await runtimeAction({ id, expectedRevision: initial.revision, action: 'update' })
    expect(control.update).toHaveBeenCalledOnce()
    expect(accepted.state).toBe('installing')
    fake.infos.get(assetId)!.update = {
      ...fake.infos.get(assetId)!.update!,
      state: 'downloading',
      bytesDownloaded: 25,
      totalBytes: 100,
    }
    expect(await row(id)).toMatchObject({ progress: 25, allowedActions: ['cancel'] })
    await runtimeAction({ id, expectedRevision: accepted.revision, action: 'cancel' })
    expect(control.cancel).toHaveBeenCalledOnce()
    finish()
    await Promise.resolve()
  })

  it('reports image baselines and pending leases without inventing scheduled cancellation', async () => {
    const info = fake.infos.get('claude-code-runtime')!
    info.status = { id: info.id, state: 'not-installed', diskUsageBytes: 0 }
    info.provided = { active: true, version: '1.0.0' }
    expect(await row('claude-code')).toMatchObject({
      currentVersion: '1.0.0',
      state: 'ready',
      allowedActions: ['check', 'update'],
    })
    fake.inUse = [{ version: '0.9.0', source: 'managed' }]
    expect(await row('claude-code')).toMatchObject({
      currentVersion: '0.9.0',
      pendingVersion: '1.0.0',
      allowedActions: ['check', 'update'],
    })
  })

  it('sanitizes a synchronous start failure and permits retry', async () => {
    const control = fake.controllers.get('codex-runtime')!
    control.check.mockImplementationOnce(() => {
      throw new Error('/private/path?token=secret')
    })
    const initial = await row('codex')
    const failed = await runtimeAction({ id: 'codex', expectedRevision: initial.revision, action: 'check' })
    expect(failed).toMatchObject({ state: 'error', error: 'check-failed' })
    expect(JSON.stringify(failed)).not.toContain('secret')
    await runtimeAction({ id: 'codex', expectedRevision: failed.revision, action: 'check' })
    expect((await row('codex')).error).toBeNull()
  })

  it('enforces rollback eligibility and does not advertise cancellation during rollback', async () => {
    const initial = await row('codex')
    await expect(
      runtimeAction({ id: 'codex', expectedRevision: initial.revision, action: 'rollback' })
    ).rejects.toMatchObject({ status: 409 })
    const info = fake.infos.get('codex-runtime')!
    info.update = { ...info.update!, rollbackVersion: '0.9.0', state: 'rolling-back' }
    expect(await row('codex')).toMatchObject({ allowedActions: [], rollbackVersion: '0.9.0' })
    info.update.state = 'idle'
    const ready = await row('codex')
    await runtimeAction({ id: 'codex', expectedRevision: ready.revision, action: 'rollback' })
    expect(fake.controllers.get('codex-runtime')!.rollback).toHaveBeenCalledOnce()
  })

  it('persists automatic policy through the controller with compare-and-set', async () => {
    const initial = await row('antigravity-acp')
    const updated = await setRuntimeAutomatic({ id: initial.id, expectedRevision: initial.revision, automatic: true })
    expect(updated.automatic).toBe(true)
    expect(updated.revision).not.toBe(initial.revision)
    expect(fake.controllers.get('antigravity-acp-runtime')!.setAutomatic).toHaveBeenCalledWith(true)
    await expect(
      setRuntimeAutomatic({ id: initial.id, expectedRevision: initial.revision, automatic: false })
    ).rejects.toMatchObject({ status: 409 })
  })

  it('handles rejected detached tasks with fixed errors', async () => {
    const control = fake.controllers.get('codex-runtime')!
    control.update.mockRejectedValueOnce(new Error('https://private.invalid?secret=value'))
    const initial = await row('codex')
    await runtimeAction({ id: 'codex', expectedRevision: initial.revision, action: 'update' })
    await vi.waitFor(async () => expect(await row('codex')).toMatchObject({ state: 'error', error: 'install-failed' }))
  })

  it('rejects cancellation when the controller has no active cancellable operation', async () => {
    const info = fake.infos.get('codex-runtime')!
    info.update.state = 'checking'
    fake.controllers.get('codex-runtime')!.cancel.mockReturnValueOnce(false)
    const initial = await row('codex')
    await expect(
      runtimeAction({ id: 'codex', expectedRevision: initial.revision, action: 'cancel' })
    ).rejects.toMatchObject({ status: 409 })
    expect((await row('codex')).revision).toBe(initial.revision)
  })

  it('keeps automatic policy revision unchanged on persistence failure', async () => {
    fake.controllers.get('codex-runtime')!.setAutomatic.mockRejectedValueOnce(new Error('/private/config'))
    const initial = await row('codex')
    await expect(
      setRuntimeAutomatic({ id: 'codex', expectedRevision: initial.revision, automatic: true })
    ).rejects.toMatchObject({ status: 503, message: 'Runtime preference could not be saved.' })
    expect(await row('codex')).toMatchObject({ revision: initial.revision, automatic: false })
  })

  it('clamps progress and hides raw status diagnostics and paths', async () => {
    const info = fake.infos.get('codex-runtime')!
    info.update = { ...info.update, state: 'downloading', bytesDownloaded: 200, totalBytes: 100 }
    expect((await row('codex')).progress).toBe(100)
    info.update = { ...info.update, state: 'failed', error: 'download-failed', totalBytes: Number.NaN }
    info.status = { ...info.status, error: '/private/token', version: '/private/runtime' }
    const failed = await row('codex')
    expect(failed).toMatchObject({ progress: null, error: 'install-failed', currentVersion: null })
    expect(JSON.stringify(failed)).not.toContain('/private')
  })
})

describe('environment preferences', () => {
  it('preserves the persisted value and revision when storage rejects the write', async () => {
    const initial = await preferences({})
    getDb().exec(`CREATE TRIGGER reject_image_preference BEFORE INSERT ON app_settings
      WHEN NEW.key = 'chat.imageGen' BEGIN SELECT RAISE(ABORT, 'synthetic write failure'); END`)
    await expect(setPreferences({ expectedRevision: initial.revision, imageGenEnabled: false })).rejects.toMatchObject({
      status: 503,
      message: 'Preferences could not be saved.',
    })
    expect(await preferences({})).toEqual(initial)
  })

  it('shares the local global image generation default and persists across restart', async () => {
    const initial = await preferences({})
    expect(initial.imageGenEnabled).toBe(true)
    const changed = await setPreferences({ expectedRevision: initial.revision, imageGenEnabled: false })
    expect(getAppFlag('chat.imageGen', true)).toBe(false)
    expect(changed.revision).not.toBe(initial.revision)
    restartDb()
    expect(await preferences({})).toEqual(changed)
  })

  it('rejects concurrent stale writes and observes local preference changes', async () => {
    const initial = await preferences({})
    const results = await Promise.allSettled([
      setPreferences({ expectedRevision: initial.revision, imageGenEnabled: false }),
      setPreferences({ expectedRevision: initial.revision, imageGenEnabled: true }),
    ])
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected'])
    expect(getAppFlag('chat.imageGen', true)).toBe(false)
    const beforeLocal = await preferences({})
    setAppFlag('chat.imageGen', true)
    await expect(
      setPreferences({ expectedRevision: beforeLocal.revision, imageGenEnabled: false })
    ).rejects.toMatchObject({ status: 409 })
  })
})
