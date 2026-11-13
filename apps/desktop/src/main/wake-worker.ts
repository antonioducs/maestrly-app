/**
 * Wake-word detection utilityProcess runs Silero VAD and a small whisper.cpp model outside main so it never blocks
 * UI or IPC. Requests: init { moduleUrl, modelPath, useGpu }, detect { id, audio, language }.
 * Responses: ready, detect:result { id, text, silent, ms }, detect:error { id, error }.
 */

import { detectWakeText } from './wake-detect'
import type { VadContextLike, WhisperAddon, WhisperContextLike } from './whisper-addon'

let config = { moduleUrl: '', modelPath: '', useGpu: false }
let engine: Promise<{ whisper: WhisperContextLike; vad: VadContextLike }> | null = null

function getEngine(): Promise<{ whisper: WhisperContextLike; vad: VadContextLike }> {
  if (!engine) {
    engine = (async () => {
      if (!config.moduleUrl.startsWith('file:') || !config.modelPath) throw new Error('Wake worker was not initialized')
      const runtime = (await import(config.moduleUrl)) as { loadWhisper(): WhisperAddon; vadModelPath: string }
      const addon = runtime.loadWhisper()
      return {
        whisper: new addon.WhisperContext({
          filePath: config.modelPath,
          useGpu: config.useGpu,
          useFlashAttn: config.useGpu,
        }),
        vad: new addon.WhisperVadContext({ filePath: runtime.vadModelPath, useGpu: false, nThreads: 1 }),
      }
    })()
    engine.catch(() => {
      engine = null
    })
  }
  return engine
}

const parentPort = process.parentPort

parentPort.on('message', async (e) => {
  const msg = e.data as {
    type: string
    id?: string
    audio?: Float32Array
    language?: string
    moduleUrl?: string
    modelPath?: string
    useGpu?: boolean
  }
  if (msg.type === 'init') {
    config = { moduleUrl: msg.moduleUrl ?? '', modelPath: msg.modelPath ?? '', useGpu: msg.useGpu === true }
    parentPort.postMessage({ type: 'ready' })
    return
  }
  if (msg.type === 'detect' && msg.id) {
    try {
      const audio = msg.audio instanceof Float32Array ? msg.audio : new Float32Array(msg.audio ?? [])
      const started = Date.now()
      const { text, silent } = await detectWakeText(await getEngine(), audio, msg.language === 'en' ? 'en' : 'pt')
      parentPort.postMessage({ type: 'detect:result', id: msg.id, text, silent, ms: Date.now() - started })
    } catch (err) {
      parentPort.postMessage({ type: 'detect:error', id: msg.id, error: String((err as Error)?.message ?? err) })
    }
  }
})
