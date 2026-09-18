import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { VOICE_AUDIO, VOICE_LIMITS } from '@maestrly/host-protocol'
import { encodeCanonicalWav } from '../src/voice/wav.js'
import type { AsrRequest, AsrWorkerFactory, AsrWorkerHandle } from '../src/voice/worker-client.js'
import { directory } from './bot-helpers.js'

export const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex')

/** Speech-shaped audio: a tone loud enough that the silence gate lets it through. */
export function speech(durationMs = 1_000, amplitude = 0.4) {
  const count = Math.round((VOICE_AUDIO.sampleRate * durationMs) / 1000)
  const samples = Buffer.alloc(count * 2)
  for (let index = 0; index < count; index++)
    samples.writeInt16LE(Math.round(Math.sin((index / VOICE_AUDIO.sampleRate) * 2 * Math.PI * 220) * amplitude * 32767), index * 2)
  return encodeCanonicalWav(samples)
}
/** A recording with nothing in it; the Host must say so rather than invent a sentence. */
export function silence(durationMs = 1_000) {
  const count = Math.round((VOICE_AUDIO.sampleRate * durationMs) / 1000)
  return encodeCanonicalWav(Buffer.alloc(count * 2))
}

/**
 * A verified bundle on disk. It is written by the test so the manifest digests are real: the
 * Host refuses a bundle whose files do not match, and a fixture that skipped that check would
 * hide exactly the failure mode worth testing.
 */
export async function asrBundle(options: { modelId?: string; tamper?: boolean } = {}) {
  const root = join(await directory(), 'asr')
  mkdirSync(join(root, 'models'), { recursive: true, mode: 0o700 })
  const entry = Buffer.from('export const worker = true\n')
  const model = Buffer.from('fixture-model-weights')
  writeFileSync(join(root, 'worker.mjs'), entry)
  writeFileSync(join(root, 'models', 'weights.bin'), model)
  writeFileSync(
    join(root, 'manifest.json'),
    JSON.stringify({
      version: 1,
      modelId: options.modelId ?? 'fixture/whisper-base',
      runtimeVersion: '0.0.1-fixture',
      entry: 'worker.mjs',
      files: [
        { path: 'worker.mjs', sha256: sha256(entry), bytes: entry.length },
        { path: 'models/weights.bin', sha256: options.tamper ? sha256(Buffer.from('other')) : sha256(model), bytes: model.length },
      ],
    })
  )
  return root
}

export interface FakeAsr {
  factory: AsrWorkerFactory
  /** Requests the worker actually received, in order. */
  received: AsrRequest[]
  workers: number
  killed: number
  /** Decides what the worker answers; the default is a plausible transcript. */
  respond(handler: (request: AsrRequest, handle: FakeAsrHandle) => void): void
}
export interface FakeAsrHandle extends AsrWorkerHandle {
  reply(message: unknown): void
  crash(reason?: string): void
}

/** A worker fixture that speaks the real protocol, including late and foreign answers. */
export function fakeAsr(): FakeAsr {
  const state: FakeAsr = {
    received: [],
    workers: 0,
    killed: 0,
    respond(handler) {
      behaviour = handler
    },
    factory: () => {
      state.workers += 1
      const listeners: ((message: unknown) => void)[] = []
      const exits: ((reason: string) => void)[] = []
      let alive = true
      const handle: FakeAsrHandle = {
        send(request) {
          state.received.push(request)
          behaviour(request, handle)
        },
        onMessage(listener) {
          listeners.push(listener)
        },
        onExit(listener) {
          exits.push(listener)
        },
        kill() {
          if (!alive) return
          alive = false
          state.killed += 1
        },
        reply(message) {
          if (alive) for (const listener of [...listeners]) listener(message)
        },
        crash(reason = 'crashed') {
          alive = false
          for (const listener of [...exits]) listener(reason)
        },
      }
      return handle
    },
  }
  let behaviour: (request: AsrRequest, handle: FakeAsrHandle) => void = (request, handle) =>
    handle.reply({ type: 'result', jobId: request.jobId, generation: request.generation, text: 'toda segunda às nove, prepare esse resumo', language: 'pt' })
  return state
}

/** Uploads a recording exactly as the application does: begin, chunks, finish. */
export async function upload(lab: { call: (method: string, params?: unknown) => Promise<any> }, target: { kind: 'bot' | 'team'; id: string }, wav: Buffer) {
  const durationMs = Math.round(((wav.length - 44) / (VOICE_AUDIO.sampleRate * 2)) * 1000)
  const transfer = await lab.call('voice.upload.begin', {
    target,
    clientClipId: randomUUID(),
    sizeBytes: wav.length,
    durationMs,
    sha256: sha256(wav),
  })
  for (let offset = 0; offset < wav.length; offset += VOICE_LIMITS.chunkBytes)
    await lab.call('voice.upload.chunk', {
      transferId: transfer.transferId,
      offset,
      dataBase64: wav.subarray(offset, Math.min(offset + VOICE_LIMITS.chunkBytes, wav.length)).toString('base64'),
    })
  return { transfer, clip: await lab.call('voice.upload.finish', { transferId: transfer.transferId }) }
}
