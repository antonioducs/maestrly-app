import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { app } from 'electron'
import type { ChatAttachmentInput, MessagePart } from '../../shared/chat'
import {
  MAX_ATTACHMENT_IMAGE_BYTES,
  MAX_ATTACHMENT_IMAGES_PER_MESSAGE,
  MAX_ATTACHMENT_IMAGE_BYTES_PER_MESSAGE,
  MAX_ATTACHMENT_TEXT_BYTES,
} from '../../shared/memory-policy'

export {
  MAX_ATTACHMENT_IMAGE_BYTES,
  MAX_ATTACHMENT_IMAGES_PER_MESSAGE,
  MAX_ATTACHMENT_IMAGE_BYTES_PER_MESSAGE,
  MAX_ATTACHMENT_TEXT_BYTES,
}

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

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/

export class AttachmentArtifactError extends Error {
  readonly name = 'AttachmentArtifactError'
}

function root(): string {
  return path.join(app.getPath('userData'), 'chat-attachment-images')
}

function conversationDir(conversationId: string): string {
  if (!SAFE_ID.test(conversationId)) throw new AttachmentArtifactError(`Invalid conversation id: ${conversationId}`)
  return path.join(root(), conversationId)
}

function sniff(buffer: Buffer): { mime: string; ext: string } | null {
  return MIME_BY_MAGIC.find((candidate) => candidate.match(buffer)) ?? null
}

function artifactPath(conversationId: string, artifactId: string): string | null {
  if (!SAFE_ID.test(artifactId)) return null
  const dir = conversationDir(conversationId)
  for (const { ext } of MIME_BY_MAGIC) {
    const candidate = path.join(dir, `${artifactId}.${ext}`)
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

export function decodeAttachmentImage(input: Uint8Array | string): { buffer: Buffer; mime: string; ext: string } {
  let buffer: Buffer
  if (typeof input === 'string') {
    const raw = input.trim()
    const payload = /^data:[^;,]*;base64,/i.test(raw) ? raw.slice(raw.indexOf(',') + 1) : raw
    const compact = payload.replace(/\s+/g, '')
    if (!compact || !/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) {
      throw new AttachmentArtifactError('The attachment is not valid base64.')
    }
    buffer = Buffer.from(compact, 'base64')
  } else {
    buffer = Buffer.from(input)
  }
  if (buffer.length === 0 || buffer.length > MAX_ATTACHMENT_IMAGE_BYTES) {
    throw new AttachmentArtifactError(`The attachment exceeds ${MAX_ATTACHMENT_IMAGE_BYTES} bytes.`)
  }
  const format = sniff(buffer)
  if (!format) throw new AttachmentArtifactError('The attachment is not a supported image format.')
  return { buffer, ...format }
}

export async function saveAttachmentImage(args: {
  conversationId: string
  bytes: Uint8Array | string
  label?: string
}): Promise<{ artifactId: string; mediaType: string; name: string; byteSize: number }> {
  const { buffer, mime, ext } = decodeAttachmentImage(args.bytes)
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
    throw error instanceof AttachmentArtifactError
      ? error
      : new AttachmentArtifactError(`Failed to store the attachment: ${(error as Error).message}`)
  }
  const base = (args.label ?? '')
    .trim()
    .replace(/[^\w.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return { artifactId, mediaType: mime, name: `${base || 'attachment'}.${ext}`, byteSize: buffer.length }
}

/**
 * Legacy image data URL embedded in a part — same write limit. Check encoded length
 * BEFORE Buffer.from: reject tampered/oversized payloads without allocating a huge buffer in main.
 */
export function decodeLegacyAttachmentData(
  data: string | undefined
): { bytes: Buffer; mediaType: string } | null {
  if (typeof data !== 'string') return null
  const match = /^data:([^;,]+);base64,([\s\S]+)$/i.exec(data)
  if (!match) return null
  const encoded = match[2]!.replace(/\s+/g, '')
  if (!encoded || encoded.length > Math.ceil(MAX_ATTACHMENT_IMAGE_BYTES / 3) * 4) return null
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return null
  const bytes = Buffer.from(encoded, 'base64')
  if (bytes.length === 0 || bytes.length > MAX_ATTACHMENT_IMAGE_BYTES) return null
  return { bytes, mediaType: match[1]! }
}

function validArtifactStat(stat: { size: number; isFile: () => boolean; isSymbolicLink: () => boolean }, expectedByteSize: number | null): boolean {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0 || stat.size > MAX_ATTACHMENT_IMAGE_BYTES) return false
  if (expectedByteSize !== null && stat.size !== expectedByteSize) return false
  return true
}

function expectedOf(byteSize: unknown): number | null {
  return typeof byteSize === 'number' && Number.isSafeInteger(byteSize) && byteSize > 0 ? byteSize : null
}

export async function readAttachmentImage(
  conversationId: string,
  artifactId: string,
  expectedByteSize?: number
): Promise<
  | { ok: true; bytes: Uint8Array; mediaType: string; byteSize: number }
  | { ok: false; error: 'not-found' | 'unreadable' | 'invalid' }
> {
  let file: string | null
  try {
    file = artifactPath(conversationId, artifactId)
  } catch {
    return { ok: false, error: 'invalid' }
  }
  if (!file) return { ok: false, error: 'not-found' }
  const expected = expectedOf(expectedByteSize)
  // Preflight via lstat: reject replaced/tampered sidecars (symlink, non-file, zero size, oversized, metadata
  // mismatch) WITHOUT loading bytes — the same bounded contract as writes.
  try {
    const stat = await fsp.lstat(file)
    if (!validArtifactStat(stat, expected)) return { ok: false, error: 'invalid' }
  } catch {
    return { ok: false, error: 'unreadable' }
  }
  let buffer: Buffer
  try {
    buffer = await fsp.readFile(file)
  } catch {
    return { ok: false, error: 'unreadable' }
  }
  // Revalidate AFTER reading: the file may change between lstat and readFile.
  if (buffer.length === 0 || buffer.length > MAX_ATTACHMENT_IMAGE_BYTES) return { ok: false, error: 'invalid' }
  if (expected !== null && buffer.length !== expected) return { ok: false, error: 'invalid' }
  const format = sniff(buffer)
  if (!format) return { ok: false, error: 'invalid' }
  return { ok: true, bytes: buffer, mediaType: format.mime, byteSize: buffer.length }
}

export async function deleteAttachmentImages(conversationId: string, artifactIds: readonly string[]): Promise<void> {
  for (const artifactId of artifactIds) {
    try {
      const file = artifactPath(conversationId, artifactId)
      if (file) await fsp.rm(file, { force: true })
    } catch {
      /* orphan is better than failing cleanup */
    }
  }
}

export async function deleteConversationAttachmentImages(conversationId: string): Promise<void> {
  try {
    await fsp.rm(conversationDir(conversationId), { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
}

export function resolveFileImageBytesSync(
  conversationId: string,
  part: { artifactId?: string; data?: string; byteSize?: number }
): { bytes: Uint8Array; mediaType: string } | null {
  if (part.artifactId) {
    try {
      const file = artifactPath(conversationId, part.artifactId)
      if (!file) return null
      const expected = expectedOf(part.byteSize)
      const stat = fs.lstatSync(file)
      if (!validArtifactStat(stat, expected)) return null
      const buffer = fs.readFileSync(file)
      if (buffer.length === 0 || buffer.length > MAX_ATTACHMENT_IMAGE_BYTES) return null
      if (expected !== null && buffer.length !== expected) return null
      const format = sniff(buffer)
      if (!format) return null
      return { bytes: buffer, mediaType: format.mime }
    } catch {
      return null
    }
  }
  return decodeLegacyAttachmentData(part.data)
}

export async function resolveFileImageBytes(
  conversationId: string,
  part: { artifactId?: string; data?: string; byteSize?: number }
): Promise<{ bytes: Uint8Array; mediaType: string } | null> {
  if (part.artifactId) {
    const stored = await readAttachmentImage(conversationId, part.artifactId, part.byteSize)
    return stored.ok ? { bytes: stored.bytes, mediaType: stored.mediaType } : null
  }
  return decodeLegacyAttachmentData(part.data)
}

export async function reconcileOrphanAttachmentTmp(conversationId?: string): Promise<void> {
  const dirs = conversationId ? [conversationDir(conversationId)] : [root()]
  for (const dir of dirs) {
    try {
      const entries = await fsp.readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith('.tmp')) {
          await fsp.rm(path.join(dir, entry.name), { force: true }).catch(() => {})
        }
      }
    } catch {
      /* missing root is fine */
    }
  }
}

/**
 * Rebuilds message attachments for resend (edit+resend). Truncating the original message
 * (`deleteChatMessagesFrom`) removes image sidecars — reusing `artifactId` would point the new message
 * to a deleted file. COPY image bytes BEFORE truncation; startSend creates a NEW
 * artifact owned by the rewritten message. Discard unreadable attachments (already broken
 * in the original); retain interpreter descriptions already paid for.
 */
export async function preserveResendAttachments(
  conversationId: string,
  parts: readonly Extract<MessagePart, { type: 'file' }>[]
): Promise<ChatAttachmentInput[]> {
  const out: ChatAttachmentInput[] = []
  for (const p of parts) {
    if (p.kind === 'text') {
      out.push({
        name: p.name,
        mediaType: p.mediaType,
        kind: 'text',
        ...(p.data ? { data: p.data } : {}),
        ...(p.description ? { description: p.description } : {}),
        ...(p.descriptionModel ? { descriptionModel: p.descriptionModel } : {}),
      })
      continue
    }
    if (p.artifactId) {
      const stored = await readAttachmentImage(conversationId, p.artifactId, p.byteSize)
      if (stored.ok) {
        out.push({
          name: p.name,
          mediaType: p.mediaType,
          kind: 'image',
          bytes: stored.bytes,
          ...(p.description ? { description: p.description } : {}),
          ...(p.descriptionModel ? { descriptionModel: p.descriptionModel } : {}),
        })
      }
      continue
    }
    out.push({
      name: p.name,
      mediaType: p.mediaType,
      kind: 'image',
      ...(p.data ? { data: p.data } : {}),
      ...(p.description ? { description: p.description } : {}),
      ...(p.descriptionModel ? { descriptionModel: p.descriptionModel } : {}),
    })
  }
  return out
}
