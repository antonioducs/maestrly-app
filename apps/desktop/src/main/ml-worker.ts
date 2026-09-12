/**
 * Embedding utilityProcess runs transformers.js all-MiniLM-L6-v2 (ONNX, 384 dimensions) outside main
 * to prevent CPU inference from blocking IPC/UI. The on-demand local-ml-runtime provides its absolute
 * file URL. Since the worker has no Electron app module, main sends cacheDir/moduleUrl in init over
 * process.parentPort. Requests: init, embed {id,texts}, smoke. Responses: ready, embed:result
 * {id,vecs}, embed:error {id,error}, smoke:result {onnxValue,sharpBytes}, smoke:error {error}.
 */

import { createRequire } from 'node:module'

// Dependency-free 1D ONNX Identity model exercises the native backend without downloading a transformers.js
// model. Packaged smoke checks use the same worker as production RAG.
const TINY_IDENTITY_MODEL = Buffer.from(
  'CAg6SAoaCgFYEgFZGghpZWRudGl0eSIISWRlbnRpdHkSCGlkZW50aXR5Wg8KAVgSCgoICAESBAoCCAFiDwoBWRIKCggIARIECgIIAUICEA0=',
  'base64'
)

type Extractor = (
  texts: string[],
  opts: { pooling: 'mean'; normalize: boolean }
) => Promise<{ data: Float32Array; dims: number[] }>

let extractorPromise: Promise<Extractor> | null = null
let cacheDir = ''
let moduleUrl = ''

function getExtractor(): Promise<Extractor> {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      if (!moduleUrl.startsWith('file:')) throw new Error('Local ML runtime module URL was not initialized')
      const { pipeline, env } = (await import(moduleUrl)) as {
        pipeline: (task: string, model: string) => Promise<unknown>
        env: { allowLocalModels: boolean; cacheDir?: string }
      }
      env.allowLocalModels = false
      if (cacheDir) env.cacheDir = cacheDir // modelo cacheado no userData (baixa 1x)
      const ex = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2')
      return ex as unknown as Extractor
    })()
    // Do not cache load failures. Reset after transient download/cache errors so the next embed retries
    // instead of leaving a permanently failing worker.
    extractorPromise.catch(() => {
      extractorPromise = null
    })
  }
  return extractorPromise
}

type NativeSmokeRuntime = {
  InferenceSession: {
    create(model: Uint8Array): Promise<{
      run(feeds: Record<string, unknown>): Promise<Record<string, { data: ArrayLike<number> }>>
    }>
  }
  Tensor: new (type: string, data: Float32Array, dims: number[]) => unknown
}

type SharpFactory = (input: unknown) => { png(): { toBuffer(): Promise<Uint8Array> } }

async function smokeNativeRuntime(): Promise<{ onnxValue: number; sharpBytes: number }> {
  if (!moduleUrl.startsWith('file:')) throw new Error('Local ML runtime module URL was not initialized')
  const requireFromRuntime = createRequire(moduleUrl)
  const ort = requireFromRuntime('onnxruntime-node') as NativeSmokeRuntime
  const session = await ort.InferenceSession.create(TINY_IDENTITY_MODEL)
  const result = await session.run({ X: new ort.Tensor('float32', new Float32Array([7]), [1]) })
  const onnxValue = Number(result.Y?.data?.[0])
  if (onnxValue !== 7) throw new Error(`ONNX native smoke returned ${onnxValue}, expected 7`)

  const sharp = requireFromRuntime('sharp') as SharpFactory
  const png = await sharp({ create: { width: 1, height: 1, channels: 4, background: '#000' } })
    .png()
    .toBuffer()
  if (png.length === 0) throw new Error('Sharp native smoke returned an empty image')
  return { onnxValue, sharpBytes: png.length }
}

const parentPort = process.parentPort

parentPort.on('message', async (e) => {
  const msg = e.data as { type: string; id?: string; texts?: string[]; cacheDir?: string; moduleUrl?: string }
  if (msg.type === 'init') {
    cacheDir = msg.cacheDir ?? ''
    moduleUrl = msg.moduleUrl ?? ''
    parentPort.postMessage({ type: 'ready' })
    return
  }
  if (msg.type === 'smoke') {
    try {
      parentPort.postMessage({ type: 'smoke:result', ...(await smokeNativeRuntime()) })
    } catch (err) {
      parentPort.postMessage({ type: 'smoke:error', error: String((err as Error)?.message ?? err) })
    }
    return
  }
  if (msg.type === 'embed' && msg.id) {
    try {
      const ex = await getExtractor()
      const out = await ex(msg.texts ?? [], { pooling: 'mean', normalize: true })
      const dim = out.dims[1]!
      const vecs: number[][] = []
      for (let i = 0; i < out.dims[0]!; i++) vecs.push(Array.from(out.data.slice(i * dim, (i + 1) * dim)))
      parentPort.postMessage({ type: 'embed:result', id: msg.id, vecs })
    } catch (err) {
      parentPort.postMessage({ type: 'embed:error', id: msg.id, error: String((err as Error)?.message ?? err) })
    }
  }
})
