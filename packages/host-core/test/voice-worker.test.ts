import { chmodSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AsrWorkerClient, asrRequestSchema, asrResponseSchema } from '../src/voice/worker-client.js'
import { inspectAsrBundle, resetAsrVerification } from '../src/voice/assets.js'
import { decodePcm } from '../src/voice/wav.js'
import { asrBundle, fakeAsr, speech, type FakeAsrHandle } from './voice-helpers.js'

afterEach(() => resetAsrVerification())
const samples = () => decodePcm(speech(500))
async function client(overrides: { idleMs?: number; timeoutMs?: number } = {}) {
  const asr = fakeAsr()
  const root = await asrBundle()
  const state = inspectAsrBundle(root)
  expect(state.state).toBe('ready')
  return {
    asr,
    root,
    worker: new AsrWorkerClient(() => state.bundle, {
      factory: asr.factory,
      idleMs: overrides.idleMs ?? 30,
      timeoutMs: overrides.timeoutMs ?? 300,
    }),
  }
}

describe('the worker protocol is typed, and nothing else gets through', () => {
  it('carries a job, a generation and validated audio — never a path or a module URL', () => {
    const valid = { type: 'transcribe', jobId: 'j-1', generation: 1, sampleRate: 16_000 as const, samples: samples() }
    expect(asrRequestSchema.safeParse(valid).success).toBe(true)
    expect(asrRequestSchema.safeParse({ ...valid, modelPath: '/tmp/model.onnx' }).success).toBe(false)
    expect(asrRequestSchema.safeParse({ ...valid, entry: 'file:///tmp/worker.mjs' }).success).toBe(false)
    expect(asrRequestSchema.safeParse({ ...valid, sampleRate: 44_100 }).success).toBe(false)
    expect(asrRequestSchema.safeParse({ ...valid, samples: [0.1, 0.2] }).success).toBe(false)
    expect(asrResponseSchema.safeParse({ type: 'result', jobId: 'j-1', generation: 1, text: 'olá' }).success).toBe(true)
    expect(
      asrResponseSchema.safeParse({ type: 'result', jobId: 'j-1', generation: 1, text: 'olá', confidence: 0.99 })
        .success
    ).toBe(false)
  })
})

describe.skipIf(process.platform === 'win32')('a verified bundle, or none at all', () => {
  it('reports a Host with no bundle as missing, not as broken', () => {
    expect(inspectAsrBundle(undefined)).toMatchObject({ state: 'missing' })
    expect(inspectAsrBundle('/definitely/not/here')).toMatchObject({ state: 'missing' })
    expect(inspectAsrBundle('relative/path')).toMatchObject({ state: 'incompatible' })
  })

  it.skipIf(process.getuid?.() === 0)('says a bundle is unreadable instead of pretending it is not installed', async () => {
    const root = await asrBundle()
    expect(inspectAsrBundle(root).state).toBe('ready')
    resetAsrVerification()
    // Exactly what a bundle extracted with root-only permissions looks like to the daemon, which
    // does not run as root. Reported as "missing", it sends an operator to install something that
    // is already installed.
    chmodSync(root, 0o000)
    try {
      const state = inspectAsrBundle(root)
      expect(state.state).toBe('incompatible')
      expect(state.reason).toMatch(/permissão/)
      expect(state.reason).toContain(root)
    } finally {
      chmodSync(root, 0o755)
    }
    resetAsrVerification()
    expect(inspectAsrBundle(root).state).toBe('ready')
  })

  it('refuses a bundle whose files do not match the manifest', async () => {
    const tampered = await asrBundle({ tamper: true })
    expect(inspectAsrBundle(tampered)).toMatchObject({ state: 'incompatible' })
  })

  it('refuses a bundle whose file was replaced after it was published', async () => {
    const root = await asrBundle()
    expect(inspectAsrBundle(root).state).toBe('ready')
    resetAsrVerification()
    writeFileSync(join(root, 'models', 'weights.bin'), 'different weights entirely')
    expect(inspectAsrBundle(root)).toMatchObject({ state: 'incompatible' })
  })

  it('refuses an entry point that is a symbolic link out of the bundle', async () => {
    const root = await asrBundle()
    rmSync(join(root, 'worker.mjs'))
    symlinkSync('/bin/sh', join(root, 'worker.mjs'))
    resetAsrVerification()
    expect(inspectAsrBundle(root)).toMatchObject({ state: 'incompatible' })
  })

  it('never transcribes when no bundle is installed', async () => {
    const asr = fakeAsr()
    const worker = new AsrWorkerClient(() => undefined, { factory: asr.factory })
    expect(await worker.transcribe('j-1', samples())).toMatchObject({ failureCode: 'ASR_MODEL_MISSING' })
    expect(asr.workers).toBe(0)
  })
})

describe.skipIf(process.platform === 'win32')('one job at a time, and every failure is an outcome', () => {
  it('transcribes and releases the worker after a short idle period', async () => {
    const { worker, asr } = await client({ idleMs: 20 })
    expect(await worker.transcribe('j-1', samples())).toMatchObject({
      text: 'toda segunda às nove, prepare esse resumo',
      language: 'pt',
    })
    expect(asr.workers).toBe(1)
    // The same worker serves a second job while it is still warm.
    await worker.transcribe('j-2', samples())
    expect(asr.workers).toBe(1)
    await new Promise((resolve) => setTimeout(resolve, 60))
    // Then the model is released: it does not stay resident on the machine.
    expect(asr.killed).toBe(1)
    await worker.transcribe('j-3', samples())
    expect(asr.workers).toBe(2)
    worker.close()
  })

  it('turns a crash into a failed job and replaces the worker', async () => {
    const { worker, asr } = await client()
    asr.respond((_request, handle) => (handle as FakeAsrHandle).crash('segfault'))
    const outcome = await worker.transcribe('j-1', samples())
    expect(outcome).toMatchObject({ failureCode: 'ASR_CRASHED' })
    expect(outcome.message).toContain('segfault')
    // The next job gets a fresh worker instead of a dead one.
    asr.respond((request, handle) =>
      handle.reply({ type: 'result', jobId: request.jobId, generation: request.generation, text: 'depois do crash' })
    )
    expect(await worker.transcribe('j-2', samples())).toMatchObject({ text: 'depois do crash' })
    expect(asr.workers).toBe(2)
    worker.close()
  })

  it('gives up at its timeout and ends the worker that was stuck', async () => {
    const { worker, asr } = await client({ timeoutMs: 60 })
    asr.respond(() => {
      /* never answers */
    })
    expect(await worker.transcribe('j-1', samples())).toMatchObject({ failureCode: 'ASR_TIMEOUT' })
    expect(asr.killed).toBe(1)
    worker.close()
  })

  it('ignores a late answer from a worker that was already replaced', async () => {
    const { worker, asr } = await client({ timeoutMs: 60 })
    let stuck: FakeAsrHandle | undefined
    asr.respond((_request, handle) => {
      stuck = handle as FakeAsrHandle
    })
    expect(await worker.transcribe('j-1', samples())).toMatchObject({ failureCode: 'ASR_TIMEOUT' })
    // The old worker finally answers, for the job that already ended.
    stuck?.reply({ type: 'result', jobId: 'j-1', generation: 1, text: 'resposta atrasada' })
    asr.respond((request, handle) =>
      handle.reply({ type: 'result', jobId: request.jobId, generation: request.generation, text: 'resposta certa' })
    )
    // The next job gets its own answer, never the stale one.
    expect(await worker.transcribe('j-2', samples())).toMatchObject({ text: 'resposta certa' })
    worker.close()
  })

  it('ignores an answer addressed to another job', async () => {
    const { worker, asr } = await client({ timeoutMs: 80 })
    asr.respond((request, handle) =>
      handle.reply({ type: 'result', jobId: 'someone-else', generation: request.generation, text: 'não é para você' })
    )
    expect(await worker.transcribe('j-1', samples())).toMatchObject({ failureCode: 'ASR_TIMEOUT' })
    worker.close()
  })

  it('cancels the job that is running and keeps accepting the next one', async () => {
    const { worker, asr } = await client({ timeoutMs: 5_000 })
    asr.respond(() => {
      /* never answers */
    })
    const running = worker.transcribe('j-1', samples())
    expect(worker.busy).toBe(true)
    expect(worker.cancel('j-1')).toBe(true)
    expect(await running).toMatchObject({ failureCode: 'ASR_CANCELLED' })
    expect(worker.busy).toBe(false)
    // Cancelling a job that is not running is simply false, never an error.
    expect(worker.cancel('j-1')).toBe(false)
    asr.respond((request, handle) =>
      handle.reply({ type: 'result', jobId: request.jobId, generation: request.generation, text: 'seguinte' })
    )
    expect(await worker.transcribe('j-2', samples())).toMatchObject({ text: 'seguinte' })
    worker.close()
  })

  it('refuses a second job while one is already running', async () => {
    const { worker, asr } = await client({ timeoutMs: 5_000 })
    asr.respond(() => {
      /* never answers */
    })
    const running = worker.transcribe('j-1', samples())
    expect(await worker.transcribe('j-2', samples())).toMatchObject({ failureCode: 'ASR_QUEUE_FULL' })
    worker.cancel('j-1')
    await running
    worker.close()
  })

  it('reports a model the worker could not load as a missing model', async () => {
    const { worker, asr } = await client()
    asr.respond((request, handle) =>
      handle.reply({
        type: 'error',
        jobId: request.jobId,
        generation: request.generation,
        code: 'ASR_MODEL_MISSING',
        message: 'weights not found',
      })
    )
    expect(await worker.transcribe('j-1', samples())).toMatchObject({ failureCode: 'ASR_MODEL_MISSING' })
    worker.close()
  })

  it('ends cleanly when the Host closes, without leaving a job hanging', async () => {
    const { worker, asr } = await client({ timeoutMs: 5_000 })
    asr.respond(() => {
      /* never answers */
    })
    const running = worker.transcribe('j-1', samples())
    worker.close()
    expect(await running).toMatchObject({ failureCode: 'ASR_CANCELLED' })
    expect(await worker.transcribe('j-2', samples())).toMatchObject({ failureCode: 'ASR_UNAVAILABLE' })
  })
})
