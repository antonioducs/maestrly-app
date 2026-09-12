/**
 * Voice-transcription utilityProcess runs Whisper through transformers.js/ONNX outside main to avoid
 * CPU-bound inference blocking UI/IPC. It inherits the asar hook and receives cacheDir/moduleUrl over
 * process.parentPort. Xenova/whisper-base is multilingual with automatic language detection; .en
 * variants cannot support all locales. Input is renderer-decoded/resampled mono 16 kHz Float32Array
 * PCM. Requests: init and transcribe {id,audio}. Responses: ready, transcribe:result {id,text},
 * transcribe:error {id,error}.
 */

export {} // mark as an ES module so top-level state cannot collide with ml-worker

type Transcriber = (audio: Float32Array, opts?: Record<string, unknown>) => Promise<{ text?: string }>

const MODEL = 'Xenova/whisper-base'
let pipePromise: Promise<Transcriber> | null = null
let cacheDir = ''
let moduleUrl = ''

/**
 * Clean Whisper output by removing special tokens and non-speech/silence markers such as [S],
 * [BLANK_AUDIO], [Music], or [Silence]. Return empty text for empty results or degenerate repetitions
 * of one short token.
 */
function cleanTranscript(raw: string): string {
  let t = (raw ?? '').replace(/<\|[^|]*\|>/g, ' ').replace(/\[[^\]\n]{0,40}\]/g, ' ')
  t = t.replace(/\s+/g, ' ').trim()
  const words = t.split(' ').filter(Boolean)
  if (words.length >= 6) {
    const uniq = new Set(words.map((w) => w.toLowerCase().replace(/[.,!?;:]+$/, '')))
    if (uniq.size <= 2 && [...uniq].every((w) => w.length <= 3)) return '' // ex.: "S S S" / "you you you"
  }
  return t
}

function getTranscriber(): Promise<Transcriber> {
  if (!pipePromise) {
    pipePromise = (async () => {
      if (!moduleUrl.startsWith('file:')) throw new Error('Local ML runtime module URL was not initialized')
      const { pipeline, env } = (await import(moduleUrl)) as {
        pipeline: (task: string, model: string) => Promise<unknown>
        env: { allowLocalModels: boolean; cacheDir?: string }
      }
      env.allowLocalModels = false
      if (cacheDir) env.cacheDir = cacheDir // cache the model in userData, sharing the embeddings directory
      const p = await pipeline('automatic-speech-recognition', MODEL)
      return p as unknown as Transcriber
    })()
    // Reset rejected model loads so transient download/cache failures can be retried on the next
    // transcription.
    pipePromise.catch(() => {
      pipePromise = null
    })
  }
  return pipePromise
}

const parentPort = process.parentPort

parentPort.on('message', async (e) => {
  const msg = e.data as {
    type: string
    id?: string
    audio?: Float32Array
    cacheDir?: string
    moduleUrl?: string
  }
  if (msg.type === 'init') {
    cacheDir = msg.cacheDir ?? ''
    moduleUrl = msg.moduleUrl ?? ''
    parentPort.postMessage({ type: 'ready' })
    return
  }
  if (msg.type === 'transcribe' && msg.id) {
    try {
      const t = await getTranscriber()
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
        `[asr] amostras: ${audio.length} (~${(audio.length / 16000).toFixed(1)}s) pico=${peak.toFixed(4)} rms=${rms.toFixed(4)}`
      )
      const silent = rms < 0.0008 // effectively silent audio, such as denied microphone access producing zeros
      if (silent || audio.length < 1600) {
        parentPort.postMessage({ type: 'transcribe:result', id: msg.id, text: '', silent: true })
        return
      }
      // Omit language for automatic detection; chunk/stride settings keep long audio within Whisper's
      // window.
      const out = await t(audio, { chunk_length_s: 30, stride_length_s: 5 })
      console.log('[asr] raw Whisper output:', JSON.stringify((out?.text ?? '').slice(0, 200)))
      parentPort.postMessage({
        type: 'transcribe:result',
        id: msg.id,
        text: cleanTranscript(out?.text ?? ''),
        silent: false,
      })
    } catch (err) {
      parentPort.postMessage({ type: 'transcribe:error', id: msg.id, error: String((err as Error)?.message ?? err) })
    }
  }
})
