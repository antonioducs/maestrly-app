import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

    request(type: string): { id: string } {
      for (let i = this.postMessage.mock.calls.length - 1; i >= 0; i--) {
        const message = this.postMessage.mock.calls[i]?.[0]
        if (message?.type === type && message.id) return message as { id: string }
      }
      throw new Error(`request ${type} not found`)
    }
  }

  const workers: FakeWorker[] = []
  const leases = new Map<string, ReturnType<typeof vi.fn>>()
  return {
    FakeWorker,
    workers,
    leases,
    fork: vi.fn(() => {
      const worker = new FakeWorker(workers.length + 100)
      workers.push(worker)
      return worker
    }),
    ensureRuntimeAsset: vi.fn(async () => ({ state: 'ready', path: '/runtime' })),
    readyRuntimeAsset: vi.fn(async (id: string) => ({ state: 'ready', path: `/${id}` })),
    acquireRuntimeAssetLease: vi.fn(async (id: string) => {
      const release = vi.fn()
      leases.set(id, release)
      return { id, path: `/${id}`, release }
    }),
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

async function waitForWorker(previous?: InstanceType<typeof h.FakeWorker>): Promise<InstanceType<typeof h.FakeWorker>> {
  for (let i = 0; i < 12; i++) {
    const worker = h.workers.at(-1)
    if (worker && worker !== previous && worker.postMessage.mock.calls.some(([msg]) => msg?.type === 'warm')) {
      return worker
    }
    await Promise.resolve()
  }
  throw new Error('wake worker did not send warm')
}

describe('wake worker host', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.workers.length = 0
    h.leases.clear()
    h.readyRuntimeAsset.mockImplementation(async (id: string) => ({ state: 'ready', path: `/${id}` }))
  })

  afterEach(() => {
    vi.useRealTimers()
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
    const pending = startWakeWorker(vi.fn())
    const worker = await waitForWorker()
    worker.emit('message', { type: 'warm:done', id: worker.request('warm').id })
    const started = await pending
    expect(started).not.toBeNull()
    expect(h.ensureRuntimeAsset).not.toHaveBeenCalled()
    expect(h.readyRuntimeAsset).toHaveBeenCalledWith('local-ml-runtime')
    expect(h.readyRuntimeAsset).toHaveBeenCalledWith('wake-model')
    started?.stop()
  })

  it('posts init then warm and resolves only after warm:done', async () => {
    let resolved = false
    const pending = startWakeWorker(vi.fn()).then((w) => {
      resolved = true
      return w
    })
    const worker = await waitForWorker()
    expect(worker.postMessage.mock.calls.map(([msg]) => msg?.type)).toEqual(['init', 'warm'])
    await Promise.resolve()
    expect(resolved).toBe(false)

    worker.emit('message', { type: 'warm:done', id: worker.request('warm').id })
    const started = await pending
    expect(resolved).toBe(true)
    expect(started).not.toBeNull()
    started?.stop()
  })

  it('resolves null, kills the process and releases both leases on warm:error', async () => {
    const onExit = vi.fn()
    const pending = startWakeWorker(onExit)
    const worker = await waitForWorker()

    worker.emit('message', { type: 'warm:error', id: worker.request('warm').id, error: 'shader fail' })
    await expect(pending).resolves.toBeNull()
    expect(worker.kill).toHaveBeenCalledTimes(1)
    expect(h.leases.get('local-ml-runtime')).toHaveBeenCalledTimes(1)
    expect(h.leases.get('wake-model')).toHaveBeenCalledTimes(1)
    expect(h.unregisterOwnedProcess).toHaveBeenCalledWith('wake')
    worker.emit('exit', 1)
    expect(onExit).not.toHaveBeenCalled()
  })

  it('resolves null, kills the process and releases both leases when warm times out', async () => {
    vi.useFakeTimers()
    const pending = startWakeWorker(vi.fn())
    const worker = await waitForWorker()

    await vi.advanceTimersByTimeAsync(60_000)
    await expect(pending).resolves.toBeNull()
    expect(worker.kill).toHaveBeenCalledTimes(1)
    expect(h.leases.get('local-ml-runtime')).toHaveBeenCalledTimes(1)
    expect(h.leases.get('wake-model')).toHaveBeenCalledTimes(1)
  })

  it('keeps the newest worker registered when an earlier worker exits late', async () => {
    const pendingA = startWakeWorker(vi.fn())
    const fakeA = await waitForWorker()
    fakeA.emit('message', { type: 'warm:done', id: fakeA.request('warm').id })
    const workerA = await pendingA
    expect(workerA).not.toBeNull()
    workerA?.stop()

    const pendingB = startWakeWorker(vi.fn())
    const fakeB = await waitForWorker(fakeA)
    fakeB.emit('message', { type: 'warm:done', id: fakeB.request('warm').id })
    const workerB = await pendingB
    expect(workerB).not.toBeNull()
    expect(h.registerOwnedProcess).toHaveBeenCalledTimes(2)

    h.unregisterOwnedProcess.mockClear()
    fakeA.emit('exit', 0)
    expect(h.unregisterOwnedProcess).not.toHaveBeenCalled()

    workerB?.stop()
    expect(h.unregisterOwnedProcess).toHaveBeenCalledTimes(1)
    expect(h.unregisterOwnedProcess).toHaveBeenCalledWith('wake')
  })
})
