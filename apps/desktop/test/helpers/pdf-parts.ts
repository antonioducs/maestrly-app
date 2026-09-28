import { randomBytes } from 'node:crypto'
import { deleteConversationAttachmentImages, savePdfAttachment } from '../../src/main/chat/attachment-artifacts'
import type { MessagePart } from '../../src/shared/chat'
import { makeTextPdf } from './pdf-fixtures'

type FilePart = Extract<MessagePart, { type: 'file' }>

/**
 * Stores a synthetic PDF artifact under the test userData (electron stub) in a fresh conversation and returns
 * the persisted part, as admission would build it. Call `cleanup` after the test.
 */
export async function storedPdfPart(
  over: Partial<FilePart> = {}
): Promise<{ conversationId: string; part: FilePart; bytes: Buffer; cleanup: () => Promise<void> }> {
  const conversationId = `pdf-${randomBytes(8).toString('hex')}`
  const bytes = makeTextPdf(['Hi'])
  const stored = await savePdfAttachment({ conversationId, bytes, label: 'a' })
  const part: FilePart = {
    type: 'file',
    id: 'pdf-part',
    name: 'a.pdf',
    mediaType: 'application/pdf',
    kind: 'pdf',
    artifactId: stored.artifactId,
    byteSize: stored.byteSize,
    pageCount: 1,
    data: '--- Page 1 ---\nHi',
    ...over,
  }
  return { conversationId, part, bytes, cleanup: () => deleteConversationAttachmentImages(conversationId) }
}
