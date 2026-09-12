/**
 * Store for Codex-generated IMAGE artifacts, triggered by host-managed `generate_image`.
 *
 * Core rule: BYTES never enter SQLite. App-server returns base64; one 1024px PNG can exceed
 * 1 MB — persisting it in `parts_json` would inflate the DB and overflow the character limit of
 * future transcript reseeds (same 1 MB exec incident that motivated clipPersistedToolOutput).
 * Use app-owned files under `userData/chat-generated-images/<conversationId>/<artifactId>.<ext>`; parts store
 * only OPAQUE `artifactId`.
 *
 * Generate `artifactId` here (random hex), regex-validate on every read: the renderer never supplies
 * paths; no provider/DB value enters a path without passing the traversal guard.
 */
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { app } from 'electron'
import type { ChatGeneratedImageResult } from '../../shared/chat'

/** Deliberate caps: high-quality `gpt-image-2` outputs are a few MB; 32 MB provides ample room. */
export const MAX_GENERATED_IMAGE_BYTES = 32 * 1024 * 1024

/** Only formats renderer <img> can display (data URL uses this MIME). */
const MIME_BY_MAGIC: ReadonlyArray<{ mime: string; ext: string; match: (buf: Buffer) => boolean }> = [
  {
    mime: 'image/png',
    ext: 'png',
    match: (b) =>
      b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  { mime: 'image/jpeg', ext: 'jpg', match: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    mime: 'image/webp',
    ext: 'webp',
    match: (b) =>
      b.length >= 12 &&
      b.subarray(0, 4).toString('latin1') === 'RIFF' &&
      b.subarray(8, 12).toString('latin1') === 'WEBP',
  },
  { mime: 'image/gif', ext: 'gif', match: (b) => b.length >= 6 && b.subarray(0, 3).toString('latin1') === 'GIF' },
]

/** Handles/IDs accepted in path joins. randomBytes hex matches; reject separators, `..`, and empty values. */
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/

export interface StoredGeneratedImage {
  artifactId: string
  mediaType: string
  name: string
  byteSize: number
}

export interface MaterializedGeneratedImage {
  /** Cwd-relative path normalized with `/`, ready for use in agent code. */
  path: string
  existed: boolean
}

export class GeneratedImageError extends Error {
  readonly name = 'GeneratedImageError'
}

function root(): string {
  return path.join(app.getPath('userData'), 'chat-generated-images')
}

/** Conversation directory. Throws if ID is unsafe for path construction. */
function conversationDir(conversationId: string): string {
  if (!SAFE_ID.test(conversationId)) throw new GeneratedImageError(`Invalid conversation id: ${conversationId}`)
  return path.join(root(), conversationId)
}

/**
 * Resolves the requested destination WITHOUT disk access. Deliberately stricter than
 * `write`: generated assets may only be materialized INSIDE this conversation's worktree/cwd.
 */
export function resolveGeneratedImageOutputTarget(cwd: string, outputPath: string): string {
  const raw = typeof outputPath === 'string' ? outputPath.trim() : ''
  if (!raw) throw new GeneratedImageError('The generated image outputPath must not be empty.')
  if (raw.includes('\0') || path.isAbsolute(raw) || path.win32.isAbsolute(raw) || /^[A-Za-z]:/.test(raw)) {
    throw new GeneratedImageError('The generated image outputPath must be relative to the conversation worktree.')
  }
  if (/[\\/]$/.test(raw)) {
    throw new GeneratedImageError('The generated image outputPath must include a file name.')
  }
  // Models may emit Windows separators on macOS/Linux. Treat both as directory separators —
  // this produces the expected path and subjects `..\escape.png` to the SAME traversal guard.
  const requested = raw.replace(/[\\/]+/g, path.sep)
  const workspace = path.resolve(cwd)
  const target = path.resolve(workspace, requested)
  const relative = path.relative(workspace, target)
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new GeneratedImageError('The generated image outputPath must stay inside the conversation worktree.')
  }
  return target
}

/** Detects format by MAGIC BYTES — provider supplies no MIME; do not trust extensions/labels. */
function sniff(buffer: Buffer): { mime: string; ext: string } | null {
  return MIME_BY_MAGIC.find((candidate) => candidate.match(buffer)) ?? null
}

/**
 * Decodes app-server `result`. Accepts raw base64 and data URLs (`data:image/png;base64,...`) from
 * the two protocol forms. Rejects empty payloads, invalid base64, unknown formats, and oversized
 * data with EXPLICIT errors (caller renders a visible failure card, never silence).
 */
export function decodeGeneratedImage(result: string): { buffer: Buffer; mime: string; ext: string } {
  const raw = typeof result === 'string' ? result.trim() : ''
  if (!raw) throw new GeneratedImageError('The image generation result was empty.')
  const payload = /^data:[^;,]*;base64,/i.test(raw) ? raw.slice(raw.indexOf(',') + 1) : raw
  const compact = payload.replace(/\s+/g, '')
  // Preflight BEFORE Buffer.from: 4 base64 chars = 3 bytes; checking encoded length avoids
  // allocating a huge buffer merely to discover the payload exceeds the cap.
  if (compact.length > Math.ceil(MAX_GENERATED_IMAGE_BYTES / 3) * 4) {
    throw new GeneratedImageError(`The generated image exceeds ${MAX_GENERATED_IMAGE_BYTES} bytes.`)
  }
  if (!compact || !/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) {
    throw new GeneratedImageError('The image generation result was not valid base64.')
  }
  const buffer = Buffer.from(compact, 'base64')
  if (buffer.length === 0) throw new GeneratedImageError('The decoded image was empty.')
  if (buffer.length > MAX_GENERATED_IMAGE_BYTES) {
    throw new GeneratedImageError(`The generated image exceeds ${MAX_GENERATED_IMAGE_BYTES} bytes.`)
  }
  const format = sniff(buffer)
  if (!format) throw new GeneratedImageError('The generated image is not a supported image format.')
  return { buffer, ...format }
}

/**
 * Writes artifacts ATOMICALLY (same-directory tmp + rename): a mid-write crash never exposes
 * a partial file to an already-persisted part.
 */
export async function saveGeneratedImage(args: {
  conversationId: string
  result: string
  /** Display-name base; append the actual detected extension. */
  label?: string
}): Promise<StoredGeneratedImage> {
  const { buffer, mime, ext } = decodeGeneratedImage(args.result)
  const dir = conversationDir(args.conversationId)
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 })
  const artifactId = randomBytes(16).toString('hex')
  const target = path.join(dir, `${artifactId}.${ext}`)
  const tmp = `${target}.tmp`
  try {
    await fsp.writeFile(tmp, buffer, { mode: 0o600 })
    await fsp.rename(tmp, target)
  } catch (error) {
    await fsp.rm(tmp, { force: true }).catch(() => {})
    throw error instanceof GeneratedImageError
      ? error
      : new GeneratedImageError(`Failed to store the generated image: ${(error as Error).message}`)
  }
  const base = (args.label ?? '')
    .trim()
    .replace(/[^\w.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return {
    artifactId,
    mediaType: mime,
    name: `${base || 'generated-image'}.${ext}`,
    byteSize: buffer.length,
  }
}

/** Artifact path (handle only; discover extension in directory). null if absent. */
function artifactPath(conversationId: string, artifactId: string): string | null {
  if (!SAFE_ID.test(artifactId)) return null
  const dir = conversationDir(conversationId)
  for (const { ext } of MIME_BY_MAGIC) {
    const candidate = path.join(dir, `${artifactId}.${ext}`)
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

function pathIsInside(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(rootPath, candidatePath)
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

function outputTargetWithExtension(requestedTarget: string, extension: string): string {
  const parsed = path.parse(requestedTarget)
  return path.join(parsed.dir, `${parsed.name || 'generated-image'}.${extension}`)
}

/**
 * Destinations generation can actually create. Permission must cover all BEFORE generation, since
 * format is known only after runtime returns bytes. Requested extension comes first when valid.
 */
export function resolveGeneratedImageOutputCandidates(cwd: string, outputPath: string): string[] {
  const requestedTarget = resolveGeneratedImageOutputTarget(cwd, outputPath)
  const requestedExtension = path
    .extname(requestedTarget)
    .slice(1)
    .toLowerCase()
    .replace(/^jpeg$/, 'jpg')
  const supportedExtensions = MIME_BY_MAGIC.map(({ ext }) => ext)
  const extensions = supportedExtensions.includes(requestedExtension)
    ? [requestedExtension, ...supportedExtensions.filter((extension) => extension !== requestedExtension)]
    : supportedExtensions
  return extensions.map((extension) => outputTargetWithExtension(requestedTarget, extension))
}

async function assertDestinationInsideWorkspace(workspace: string, target: string): Promise<void> {
  let workspaceReal: string
  try {
    const stat = await fsp.stat(workspace)
    if (!stat.isDirectory()) throw new Error('cwd is not a directory')
    workspaceReal = await fsp.realpath(workspace)
  } catch (error) {
    throw new GeneratedImageError(`The conversation worktree is unavailable: ${(error as Error).message}`)
  }

  // Validate existing ancestor BEFORE mkdir: an intermediate symlink must not let creation escape.
  let ancestor = path.dirname(target)
  while (true) {
    try {
      const stat = await fsp.lstat(ancestor)
      if (!stat.isDirectory() && !stat.isSymbolicLink()) {
        throw new GeneratedImageError(`The generated image destination is not a directory: ${ancestor}`)
      }
      const real = await fsp.realpath(ancestor)
      if (!pathIsInside(workspaceReal, real)) {
        throw new GeneratedImageError('The generated image destination resolves outside the conversation worktree.')
      }
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = path.dirname(ancestor)
      if (parent === ancestor) {
        throw new GeneratedImageError('The generated image destination could not be resolved safely.')
      }
      ancestor = parent
    }
  }

  try {
    await fsp.mkdir(path.dirname(target), { recursive: true })
    const realDirectory = await fsp.realpath(path.dirname(target))
    if (!pathIsInside(workspaceReal, realDirectory)) {
      throw new GeneratedImageError('The generated image destination resolves outside the conversation worktree.')
    }
  } catch (error) {
    throw error instanceof GeneratedImageError
      ? error
      : new GeneratedImageError(`Failed to prepare the generated image destination: ${(error as Error).message}`)
  }
}

/**
 * Copies a validated sidecar to the project. Requested extension never lies: final destination uses
 * magic-byte-detected extension (`hero.webp` with PNG bytes becomes `hero.png`); return that ACTUAL path to the agent.
 */
export async function materializeGeneratedImage(args: {
  conversationId: string
  artifactId: string
  expectedByteSize?: number
  cwd: string
  outputPath: string
}): Promise<MaterializedGeneratedImage> {
  const requestedTarget = resolveGeneratedImageOutputTarget(args.cwd, args.outputPath)
  const source = artifactPath(args.conversationId, args.artifactId)
  if (!source) throw new GeneratedImageError('The generated image artifact was not found.')

  let buffer: Buffer
  try {
    const stat = await fsp.lstat(source)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0 || stat.size > MAX_GENERATED_IMAGE_BYTES) {
      throw new GeneratedImageError('The generated image artifact is invalid.')
    }
    if (
      typeof args.expectedByteSize === 'number' &&
      Number.isSafeInteger(args.expectedByteSize) &&
      args.expectedByteSize > 0 &&
      stat.size !== args.expectedByteSize
    ) {
      throw new GeneratedImageError('The generated image artifact size does not match its persisted metadata.')
    }
    buffer = await fsp.readFile(source)
  } catch (error) {
    throw error instanceof GeneratedImageError
      ? error
      : new GeneratedImageError(`Failed to read the generated image artifact: ${(error as Error).message}`)
  }
  if (buffer.length === 0 || buffer.length > MAX_GENERATED_IMAGE_BYTES) {
    throw new GeneratedImageError('The generated image artifact is invalid.')
  }
  if (
    typeof args.expectedByteSize === 'number' &&
    Number.isSafeInteger(args.expectedByteSize) &&
    args.expectedByteSize > 0 &&
    buffer.length !== args.expectedByteSize
  ) {
    throw new GeneratedImageError('The generated image artifact size does not match its persisted metadata.')
  }
  const format = sniff(buffer)
  if (!format) throw new GeneratedImageError('The generated image artifact is not a supported image format.')

  const target = outputTargetWithExtension(requestedTarget, format.ext)
  await assertDestinationInsideWorkspace(path.resolve(args.cwd), target)

  let existed = false
  try {
    const existing = await fsp.lstat(target)
    if (existing.isSymbolicLink() || !existing.isFile()) {
      throw new GeneratedImageError('The generated image destination is not a regular file.')
    }
    existed = true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${randomBytes(8).toString('hex')}.tmp`)
  try {
    await fsp.writeFile(tmp, buffer, { flag: 'wx', mode: 0o644 })
    await fsp.rename(tmp, target)
  } catch (error) {
    await fsp.rm(tmp, { force: true }).catch(() => {})
    throw error instanceof GeneratedImageError
      ? error
      : new GeneratedImageError(`Failed to write the generated image into the project: ${(error as Error).message}`)
  }

  return {
    path: path.relative(path.resolve(args.cwd), target).split(path.sep).join('/'),
    existed,
  }
}

/** Same contract sent to the renderer over `chat:generated-image`. */
export type ReadGeneratedImageResult = ChatGeneratedImageResult

/**
 * Reads a conversation artifact and returns a preview/download data URL. Revalidates magic bytes:
 * externally corrupted/replaced files must not become data URLs with false MIME types.
 */
export async function readGeneratedImage(
  conversationId: string,
  artifactId: string,
  expectedByteSize?: number
): Promise<ReadGeneratedImageResult> {
  const expected =
    typeof expectedByteSize === 'number' && Number.isSafeInteger(expectedByteSize) && expectedByteSize > 0
      ? expectedByteSize
      : null
  let file: string | null
  try {
    file = artifactPath(conversationId, artifactId)
  } catch {
    return { ok: false, error: 'invalid' }
  }
  if (!file) return { ok: false, error: 'not-found' }
  // Stat preflight: reject externally tampered oversized files WITHOUT loading bytes.
  try {
    const stat = await fsp.stat(file)
    if (stat.size === 0 || stat.size > MAX_GENERATED_IMAGE_BYTES) return { ok: false, error: 'invalid' }
    if (expected !== null && stat.size !== expected) return { ok: false, error: 'invalid' }
  } catch {
    return { ok: false, error: 'unreadable' }
  }
  let buffer: Buffer
  try {
    buffer = await fsp.readFile(file)
  } catch {
    return { ok: false, error: 'unreadable' }
  }
  if (buffer.length === 0 || buffer.length > MAX_GENERATED_IMAGE_BYTES) return { ok: false, error: 'invalid' }
  // Revalidate after reading too: the file may change between stat() and readFile().
  if (expected !== null && buffer.length !== expected) return { ok: false, error: 'invalid' }
  const format = sniff(buffer)
  if (!format) return { ok: false, error: 'invalid' }
  return {
    ok: true,
    bytes: buffer,
    mediaType: format.mime,
    byteSize: buffer.length,
  }
}

/** Removes specific artifacts (truncate history / delete message). Best-effort: never throws. */
export async function deleteGeneratedImages(conversationId: string, artifactIds: readonly string[]): Promise<void> {
  for (const artifactId of artifactIds) {
    try {
      const file = artifactPath(conversationId, artifactId)
      if (file) await fsp.rm(file, { force: true })
    } catch {
      // An orphan artifact is preferable to broken history cleanup.
    }
  }
}

/** Removes ALL conversation artifacts (clear chat / delete conversation). Best-effort: never throws. */
export async function deleteConversationGeneratedImages(conversationId: string): Promise<void> {
  try {
    await fsp.rm(conversationDir(conversationId), { recursive: true, force: true })
  } catch {
    // Likewise: best-effort cleanup.
  }
}
