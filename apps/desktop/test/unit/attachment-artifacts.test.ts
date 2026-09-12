import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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
const { deleteChatMessagesFrom, getChatMessage, getMessageSeq, upsertChatMessage } = await import(
  '../../src/main/chat/chat-store'
)
const {
  MAX_ATTACHMENT_IMAGE_BYTES,
  preserveResendAttachments,
  readAttachmentImage,
  resolveFileImageBytesSync,
  saveAttachmentImage,
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
