import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { listFiles, verifyBundle } from '../scripts/build-host-asr.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (relative) => readFile(path.join(root, relative), 'utf8')
const digest = (value) => createHash('sha256').update(value).digest('hex')
const directories = []
async function temporary() {
  const directory = await mkdtemp(path.join(tmpdir(), 'asr-bundle-'))
  directories.push(directory)
  return directory
}
test.after(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})
async function bundle(overrides = {}) {
  const directory = await temporary()
  const entry = 'export const worker = true\n'
  const weights = 'fixture-weights'
  await writeFile(path.join(directory, 'worker.mjs'), entry)
  await mkdir(path.join(directory, 'models'), { recursive: true })
  await writeFile(path.join(directory, 'models', 'weights.bin'), weights)
  await writeFile(
    path.join(directory, 'manifest.json'),
    JSON.stringify({
      version: 1,
      modelId: 'fixture/whisper-base',
      runtimeVersion: '0.3.0',
      entry: 'worker.mjs',
      files: [
        { path: 'worker.mjs', sha256: digest(entry), bytes: entry.length },
        { path: 'models/weights.bin', sha256: digest(weights), bytes: weights.length },
      ],
      ...overrides,
    })
  )
  // The build leaves a bundle the service account can read; a fixture created by `mkdtemp` is
  // owner-only, which verification now (correctly) refuses.
  await chmod(directory, 0o755)
  await chmod(path.join(directory, 'models'), 0o755)
  for (const file of ['worker.mjs', 'manifest.json', 'models/weights.bin']) await chmod(path.join(directory, file), 0o644)
  return directory
}

test('the bundle build never downloads weights and refuses to run without explicit inputs', async () => {
  const builder = await read('scripts/build-host-asr.mjs')
  // No network of any kind: the operator supplies the runtime and the model.
  assert.doesNotMatch(builder, /fetch\(|https?:\/\/[a-z]|curl|wget/i)
  assert.match(builder, /ASR_INPUTS_REQUIRED/)
  // The executable part of the bundle comes from this repository, not from the inputs.
  assert.match(builder, /apps\/host\/src\/asr-worker\.ts/)
})

test('a bundle verifies only when every file matches its manifest', async () => {
  const directory = await bundle()
  const manifest = await verifyBundle(directory)
  assert.equal(manifest.modelId, 'fixture/whisper-base')

  // A tampered weight file is refused, which is the whole point of the manifest — including
  // the subtle case where somebody kept the size identical.
  await writeFile(path.join(directory, 'models', 'weights.bin'), 'different weights')
  await assert.rejects(verifyBundle(directory), /BUNDLE_FILE_SIZE/)
  await writeFile(path.join(directory, 'models', 'weights.bin'), 'fixture-WEIGHTS')
  await assert.rejects(verifyBundle(directory), /BUNDLE_FILE_DIGEST/)
})

test('a bundle the service account cannot read is refused, not silently accepted', async () => {
  const directory = await bundle()
  await verifyBundle(directory)
  // This is the failure that actually happened on the laboratory Host: the bundle was installed
  // root-only, the daemon could not read a byte of it, and voice simply never became available.
  await chmod(directory, 0o700)
  await assert.rejects(verifyBundle(directory), /BUNDLE_DIRECTORY_UNREADABLE/)
  await chmod(directory, 0o755)
  // A file anyone could rewrite is refused too: verification would prove nothing afterwards.
  await chmod(path.join(directory, 'worker.mjs'), 0o666)
  await assert.rejects(verifyBundle(directory), /BUNDLE_FILE_WRITABLE/)
})

test('a file nobody listed cannot ride along inside a verified bundle', async () => {
  const directory = await bundle()
  await writeFile(path.join(directory, 'extra.mjs'), 'export const surprise = true\n')
  await assert.rejects(verifyBundle(directory), /BUNDLE_UNLISTED_FILE/)
})

test('a missing file is reported instead of being skipped', async () => {
  const directory = await bundle()
  await rm(path.join(directory, 'models', 'weights.bin'))
  await assert.rejects(verifyBundle(directory), /BUNDLE_FILE_MISSING/)
})

test('a symbolic link is a way out of the bundle and is refused', async () => {
  const directory = await temporary()
  await writeFile(path.join(directory, 'worker.mjs'), 'export const worker = true\n')
  await symlink('/bin/sh', path.join(directory, 'shell'))
  await assert.rejects(listFiles(directory), /BUNDLE_SYMLINK/)
})

test('the worker reads models only from its own bundle and never logs what it heard', async () => {
  const worker = await read('apps/host/src/asr-worker.ts')
  assert.match(worker, /allowRemoteModels = false/)
  assert.match(worker, /localModelPath/)
  assert.match(worker, /local_files_only: true/)
  // The old desktop worker downloaded weights during inference; this one must not.
  assert.doesNotMatch(worker, /allowLocalModels = false/)
  assert.doesNotMatch(worker, /fetch\(|https?:\/\/[a-z]/i)
  // No transcript, no audio and no path ever reaches a log.
  assert.doesNotMatch(worker, /console\.(log|info|warn|error)/)
  assert.match(worker, /ASR_NO_SPEECH/)
})

test('the worker process gets a minimal environment and no Host state', async () => {
  const factory = await read('packages/host-core/src/voice/worker-process.ts')
  assert.match(factory, /serialization: 'advanced'/)
  assert.match(factory, /MAESTRLY_ASR_ROOT/)
  // stdout and stderr are not inherited: a stray print must not land in the Host log.
  assert.match(factory, /stdio: \['ignore', 'ignore', 'pipe', 'ipc'\]/)
  assert.doesNotMatch(factory, /\.\.\.process\.env/)
  assert.match(factory, /SIGKILL/)
})

test('the Host only enables voice from a root-owned configured directory', async () => {
  const main = await read('apps/host/src/main.ts')
  assert.match(main, /asrBundleDirectory/)
  assert.match(main, /Invalid ASR bundle directory/)
  assert.match(main, /\/Library\/MaestrlyHost\//)
  const service = await read('packages/host-core/src/service.ts')
  // The capability is advertised only when transcription can actually happen.
  assert.match(service, /voice\.status\(\)\.available \? \[VOICE_HOST_CAPABILITY\]/)
})
