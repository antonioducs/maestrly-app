import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AsrWorkerClient, forkAsrWorker, inspectAsrBundle, resetAsrVerification } from '@maestrly/host-core'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const directories = []
test.after(async () => {
  resetAsrVerification()
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})
async function temporary(prefix) {
  const directory = await mkdtemp(path.join(tmpdir(), prefix))
  directories.push(directory)
  return directory
}

/**
 * A stand-in for the local inference runtime with the same shape as the real one. It asserts the
 * two properties that make local transcription local — remote loading disabled and models read
 * only from the bundle — and fails loudly if the worker ever stops setting them.
 *
 * This exercises the whole packaged path (build, verify, fork, protocol, cleaning) with real
 * files and a real child process. It does not exercise Whisper itself: that evidence comes from
 * the laboratory, with the real model and consented audio.
 */
const STAND_IN_RUNTIME = `export const env = {
  allowRemoteModels: true,
  allowLocalModels: false,
  localModelPath: '',
  cacheDir: '',
  backends: { onnx: { wasm: { numThreads: 1 }, numThreads: 1 } },
}
export const pipeline = async (task, model, options) => {
  if (task !== 'automatic-speech-recognition') throw new Error('unexpected task')
  if (env.allowRemoteModels) throw new Error('remote model loading was left enabled')
  if (!env.allowLocalModels) throw new Error('local model loading was left disabled')
  if (!env.localModelPath.endsWith('/models')) throw new Error('models were not pinned to the bundle')
  if (!options?.local_files_only) throw new Error('local_files_only was not requested')
  if (env.backends.onnx.wasm.numThreads !== 2) throw new Error('thread count was not applied')
  return async (samples) => {
    if (!(samples instanceof Float32Array)) throw new Error('samples did not survive the IPC hop')
    return { text: '  Toda segunda às nove, prepare esse resumo. [BLANK_AUDIO] ' }
  }
}
`
async function bundle() {
  const input = await temporary('asr-input-')
  await mkdir(path.join(input, 'runtime'), { recursive: true })
  await mkdir(path.join(input, 'model'), { recursive: true })
  await writeFile(path.join(input, 'runtime', 'runtime.mjs'), STAND_IN_RUNTIME)
  await writeFile(path.join(input, 'model', 'weights.bin'), 'fixture weights')
  const out = path.join(await temporary('asr-bundle-'), 'bundle')
  const { spawnSync } = await import('node:child_process')
  const result = spawnSync(
    process.execPath,
    [
      path.join(root, 'scripts/build-host-asr.mjs'),
      '--runtime',
      path.join(input, 'runtime'),
      '--model',
      path.join(input, 'model'),
      '--model-id',
      'fixture/whisper-base',
      '--out',
      out,
    ],
    { encoding: 'utf8' }
  )
  assert.equal(result.status, 0, result.stderr)
  return out
}

test('the packaged worker runs as its own process and reads models only from its bundle', async (t) => {
  const directory = await bundle()
  const state = inspectAsrBundle(directory)
  assert.equal(state.state, 'ready')
  assert.equal(state.modelId, 'fixture/whisper-base')

  const worker = new AsrWorkerClient(() => state.bundle, { factory: forkAsrWorker(), idleMs: 20_000, timeoutMs: 20_000 })
  t.after(() => worker.close())
  const samples = new Float32Array(16_000 * 2)
  for (let index = 0; index < samples.length; index++) samples[index] = Math.sin(index / 8) * 0.4

  const cold = await worker.transcribe('job-1', samples)
  // The stand-in runtime throws unless every local-only guarantee was applied, so reaching a
  // transcript at all is the assertion.
  assert.equal(cold.failureCode, undefined, cold.message)
  // Non-speech markers are removed, real words are not.
  assert.equal(cold.text, 'Toda segunda às nove, prepare esse resumo.')

  // The same worker serves the next job without loading anything again.
  const warm = await worker.transcribe('job-2', samples)
  assert.equal(warm.text, cold.text)
})

test('the model is laid out under its own identifier, where the runtime looks for it', async () => {
  const directory = await bundle()
  // `fixture/whisper-base` must become `models/fixture/whisper-base`. Flattening it into
  // `models/fixture_whisper-base` produces a bundle that verifies and then finds no model at all.
  assert.equal(existsSync(path.join(directory, 'models', 'fixture', 'whisper-base', 'weights.bin')), true)
  assert.equal(existsSync(path.join(directory, 'models', 'fixture_whisper-base')), false)
  const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'))
  assert.ok(manifest.files.some((file) => file.path === 'models/fixture/whisper-base/weights.bin'))
})

test('a bundle whose files were changed never starts a worker', async () => {
  const directory = await bundle()
  resetAsrVerification()
  await writeFile(path.join(directory, 'models', 'fixture', 'whisper-base', 'weights.bin'), 'tampered weights')
  const state = inspectAsrBundle(directory)
  assert.equal(state.state, 'incompatible')
  const worker = new AsrWorkerClient(() => state.bundle, { factory: forkAsrWorker() })
  const outcome = await worker.transcribe('job-1', new Float32Array(1_600))
  assert.equal(outcome.failureCode, 'ASR_MODEL_MISSING')
  worker.close()
})

test('the worker refuses to start without a bundle directory it can trust', async () => {
  const directory = await bundle()
  const state = inspectAsrBundle(directory)
  const { spawnSync } = await import('node:child_process')
  // No bundle root: the worker says so and exits instead of guessing a location.
  const result = spawnSync(process.execPath, [state.bundle.entry], {
    env: { PATH: '/usr/bin:/bin', MAESTRLY_ASR_MODEL: 'fixture/whisper-base' },
    encoding: 'utf8',
  })
  assert.equal(result.status, 1)
  // A relative path is refused as well: only an absolute, verified directory is accepted.
  const relative = spawnSync(process.execPath, [state.bundle.entry], {
    env: { PATH: '/usr/bin:/bin', MAESTRLY_ASR_ROOT: 'models', MAESTRLY_ASR_MODEL: 'fixture/whisper-base' },
    encoding: 'utf8',
  })
  assert.equal(relative.status, 1)
})
