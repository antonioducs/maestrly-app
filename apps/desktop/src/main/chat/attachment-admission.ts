/**
 * Admission of renderer-supplied chat attachments into persisted message parts (startSend). Text is inlined,
 * images and PDFs become conversation artifacts. PDF text is extracted in the isolated worker BEFORE the
 * document is written, so an unreadable PDF never leaves a sidecar behind. Images and PDFs share the
 * per-message binary budget.
 */
import { randomUUID } from 'node:crypto'
import type { ChatAttachmentInput, MessagePart } from '../../shared/chat'
import {
  decodeAttachmentPdf,
  MAX_ATTACHMENT_IMAGE_BYTES,
  MAX_ATTACHMENT_IMAGE_BYTES_PER_MESSAGE,
  MAX_ATTACHMENT_IMAGES_PER_MESSAGE,
  MAX_ATTACHMENT_PDF_BYTES,
  MAX_ATTACHMENT_TEXT_BYTES,
  saveAttachmentImage,
  savePdfAttachment,
} from './attachment-artifacts'
import { MAX_ATTACHMENT_PDFS_PER_MESSAGE } from '../../shared/memory-policy'
import { extractPdfTextIsolated } from './pdf-text'

type FilePart = Extract<MessagePart, { type: 'file' }>

export type AttachmentAdmissionErrorCode = 'invalid-attachment' | 'pdf-unreadable'

export class AttachmentAdmissionError extends Error {
  readonly name = 'AttachmentAdmissionError'
  constructor(
    readonly code: AttachmentAdmissionErrorCode,
    message: string
  ) {
    super(message)
  }
}

function descriptionFields(a: ChatAttachmentInput): Pick<FilePart, 'description' | 'descriptionModel'> {
  return {
    ...(typeof a.description === 'string' && a.description ? { description: a.description } : {}),
    ...(typeof a.descriptionModel === 'string' && a.descriptionModel ? { descriptionModel: a.descriptionModel } : {}),
  }
}

/**
 * Builds file parts for `attachments`. `onArtifactCreated` is called right after each artifact is written so
 * the caller can delete it if admission (or anything before the message is persisted) fails later.
 */
export async function admitChatAttachments(args: {
  conversationId: string
  attachments: readonly ChatAttachmentInput[]
  signal?: AbortSignal
  extractPdf?: typeof extractPdfTextIsolated
  onArtifactCreated: (artifactId: string) => void
}): Promise<FilePart[]> {
  const parts: FilePart[] = []
  let imageCount = 0
  let pdfCount = 0
  let binaryBytes = 0
  for (const a of args.attachments) {
    if (!a || (a.kind !== 'image' && a.kind !== 'text' && a.kind !== 'pdf')) continue
    if (a.kind === 'text') {
      const data = typeof a.data === 'string' ? a.data : ''
      if (Buffer.byteLength(data, 'utf8') > MAX_ATTACHMENT_TEXT_BYTES) continue
      parts.push({
        type: 'file',
        id: randomUUID(),
        name: a.name || 'file',
        mediaType: a.mediaType || 'text/plain',
        kind: 'text',
        data,
        ...descriptionFields(a),
      })
      continue
    }
    if (a.kind === 'pdf') {
      if (!(a.bytes instanceof Uint8Array)) continue
      if (++pdfCount > MAX_ATTACHMENT_PDFS_PER_MESSAGE) {
        throw new AttachmentAdmissionError('invalid-attachment', 'too-many-pdfs')
      }
      if (a.bytes.byteLength > MAX_ATTACHMENT_PDF_BYTES) {
        throw new AttachmentAdmissionError('invalid-attachment', 'pdf-too-large')
      }
      binaryBytes += a.bytes.byteLength
      if (binaryBytes > MAX_ATTACHMENT_IMAGE_BYTES_PER_MESSAGE) {
        throw new AttachmentAdmissionError('invalid-attachment', 'attachments-too-large')
      }
      try {
        decodeAttachmentPdf(a.bytes)
      } catch (error) {
        throw new AttachmentAdmissionError('invalid-attachment', (error as Error).message)
      }
      const extracted = await (args.extractPdf ?? extractPdfTextIsolated)(a.bytes, {
        maxTextBytes: MAX_ATTACHMENT_TEXT_BYTES,
        signal: args.signal,
      })
      if (!extracted.ok) throw new AttachmentAdmissionError('pdf-unreadable', extracted.error)
      const stored = await savePdfAttachment({ conversationId: args.conversationId, bytes: a.bytes, label: a.name })
      args.onArtifactCreated(stored.artifactId)
      parts.push({
        type: 'file',
        id: randomUUID(),
        name: a.name || stored.name,
        mediaType: stored.mediaType,
        kind: 'pdf',
        artifactId: stored.artifactId,
        byteSize: stored.byteSize,
        data: extracted.text,
        pageCount: extracted.pageCount,
        ...(extracted.truncated ? { textTruncated: true } : {}),
      })
      continue
    }
    if (a.artifactId) {
      parts.push({
        type: 'file',
        id: randomUUID(),
        name: a.name || 'file',
        mediaType: a.mediaType || 'image/png',
        kind: 'image',
        artifactId: a.artifactId,
        byteSize: a.byteSize,
        ...descriptionFields(a),
      })
      continue
    }
    const raw = a.bytes ?? a.data
    if (raw == null) continue
    imageCount += 1
    if (imageCount > MAX_ATTACHMENT_IMAGES_PER_MESSAGE) {
      throw new AttachmentAdmissionError('invalid-attachment', 'too-many-images')
    }
    let stored: Awaited<ReturnType<typeof saveAttachmentImage>>
    try {
      stored = await saveAttachmentImage({ conversationId: args.conversationId, bytes: raw, label: a.name })
    } catch (error) {
      throw new AttachmentAdmissionError('invalid-attachment', (error as Error).message)
    }
    args.onArtifactCreated(stored.artifactId)
    if (stored.byteSize > MAX_ATTACHMENT_IMAGE_BYTES) {
      throw new AttachmentAdmissionError('invalid-attachment', 'image-too-large')
    }
    binaryBytes += stored.byteSize
    if (binaryBytes > MAX_ATTACHMENT_IMAGE_BYTES_PER_MESSAGE) {
      throw new AttachmentAdmissionError('invalid-attachment', 'attachments-too-large')
    }
    parts.push({
      type: 'file',
      id: randomUUID(),
      name: a.name || stored.name,
      mediaType: stored.mediaType,
      kind: 'image',
      artifactId: stored.artifactId,
      byteSize: stored.byteSize,
      ...descriptionFields(a),
    })
  }
  return parts
}
