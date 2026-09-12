// Stable entry point copied into each local-ml-runtime archive.
// Models are intentionally not bundled: transformers.js downloads them lazily into the app-owned cache.
export { env, pipeline } from './node_modules/@xenova/transformers/src/transformers.js'
