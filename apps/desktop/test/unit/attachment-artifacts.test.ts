import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Edit-and-resend regression for artifact-backed images (review loop round 1).
 * deleteChatMessagesFrom removes sidecars belonging to truncated messages.
 * Reusing the old artifactId would point the resent message at a deleted file.
 * preserveResendAttachments copies bytes before truncation; startSend writes
 * a new artifact owned by the replacement message from those bytes.
 */

const h = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', () => ({
  app: {
    getPath: () => h.userData,
    getName: () => 'agents-test',
    getVersion: () => '0.0.0-test',
    getLocale: () => 'en-US',
    getAppPath: () => h.userData,
    isPackaged: false,
    on: () => {},
    once: () => {},
  },
}))

const { freshDb, closeDb } = await import('../helpers/db')
const { makeConversation, makeWorkspace } = await import('../helpers/factories')
const {
  deleteChatMessagesFrom,
  findAttachmentImagePart,
  findAttachmentPdfPart,
  getChatMessage,
  getMessageSeq,
  upsertChatMessage,
} = await import('../../src/main/chat/chat-store')
const {
  AttachmentArtifactError,
  MAX_ATTACHMENT_IMAGE_BYTES,
  MAX_ATTACHMENT_PDF_BYTES,
  clearAttachmentPreviews,
  deleteAttachmentImages,
  deleteConversationAttachmentImages,
  materializePdfPreview,
  preserveResendAttachments,
  readAttachmentImage,
  readAttachmentPdf,
  resolveFileImageBytesSync,
  resolveFilePdfBytesSync,
  saveAttachmentImage,
  savePdfAttachment,
} = await import('../../src/main/chat/attachment-artifacts')

const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

const artifactFile = (conversationId: string, artifactId: string): string =>
  path.join(h.userData, 'chat-attachment-images', conversationId, `${artifactId}.png`)

/** Select visible file parts using the same filter as chat:resend. */
function filePartsOf(
  conversationId: string,
  messageId: string
): Extract<import('../../src/shared/chat').MessagePart, { type: 'file' }>[] {
  return (getChatMessage(conversationId, messageId)?.parts ?? []).filter(
    (p): p is Extract<import('../../src/shared/chat').MessagePart, { type: 'file' }> => p.type === 'file'
  )
}

beforeEach(() => {
  h.userData = mkdtempSync(path.join(os.tmpdir(), 'maestrly-attachment-store-'))
  freshDb()
})
afterEach(() => {
  closeDb()
  rmSync(h.userData, { recursive: true, force: true })
})

function chatConv(): { id: string } {
  const ws = makeWorkspace()
  return makeConversation(ws.id, { mode: 'local' })
}

/** User message paired with its artifact-backed image, as maintained by the app. */
async function addImageMessage(
  conversationId: string,
  messageId: string,
  createdAt = 1
): Promise<{ artifactId: string }> {
  const stored = await saveAttachmentImage({ conversationId, bytes: PNG_1X1, label: 'shot' })
  upsertChatMessage({
    id: messageId,
    conversationId,
    role: 'user',
    createdAt,
    parts: [
      {
        type: 'file',
        id: `${messageId}_img`,
        name: stored.name,
        mediaType: stored.mediaType,
        kind: 'image',
        artifactId: stored.artifactId,
        byteSize: stored.byteSize,
      },
    ],
  })
  return { artifactId: stored.artifactId }
}

describe('preserveResendAttachments (edit and resend)', () => {
  it('copies bytes before truncation so resend does not reference a deleted sidecar', async () => {
    const conv = chatConv()
    const original = await addImageMessage(conv.id, 'm1')

    const fileParts = filePartsOf(conv.id, 'm1')
    const attachments = await preserveResendAttachments(conv.id, fileParts)

    // Resend keeps bytes instead of the old artifactId, which truncation invalidates.
    expect(attachments).toHaveLength(1)
    expect(attachments[0]).toMatchObject({ kind: 'image' })
    expect(attachments[0]!.name).toContain('.png')
    expect(attachments[0]!.bytes).toBeInstanceOf(Uint8Array)
    expect(attachments[0]!.bytes!.byteLength).toBeGreaterThan(0)
    expect(attachments[0]!.artifactId).toBeUndefined()

    // Truncation removes the old message sidecar.
    const seq = getMessageSeq('m1')
    if (seq == null) throw new Error('missing seq')
    deleteChatMessagesFrom(conv.id, seq)
    await vi.waitFor(() => expect(existsSync(artifactFile(conv.id, original.artifactId))).toBe(false))

    // startSend rewrites the copied bytes into a new readable artifact.
    const restored = await saveAttachmentImage({ conversationId: conv.id, bytes: attachments[0]!.bytes! })
    expect(restored.artifactId).not.toBe(original.artifactId)
    expect(existsSync(artifactFile(conv.id, restored.artifactId))).toBe(true)
    expect((await readAttachmentImage(conv.id, restored.artifactId)).ok).toBe(true)
  })

  it('preserves the existing interpreter description and text file data', async () => {
    const conv = chatConv()
    const stored = await saveAttachmentImage({ conversationId: conv.id, bytes: PNG_1X1, label: 'shot' })
    upsertChatMessage({
      id: 'm1',
      conversationId: conv.id,
      role: 'user',
      createdAt: 1,
      parts: [
        {
          type: 'file',
          id: 'm1_img',
          name: stored.name,
          mediaType: stored.mediaType,
          kind: 'image',
          artifactId: stored.artifactId,
          byteSize: stored.byteSize,
          description: 'um pixel verde',
          descriptionModel: 'gpt-5.6-mini',
        },
        { type: 'file', id: 'm1_txt', name: 'notas.txt', mediaType: 'text/plain', kind: 'text', data: 'conteúdo' },
      ],
    })

    const fileParts = filePartsOf(conv.id, 'm1')
    const attachments = await preserveResendAttachments(conv.id, fileParts)

    expect(attachments).toHaveLength(2)
    const image = attachments.find((a) => a.kind === 'image')
    const text = attachments.find((a) => a.kind === 'text')
    expect(image).toMatchObject({ description: 'um pixel verde', descriptionModel: 'gpt-5.6-mini' })
    expect(text).toMatchObject({ data: 'conteúdo' })
    expect(text!.artifactId).toBeUndefined()
  })

  it('drops an image attachment whose original sidecar no longer exists', async () => {
    const conv = chatConv()
    const { artifactId } = await addImageMessage(conv.id, 'm1')
    // Simulate a missing file on disk.
    rmSync(path.dirname(artifactFile(conv.id, artifactId)), { recursive: true, force: true })

    const fileParts = filePartsOf(conv.id, 'm1')
    const attachments = await preserveResendAttachments(conv.id, fileParts)

    expect(attachments).toHaveLength(0)
  })
})

/** A sniffable 1x1 PNG header with zero padding large enough to exceed the limit. */
const oversizedPng = () =>
  Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(MAX_ATTACHMENT_IMAGE_BYTES + 1)])

describe('bounded attachment reads (review loop, round 2)', () => {
  it('readAttachmentImage rejects oversized sidecars before reading bytes using stat', async () => {
    const conv = chatConv()
    const stored = await saveAttachmentImage({ conversationId: conv.id, bytes: PNG_1X1, label: 'shot' })
    // An externally replaced file contains valid PNG bytes above the limit.
    writeFileSync(artifactFile(conv.id, stored.artifactId), oversizedPng())

    const result = await readAttachmentImage(conv.id, stored.artifactId)

    expect(result).toMatchObject({ ok: false, error: 'invalid' })
  })

  it('readAttachmentImage rejects symlinks without following them', async () => {
    const conv = chatConv()
    const stored = await saveAttachmentImage({ conversationId: conv.id, bytes: PNG_1X1, label: 'shot' })
    const file = artifactFile(conv.id, stored.artifactId)
    rmSync(file)
    const outside = path.join(h.userData, 'outside.png')
    writeFileSync(outside, Buffer.from(PNG_1X1, 'base64'))
    symlinkSync(outside, file)

    const result = await readAttachmentImage(conv.id, stored.artifactId)

    expect(result).toMatchObject({ ok: false, error: 'invalid' })
  })

  it('readAttachmentImage validates persisted byteSize metadata', async () => {
    const conv = chatConv()
    const stored = await saveAttachmentImage({ conversationId: conv.id, bytes: PNG_1X1, label: 'shot' })

    expect(await readAttachmentImage(conv.id, stored.artifactId, stored.byteSize + 1)).toMatchObject({
      ok: false,
      error: 'invalid',
    })
    expect((await readAttachmentImage(conv.id, stored.artifactId, stored.byteSize)).ok).toBe(true)
  })

  it('resolveFileImageBytesSync enforces limits and metadata synchronously', async () => {
    const conv = chatConv()
    const stored = await saveAttachmentImage({ conversationId: conv.id, bytes: PNG_1X1, label: 'shot' })
    const file = artifactFile(conv.id, stored.artifactId)

    // An oversized tampered sidecar returns null without allocating a main-process buffer.
    writeFileSync(file, oversizedPng())
    expect(resolveFileImageBytesSync(conv.id, { artifactId: stored.artifactId, byteSize: stored.byteSize })).toBeNull()

    // A byteSize mismatch against persisted metadata returns null.
    writeFileSync(file, Buffer.from(PNG_1X1, 'base64'))
    expect(
      resolveFileImageBytesSync(conv.id, { artifactId: stored.artifactId, byteSize: stored.byteSize + 1 })
    ).toBeNull()

    // Preserve the valid-input behavior.
    expect(
      resolveFileImageBytesSync(conv.id, { artifactId: stored.artifactId, byteSize: stored.byteSize })?.mediaType
    ).toBe('image/png')
  })

  it('bounds legacy inline decoding before and after decode and validates the payload', () => {
    const conv = chatConv()
    const maxEncoded = Math.ceil(MAX_ATTACHMENT_IMAGE_BYTES / 3) * 4

    // Reject excessive encoded length before decoding.
    expect(
      resolveFileImageBytesSync(conv.id, { data: `data:image/png;base64,${'A'.repeat(maxEncoded + 1)}` })
    ).toBeNull()
    // Reject excessive decoded bytes after the encoded-length preflight passes.
    expect(resolveFileImageBytesSync(conv.id, { data: `data:image/png;base64,${'A'.repeat(maxEncoded)}` })).toBeNull()
    // Invalid base64 returns null.
    expect(resolveFileImageBytesSync(conv.id, { data: 'data:image/png;base64,!!!' })).toBeNull()
    // A valid data URL decodes using the header MIME type.
    expect(resolveFileImageBytesSync(conv.id, { data: `data:image/png;base64,${PNG_1X1}` })?.mediaType).toBe(
      'image/png'
    )
  })
})

/** Minimal bytes carrying the PDF signature; storage validates the signature, not the document structure. */
const PDF = Buffer.from('%PDF-1.4\n%%EOF\n')

const pdfFile = (conversationId: string, artifactId: string): string =>
  path.join(h.userData, 'chat-attachment-images', conversationId, `${artifactId}.pdf`)

describe('PDF attachment artifacts', () => {
  it('stores a PDF sidecar and reads the same bytes back', async () => {
    const conv = chatConv()
    const stored = await savePdfAttachment({ conversationId: conv.id, bytes: PDF, label: 'Spec v2' })

    expect(stored).toMatchObject({ mediaType: 'application/pdf', name: 'Spec-v2.pdf', byteSize: PDF.length })
    expect(existsSync(pdfFile(conv.id, stored.artifactId))).toBe(true)
    const read = await readAttachmentPdf(conv.id, stored.artifactId, stored.byteSize)
    expect(read.ok).toBe(true)
    if (read.ok) expect(Buffer.from(read.bytes).equals(PDF)).toBe(true)
    expect(Buffer.from(resolveFilePdfBytesSync(conv.id, stored) ?? []).equals(PDF)).toBe(true)
  })

  it('rejects bytes without the PDF signature and oversized PDFs', async () => {
    const conv = chatConv()
    await expect(
      savePdfAttachment({ conversationId: conv.id, bytes: Buffer.from('not a pdf') })
    ).rejects.toBeInstanceOf(AttachmentArtifactError)
    const oversized = Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(MAX_ATTACHMENT_PDF_BYTES - 4)])
    expect(oversized.length).toBe(MAX_ATTACHMENT_PDF_BYTES + 1)
    await expect(savePdfAttachment({ conversationId: conv.id, bytes: oversized })).rejects.toBeInstanceOf(
      AttachmentArtifactError
    )
  })

  it('never serves a PDF artifact through the image readers', async () => {
    const conv = chatConv()
    const stored = await savePdfAttachment({ conversationId: conv.id, bytes: PDF })

    expect(await readAttachmentImage(conv.id, stored.artifactId, stored.byteSize)).toMatchObject({
      ok: false,
      error: 'invalid',
    })
    expect(resolveFileImageBytesSync(conv.id, stored)).toBeNull()
  })

  it('validates persisted byteSize and rejects symlinked PDF sidecars', async () => {
    const conv = chatConv()
    const stored = await savePdfAttachment({ conversationId: conv.id, bytes: PDF })

    expect(await readAttachmentPdf(conv.id, stored.artifactId, stored.byteSize + 1)).toMatchObject({
      ok: false,
      error: 'invalid',
    })
    expect(
      resolveFilePdfBytesSync(conv.id, { artifactId: stored.artifactId, byteSize: stored.byteSize + 1 })
    ).toBeNull()

    const file = pdfFile(conv.id, stored.artifactId)
    rmSync(file)
    const outside = path.join(h.userData, 'outside.pdf')
    writeFileSync(outside, PDF)
    symlinkSync(outside, file)
    expect(await readAttachmentPdf(conv.id, stored.artifactId)).toMatchObject({ ok: false, error: 'invalid' })
    expect(resolveFilePdfBytesSync(conv.id, { artifactId: stored.artifactId })).toBeNull()
  })

  it('copies PDF bytes for edit and resend', async () => {
    const conv = chatConv()
    const stored = await savePdfAttachment({ conversationId: conv.id, bytes: PDF, label: 'spec' })

    const attachments = await preserveResendAttachments(conv.id, [
      {
        type: 'file',
        id: 'p1',
        name: 'spec.pdf',
        mediaType: 'application/pdf',
        kind: 'pdf',
        artifactId: stored.artifactId,
        byteSize: stored.byteSize,
        data: '--- Page 1 ---\nHi',
        pageCount: 1,
      },
    ])

    expect(attachments).toHaveLength(1)
    expect(attachments[0]).toMatchObject({ name: 'spec.pdf', mediaType: 'application/pdf', kind: 'pdf' })
    expect(attachments[0]!.artifactId).toBeUndefined()
    expect(Buffer.from(attachments[0]!.bytes!).equals(PDF)).toBe(true)
  })

  it('deletes PDF sidecars with the attachment cleanup', async () => {
    const conv = chatConv()
    const stored = await savePdfAttachment({ conversationId: conv.id, bytes: PDF })
    expect(existsSync(pdfFile(conv.id, stored.artifactId))).toBe(true)

    await deleteAttachmentImages(conv.id, [stored.artifactId])

    expect(existsSync(pdfFile(conv.id, stored.artifactId))).toBe(false)
  })
})

describe('PDF previews for the system viewer', () => {
  const previews = (): string => path.join(h.userData, 'chat-attachment-previews')

  it('writes a read-only copy named after the attachment, outside the artifact store', async () => {
    const conv = chatConv()
    const stored = await savePdfAttachment({ conversationId: conv.id, bytes: PDF })

    const preview = await materializePdfPreview(conv.id, { ...stored, name: 'Relatório final.pdf' })

    expect(preview.ok).toBe(true)
    if (!preview.ok) return
    expect(preview.path).toBe(path.join(previews(), conv.id, stored.artifactId, 'Relatório final.pdf'))
    expect(readFileSync(preview.path).equals(PDF)).toBe(true)
    expect(statSync(preview.path).mode & 0o222).toBe(0)
    // The stored artifact stays untouched: the viewer can never modify it.
    expect((await readAttachmentPdf(conv.id, stored.artifactId, stored.byteSize)).ok).toBe(true)
  })

  it('reopens by rewriting the same copy instead of accumulating files', async () => {
    const conv = chatConv()
    const stored = await savePdfAttachment({ conversationId: conv.id, bytes: PDF })
    const first = await materializePdfPreview(conv.id, { ...stored, name: 'a.pdf' })
    const second = await materializePdfPreview(conv.id, { ...stored, name: 'a.pdf' })

    expect(first).toEqual(second)
    expect(second.ok && readFileSync(second.path).equals(PDF)).toBe(true)
  })

  it.each([
    ['../../escape.pdf', 'escape.pdf'],
    ['C:\\Users\\x\\notes.PDF', 'notes.pdf'],
    ['bad<>:"|?*name', 'bad-name.pdf'],
    ['.hidden.pdf', 'hidden.pdf'],
    ['', 'document.pdf'],
    ['CON.pdf', '_CON.pdf'],
  ])('sanitizes the file name %j', async (name, expected) => {
    const conv = chatConv()
    const stored = await savePdfAttachment({ conversationId: conv.id, bytes: PDF })

    const preview = await materializePdfPreview(conv.id, { ...stored, name })

    expect(preview.ok && path.basename(preview.path)).toBe(expected)
    expect(preview.ok && path.dirname(preview.path)).toBe(path.join(previews(), conv.id, stored.artifactId))
  })

  it('refuses missing, tampered and non-PDF artifacts', async () => {
    const conv = chatConv()
    const stored = await savePdfAttachment({ conversationId: conv.id, bytes: PDF })

    expect(await materializePdfPreview(conv.id, { artifactId: 'missing', name: 'a.pdf' })).toEqual({
      ok: false,
      error: 'not-found',
    })
    expect(await materializePdfPreview(conv.id, { ...stored, byteSize: stored.byteSize + 1, name: 'a.pdf' })).toEqual({
      ok: false,
      error: 'invalid',
    })
    const image = await saveAttachmentImage({ conversationId: conv.id, bytes: PNG_1X1 })
    expect(await materializePdfPreview(conv.id, { ...image, name: 'a.pdf' })).toEqual({ ok: false, error: 'invalid' })
    expect(existsSync(previews())).toBe(false)
  })

  it('does not write through a symlink planted at the preview path', async () => {
    const conv = chatConv()
    const stored = await savePdfAttachment({ conversationId: conv.id, bytes: PDF })
    const dir = path.join(previews(), conv.id, stored.artifactId)
    mkdirSync(dir, { recursive: true })
    const outside = path.join(h.userData, 'outside.txt')
    writeFileSync(outside, 'keep')
    symlinkSync(outside, path.join(dir, 'a.pdf'))

    const preview = await materializePdfPreview(conv.id, { ...stored, name: 'a.pdf' })

    expect(preview.ok && readFileSync(preview.path).equals(PDF)).toBe(true)
    expect(readFileSync(outside, 'utf8')).toBe('keep')
  })

  it('removes previews with their message, their conversation, and at startup', async () => {
    const conv = chatConv()
    const a = await savePdfAttachment({ conversationId: conv.id, bytes: PDF })
    const b = await savePdfAttachment({ conversationId: conv.id, bytes: PDF })
    await materializePdfPreview(conv.id, { ...a, name: 'a.pdf' })
    await materializePdfPreview(conv.id, { ...b, name: 'b.pdf' })

    await deleteAttachmentImages(conv.id, [a.artifactId])
    expect(existsSync(path.join(previews(), conv.id, a.artifactId))).toBe(false)
    expect(existsSync(path.join(previews(), conv.id, b.artifactId))).toBe(true)

    await deleteConversationAttachmentImages(conv.id)
    expect(existsSync(path.join(previews(), conv.id))).toBe(false)

    const other = chatConv()
    const c = await savePdfAttachment({ conversationId: other.id, bytes: PDF })
    await materializePdfPreview(other.id, { ...c, name: 'c.pdf' })
    await clearAttachmentPreviews()
    expect(existsSync(previews())).toBe(false)
  })
})

describe('attachment part ownership lookups', () => {
  it('resolves a PDF part only within its own message and conversation', async () => {
    const conv = chatConv()
    const other = chatConv()
    const stored = await savePdfAttachment({ conversationId: conv.id, bytes: PDF })
    upsertChatMessage({
      id: 'm-pdf',
      conversationId: conv.id,
      role: 'user',
      createdAt: 1,
      parts: [
        {
          type: 'file',
          id: 'p1',
          name: 'a.pdf',
          mediaType: 'application/pdf',
          kind: 'pdf',
          artifactId: stored.artifactId,
          byteSize: stored.byteSize,
          pageCount: 1,
          data: '',
        },
      ],
    })

    expect(findAttachmentPdfPart(conv.id, 'm-pdf', 'p1')).toMatchObject({ kind: 'pdf', artifactId: stored.artifactId })
    expect(findAttachmentPdfPart(other.id, 'm-pdf', 'p1')).toBeNull()
    expect(findAttachmentPdfPart(conv.id, 'm-pdf', 'missing')).toBeNull()
    // The image lookup (thumbnail IPC) never returns a PDF part.
    expect(findAttachmentImagePart(conv.id, 'm-pdf', 'p1')).toBeNull()
  })
})
