import { VOICE_LIMITS, type VoiceFailureCode } from '@maestrly/host-protocol'
import { z } from 'zod'
import type { AsrBundle } from './assets.js'

/**
 * Typed protocol between the Host and the speech-recognition worker. The worker receives
 * validated audio samples and an identifier; it never receives a module URL, a model name, a
 * filesystem path or anything else a caller could have chosen. The executable code comes from
 * the verified bundle, and the bundle is the only place models are read from.
 */
export const asrRequestSchema = z.strictObject({
  type: z.literal('transcribe'),
  jobId: z.string().min(1).max(128),
  generation: z.number().int().positive(),
  sampleRate: z.literal(16_000),
  /** 16-bit mono samples as float, already validated against the canonical WAV contract. */
  samples: z.custom<Float32Array>((value) => value instanceof Float32Array, { message: 'Float32Array required' }),
})
export type AsrRequest = z.infer<typeof asrRequestSchema>
export const asrResponseSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('result'),
    jobId: z.string().min(1).max(128),
    generation: z.number().int().positive(),
    text: z.string().max(200_000),
    language: z.string().max(16).optional(),
    durationMs: z.number().int().nonnegative().optional(),
  }),
  z.strictObject({
    type: z.literal('error'),
    jobId: z.string().min(1).max(128),
    generation: z.number().int().positive(),
    code: z.string().min(1).max(40),
    message: z.string().max(400),
  }),
  z.strictObject({ type: z.literal('ready'), modelId: z.string().max(80) }),
])
export type AsrResponse = z.infer<typeof asrResponseSchema>

export interface AsrWorkerHandle {
  send(request: AsrRequest): void
  onMessage(listener: (message: unknown) => void): void
  onExit(listener: (reason: string) => void): void
  kill(): void
}
export type AsrWorkerFactory = (bundle: AsrBundle) => AsrWorkerHandle

export interface AsrOptions {
  /** Absolute directory of the verified bundle; absent means this Host has no ASR installed. */
  bundleDirectory?: string
  /** Injection seam for tests; production forks the bundle entry point as a Node process. */
  factory?: AsrWorkerFactory
  idleMs?: number
  timeoutMs?: number
}

export interface TranscriptionOutcome {
  text?: string
  language?: string
  durationMs?: number
  failureCode?: VoiceFailureCode
  message?: string
}

/**
 * Drives at most one worker and at most one job at a time.
 *
 * Everything here exists so that a transcription can fail without taking anything else with
 * it. A crash, a timeout or a cancellation ends that job only; the worker is replaced, the
 * generation moves on, and a late answer from the previous worker is discarded rather than
 * written to a recording the person already moved past. The worker also exits after a short
 * idle period: a speech model has no business staying resident on a machine that is running
 * other people's work.
 */
export class AsrWorkerClient {
  private worker?: AsrWorkerHandle
  private generation = 0
  private idleTimer?: ReturnType<typeof setTimeout>
  private active?: {
    jobId: string
    generation: number
    resolve: (outcome: TranscriptionOutcome) => void
    timer: ReturnType<typeof setTimeout>
  }
  private closed = false
  constructor(
    private readonly bundle: () => AsrBundle | undefined,
    private readonly options: AsrOptions = {}
  ) {}

  get busy() {
    return !!this.active
  }
  get activeJobId() {
    return this.active?.jobId
  }

  /**
   * Runs one transcription. The promise always resolves: a failure is an outcome the person
   * can act on, not an exception that would leave a job row in limbo.
   */
  transcribe(jobId: string, samples: Float32Array): Promise<TranscriptionOutcome> {
    if (this.closed) return Promise.resolve({ failureCode: 'ASR_UNAVAILABLE', message: 'O serviço de transcrição foi encerrado.' })
    if (this.active) return Promise.resolve({ failureCode: 'ASR_QUEUE_FULL', message: 'Já existe uma transcrição em andamento.' })
    const bundle = this.bundle()
    if (!bundle) return Promise.resolve({ failureCode: 'ASR_MODEL_MISSING', message: 'Este Host ainda não tem o pacote de transcrição instalado.' })
    let worker: AsrWorkerHandle
    try {
      worker = this.ensureWorker(bundle)
    } catch (error) {
      return Promise.resolve({ failureCode: 'ASR_UNAVAILABLE', message: error instanceof Error ? error.message.slice(0, 300) : 'Não foi possível iniciar a transcrição.' })
    }
    const generation = this.generation
    return new Promise<TranscriptionOutcome>((resolve) => {
      const timer = setTimeout(() => this.settle(generation, jobId, { failureCode: 'ASR_TIMEOUT', message: 'A transcrição demorou demais e foi interrompida.' }, true), this.options.timeoutMs ?? VOICE_LIMITS.jobTimeoutMs)
      timer.unref?.()
      this.active = { jobId, generation, resolve, timer }
      this.clearIdle()
      try {
        worker.send({ type: 'transcribe', jobId, generation, sampleRate: 16_000, samples })
      } catch (error) {
        this.settle(generation, jobId, { failureCode: 'ASR_CRASHED', message: error instanceof Error ? error.message.slice(0, 300) : 'O serviço de transcrição falhou.' }, true)
      }
    })
  }

  /** Stops the job that is running now. A late answer from its worker is ignored. */
  cancel(jobId: string) {
    if (this.active?.jobId !== jobId) return false
    this.settle(this.active.generation, jobId, { failureCode: 'ASR_CANCELLED', message: 'Transcrição cancelada.' }, true)
    return true
  }

  private ensureWorker(bundle: AsrBundle) {
    if (this.worker) return this.worker
    const factory = this.options.factory
    if (!factory) throw new Error('Nenhum executor de transcrição configurado neste Host.')
    this.generation += 1
    const generation = this.generation
    const worker = factory(bundle)
    worker.onMessage((message) => this.receive(generation, message))
    worker.onExit((reason) => {
      if (this.worker === worker) this.worker = undefined
      if (this.active?.generation === generation)
        this.settle(generation, this.active.jobId, { failureCode: 'ASR_CRASHED', message: `O serviço de transcrição parou (${reason}).` }, false)
    })
    this.worker = worker
    return worker
  }

  private receive(generation: number, message: unknown) {
    const parsed = asrResponseSchema.safeParse(message)
    if (!parsed.success || parsed.data.type === 'ready') return
    // A worker that was already replaced must not write into the current job.
    if (generation !== this.generation || !this.active || this.active.generation !== generation) return
    if (parsed.data.jobId !== this.active.jobId) return
    if (parsed.data.type === 'error') {
      this.settle(generation, parsed.data.jobId, { failureCode: this.failureFor(parsed.data.code), message: parsed.data.message }, true)
      return
    }
    this.settle(
      generation,
      parsed.data.jobId,
      {
        text: parsed.data.text,
        ...(parsed.data.language ? { language: parsed.data.language } : {}),
        ...(parsed.data.durationMs !== undefined ? { durationMs: parsed.data.durationMs } : {}),
      },
      false
    )
  }
  private failureFor(code: string): VoiceFailureCode {
    if (code === 'ASR_NO_SPEECH') return 'ASR_NO_SPEECH'
    if (code === 'ASR_MODEL_MISSING') return 'ASR_MODEL_MISSING'
    return 'ASR_CRASHED'
  }

  private settle(generation: number, jobId: string, outcome: TranscriptionOutcome, replaceWorker: boolean) {
    const active = this.active
    if (!active || active.generation !== generation || active.jobId !== jobId) return
    clearTimeout(active.timer)
    this.active = undefined
    if (replaceWorker) {
      // The worker may still be mid-inference: end it and move the generation forward, so a
      // late result cannot be attributed to the next recording.
      this.worker?.kill()
      this.worker = undefined
    }
    active.resolve(outcome)
    this.scheduleIdle()
  }

  private clearIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = undefined
  }
  /** The model is released after a short pause; it does not stay resident all day. */
  private scheduleIdle() {
    this.clearIdle()
    if (this.closed || !this.worker) return
    this.idleTimer = setTimeout(() => {
      if (this.active) return
      this.worker?.kill()
      this.worker = undefined
    }, this.options.idleMs ?? VOICE_LIMITS.workerIdleMs)
    this.idleTimer.unref?.()
  }
  close() {
    this.closed = true
    this.clearIdle()
    if (this.active) this.settle(this.active.generation, this.active.jobId, { failureCode: 'ASR_CANCELLED', message: 'O Host foi encerrado.' }, true)
    this.worker?.kill()
    this.worker = undefined
  }
}
