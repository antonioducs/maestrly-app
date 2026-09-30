/**
 * Voice-transcription utilityProcess runs whisper.cpp (large-v3-turbo) outside main to avoid CPU/GPU-bound
 * inference blocking UI/IPC. The local-ml-runtime asset provides the N-API addon and the Silero VAD model
 * through runtime.mjs; the speech model path comes from the whisper-model asset. Silero VAD gates every
 * request, because Whisper invents text ("Obrigado.") from silence or room noise. Input is renderer-decoded
 * mono 16 kHz Float32Array PCM. Requests: init {moduleUrl,modelPath,useGpu}, transcribe {id,audio,language},
 * warm {id}. Responses: ready, transcribe:result {id,text,silent}, transcribe:error {id,error}.
 */

import { availableParallelism } from 'node:os'
import { cleanTranscript, floatToPcm16, speechSpan, type SpeechSegment } from './asr-audio'

interface WhisperContextLike {
  transcribeData(
    audio: ArrayBuffer,
    options?: { language?: string; maxThreads?: number }
  ): { promise: Promise<{ result: string }> }
  release(): Promise<void>
}
interface VadContextLike {
  detectSpeechData(audio: ArrayBuffer): Promise<SpeechSegment[]>
  release(): Promise<void>
}
interface WhisperAddon {
  WhisperContext: new (o: { filePath: string; useGpu?: boolean; useFlashAttn?: boolean }) => WhisperContextLike
  WhisperVadContext: new (o: { filePath: string; useGpu?: boolean; nThreads?: number }) => VadContextLike
}

let config = { moduleUrl: '', modelPath: '', useGpu: false }
let engine: Promise<{ whisper: WhisperContextLike; vad: VadContextLike }> | null = null
let warmed: Promise<void> | null = null
const maxThreads = Math.min(8, Math.max(1, availableParallelism() - 1))

function getEngine(): Promise<{ whisper: WhisperContextLike; vad: VadContextLike }> {
  if (!engine) {
    engine = (async () => {
      if (!config.moduleUrl.startsWith('file:') || !config.modelPath) throw new Error('ASR worker was not initialized')
      const runtime = (await import(config.moduleUrl)) as { loadWhisper(): WhisperAddon; vadModelPath: string }
      const addon = runtime.loadWhisper()
      return {
        whisper: new addon.WhisperContext({
          filePath: config.modelPath,
          useGpu: config.useGpu,
          useFlashAttn: config.useGpu,
        }),
        vad: new addon.WhisperVadContext({ filePath: runtime.vadModelPath, useGpu: false, nThreads: 2 }),
      }
    })()
    // A failed load can be retried by the next request.
    engine.catch(() => {
      engine = null
    })
  }
  return engine
}

/**
 * Load both models and run one throwaway pass, which compiles the Metal shaders on first use (seconds, once per
 * machine). Runs once per worker: the renderer warms on every recording start, and the addon serializes inference,
 * so repeating the pass would delay the real request.
 */
function warm(): Promise<void> {
  if (!warmed) {
    warmed = (async () => {
      const { whisper } = await getEngine()
      await whisper.transcribeData(floatToPcm16(new Float32Array(16000)), { language: 'en', maxThreads }).promise
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
      parentPort.postMessage({ type: 'transcribe:result', id: msg.id, text: '', silent: true })
    } catch (err) {
      parentPort.postMessage({ type: 'transcribe:error', id: msg.id, error: String((err as Error)?.message ?? err) })
    }
    return
  }
  if (msg.type === 'transcribe' && msg.id) {
    try {
      const audio = msg.audio instanceof Float32Array ? msg.audio : new Float32Array(msg.audio ?? [])
      // Audio-level diagnostics distinguish a silent stream or missing microphone permission from model
      // errors.
      let peak = 0
      let sumSq = 0
      for (let i = 0; i < audio.length; i++) {
        const v = Math.abs(audio[i])
        if (v > peak) peak = v
        sumSq += audio[i] * audio[i]
      }
      const rms = audio.length ? Math.sqrt(sumSq / audio.length) : 0
      console.log(
        `[asr] samples: ${audio.length} (~${(audio.length / 16000).toFixed(1)}s) peak=${peak.toFixed(4)} rms=${rms.toFixed(4)}`
      )
      const silent = rms < 0.0008 // effectively silent audio, such as denied microphone access producing zeros
      if (silent || audio.length < 1600) {
        parentPort.postMessage({ type: 'transcribe:result', id: msg.id, text: '', silent: true })
        return
      }
      const { whisper, vad } = await getEngine()
      const span = speechSpan(await vad.detectSpeechData(floatToPcm16(audio)), audio.length)
      if (!span) {
        console.log('[asr] VAD found no speech')
        parentPort.postMessage({ type: 'transcribe:result', id: msg.id, text: '', silent: true })
        return
      }
      // Pass 'auto' explicitly: whisper.cpp defaults to English when no language is given.
      const language = msg.language || 'auto'
      const started = Date.now()
      const out = await whisper.transcribeData(floatToPcm16(audio.subarray(span.start, span.end)), {
        language,
        maxThreads,
      }).promise
      console.log(`[asr] whisper ${Date.now() - started} ms:`, JSON.stringify((out?.result ?? '').slice(0, 200)))
      parentPort.postMessage({
        type: 'transcribe:result',
        id: msg.id,
        text: cleanTranscript(out?.result ?? ''),
        silent: false,
      })
    } catch (err) {
      parentPort.postMessage({ type: 'transcribe:error', id: msg.id, error: String((err as Error)?.message ?? err) })
    }
  }
})
