import { app, utilityProcess, type UtilityProcess } from 'electron'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { RuntimeAssetLease } from '../shared/runtime-assets'
import { registerOwnedProcess, unregisterOwnedProcess } from './performance/owned-processes'
import { acquireRuntimeAssetLease, readyRuntimeAsset } from './runtime-assets/app-service'
import { WAKE_MODEL_FILE } from './runtime-assets/registry'

export interface WakeDetectResult {
  text: string
  silent: boolean
  ms: number
}

export interface WakeWorker {
  detect(audio: Float32Array, language: 'pt' | 'en'): Promise<WakeDetectResult | null>
  stop(): void
}

const REQUEST_TIMEOUT_MS = 5000
const WARM_TIMEOUT_MS = 60_000
let registeredOwnerToken: symbol | null = null

export async function wakeAssetsReady(): Promise<boolean> {
  try {
    await Promise.all([readyRuntimeAsset('local-ml-runtime'), readyRuntimeAsset('wake-model')])
    return true
  } catch {
    return false
  }
}

export async function startWakeWorker(onExit: () => void): Promise<WakeWorker | null> {
  let lease: RuntimeAssetLease | null = null
  let modelLease: RuntimeAssetLease | null = null
  try {
    await readyRuntimeAsset('local-ml-runtime')
    const model = await readyRuntimeAsset('wake-model')
    lease = await acquireRuntimeAssetLease('local-ml-runtime')
    modelLease = await acquireRuntimeAssetLease('wake-model', model.path)

    const workerPath = path.join(app.getAppPath(), 'out', 'main', 'wake-worker.js')
    const w: UtilityProcess = utilityProcess.fork(workerPath, [], { serviceName: 'wake-word', stdio: 'pipe' })
    const pending = new Map<
      string,
      { resolve: (r: WakeDetectResult | null) => void; timer: ReturnType<typeof setTimeout> }
    >()
    let warmWaiter: { id: string; resolve: (ok: boolean) => void; timer: ReturnType<typeof setTimeout> } | null = null
    let seq = 0
    let stopped = false
    const ownerToken = Symbol('wake-worker')

    const settle = (id: string, result: WakeDetectResult | null): void => {
      const entry = pending.get(id)
      if (!entry) return
      clearTimeout(entry.timer)
      pending.delete(id)
      entry.resolve(result)
    }

    const settleWarm = (ok: boolean): void => {
      if (!warmWaiter) return
      const current = warmWaiter
      warmWaiter = null
      clearTimeout(current.timer)
      current.resolve(ok)
    }

    const cleanup = (): void => {
      lease?.release()
      lease = null
      modelLease?.release()
      modelLease = null
      if (registeredOwnerToken === ownerToken) {
        registeredOwnerToken = null
        unregisterOwnedProcess('wake')
      }
      settleWarm(false)
      for (const id of [...pending.keys()]) settle(id, null)
    }

    w.stdout?.on('data', (d) => console.log('[wake-worker]', String(d).trim()))
    w.stderr?.on('data', (d) => console.error('[wake-worker]', String(d).trim()))
    w.on('message', (msg: { type?: string; id?: string; text?: string; silent?: boolean; ms?: number; error?: string }) => {
      if (stopped || !msg?.id) return
      if (msg.type === 'warm:done' && warmWaiter?.id === msg.id) {
        settleWarm(true)
      } else if (msg.type === 'warm:error' && warmWaiter?.id === msg.id) {
        console.error('[wake] worker warm error:', msg.error)
        settleWarm(false)
      } else if (msg.type === 'detect:result') {
        settle(msg.id, { text: msg.text ?? '', silent: !!msg.silent, ms: msg.ms ?? 0 })
      } else if (msg.type === 'detect:error') {
        console.error('[wake] worker error:', msg.error)
        settle(msg.id, null)
      }
    })
    w.on('exit', (code) => {
      cleanup()
      if (!stopped) {
        if (code !== 0) console.error('[wake] wake-worker exited with code', code)
        onExit()
      }
    })

    w.postMessage({
      type: 'init',
      moduleUrl: pathToFileURL(path.join(lease.path, 'runtime.mjs')).href,
      modelPath: path.join(modelLease.path, WAKE_MODEL_FILE),
      useGpu: process.platform === 'darwin',
    })

    registeredOwnerToken = ownerToken
    registerOwnedProcess({
      key: 'wake',
      kind: 'asr',
      pid: () => (stopped ? null : (w.pid ?? null)),
      state: () => (pending.size > 0 || warmWaiter ? 'busy' : 'idle'),
      extra: () => ({ pending: pending.size }),
    })

    const warmId = String(++seq)
    const warmed = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        console.error('[wake] worker warm timed out')
        settleWarm(false)
      }, WARM_TIMEOUT_MS)
      warmWaiter = { id: warmId, resolve, timer }
      try {
        w.postMessage({ type: 'warm', id: warmId })
      } catch (e) {
        console.error('[wake] failed to send warm to wake-worker:', (e as Error)?.message ?? e)
        settleWarm(false)
      }
    })
    if (!warmed || stopped) {
      stopped = true
      cleanup()
      try {
        w.kill()
      } catch {
        // ignore kill failures if already dead
      }
      return null
    }

    return {
      detect(audio, language) {
        if (stopped) return Promise.resolve(null)
        const id = String(++seq)
        return new Promise<WakeDetectResult | null>((resolve) => {
          const timer = setTimeout(() => settle(id, null), REQUEST_TIMEOUT_MS)
          pending.set(id, { resolve, timer })
          try {
            w.postMessage({ type: 'detect', id, audio, language })
          } catch (e) {
            console.error('[wake] failed to send to wake-worker:', (e as Error)?.message ?? e)
            settle(id, null)
          }
        })
      },
      stop() {
        if (stopped) return
        stopped = true
        cleanup()
        try {
          w.kill()
        } catch {
          // ignore kill failures if already dead
        }
      },
    }
  } catch (e) {
    lease?.release()
    modelLease?.release()
    console.error('[wake] could not start wake-worker:', (e as Error)?.message ?? e)
    return null
  }
}
