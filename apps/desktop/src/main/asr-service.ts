/**
 * Local Whisper transcription through asr-worker runs ONNX inference outside main. Startup/response
 * failures return null so Chat remains usable. The model downloads once into
 * userData/transformers-cache, shared with embeddings.
 */
import { app, utilityProcess, type UtilityProcess } from 'electron'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { registerOwnedProcess, unregisterOwnedProcess } from './performance/owned-processes'
import { registerReclaimable, touchReclaimable, unregisterReclaimable } from './performance/memory-reclaimer'
import { WORKER_IDLE_TTL_MS } from '../shared/memory-policy'
import { acquireRuntimeAssetLease, ensureRuntimeAsset } from './runtime-assets/app-service'
import type { RuntimeAssetLease } from '../shared/runtime-assets'

let worker: UtilityProcess | null = null
let workerLease: RuntimeAssetLease | null = null
let workerFlight: Promise<UtilityProcess | null> | null = null
let workerInstallController: AbortController | null = null
let stopGeneration = 0
let seq = 0
let workerGeneration = 0
/** Start of the current idle interval, used as reclaimable lastActiveAt when no work is pending. */
let idleSince = Date.now()
const intentionalStops = new WeakSet<UtilityProcess>()
export interface TranscribeResult {
  text: string | null // null means unavailable or failed
  silent: boolean // silent audio from missing permission or no speech
}
const pending = new Map<
  string,
  { resolve: (r: TranscribeResult) => void; timer: ReturnType<typeof setTimeout>; generation: number }
>()

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

async function startWorker(generationAtStart: number, signal: AbortSignal): Promise<UtilityProcess | null> {
  let lease: RuntimeAssetLease | null = null
  try {
    await ensureRuntimeAsset('local-ml-runtime', signal)
    lease = await acquireRuntimeAssetLease('local-ml-runtime')
    if (generationAtStart !== stopGeneration) {
      lease.release()
      return null
    }
    const workerPath = path.join(app.getAppPath(), 'out', 'main', 'asr-worker.js')
    const w = utilityProcess.fork(workerPath, [], { serviceName: 'whisper-asr', stdio: 'pipe' })
    const generation = ++workerGeneration
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
      if (workerLease === lease) {
        workerLease = null
        lease!.release()
      }
      unregisterOwnedProcess('asr')
      unregisterReclaimable(ASR_RECLAIM_KEY)
      for (const id of [...pending.keys()]) settle(id, { text: null, silent: false }, generation) // release waiters
    })
    w.postMessage({
      type: 'init',
      cacheDir: path.join(app.getPath('userData'), 'transformers-cache'),
      moduleUrl: pathToFileURL(path.join(lease.path, 'runtime.mjs')).href,
    })
    worker = w
    workerLease = lease
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
    if (!signal.aborted) {
      console.error('[asr] could not start asr-worker; transcription disabled:', (e as Error)?.message ?? e)
    }
    return null
  }
}

/** Transcribe mono 16 kHz Float32 PCM to text/silent; null text means unavailable or failed. */
export async function transcribe(audio: Float32Array): Promise<TranscribeResult> {
  if (!(audio instanceof Float32Array) || audio.length === 0) return { text: null, silent: false }
  const w = await ensureWorker()
  if (!w) return { text: null, silent: false }
  const generation = workerGeneration
  const id = String(++seq)
  return new Promise<TranscribeResult>((resolve) => {
    // The first request may download the model, so allow a generous timeout; the exit handler also resolves
    // pending work.
    const timer = setTimeout(() => settle(id, { text: null, silent: false }, generation), 5 * 60_000)
    pending.set(id, { resolve, timer, generation })
    try {
      w.postMessage({ type: 'transcribe', id, audio })
    } catch (e) {
      console.error('[asr] failed to send to asr-worker:', (e as Error)?.message ?? e)
      settle(id, { text: null, silent: false })
    }
  })
}

/** Stop the transcription utilityProcess during shutdown or reclaimer eviction. */
export function stopAsrWorker(): void {
  const w = worker
  stopGeneration++
  workerInstallController?.abort(new Error('ASR worker startup cancelled'))
  workerInstallController = null
  if (w) intentionalStops.add(w)
  worker = null
  workerLease?.release()
  workerLease = null
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
