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
      cancel: vi.fn(() => true),
    },
  }
})

vi.mock('../../src/main/runtime-assets/app-service', () => ({
  runtimeAssetInfo: mocks.info,
  runtimeAssetService: () => mocks.service,
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

  it.each(['status', 'install', 'cancel', 'repair', 'remove'])('rejects unknown IDs for %s', async (operation) => {
    const handlers = operation === 'status' ? reads : mutations
    await expect(
      Promise.resolve().then(() => handlers.get(`runtime-assets:${operation}`)?.({}, 'not-a-runtime'))
    ).rejects.toThrow('Unknown runtime asset id')
  })

  it('runs explicit mutations and emits the resulting renderer-safe status', async () => {
    await expect(mutations.get('runtime-assets:install')?.({}, 'tunnel-client')).resolves.toMatchObject({
      id: 'tunnel-client',
      status: { state: 'ready' },
    })
    expect(mocks.service.install).toHaveBeenCalledWith('tunnel-client')
    expect(emitChanged).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'tunnel-client' }))
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
