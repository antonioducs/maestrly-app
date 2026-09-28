import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Message admission for chat attachments (startSend). PDFs are validated, their text extracted in the isolated
 * worker BEFORE anything is written, and only then stored as artifacts; PDF bytes share the per-message binary
 * budget with images. Text and image admission keep their previous behavior.
 */
const h = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', () => ({ app: { getPath: () => h.userData, getAppPath: () => h.userData } }))

const { AttachmentAdmissionError, admitChatAttachments } = await import('../../src/main/chat/attachment-admission')
const { MAX_ATTACHMENT_PDF_BYTES, MAX_ATTACHMENT_IMAGE_BYTES, MAX_ATTACHMENT_TEXT_BYTES } = await import(
  '../../src/main/chat/attachment-artifacts'
)
const { makeTextPdf } = await import('../helpers/pdf-fixtures')

import type { ChatAttachmentInput } from '../../src/shared/chat'
import type { PdfTextResult } from '../../src/main/chat/pdf-text'

const MiB = 1024 * 1024
const CONV = 'conv-admission'
const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

const dir = (): string => path.join(h.userData, 'chat-attachment-images', CONV)
const storedFiles = (ext: string): string[] =>
  existsSync(dir()) ? readdirSync(dir()).filter((name) => name.endsWith(`.${ext}`)) : []

const pdfInput = (bytes: Uint8Array, name = 'spec.pdf'): ChatAttachmentInput => ({
  name,
  mediaType: 'application/pdf',
  kind: 'pdf',
  bytes,
})
const paddedPdf = (size: number): Buffer => Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(size - 5)])

const okExtract = (over: Partial<Extract<PdfTextResult, { ok: true }>> = {}) =>
  vi.fn(
    async (): Promise<PdfTextResult> => ({
      ok: true,
      pageCount: 1,
      text: '--- Page 1 ---\nHi',
      truncated: false,
      ...over,
    })
  )

async function admit(attachments: ChatAttachmentInput[], extractPdf = okExtract()) {
  const created: string[] = []
  const parts = await admitChatAttachments({
    conversationId: CONV,
    attachments,
    extractPdf,
    onArtifactCreated: (id) => created.push(id),
  })
  return { parts, created, extractPdf }
}

async function admissionError(attachments: ChatAttachmentInput[], extractPdf = okExtract()) {
  const error = await admit(attachments, extractPdf).catch((e: unknown) => e)
  expect(error).toBeInstanceOf(AttachmentAdmissionError)
  return error as InstanceType<typeof AttachmentAdmissionError>
}

beforeEach(() => {
  h.userData = mkdtempSync(path.join(os.tmpdir(), 'maestrly-attachment-admission-'))
})
afterEach(() => {
  rmSync(h.userData, { recursive: true, force: true })
})

describe('admitChatAttachments: PDFs', () => {
  it('extracts, stores and describes a valid PDF', async () => {
    const bytes = makeTextPdf(['Hi'])
    const { parts, created, extractPdf } = await admit([pdfInput(bytes)])

    expect(parts).toHaveLength(1)
    expect(parts[0]).toMatchObject({
      type: 'file',
      name: 'spec.pdf',
      kind: 'pdf',
      mediaType: 'application/pdf',
      pageCount: 1,
      data: '--- Page 1 ---\nHi',
      byteSize: bytes.length,
    })
    expect(parts[0]!.textTruncated).toBeUndefined()
    expect(created).toEqual([parts[0]!.artifactId])
    expect(storedFiles('pdf')).toEqual([`${parts[0]!.artifactId}.pdf`])
    expect(extractPdf).toHaveBeenCalledWith(bytes, expect.objectContaining({ maxTextBytes: MAX_ATTACHMENT_TEXT_BYTES }))
  })

  it('records truncated extraction', async () => {
    const { parts } = await admit([pdfInput(makeTextPdf(['Hi']))], okExtract({ truncated: true }))

    expect(parts[0]).toMatchObject({ kind: 'pdf', textTruncated: true })
  })

  it('rejects more than four PDFs in one message', async () => {
    const pdf = makeTextPdf(['Hi'])
    const error = await admissionError(Array.from({ length: 5 }, (_, i) => pdfInput(pdf, `p${i}.pdf`)))

    expect(error.code).toBe('invalid-attachment')
  })

  it('rejects an oversized PDF without writing it', async () => {
    const error = await admissionError([pdfInput(paddedPdf(MAX_ATTACHMENT_PDF_BYTES + 1))])

    expect(error.code).toBe('invalid-attachment')
    expect(storedFiles('pdf')).toEqual([])
  })

  it('shares the per-message binary budget with images', async () => {
    const image = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(MAX_ATTACHMENT_IMAGE_BYTES - 8)])
    const error = await admissionError([
      pdfInput(paddedPdf(9 * MiB), 'a.pdf'),
      { name: 'shot.png', mediaType: 'image/png', kind: 'image', bytes: image },
      pdfInput(paddedPdf(7 * MiB), 'b.pdf'),
    ])

    expect(error.code).toBe('invalid-attachment')
  })

  it('rejects bytes without the PDF signature', async () => {
    const error = await admissionError([pdfInput(Buffer.from('not a pdf at all'))])

    expect(error.code).toBe('invalid-attachment')
  })

  it('reports unreadable PDFs before storing them', async () => {
    const extractPdf = vi.fn(async (): Promise<PdfTextResult> => ({ ok: false, error: 'encrypted' }))
    const error = await admissionError([pdfInput(makeTextPdf(['Hi']))], extractPdf)

    expect(error.code).toBe('pdf-unreadable')
    expect(storedFiles('pdf')).toEqual([])
  })
})

describe('admitChatAttachments: text and images (unchanged)', () => {
  it('admits text inline and stores images as artifacts', async () => {
    const { parts, created } = await admit([
      { name: 'notes.txt', mediaType: 'text/plain', kind: 'text', data: 'hello' },
      { name: 'shot.png', mediaType: 'image/png', kind: 'image', data: PNG_1X1 },
    ])

    expect(parts).toHaveLength(2)
    expect(parts[0]).toMatchObject({
      type: 'file',
      name: 'notes.txt',
      mediaType: 'text/plain',
      kind: 'text',
      data: 'hello',
    })
    expect(parts[1]).toMatchObject({ type: 'file', name: 'shot.png', mediaType: 'image/png', kind: 'image' })
    expect(parts[1]!.data).toBeUndefined()
    expect(created).toEqual([parts[1]!.artifactId])
    expect(storedFiles('png')).toEqual([`${parts[1]!.artifactId}.png`])
  })

  it('reuses renderer-provided image artifacts without creating new ones', async () => {
    const { parts, created } = await admit([
      { name: 'a.png', mediaType: 'image/png', kind: 'image', artifactId: 'existing', byteSize: 10 },
    ])

    expect(parts[0]).toMatchObject({ kind: 'image', artifactId: 'existing', byteSize: 10 })
    expect(created).toEqual([])
  })

  it('drops oversized text and unknown kinds silently', async () => {
    const { parts } = await admit([
      { name: 'big.txt', mediaType: 'text/plain', kind: 'text', data: 'x'.repeat(MAX_ATTACHMENT_TEXT_BYTES + 1) },
      { name: 'weird', mediaType: 'x', kind: 'audio' as never },
    ])

    expect(parts).toEqual([])
  })
})
