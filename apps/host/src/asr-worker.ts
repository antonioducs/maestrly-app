/**
 * Speech-recognition worker. It runs as its own Node process, outside the Host daemon and
 * outside every bot VM, so a model that is slow, hungry or simply broken cannot take the
 * Host's scheduling, leases or live screen down with it.
 *
 * Three properties matter more than the transcription itself.
 *
 * Models are read ONLY from the verified bundle directory this process was started with, with
 * remote loading disabled. That is what makes "the audio never leaves your computer" a
 * property of the system rather than a promise in a settings screen — and it is the opposite
 * of the older desktop worker, which downloaded weights lazily during inference.
 *
 * Nothing about the audio or the text is ever logged. A transcript is the most private thing
 * this product handles; a stray console line would put it in a file somebody else can read.
 *
 * And silence is reported as silence. Whisper happily produces a plausible sentence for an
 * empty recording; answering "no speech" is the honest outcome.
 */
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'

type Transcriber = (audio: Float32Array, options?: Record<string, unknown>) => Promise<{ text?: string }>
interface TransformersModule {
  pipeline: (task: string, model: string, options?: Record<string, unknown>) => Promise<unknown>
  env: {
    allowRemoteModels: boolean
    allowLocalModels: boolean
    localModelPath: string
    cacheDir?: string
    backends?: { onnx?: { wasm?: { numThreads?: number }; numThreads?: number } }
  }
}

const root = process.env.MAESTRLY_ASR_ROOT ?? ''
const modelId = process.env.MAESTRLY_ASR_MODEL ?? ''
const threads = Math.max(1, Math.min(4, Number(process.env.MAESTRLY_ASR_THREADS ?? '2') || 2))
const send = (message: unknown) => process.send?.(message)

function fail(code: string, message: string): never {
  // No audio, no text, no paths: a crash message is not a place to leak either.
  send({ type: 'fatal', code, message })
  process.exit(1)
}
if (!root || !isAbsolute(root)) fail('ASR_MODEL_MISSING', 'The bundle directory was not provided')
if (!modelId) fail('ASR_MODEL_MISSING', 'The model identifier was not provided')

let loading: Promise<Transcriber> | undefined
function transcriber(): Promise<Transcriber> {
  if (loading) return loading
  loading = (async () => {
    const entry = join(root, 'runtime.mjs')
    if (!existsSync(entry)) throw Object.assign(new Error('Local inference runtime is missing from the bundle'), { code: 'ASR_MODEL_MISSING' })
    const module = (await import(pathToFileURL(entry).href)) as TransformersModule
    // Local only. A missing file must fail loudly instead of quietly fetching weights.
    module.env.allowRemoteModels = false
    module.env.allowLocalModels = true
    module.env.localModelPath = join(root, 'models')
    module.env.cacheDir = join(root, 'models')
    if (module.env.backends?.onnx?.wasm) module.env.backends.onnx.wasm.numThreads = threads
    if (module.env.backends?.onnx) module.env.backends.onnx.numThreads = threads
    const pipe = await module.pipeline('automatic-speech-recognition', modelId, { local_files_only: true })
    return pipe as unknown as Transcriber
  })()
  // A failed load is retried on the next job instead of poisoning the process for good.
  loading.catch(() => {
    loading = undefined
  })
  return loading
}

/**
 * Whisper marks non-speech with bracketed tokens such as [BLANK_AUDIO]. Only that exact family
 * is removed: stripping every bracketed span, as the old worker did, would silently delete
 * legitimate content a person dictated — "[nome do cliente]" is text, not a marker.
 */
const NON_SPEECH = /\[(?:BLANK_AUDIO|SILENCE|INAUDIBLE|NO SPEECH|MUSIC|MÚSICA|SILÊNCIO|APPLAUSE|LAUGHTER)\]/gi
export function cleanTranscript(raw: string): string {
  const text = (raw ?? '')
    .replace(/<\|[^|]*\|>/g, ' ')
    .replace(NON_SPEECH, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const words = text.split(' ').filter(Boolean)
  // A degenerate loop of one short token is the model failing, not a person speaking.
  if (words.length >= 6) {
    const unique = new Set(words.map((word) => word.toLowerCase().replace(/[.,!?;:]+$/, '')))
    if (unique.size <= 2 && [...unique].every((word) => word.length <= 3)) return ''
  }
  return text
}

interface TranscribeMessage {
  type: 'transcribe'
  jobId: string
  generation: number
  sampleRate: number
  samples: Float32Array
}
process.on('message', (message: unknown) => {
  const request = message as Partial<TranscribeMessage>
  if (request?.type !== 'transcribe' || typeof request.jobId !== 'string' || typeof request.generation !== 'number') return
  const samples = request.samples
  if (!(samples instanceof Float32Array) || request.sampleRate !== 16_000) {
    send({ type: 'error', jobId: request.jobId, generation: request.generation, code: 'ASR_UNAVAILABLE', message: 'Unsupported audio payload' })
    return
  }
  void (async () => {
    const started = Date.now()
    try {
      const run = await transcriber()
      const result = await run(samples, { chunk_length_s: 30, stride_length_s: 5, return_timestamps: false })
      const text = cleanTranscript(result?.text ?? '')
      if (!text) {
        send({ type: 'error', jobId: request.jobId, generation: request.generation, code: 'ASR_NO_SPEECH', message: 'No speech detected' })
        return
      }
      send({ type: 'result', jobId: request.jobId, generation: request.generation, text, durationMs: Date.now() - started })
    } catch (error) {
      const code = (error as { code?: string }).code === 'ASR_MODEL_MISSING' ? 'ASR_MODEL_MISSING' : 'ASR_CRASHED'
      send({
        type: 'error',
        jobId: request.jobId,
        generation: request.generation,
        code,
        // Bounded and generic: a stack trace here could carry a fragment of the audio path.
        message: (error instanceof Error ? error.message : 'Transcription failed').slice(0, 300),
      })
    }
  })()
})

// Announce readiness without loading the model: the Host learns the process is alive, and the
// weights are only read when there is actually something to transcribe.
send({ type: 'ready', modelId })
// Keep the require seam so the bundler does not tree-shake the dynamic import above.
export const require_ = createRequire(import.meta.url)
