import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
  class FakeWorker {
    pid: number
    stdout = { on: vi.fn() }
    stderr = { on: vi.fn() }
    postMessage = vi.fn()
    kill = vi.fn()
    private listeners = new Map<string, Array<(...args: never[]) => void>>()

    constructor(pid: number) {
      this.pid = pid
    }

    on(event: string, listener: (...args: never[]) => void): this {
      const listeners = this.listeners.get(event) ?? []
      listeners.push(listener)
      this.listeners.set(event, listeners)
      return this
    }

    emit(event: string, ...args: unknown[]): void {
      for (const listener of this.listeners.get(event) ?? []) listener(...(args as never[]))
    }
  }

  const workers: FakeWorker[] = []
  return {
    FakeWorker,
    workers,
    fork: vi.fn(() => {
      const worker = new FakeWorker(workers.length + 100)
      workers.push(worker)
      return worker
    }),
    ensureRuntimeAsset: vi.fn(async () => ({ state: 'ready', path: '/runtime' })),
    readyRuntimeAsset: vi.fn(async (id: string) => ({ state: 'ready', path: `/${id}` })),
    acquireRuntimeAssetLease: vi.fn(async (id: string) => ({
      id,
      path: `/${id}`,
      release: vi.fn(),
    })),
    registerOwnedProcess: vi.fn(),
    unregisterOwnedProcess: vi.fn(),
  }
})

vi.mock('electron', () => ({
  app: { getAppPath: () => '/app' },
  utilityProcess: { fork: h.fork },
}))

vi.mock('../../src/main/performance/owned-processes', () => ({
  registerOwnedProcess: h.registerOwnedProcess,
  unregisterOwnedProcess: h.unregisterOwnedProcess,
}))

vi.mock('../../src/main/runtime-assets/app-service', () => ({
  ensureRuntimeAsset: h.ensureRuntimeAsset,
  readyRuntimeAsset: h.readyRuntimeAsset,
  acquireRuntimeAssetLease: h.acquireRuntimeAssetLease,
}))

import { startWakeWorker, wakeAssetsReady } from '../../src/main/wake-worker-host'

describe('wake worker host', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.workers.length = 0
    h.readyRuntimeAsset.mockImplementation(async (id: string) => ({ state: 'ready', path: `/${id}` }))
  })

  it('reports wakeAssetsReady true only when both local-ml-runtime and wake-model are ready', async () => {
    await expect(wakeAssetsReady()).resolves.toBe(true)

    h.readyRuntimeAsset.mockImplementation(async (id: string) => {
      if (id === 'local-ml-runtime') throw new Error('missing runtime')
      return { state: 'ready', path: `/${id}` }
    })
    await expect(wakeAssetsReady()).resolves.toBe(false)

    h.readyRuntimeAsset.mockImplementation(async (id: string) => {
      if (id === 'wake-model') throw new Error('missing model')
      return { state: 'ready', path: `/${id}` }
    })
    await expect(wakeAssetsReady()).resolves.toBe(false)
  })

  it('never calls ensureRuntimeAsset when starting the wake worker', async () => {
    h.readyRuntimeAsset.mockImplementation(async (id: string) => {
      if (id === 'local-ml-runtime') throw new Error('missing runtime')
      return { state: 'ready', path: `/${id}` }
    })
    await expect(startWakeWorker(vi.fn())).resolves.toBeNull()
    expect(h.ensureRuntimeAsset).not.toHaveBeenCalled()
    expect(h.fork).not.toHaveBeenCalled()

    h.readyRuntimeAsset.mockImplementation(async (id: string) => ({ state: 'ready', path: `/${id}` }))
    const worker = await startWakeWorker(vi.fn())
    expect(worker).not.toBeNull()
    expect(h.ensureRuntimeAsset).not.toHaveBeenCalled()
    expect(h.readyRuntimeAsset).toHaveBeenCalledWith('local-ml-runtime')
    expect(h.readyRuntimeAsset).toHaveBeenCalledWith('wake-model')
    worker?.stop()
  })
})
