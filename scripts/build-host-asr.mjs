#!/usr/bin/env node
/**
 * Builds the speech-recognition bundle a Host installs to transcribe voice messages locally.
 *
 * The output is deliberately self-contained and verifiable: the worker entry point, the
 * inference runtime and the model weights, plus a manifest that lists every file with its
 * digest. The Host re-checks that manifest before it starts a worker, and the worker is
 * configured to read models only from this directory with remote loading disabled — which is
 * what makes "the audio stays on your computer" true rather than aspirational.
 *
 * Nothing here downloads anything. The runtime and the model are inputs an operator supplies
 * explicitly, so a build cannot quietly pull unverified weights off the internet.
 *
 * Usage:
 *   node scripts/build-host-asr.mjs --runtime <dir> --model <dir> --model-id <id> [--out <dir>]
 *   node scripts/build-host-asr.mjs --check <dir>
 */
import { createHash } from 'node:crypto'
import { chmod, cp, mkdir, readFile, readdir, rm, writeFile, lstat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const MANIFEST_VERSION = 1
/** Files the worker needs from the inference runtime; everything else is copied as found. */
export const RUNTIME_ENTRY = 'runtime.mjs'

function parseArgs(argv) {
  const args = {}
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]
    if (!flag.startsWith('--')) continue
    const key = flag.slice(2)
    const value = argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[++index] : 'true'
    args[key] = value
  }
  return args
}
const digest = (buffer) => createHash('sha256').update(buffer).digest('hex')

/** Every regular file under a directory, as bundle-relative POSIX paths, sorted. */
export async function listFiles(directory, prefix = '') {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    const absolute = path.join(directory, entry.name)
    const info = await lstat(absolute)
    // A symbolic link inside a verified bundle is a way out of it; refuse instead of following.
    if (info.isSymbolicLink()) throw new Error(`BUNDLE_SYMLINK: ${relative}`)
    if (info.isDirectory()) files.push(...(await listFiles(absolute, relative)))
    else if (info.isFile()) files.push(relative)
  }
  return files
}

/** Directories the service must be able to enter, files it must be able to read, nothing writable. */
export const DIRECTORY_MODE = 0o755
export const FILE_MODE = 0o644
export async function normalizePermissions(directory) {
  await chmod(directory, DIRECTORY_MODE)
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) await normalizePermissions(absolute)
    else if (entry.isFile()) await chmod(absolute, FILE_MODE)
  }
}

/**
 * Every file readable by the service account, and no file writable by anyone but root. This is
 * checked as part of verification because the failure it catches is silent: the Host installs the
 * bundle, cannot read it, and simply stops advertising that it can transcribe.
 */
export async function checkPermissions(directory) {
  const info = await lstat(directory)
  if ((info.mode & 0o005) !== 0o005) throw new Error(`BUNDLE_DIRECTORY_UNREADABLE: ${directory}`)
  if ((info.mode & 0o022) !== 0) throw new Error(`BUNDLE_DIRECTORY_WRITABLE: ${directory}`)
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) await checkPermissions(absolute)
    else if (entry.isFile()) {
      const file = await lstat(absolute)
      if ((file.mode & 0o004) !== 0o004) throw new Error(`BUNDLE_FILE_UNREADABLE: ${absolute}`)
      if ((file.mode & 0o022) !== 0) throw new Error(`BUNDLE_FILE_WRITABLE: ${absolute}`)
    }
  }
}

/** Recomputes every digest of an existing bundle; this is what the Host does before starting a worker. */
export async function verifyBundle(directory) {
  const manifestPath = path.join(directory, 'manifest.json')
  if (!existsSync(manifestPath)) throw new Error('BUNDLE_MANIFEST_MISSING')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  if (manifest.version !== MANIFEST_VERSION) throw new Error('BUNDLE_MANIFEST_VERSION')
  if (!manifest.modelId || !manifest.entry) throw new Error('BUNDLE_MANIFEST_INCOMPLETE')
  const listed = new Set(manifest.files.map((file) => file.path))
  const present = new Set(await listFiles(directory))
  present.delete('manifest.json')
  for (const file of present) if (!listed.has(file)) throw new Error(`BUNDLE_UNLISTED_FILE: ${file}`)
  await checkPermissions(directory)
  for (const file of manifest.files) {
    const absolute = path.join(directory, file.path)
    if (!existsSync(absolute)) throw new Error(`BUNDLE_FILE_MISSING: ${file.path}`)
    const bytes = await readFile(absolute)
    if (bytes.length !== file.bytes) throw new Error(`BUNDLE_FILE_SIZE: ${file.path}`)
    if (digest(bytes) !== file.sha256) throw new Error(`BUNDLE_FILE_DIGEST: ${file.path}`)
  }
  return manifest
}

async function build(args) {
  const runtime = args.runtime && path.resolve(args.runtime)
  const model = args.model && path.resolve(args.model)
  const modelId = args['model-id']
  if (!runtime || !model || !modelId)
    throw new Error(
      'ASR_INPUTS_REQUIRED: pass --runtime <local-ml runtime dir> --model <model dir> --model-id <id>. This build never downloads weights; supply them explicitly.'
    )
  if (!existsSync(path.join(runtime, RUNTIME_ENTRY))) throw new Error(`ASR_RUNTIME_ENTRY_MISSING: ${RUNTIME_ENTRY}`)
  const out = path.resolve(args.out ?? path.join(root, 'dist', 'maestrly-host-asr'))
  await rm(out, { recursive: true, force: true })
  await mkdir(out, { recursive: true, mode: 0o755 })

  // The worker is bundled from this repository, not taken from the inputs: the executable part
  // of the bundle is ours, and the inputs only ever provide the runtime and the weights.
  const esbuild = await import('esbuild')
  await esbuild.build({
    entryPoints: [path.join(root, 'apps/host/src/asr-worker.ts')],
    outfile: path.join(out, 'worker.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    // The inference runtime is loaded at runtime from the verified bundle directory, by path.
    external: ['./runtime.mjs'],
    banner: { js: '// Maestrly Host ASR worker. Models are read only from this verified bundle.' },
  })
  await cp(runtime, out, { recursive: true, dereference: true })
  // The inference runtime resolves a model by its own identifier under the local model path, so
  // `Xenova/whisper-base` has to land in `models/Xenova/whisper-base`. Flattening the identifier
  // produced a bundle that verified perfectly and then found no model at all; every segment is
  // validated instead, which keeps the copy inside the bundle without rewriting the path.
  const segments = modelId.split('/')
  if (segments.length > 2 || segments.some((segment) => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment)))
    throw new Error(`ASR_MODEL_ID_INVALID: ${modelId}`)
  await mkdir(path.join(out, 'models'), { recursive: true, mode: 0o755 })
  await cp(model, path.join(out, 'models', ...segments), { recursive: true, dereference: true })
  // The Host daemon does not run as root: it runs as its own unprivileged service account, and it
  // has to read every file here to verify the bundle before starting a worker. `cp` preserves the
  // modes of wherever the runtime and the weights came from, so the copy is normalised explicitly:
  // root-owned, readable by the service, writable by nobody else. A bundle that only root can read
  // installs perfectly and then makes the Host report that it cannot transcribe.
  await normalizePermissions(out)

  const files = (await listFiles(out)).filter((file) => file !== 'manifest.json')
  const described = []
  for (const file of files) {
    const bytes = await readFile(path.join(out, file))
    described.push({ path: file, sha256: digest(bytes), bytes: bytes.length })
  }
  const runtimeVersion = JSON.parse(await readFile(path.join(root, 'apps/host/package.json'), 'utf8')).version
  const manifest = { version: MANIFEST_VERSION, modelId, runtimeVersion, entry: 'worker.mjs', files: described }
  await writeFile(path.join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  await verifyBundle(out)
  const total = described.reduce((sum, file) => sum + file.bytes, 0)
  process.stdout.write(`${JSON.stringify({ out, modelId, files: described.length, bytes: total }, null, 2)}\n`)
  return out
}

// Comparing raw strings breaks when the script is invoked by a relative path, which is exactly
// how `npm run` calls it; resolving both sides is what makes the entry point actually run.
if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? '')).href) {
  const args = parseArgs(process.argv.slice(2))
  const run =
    args.check && args.check !== 'true'
      ? verifyBundle(path.resolve(args.check)).then((manifest) =>
          process.stdout.write(`${JSON.stringify(manifest.modelId)} verified\n`)
        )
      : build(args)
  run.catch((error) => {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  })
}
