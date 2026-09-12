import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WORKER_IDLE_TTL_MS } from '../../src/shared/memory-policy'

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
  const releaseRuntimeLease = vi.fn()
  return {
    FakeWorker,
    workers,
    fork: vi.fn(() => {
      const worker = new FakeWorker(workers.length + 100)
      workers.push(worker)
      return worker
    }),
    ensureRuntimeAsset: vi.fn<
      (_id: string, _signal?: AbortSignal) => Promise<{ state: string; path: string }>
    >(async () => ({ state: 'ready', path: '/runtime' })),
    readyRuntimeAsset: vi.fn(async () => ({ state: 'ready', path: '/runtime' })),
    releaseRuntimeLease,
    acquireRuntimeAssetLease: vi.fn(async () => ({
      id: 'local-ml-runtime',
      path: '/runtime',
      release: releaseRuntimeLease,
    })),
  }
})

vi.mock('electron', () => ({
  app: {
    getAppPath: () => '/app',
    getPath: () => '/user-data',
  },
  utilityProcess: { fork: h.fork },
}))

vi.mock('../../src/main/crash-reporter', () => ({ captureProcessExit: vi.fn() }))
vi.mock('../../src/main/performance/owned-processes', () => ({
  registerOwnedProcess: vi.fn(),
  unregisterOwnedProcess: vi.fn(),
}))
vi.mock('../../src/main/runtime-assets/app-service', () => ({
  ensureRuntimeAsset: h.ensureRuntimeAsset,
  readyRuntimeAsset: h.readyRuntimeAsset,
  acquireRuntimeAssetLease: h.acquireRuntimeAssetLease,
}))

import { stopAsrWorker, transcribe } from '../../src/main/asr-service'
import {
  embedTexts,
  stopEmbeddingWorker,
  trackEmbeddingWrite,
} from '../../src/main/local-ml/embedding-service'
import { getMemoryReclaimerSnapshot, runMemoryReclaim } from '../../src/main/performance/memory-reclaimer'

function latestWorker(): InstanceType<typeof h.FakeWorker> {
  const worker = h.workers.at(-1)
  if (!worker) throw new Error('worker not started')
  return worker
}

async function latestWorkerAsync(): Promise<InstanceType<typeof h.FakeWorker>> {
  for (let i = 0; i < 8 && h.workers.length === 0; i++) await Promise.resolve()
  const worker = latestWorker()
  for (let i = 0; i < 8 && !worker.postMessage.mock.calls.some(([message]) => message?.id); i++) await Promise.resolve()
  return worker
}

async function requestAsync(worker: InstanceType<typeof h.FakeWorker>, type: string): Promise<{ id: string }> {
  for (let i = 0; i < 4; i++) await Promise.resolve()
  for (let i = 0; i < 8; i++) {
    try {
      return worker.request(type)
    } catch {
      await Promise.resolve()
    }
  }
  return worker.request(type)
}

async function workerAfter(
  previous: InstanceType<typeof h.FakeWorker>
): Promise<InstanceType<typeof h.FakeWorker>> {
  for (let i = 0; i < 12 && latestWorker() === previous; i++) await Promise.resolve()
  return latestWorker()
}

describe('bounded idle stop for local workers', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    h.workers.length = 0
    h.ensureRuntimeAsset.mockResolvedValue({ state: 'ready', path: '/runtime' })
    h.readyRuntimeAsset.mockResolvedValue({ state: 'ready', path: '/runtime' })
  })

  afterEach(() => {
    stopAsrWorker()
    stopEmbeddingWorker()
    vi.useRealTimers()
  })

  it('ASR starts the TTL after the operation and exits when it expires', async () => {
    const result = transcribe(new Float32Array([0.1]))
    const worker = await latestWorkerAsync()
    expect(h.ensureRuntimeAsset).toHaveBeenCalledWith('local-ml-runtime', expect.any(AbortSignal))
    expect(h.acquireRuntimeAssetLease).toHaveBeenCalledWith('local-ml-runtime')
    expect(worker.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'init', moduleUrl: pathToFileURL('/runtime/runtime.mjs').href })
    )

    await vi.advanceTimersByTimeAsync(WORKER_IDLE_TTL_MS)
    expect(worker.kill).not.toHaveBeenCalled()
    await expect(result).resolves.toEqual({ text: null, silent: false })

    await vi.advanceTimersByTimeAsync(WORKER_IDLE_TTL_MS)
    expect(worker.kill).toHaveBeenCalledTimes(1)
  })

  it('ASR rearms on use, restarts, and ignores stale callbacks', async () => {
    const first = transcribe(new Float32Array([0.1]))
    const oldWorker = await latestWorkerAsync()
    oldWorker.emit('message', {
      type: 'transcribe:result',
      id: (await requestAsync(oldWorker, 'transcribe')).id,
      text: 'one',
    })
    await expect(first).resolves.toEqual({ text: 'one', silent: false })

    await vi.advanceTimersByTimeAsync(WORKER_IDLE_TTL_MS - 1)
    const second = transcribe(new Float32Array([0.2]))
    oldWorker.emit('message', {
      type: 'transcribe:result',
      id: (await requestAsync(oldWorker, 'transcribe')).id,
      text: 'two',
    })
    await expect(second).resolves.toEqual({ text: 'two', silent: false })
    await vi.advanceTimersByTimeAsync(1)
    expect(oldWorker.kill).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(WORKER_IDLE_TTL_MS - 1)
    expect(oldWorker.kill).toHaveBeenCalledTimes(1)

    const restarted = transcribe(new Float32Array([0.3]))
    const newWorker = await workerAfter(oldWorker)
    expect(newWorker).not.toBe(oldWorker)
    oldWorker.emit('message', {
      type: 'transcribe:result',
      id: (await requestAsync(newWorker, 'transcribe')).id,
      text: 'stale',
    })
    oldWorker.emit('exit', 0)
    newWorker.emit('message', {
      type: 'transcribe:result',
      id: (await requestAsync(newWorker, 'transcribe')).id,
      text: 'fresh',
    })
    await expect(restarted).resolves.toEqual({ text: 'fresh', silent: false })
  })

  it('ASR reschedules on drain so the old deadline does not sweep and the fresh TTL runs in full', async () => {
    const first = transcribe(new Float32Array([0.1]))
    const worker = await latestWorkerAsync()
    worker.emit('message', {
      type: 'transcribe:result',
      id: (await requestAsync(worker, 'transcribe')).id,
      text: 'one',
    })
    await expect(first).resolves.toEqual({ text: 'one', silent: false })

    await vi.advanceTimersByTimeAsync(WORKER_IDLE_TTL_MS - 60_000)
    const second = transcribe(new Float32Array([0.2]))
    worker.emit('message', {
      type: 'transcribe:result',
      id: (await requestAsync(worker, 'transcribe')).id,
      text: 'two',
    })
    await expect(second).resolves.toEqual({ text: 'two', silent: false })

    const sweepBefore = getMemoryReclaimerSnapshot().lastSweepAt
    await vi.advanceTimersByTimeAsync(60_000)
    expect(worker.kill).not.toHaveBeenCalled()
    expect(getMemoryReclaimerSnapshot().lastSweepAt).toBe(sweepBefore)

    await vi.advanceTimersByTimeAsync(WORKER_IDLE_TTL_MS)
    expect(worker.kill).toHaveBeenCalledTimes(1)
  })

  it('ASR shutdown resolves pending work and clears the idle timer', async () => {
    const pending = transcribe(new Float32Array([0.1]))
    const worker = await latestWorkerAsync()
    stopAsrWorker()

    await expect(pending).resolves.toEqual({ text: null, silent: false })
    expect(worker.kill).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(WORKER_IDLE_TTL_MS * 2)
    expect(worker.kill).toHaveBeenCalledTimes(1)
  })

  it('embeddings stay alive while pending and arm the TTL on completion', async () => {
    const embedding = embedTexts(['hello'])
    const worker = await latestWorkerAsync()
    expect(h.readyRuntimeAsset).toHaveBeenCalledWith('local-ml-runtime')
    expect(h.ensureRuntimeAsset).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(WORKER_IDLE_TTL_MS - 1)
    expect(worker.kill).not.toHaveBeenCalled()

    worker.emit('message', { type: 'embed:result', id: (await requestAsync(worker, 'embed')).id, vecs: [[1]] })
    await expect(embedding).resolves.toEqual([[1]])
    await vi.advanceTimersByTimeAsync(WORKER_IDLE_TTL_MS)
    expect(worker.kill).toHaveBeenCalledTimes(1)
  })

  it('embeddings reschedule after pending work so the old deadline does not sweep', async () => {
    const first = embedTexts(['first'])
    const worker = await latestWorkerAsync()
    worker.emit('message', { type: 'embed:result', id: (await requestAsync(worker, 'embed')).id, vecs: [[1]] })
    await expect(first).resolves.toEqual([[1]])

    await vi.advanceTimersByTimeAsync(WORKER_IDLE_TTL_MS - 60_000)
    const second = embedTexts(['second'])
    worker.emit('message', { type: 'embed:result', id: (await requestAsync(worker, 'embed')).id, vecs: [[2]] })
    await expect(second).resolves.toEqual([[2]])

    const sweepBefore = getMemoryReclaimerSnapshot().lastSweepAt
    await vi.advanceTimersByTimeAsync(60_000)
    expect(worker.kill).not.toHaveBeenCalled()
    expect(getMemoryReclaimerSnapshot().lastSweepAt).toBe(sweepBefore)

    await vi.advanceTimersByTimeAsync(WORKER_IDLE_TTL_MS)
    expect(worker.kill).toHaveBeenCalledTimes(1)
  })

  it('embeddings restart transparently after idle stop', async () => {
    const first = embedTexts(['first'])
    const oldWorker = await latestWorkerAsync()
    oldWorker.emit('message', { type: 'embed:result', id: (await requestAsync(oldWorker, 'embed')).id, vecs: [[1]] })
    await expect(first).resolves.toEqual([[1]])
    await vi.advanceTimersByTimeAsync(WORKER_IDLE_TTL_MS)
    expect(oldWorker.kill).toHaveBeenCalledTimes(1)

    const second = embedTexts(['second'])
    const newWorker = await workerAfter(oldWorker)
    expect(newWorker).not.toBe(oldWorker)
    oldWorker.emit('exit', 0)
    newWorker.emit('message', { type: 'embed:result', id: (await requestAsync(newWorker, 'embed')).id, vecs: [[2]] })
    await expect(second).resolves.toEqual([[2]])
  })

  it('can install the runtime on demand after a read-only startup attempt finds nothing', async () => {
    h.readyRuntimeAsset.mockRejectedValueOnce(new Error('runtime not installed'))

    await expect(embedTexts(['without install'])).resolves.toBeNull()
    expect(h.fork).not.toHaveBeenCalled()

    const installed = embedTexts(['with install'], { install: true })
    const worker = await latestWorkerAsync()
    worker.emit('message', { type: 'embed:result', id: (await requestAsync(worker, 'embed')).id, vecs: [[1]] })

    await expect(installed).resolves.toEqual([[1]])
    expect(h.ensureRuntimeAsset).toHaveBeenCalledWith('local-ml-runtime', expect.any(AbortSignal))
  })

  it('embedding shutdown resolves pending work and prevents late idle stops', async () => {
    const pending = embedTexts(['pending'])
    const worker = await latestWorkerAsync()
    stopEmbeddingWorker()

    await expect(pending).resolves.toBeNull()
    expect(worker.kill).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(WORKER_IDLE_TTL_MS * 2)
    expect(worker.kill).toHaveBeenCalledTimes(1)
    expect(h.workers).toHaveLength(1)
  })

  it('embedding shutdown cancels in-flight installation and allows a later retry', async () => {
    let installStarted!: () => void
    const installationStarted = new Promise<void>((resolve) => {
      installStarted = resolve
    })
    h.ensureRuntimeAsset.mockImplementation(async (_id, signal?: AbortSignal) => {
      installStarted()
      await new Promise<void>((_resolve, reject) => {
        if (signal?.aborted) {
          reject(signal.reason)
          return
        }
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
      return { state: 'ready', path: '/runtime' }
    })

    const stopped = embedTexts(['during install'], { install: true })
    await installationStarted
    expect(h.ensureRuntimeAsset).toHaveBeenCalledWith('local-ml-runtime', expect.any(AbortSignal))

    stopEmbeddingWorker()
    await expect(stopped).resolves.toBeNull()
    expect(h.fork).not.toHaveBeenCalled()

    h.ensureRuntimeAsset.mockResolvedValue({ state: 'ready', path: '/runtime' })
    const retry = embedTexts(['after install'], { install: true })
    const worker = await latestWorkerAsync()
    worker.emit('message', { type: 'embed:result', id: (await requestAsync(worker, 'embed')).id, vecs: [[1]] })

    await expect(retry).resolves.toEqual([[1]])
    expect(h.ensureRuntimeAsset).toHaveBeenCalledTimes(2)
  })

  it('hard or manual reclaim immediately kills an idle ASR worker', async () => {
    const result = transcribe(new Float32Array([0.1]))
    const worker = await latestWorkerAsync()
    worker.emit('message', {
      type: 'transcribe:result',
      id: (await requestAsync(worker, 'transcribe')).id,
      text: 'one',
    })
    await expect(result).resolves.toEqual({ text: 'one', silent: false })

    const reclaim = await runMemoryReclaim('manual')
    expect(reclaim.evicted).toContain('asr-worker')
    expect(worker.kill).toHaveBeenCalledTimes(1)
  })

  it('pending ASR work is protected from manual reclaim', async () => {
    void transcribe(new Float32Array([0.1]))
    const worker = await latestWorkerAsync()

    const reclaim = await runMemoryReclaim('manual')
    expect(reclaim.evicted).not.toContain('asr-worker')
    expect(worker.kill).not.toHaveBeenCalled()
  })

  it('pending embedding work is protected from manual reclaim', async () => {
    const pending = embedTexts(['pending'])
    const worker = await latestWorkerAsync()

    const protectedReclaim = await runMemoryReclaim('manual')
    expect(protectedReclaim.evicted).not.toContain('embeddings-worker')
    expect(worker.kill).not.toHaveBeenCalled()

    worker.emit('message', { type: 'embed:result', id: (await requestAsync(worker, 'embed')).id, vecs: [[1]] })
    await expect(pending).resolves.toEqual([[1]])
  })

  it('tracked embedding writes protect an idle worker until persistence completes', async () => {
    const embedding = embedTexts(['seed'])
    const worker = await latestWorkerAsync()
    worker.emit('message', { type: 'embed:result', id: (await requestAsync(worker, 'embed')).id, vecs: [[1]] })
    await expect(embedding).resolves.toEqual([[1]])

    let finishWrite!: () => void
    const write = trackEmbeddingWrite(
      new Promise<void>((resolve) => {
        finishWrite = resolve
      })
    )
    const protectedReclaim = await runMemoryReclaim('manual')
    expect(protectedReclaim.evicted).not.toContain('embeddings-worker')
    expect(worker.kill).not.toHaveBeenCalled()

    finishWrite()
    await write
    await Promise.resolve()

    const reclaim = await runMemoryReclaim('manual')
    expect(reclaim.evicted).toContain('embeddings-worker')
    expect(worker.kill).toHaveBeenCalledTimes(1)
  })
})
