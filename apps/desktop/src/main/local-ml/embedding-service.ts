import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, utilityProcess, type UtilityProcess } from 'electron'
import { WORKER_IDLE_TTL_MS } from '../../shared/memory-policy'
import type { RuntimeAssetLease } from '../../shared/runtime-assets'
import { registerOwnedProcess, unregisterOwnedProcess } from '../performance/owned-processes'
import { registerReclaimable, touchReclaimable, unregisterReclaimable } from '../performance/memory-reclaimer'
import { acquireRuntimeAssetLease, ensureRuntimeAsset, readyRuntimeAsset } from '../runtime-assets/app-service'

export interface EmbedTextsOptions {
  install?: boolean
  signal?: AbortSignal
  retry?: boolean | number
}

export interface EmbeddingModelInfo {
  id: 'Xenova/all-MiniLM-L6-v2'
  dimensions: 384
  normalized: true
  runtime: 'utility-process'
}

let worker: UtilityProcess | null = null
let workerLease: RuntimeAssetLease | null = null
let workerFlight: Promise<UtilityProcess | null> | null = null
let workerInstallController: AbortController | null = null
let workerFlightAllowsInstall = false
let sequence = 0
let workerGeneration = 0
let stopGeneration = 0
let idleSince = Date.now()
const intentionalStops = new WeakSet<UtilityProcess>()
const pending = new Map<
  string,
  {
    resolve: (value: number[][] | null) => void
    timer: ReturnType<typeof setTimeout>
    generation: number
    removeAbort?: () => void
  }
>()
const writeFlights = new Set<Promise<unknown>>()

const RECLAIM_KEY = 'embeddings-worker'

function isBusy(): boolean {
  return pending.size > 0 || writeFlights.size > 0
}

function registerWorkerLifecycle(): void {
  registerReclaimable({
    key: RECLAIM_KEY,
    kind: 'worker',
    lastActiveAt: () => (isBusy() ? Date.now() : idleSince),
    coldTtlMs: WORKER_IDLE_TTL_MS,
    priority: 12,
    protection: () => {
      const reasons = [...(pending.size > 0 ? ['pending'] : []), ...(writeFlights.size > 0 ? ['in-flight'] : [])]
      return { protected: reasons.length > 0, reasons }
    },
    prepare: async () => ({ ok: !isBusy() }),
    evict: () => stopEmbeddingWorker(),
  })
}

function markIdle(): void {
  if (isBusy()) return
  idleSince = Date.now()
  touchReclaimable(RECLAIM_KEY)
}

function settle(id: string, value: number[][] | null, generation?: number, rearmIdle = true): void {
  const operation = pending.get(id)
  if (!operation || (generation != null && operation.generation !== generation)) return
  clearTimeout(operation.timer)
  operation.removeAbort?.()
  pending.delete(id)
  operation.resolve(value)
  if (rearmIdle) markIdle()
}

async function ensureWorker(install: boolean): Promise<UtilityProcess | null> {
  if (worker) return worker
  if (workerFlight) {
    const canInstall = workerFlightAllowsInstall
    const existing = await workerFlight
    if (existing || !install || canInstall) return existing
    return ensureWorker(true)
  }
  const generation = stopGeneration
  const controller = new AbortController()
  workerInstallController = controller
  workerFlightAllowsInstall = install
  workerFlight = startWorker(install, generation, controller.signal).finally(() => {
    if (workerInstallController === controller) workerInstallController = null
    workerFlight = null
    workerFlightAllowsInstall = false
  })
  return workerFlight
}

async function startWorker(
  install: boolean,
  generationAtStart: number,
  signal: AbortSignal
): Promise<UtilityProcess | null> {
  let lease: RuntimeAssetLease | null = null
  try {
    if (install) await ensureRuntimeAsset('local-ml-runtime', signal)
    else await readyRuntimeAsset('local-ml-runtime')
    lease = await acquireRuntimeAssetLease('local-ml-runtime')
    if (generationAtStart !== stopGeneration) {
      lease.release()
      return null
    }
    const workerPath = path.join(app.getAppPath(), 'out', 'main', 'ml-worker.js')
    const process = utilityProcess.fork(workerPath, [], { serviceName: 'ml-embeddings', stdio: 'pipe' })
    const generation = ++workerGeneration
    process.stdout?.on('data', (data) => console.log('[ml-worker]', String(data).trim()))
    process.stderr?.on('data', (data) => console.error('[ml-worker]', String(data).trim()))
    process.on('message', (message: { type?: string; id?: string; vecs?: number[][]; error?: string }) => {
      if (worker !== process || workerGeneration !== generation) return
      if (message.type === 'embed:result' && message.id) settle(message.id, message.vecs ?? null, generation)
      else if (message.type === 'embed:error' && message.id) {
        console.error('[embeddings] worker error:', message.error)
        settle(message.id, null, generation)
      }
    })
    process.on('exit', (code) => {
      const intentional = intentionalStops.delete(process)
      if (!intentional && code !== 0) console.error('[ml] Worker exited unexpectedly', { exitCode: code })
      if (worker !== process || workerGeneration !== generation) return
      worker = null
      if (workerLease === lease) {
        workerLease = null
        lease!.release()
      }
      unregisterOwnedProcess('embeddings')
      unregisterReclaimable(RECLAIM_KEY)
      for (const id of [...pending.keys()]) settle(id, null, generation)
    })
    process.postMessage({
      type: 'init',
      cacheDir: path.join(app.getPath('userData'), 'transformers-cache'),
      moduleUrl: pathToFileURL(path.join(lease.path, 'runtime.mjs')).href,
    })
    worker = process
    workerLease = lease
    idleSince = Date.now()
    registerWorkerLifecycle()
    registerOwnedProcess({
      key: 'embeddings',
      kind: 'embeddings',
      pid: () => worker?.pid ?? null,
      state: () => (isBusy() ? 'busy' : 'idle'),
      extra: () => ({ pending: pending.size, inFlight: writeFlights.size }),
    })
    return process
  } catch (error) {
    lease?.release()
    if (!signal.aborted) {
      console.error('[embeddings] worker unavailable:', error instanceof Error ? error.message : error)
    }
    return null
  }
}

async function embedOnce(texts: string[], options: EmbedTextsOptions): Promise<number[][] | null> {
  if (texts.length === 0) return []
  if (options.signal?.aborted) return null
  const process = await ensureWorker(options.install === true)
  if (!process || options.signal?.aborted) return null
  const generation = workerGeneration
  const id = String(++sequence)
  return new Promise((resolve) => {
    const timer = setTimeout(() => settle(id, null, generation), 5 * 60_000)
    const operation: typeof pending extends Map<string, infer V> ? V : never = { resolve, timer, generation }
    if (options.signal) {
      const abort = () => settle(id, null, generation)
      options.signal.addEventListener('abort', abort, { once: true })
      operation.removeAbort = () => options.signal?.removeEventListener('abort', abort)
    }
    pending.set(id, operation)
    try {
      process.postMessage({ type: 'embed', id, texts })
    } catch (error) {
      console.error('[embeddings] postMessage failed:', error instanceof Error ? error.message : error)
      settle(id, null, generation)
    }
  })
}

const delay = (milliseconds: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const timer = setTimeout(resolve, milliseconds)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true }
    )
  })

export async function embedTexts(texts: string[], options: EmbedTextsOptions = {}): Promise<number[][] | null> {
  const retryCount = options.retry === true ? 3 : typeof options.retry === 'number' ? Math.max(0, options.retry) : 0
  const generation = stopGeneration
  let result = await embedOnce(texts, options)
  const backoff = [400, 1_200, 3_000]
  for (let attempt = 0; result === null && attempt < retryCount; attempt += 1) {
    if (options.signal?.aborted || generation !== stopGeneration) return null
    await delay(backoff[Math.min(attempt, backoff.length - 1)]!, options.signal)
    if (options.signal?.aborted || generation !== stopGeneration) return null
    result = await embedOnce(texts, options)
  }
  return result
}

export function getEmbeddingModelInfo(): EmbeddingModelInfo {
  return { id: 'Xenova/all-MiniLM-L6-v2', dimensions: 384, normalized: true, runtime: 'utility-process' }
}

export function trackEmbeddingWrite<T>(operation: Promise<T>): Promise<T> {
  writeFlights.add(operation)
  void operation.finally(() => {
    writeFlights.delete(operation)
    markIdle()
  })
  return operation
}

export function hasPendingEmbeddingWrites(): boolean {
  return writeFlights.size > 0 || pending.size > 0
}

export async function flushPendingEmbeddingWrites(timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (hasPendingEmbeddingWrites()) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) return false
    const flights = [...writeFlights]
    if (flights.length === 0) {
      await delay(Math.min(25, remaining))
      continue
    }
    let timedOut = false
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      Promise.allSettled(flights),
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          timedOut = true
          resolve()
        }, remaining)
      }),
    ])
    if (timer) clearTimeout(timer)
    if (timedOut) return false
  }
  return true
}

export function stopEmbeddingWorker(): void {
  const process = worker
  stopGeneration += 1
  workerInstallController?.abort(new Error('embedding worker startup cancelled'))
  workerInstallController = null
  if (process) intentionalStops.add(process)
  worker = null
  workerLease?.release()
  workerLease = null
  unregisterOwnedProcess('embeddings')
  unregisterReclaimable(RECLAIM_KEY)
  for (const id of [...pending.keys()]) settle(id, null, undefined, false)
  try {
    process?.kill()
  } catch {
    // worker already exited
  }
}

/** Packaged smoke check through the same utilityProcess contract without downloading a model. */
export async function runMlWorkerNativeSmoke(runtimePath: string): Promise<{ onnxValue: number; sharpBytes: number }> {
  const workerPath = path.join(app.getAppPath(), 'out', 'main', 'ml-worker.js')
  const moduleUrl = pathToFileURL(path.join(path.resolve(runtimePath), 'runtime.mjs')).href
  const process = utilityProcess.fork(workerPath, [], { serviceName: 'packaged-local-ml-smoke', stdio: 'pipe' })
  return new Promise((resolve, reject) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (error?: Error, result?: { onnxValue: number; sharpBytes: number }) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      try {
        process.kill()
      } catch {
        // already exited
      }
      if (error) reject(error)
      else resolve(result!)
    }
    timer = setTimeout(() => finish(new Error('Timed out waiting for packaged local-ML utilityProcess smoke')), 120_000)
    process.on('message', (message: { type?: string; error?: string; onnxValue?: number; sharpBytes?: number }) => {
      if (message.type === 'ready') process.postMessage({ type: 'smoke' })
      else if (message.type === 'smoke:result') {
        if (typeof message.onnxValue !== 'number' || typeof message.sharpBytes !== 'number') {
          finish(new Error('Packaged local-ML smoke returned an incomplete native result'))
        } else finish(undefined, { onnxValue: message.onnxValue, sharpBytes: message.sharpBytes })
      } else if (message.type === 'smoke:error') finish(new Error(message.error ?? 'Packaged local-ML smoke failed'))
    })
    process.on('exit', (code) => {
      if (!settled) finish(new Error(`Packaged local-ML utilityProcess exited before smoke completion (code ${code})`))
    })
    process.postMessage({ type: 'init', cacheDir: '', moduleUrl })
  })
}
