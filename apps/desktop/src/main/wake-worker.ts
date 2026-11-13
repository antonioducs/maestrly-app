/**
 * Wake-word detection utilityProcess runs Silero VAD and a small whisper.cpp model outside main so it never blocks
 * UI or IPC. Requests: init { moduleUrl, modelPath, useGpu }, warm { id }, detect { id, audio, language }.
 * Responses: ready, warm:done { id }, warm:error { id, error }, detect:result { id, text, silent, ms },
 * detect:error { id, error }.
 */

import { floatToPcm16 } from './asr-audio'
import { detectWakeText } from './wake-detect'
import type { VadContextLike, WhisperAddon, WhisperContextLike } from './whisper-addon'

let config = { moduleUrl: '', modelPath: '', useGpu: false }
let engine: Promise<{ whisper: WhisperContextLike; vad: VadContextLike }> | null = null
let warmed: Promise<void> | null = null

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

/** Load the engine and run one throwaway pass once per worker so Metal shaders and model weights are ready. */
function warm(): Promise<void> {
  if (!warmed) {
    warmed = (async () => {
      const { whisper } = await getEngine()
      await whisper.transcribeData(floatToPcm16(new Float32Array(16000)), { language: 'en', maxThreads: 2 }).promise
    })()
    warmed.catch(() => {
      warmed = null
    })
  }
  return warmed
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
  if (msg.type === 'warm' && msg.id) {
    try {
      await warm()
      parentPort.postMessage({ type: 'warm:done', id: msg.id })
    } catch (err) {
      parentPort.postMessage({ type: 'warm:error', id: msg.id, error: String((err as Error)?.message ?? err) })
    }
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
