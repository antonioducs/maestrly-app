import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeAssetId, RuntimeAssetInfo, RuntimeAssetState } from '../../src/shared/runtime-assets'
import type { IpcRegistrar } from '../../src/main/ipc-registrar'

const mocks = vi.hoisted(() => {
  const states = new Map<RuntimeAssetId, RuntimeAssetState>()
  const info = vi.fn(
    async (id: RuntimeAssetId): Promise<RuntimeAssetInfo> => ({
      id,
      displayName: id,
      requiredBy: 'test',
      availableVersion: '1',
      downloadBytes: 1,
      unpackedBytes: 1,
      status: { id, state: states.get(id) ?? 'not-installed', diskUsageBytes: 0 },
    })
  )
  const progressInfo = vi.fn(
    async (id: RuntimeAssetId): Promise<RuntimeAssetInfo> => ({
      id,
      displayName: id,
      requiredBy: 'test',
      availableVersion: '1',
      downloadBytes: 1,
      unpackedBytes: 1,
      status: { id, state: states.get(id) ?? 'not-installed', diskUsageBytes: 0 },
    })
  )
  const operation = (state: RuntimeAssetState) =>
    vi.fn(async (id: RuntimeAssetId) => {
      states.set(id, state)
      return { id, state }
    })
  let changedEmitter: ((info: RuntimeAssetInfo) => void) | undefined
  const snapshot = { state: 'idle', automatic: false, restartRequired: false }
  return {
    states,
    changedEmitter: () => changedEmitter,
    setEmitter: vi.fn((emit: (info: RuntimeAssetInfo) => void) => {
      changedEmitter = emit
    }),
    info,
    progressInfo,
    service: {
      install: operation('ready'),
      repair: operation('ready'),
      remove: operation('not-installed'),
      cancel: vi.fn(() => false),
    },
    updates: {
      installInitial: vi.fn(async () => ({ id: 'codex-runtime', state: 'ready' })),
      check: vi.fn(async () => snapshot),
      update: vi.fn(async () => snapshot),
      rollback: vi.fn(async () => snapshot),
      setAutomatic: vi.fn(async () => snapshot),
      cancel: vi.fn(() => true),
      prune: vi.fn(async () => undefined),
    },
  }
})

vi.mock('../../src/main/runtime-assets/app-service', () => ({
  runtimeAssetInfo: mocks.info,
  runtimeAssetService: () => mocks.service,
  codexRuntimeUpdates: () => mocks.updates,
  setRuntimeAssetChangedEmitter: mocks.setEmitter,
}))

import { registerRuntimeAssetIpc } from '../../src/main/runtime-assets/ipc'

describe('runtime asset IPC', () => {
  const reads = new Map<string, (...args: unknown[]) => unknown>()
  const mutations = new Map<string, (...args: unknown[]) => unknown>()
  const emitChanged = vi.fn()

  beforeEach(() => {
    reads.clear()
    mutations.clear()
    mocks.states.clear()
    mocks.info.mockClear()
    mocks.progressInfo.mockClear()
    mocks.setEmitter.mockClear()
    emitChanged.mockClear()
    Object.values(mocks.service).forEach((fn) => fn.mockClear())
    Object.values(mocks.updates).forEach((fn) => fn.mockClear())
    const reg = {
      handle: (channel: string, fn: (...args: unknown[]) => unknown) => reads.set(channel, fn),
      mhandle: (channel: string, fn: (...args: unknown[]) => unknown) => mutations.set(channel, fn),
      on: vi.fn(),
      mon: vi.fn(),
    } as unknown as IpcRegistrar
    registerRuntimeAssetIpc(reg, { emitChanged })
  })

  it('list and status are read-only and never install or download', async () => {
    await expect(reads.get('runtime-assets:status')?.({}, 'codex-runtime')).resolves.toMatchObject({
      id: 'codex-runtime',
    })
    await expect(reads.get('runtime-assets:list')?.({})).resolves.toHaveLength(4)
    expect(mocks.service.install).not.toHaveBeenCalled()
    expect(mocks.service.repair).not.toHaveBeenCalled()
  })

  it.each(['status', 'install', 'cancel', 'repair', 'remove', 'check-update', 'update', 'rollback', 'set-auto-update'])(
    'rejects unknown IDs for %s',
    async (operation) => {
      const handlers = operation === 'status' ? reads : mutations
      await expect(
        Promise.resolve().then(() => handlers.get(`runtime-assets:${operation}`)?.({}, 'not-a-runtime'))
      ).rejects.toThrow('Unknown runtime asset id')
    }
  )

  it('runs explicit mutations and emits the resulting renderer-safe status', async () => {
    await expect(mutations.get('runtime-assets:install')?.({}, 'tunnel-client')).resolves.toMatchObject({
      id: 'tunnel-client',
      status: { state: 'ready' },
    })
    expect(mocks.service.install).toHaveBeenCalledWith('tunnel-client')
    expect(emitChanged).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'tunnel-client' }))
  })

  it('routes Codex first installs through the release controller only', async () => {
    await mutations.get('runtime-assets:install')?.({}, 'codex-runtime')
    expect(mocks.updates.installInitial).toHaveBeenCalledTimes(1)
    expect(mocks.service.install).not.toHaveBeenCalled()
  })

  it.each([
    ['check-update', 'check', [true]],
    ['update', 'update', []],
    ['rollback', 'rollback', []],
  ] as const)('runs Codex %s and emits the refreshed status', async (channel, method, args) => {
    await expect(mutations.get(`runtime-assets:${channel}`)?.({}, 'codex-runtime')).resolves.toMatchObject({
      id: 'codex-runtime',
    })
    expect(mocks.updates[method]).toHaveBeenCalledWith(...args)
    expect(emitChanged).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'codex-runtime' }))
  })

  it.each(['check-update', 'update', 'rollback', 'set-auto-update'])(
    'accepts only updatable assets for %s',
    async (operation) => {
      await expect(
        Promise.resolve().then(() => mutations.get(`runtime-assets:${operation}`)?.({}, 'tunnel-client', true))
      ).rejects.toThrow(/not supported for tunnel-client/)
      expect(Object.values(mocks.updates).some((fn) => fn.mock.calls.length > 0)).toBe(false)
    }
  )

  it('validates the automatic preference as a boolean', async () => {
    await expect(
      Promise.resolve().then(() => mutations.get('runtime-assets:set-auto-update')?.({}, 'codex-runtime', 'yes'))
    ).rejects.toThrow('Expected a boolean')
    await mutations.get('runtime-assets:set-auto-update')?.({}, 'codex-runtime', true)
    expect(mocks.updates.setAutomatic).toHaveBeenCalledWith(true)
  })

  it('cancels Codex updates together with installs and prunes metadata on removal', async () => {
    await expect(mutations.get('runtime-assets:cancel')?.({}, 'codex-runtime')).resolves.toBe(true)
    expect(mocks.updates.cancel).toHaveBeenCalled()
    await mutations.get('runtime-assets:remove')?.({}, 'codex-runtime')
    expect(mocks.updates.prune).toHaveBeenCalled()
    await mutations.get('runtime-assets:cancel')?.({}, 'tunnel-client')
    expect(mocks.updates.cancel).toHaveBeenCalledTimes(1)
  })

  it('wires internal service progress through the central renderer emitter', async () => {
    expect(mocks.setEmitter).toHaveBeenCalledWith(expect.any(Function))
    const progress = {
      id: 'tunnel-client' as const,
      displayName: 'tunnel-client',
      requiredBy: 'test',
      availableVersion: '1',
      downloadBytes: 1,
      unpackedBytes: 1,
      status: { id: 'tunnel-client' as const, state: 'downloading' as const, diskUsageBytes: 0 },
    }
    mocks.changedEmitter()?.(progress)
    expect(emitChanged).toHaveBeenCalledWith(progress)
    expect(mocks.progressInfo).not.toHaveBeenCalled()
  })
})
