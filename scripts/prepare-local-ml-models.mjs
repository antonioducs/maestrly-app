#!/usr/bin/env node
// Populate a transferable model cache directly from the upstream model host.
import path from 'node:path'
import { mkdir } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

const args = process.argv.slice(2)
const cacheIndex = args.indexOf('--cache-dir')
if (cacheIndex < 0 || !args[cacheIndex + 1] || args[cacheIndex + 1].startsWith('--')) {
  throw new Error('Usage: node scripts/prepare-local-ml-models.mjs --cache-dir <directory> [--offline]')
}
const cacheDir = path.resolve(args[cacheIndex + 1])
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'desktop')
const { env, pipeline } = await import(
  pathToFileURL(path.join(root, 'runtime-assets/local-ml/node_modules/@xenova/transformers/src/transformers.js')).href
)
const offline = args.includes('--offline')
env.allowLocalModels = offline
env.allowRemoteModels = !offline
if (offline) {
  env.localModelPath = cacheDir
  globalThis.fetch = async () => {
    throw new Error('Network access is disabled during offline verification')
  }
}
env.cacheDir = cacheDir
await mkdir(cacheDir, { recursive: true })
for (const [task, model] of [
  ['feature-extraction', 'Xenova/all-MiniLM-L6-v2'],
  ['automatic-speech-recognition', 'Xenova/whisper-base'],
]) {
  console.log(`[local-ml-models] Preparing ${model}`)
  const instance = await pipeline(task, model)
  await instance.dispose()
}
console.log(`[local-ml-models] Both models loaded successfully from ${cacheDir}`)
