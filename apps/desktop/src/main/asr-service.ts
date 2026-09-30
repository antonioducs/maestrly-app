/**
 * Local voice dictation through asr-worker, which runs whisper.cpp outside main. The engine comes from the
 * local-ml-runtime asset and the speech model from the separate whisper-model asset; this service never
 * downloads the model, so dictation reports `modelMissing` until the user installs it. Startup/response
 * failures return null text so Chat remains usable.
 */
import { app, utilityProcess, type UtilityProcess } from 'electron'
import { rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { registerOwnedProcess, unregisterOwnedProcess } from './performance/owned-processes'
import { registerReclaimable, touchReclaimable, unregisterReclaimable } from './performance/memory-reclaimer'
import { WORKER_IDLE_TTL_MS } from '../shared/memory-policy'
import { asrSupport, type AsrLanguage, type AsrSupport } from '../shared/asr'
import { acquireRuntimeAssetLease, ensureRuntimeAsset, readyRuntimeAsset } from './runtime-assets/app-service'
import { RUNTIME_ASSET_REGISTRY, WHISPER_MODEL_FILE, hostRuntimeTarget } from './runtime-assets/registry'
import type { RuntimeAssetLease } from '../shared/runtime-assets'

let worker: UtilityProcess | null = null
let workerLease: RuntimeAssetLease | null = null
let workerModelLease: RuntimeAssetLease | null = null
let workerFlight: Promise<UtilityProcess | null> | null = null
let workerInstallController: AbortController | null = null
let stopGeneration = 0
let seq = 0
let workerGeneration = 0
let legacyCacheRemoved = false
/** Start of the current idle interval, used as reclaimable lastActiveAt when no work is pending. */
let idleSince = Date.now()
const intentionalStops = new WeakSet<UtilityProcess>()
export interface TranscribeResult {
  text: string | null // null means unavailable or failed
  silent: boolean // silent audio from missing permission or no speech
  modelMissing?: boolean // the whisper-model asset is not installed
}
const pending = new Map<
  string,
  { resolve: (r: TranscribeResult) => void; timer: ReturnType<typeof setTimeout>; generation: number }
>()
/** Models are local, so a request only waits for inference; a stuck worker must not hold the UI for long. */
const REQUEST_TIMEOUT_MS = 60_000

/**
 * Use the shared reclaimer schedule: normal TTL stops idle Whisper, while hard/manual reclamation can
 * release it immediately. In-flight requests protect it; prepare permits only idle eviction and evict
 * calls stopAsrWorker.
 */
const ASR_RECLAIM_KEY = 'asr-worker'
const ASR_RECLAIM_PRIORITY = 12

function registerAsrReclaimable(): void {
  registerReclaimable({
    key: ASR_RECLAIM_KEY,
    kind: 'worker',
    lastActiveAt: () => (pending.size > 0 ? Date.now() : idleSince),
    coldTtlMs: WORKER_IDLE_TTL_MS,
    priority: ASR_RECLAIM_PRIORITY,
    protection: () =>
      pending.size > 0 ? { protected: true, reasons: ['pending'] } : { protected: false, reasons: [] },
    prepare: async () => ({ ok: pending.size === 0 }),
    evict: () => stopAsrWorker(),
  })
}

function settle(id: string, r: TranscribeResult, generation?: number, rearmIdle = true): void {
  const p = pending.get(id)
  if (!p || (generation != null && p.generation !== generation)) return
  clearTimeout(p.timer)
  pending.delete(id)
  p.resolve(r)
  // Reclaimable TTL starts when work drains into idle, not at the previous activity timestamp.
  if (rearmIdle && pending.size === 0) {
    idleSince = Date.now()
    // An updated idle epoch changes the deadline; reschedule the reclaimer immediately.
    touchReclaimable(ASR_RECLAIM_KEY)
  }
}

function releaseWorkerLeases(): void {
  workerLease?.release()
  workerLease = null
  workerModelLease?.release()
  workerModelLease = null
}

/** Read-only: the voice model is installed only by an explicit user action. */
async function modelReady(): Promise<boolean> {
  try {
    await readyRuntimeAsset('whisper-model')
    return true
  } catch {
    return false
  }
}

async function ensureWorker(): Promise<UtilityProcess | null> {
  if (worker) return worker
  if (workerFlight) return workerFlight
  const generationAtStart = stopGeneration
  const installController = new AbortController()
  workerInstallController = installController
  workerFlight = startWorker(generationAtStart, installController.signal).finally(() => {
    if (workerInstallController === installController) workerInstallController = null
    workerFlight = null
  })
  return workerFlight
}

/** The Transformers.js whisper-base cache from the previous engine is never read again. */
function removeLegacyModelCache(): void {
  if (legacyCacheRemoved) return
  legacyCacheRemoved = true
  void rm(path.join(app.getPath('userData'), 'transformers-cache', 'Xenova', 'whisper-base'), {
    recursive: true,
    force: true,
  }).catch(() => {})
}

async function startWorker(generationAtStart: number, signal: AbortSignal): Promise<UtilityProcess | null> {
  let lease: RuntimeAssetLease | null = null
  let modelLease: RuntimeAssetLease | null = null
  try {
    removeLegacyModelCache()
    await ensureRuntimeAsset('local-ml-runtime', signal)
    const model = await readyRuntimeAsset('whisper-model')
    lease = await acquireRuntimeAssetLease('local-ml-runtime')
    modelLease = await acquireRuntimeAssetLease('whisper-model', model.path)
    if (generationAtStart !== stopGeneration) {
      lease.release()
      modelLease.release()
      return null
    }
    const workerPath = path.join(app.getAppPath(), 'out', 'main', 'asr-worker.js')
    const w = utilityProcess.fork(workerPath, [], { serviceName: 'whisper-asr', stdio: 'pipe' })
    const generation = ++workerGeneration
    const ownLease = lease
    const ownModelLease = modelLease
    w.stdout?.on('data', (d) => console.log('[asr-worker]', String(d).trim()))
    w.stderr?.on('data', (d) => console.error('[asr-worker]', String(d).trim()))
    w.on('message', (msg: { type?: string; id?: string; text?: string; silent?: boolean; error?: string }) => {
      if (worker !== w || workerGeneration !== generation) return
      if (msg?.type === 'transcribe:result' && msg.id)
        settle(msg.id, { text: msg.text ?? '', silent: !!msg.silent }, generation)
      else if (msg?.type === 'transcribe:error' && msg.id) {
        console.error('[asr] worker error:', msg.error)
        settle(msg.id, { text: null, silent: false }, generation)
      }
    })
    w.on('exit', (code) => {
      if (code !== 0) console.error('[asr] asr-worker exited with code', code)
      const intentional = intentionalStops.delete(w)
      if (!intentional && code !== 0) console.error('[asr] Worker exited unexpectedly', { exitCode: code })
      if (worker !== w || workerGeneration !== generation) return
      worker = null
      if (workerLease === ownLease && workerModelLease === ownModelLease) releaseWorkerLeases()
      unregisterOwnedProcess('asr')
      unregisterReclaimable(ASR_RECLAIM_KEY)
      for (const id of [...pending.keys()]) settle(id, { text: null, silent: false }, generation) // release waiters
    })
    w.postMessage({
      type: 'init',
      moduleUrl: pathToFileURL(path.join(lease.path, 'runtime.mjs')).href,
      modelPath: path.join(modelLease.path, WHISPER_MODEL_FILE),
      // Metal on Apple silicon; the Windows and Linux addons are CPU builds.
      useGpu: process.platform === 'darwin',
    })
    worker = w
    workerLease = lease
    workerModelLease = modelLease
    idleSince = Date.now()
    registerAsrReclaimable()
    registerOwnedProcess({
      key: 'asr',
      kind: 'asr',
      pid: () => worker?.pid ?? null,
      state: () => (pending.size > 0 ? 'busy' : worker ? 'idle' : 'idle'),
      extra: () => ({ pending: pending.size }),
    })
    return w
  } catch (e) {
    lease?.release()
    modelLease?.release()
    if (!signal.aborted) {
      console.error('[asr] could not start asr-worker; transcription disabled:', (e as Error)?.message ?? e)
    }
    return null
  }
}

function request(w: UtilityProcess, message: Record<string, unknown>): Promise<TranscribeResult> {
  const generation = workerGeneration
  const id = String(++seq)
  return new Promise<TranscribeResult>((resolve) => {
    // The exit handler also resolves pending work.
    const timer = setTimeout(() => settle(id, { text: null, silent: false }, generation), REQUEST_TIMEOUT_MS)
    pending.set(id, { resolve, timer, generation })
    try {
      w.postMessage({ ...message, id })
    } catch (e) {
      console.error('[asr] failed to send to asr-worker:', (e as Error)?.message ?? e)
      settle(id, { text: null, silent: false })
    }
  })
}

/** Transcribe mono 16 kHz Float32 PCM to text/silent; null text means unavailable or failed. */
export async function transcribe(
  audio: Float32Array,
  options: { language?: AsrLanguage } = {}
): Promise<TranscribeResult> {
  if (!(audio instanceof Float32Array) || audio.length === 0) return { text: null, silent: false }
  if (!(await modelReady())) return { text: null, silent: false, modelMissing: true }
  const w = await ensureWorker()
  if (!w) return { text: null, silent: false }
  return request(w, { type: 'transcribe', audio, language: options.language ?? 'auto' })
}

/**
 * Start the worker and load both models ahead of a dictation. The first load on macOS also compiles the
 * Metal shaders, which takes seconds once. Resolves false when the model is missing or the worker failed.
 */
export async function warmAsr(): Promise<boolean> {
  if (!(await modelReady())) return false
  const w = await ensureWorker()
  if (!w) return false
  return (await request(w, { type: 'warm' })).text !== null
}

/** Whether this host can run dictation, decided before anything is downloaded. */
export function currentAsrSupport(): AsrSupport {
  let hasRuntimeTarget = false
  try {
    hasRuntimeTarget = !!RUNTIME_ASSET_REGISTRY['local-ml-runtime'].targets[hostRuntimeTarget()]
  } catch {
    // Unsupported OS or architecture.
  }
  return asrSupport({ hasRuntimeTarget, platform: process.platform, osRelease: os.release() })
}

/** Stop the transcription utilityProcess during shutdown or reclaimer eviction. */
export function stopAsrWorker(): void {
  const w = worker
  stopGeneration++
  workerInstallController?.abort(new Error('ASR worker startup cancelled'))
  workerInstallController = null
  if (w) intentionalStops.add(w)
  worker = null
  releaseWorkerLeases()
  unregisterOwnedProcess('asr')
  unregisterReclaimable(ASR_RECLAIM_KEY)
  for (const id of [...pending.keys()]) settle(id, { text: null, silent: false }, undefined, false)
  if (w) {
    try {
      w.kill()
    } catch {
      /* Already terminated. */
    }
  }
}
