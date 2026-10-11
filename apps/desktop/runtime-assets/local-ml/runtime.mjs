// Stable entry point copied into each local-ml-runtime archive.
// Transformers.js models are downloaded lazily; the Whisper speech model is the separate whisper-model asset.
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
export { env, pipeline } from './node_modules/@xenova/transformers/src/transformers.js'

const require = createRequire(import.meta.url)
/** whisper.cpp N-API addon built for this archive's platform (Metal on macOS, CPU elsewhere). */
export function loadWhisper() {
  return require(`@fugood/node-whisper-${process.platform}-${process.arch}`)
}
/** Silero voice-activity model shipped inside the archive. */
export const vadModelPath = fileURLToPath(new URL('./models/ggml-silero-v6.2.0.bin', import.meta.url))
