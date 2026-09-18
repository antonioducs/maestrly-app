import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { z } from 'zod'

/**
 * Discovery and verification of the local speech-recognition bundle.
 *
 * The Host runs the bundle it was given, not whatever happens to be on disk. A manifest lists
 * every file with its digest; the worker is only allowed to start after those digests match,
 * and the worker itself is told to load models exclusively from this verified directory with
 * remote loading disabled. That is what makes "the audio stays on your computer" a property
 * of the system rather than a promise in a settings screen.
 */
export const asrManifestSchema = z.strictObject({
  version: z.literal(1),
  modelId: z.string().min(1).max(80),
  runtimeVersion: z.string().min(1).max(40),
  /** Entry point, relative to the bundle root; never an absolute path from a caller. */
  entry: z.string().min(1).max(200),
  /**
   * One entry per file, because verification is per file. A real inference runtime is not a
   * handful of files: the ONNX build alone ships hundreds of native and JavaScript artifacts, and
   * the first bundle assembled from the shipped runtime had 864. The cap has room to grow and is
   * still bounded, so a malformed manifest cannot ask the Host to hash an unbounded list.
   */
  files: z
    .array(z.strictObject({ path: z.string().min(1).max(300), sha256: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().int().nonnegative() }))
    .min(1)
    .max(4_000),
})
export type AsrManifest = z.infer<typeof asrManifestSchema>

export interface AsrBundle {
  root: string
  entry: string
  modelId: string
  runtimeVersion: string
  bytes: number
}
export interface AsrBundleState {
  state: 'ready' | 'missing' | 'incompatible'
  bundle?: AsrBundle
  modelId?: string
  reason?: string
  downloadBytes?: number
}

/**
 * Shape of a path inside the bundle. Scoped npm packages are ordinary here — a real inference
 * runtime ships `node_modules/@huggingface/...` — so `@` and `+` are allowed. This is defence in
 * depth only: what actually keeps the read inside the bundle is resolving against the root and
 * refusing anything that is not a regular file.
 */
const RELATIVE_SAFE = /^[A-Za-z0-9@][A-Za-z0-9._+\-/@]*$/

/** Refuses anything that could reach outside the bundle: absolute paths, `..`, links. */
function resolveInside(root: string, relative: string) {
  if (!RELATIVE_SAFE.test(relative) || relative.includes('..')) throw new Error(`Unsafe bundle path: ${relative}`)
  const target = resolve(root, relative)
  if (!target.startsWith(`${root}/`)) throw new Error(`Bundle path escapes the bundle: ${relative}`)
  const info = lstatSync(target)
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Bundle entry is not a regular file: ${relative}`)
  return target
}

/**
 * Inspects a bundle directory. Verification is complete but memoised per manifest digest, so
 * a Host that transcribes all day does not re-hash a model file for every recording.
 */
const verified = new Map<string, string>()
export function inspectAsrBundle(directory?: string): AsrBundleState {
  if (!directory) return { state: 'missing', reason: 'Nenhum pacote de transcrição foi instalado neste Host.' }
  if (!isAbsolute(directory)) return { state: 'incompatible', reason: 'O caminho do pacote de transcrição precisa ser absoluto.' }
  const manifestPath = join(directory, 'manifest.json')
  /**
   * "Not installed" and "installed but unreadable" look identical to `existsSync`, and the
   * difference is everything: the first asks an operator to install a bundle, the second tells
   * them the bundle is right there and this service cannot open it. The daemon does not run as
   * root, so a bundle extracted with root-only permissions produces exactly this — and reporting
   * it as missing sends whoever is debugging to look in the wrong place.
   */
  let raw: string
  try {
    raw = readFileSync(manifestPath, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return { state: 'missing', reason: 'Nenhum pacote de transcrição foi instalado neste Host.' }
    if (code === 'EACCES' || code === 'EPERM')
      return {
        state: 'incompatible',
        reason: `O pacote de transcrição existe em ${directory}, mas este serviço não tem permissão para lê-lo. Os arquivos precisam ser legíveis pela conta que executa o Host.`,
      }
    return { state: 'incompatible', reason: `Não foi possível ler o pacote de transcrição: ${code ?? 'erro desconhecido'}.` }
  }
  try {
    const manifest = asrManifestSchema.parse(JSON.parse(raw))
    const root = resolve(directory)
    const manifestDigest = createHash('sha256').update(raw).digest('hex')
    const bytes = manifest.files.reduce((sum, file) => sum + file.bytes, 0)
    if (verified.get(root) !== manifestDigest) {
      for (const file of manifest.files) {
        const target = resolveInside(root, file.path)
        const size = statSync(target).size
        if (size !== file.bytes) throw new Error(`Bundle file has unexpected size: ${file.path}`)
        const digest = createHash('sha256').update(readFileSync(target)).digest('hex')
        if (digest !== file.sha256) throw new Error(`Bundle file failed verification: ${file.path}`)
      }
      verified.set(root, manifestDigest)
    }
    return {
      state: 'ready',
      modelId: manifest.modelId,
      bundle: { root, entry: resolveInside(root, manifest.entry), modelId: manifest.modelId, runtimeVersion: manifest.runtimeVersion, bytes },
    }
  } catch (error) {
    return { state: 'incompatible', reason: error instanceof Error ? error.message.slice(0, 300) : 'Pacote de transcrição inválido.' }
  }
}
/** Test seam: forget what was verified, so a tampered bundle is re-checked. */
export function resetAsrVerification() {
  verified.clear()
}
