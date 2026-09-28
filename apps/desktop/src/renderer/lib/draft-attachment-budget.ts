import {
  MAX_ATTACHMENT_IMAGE_BYTES,
  MAX_ATTACHMENT_IMAGES_PER_MESSAGE,
  MAX_ATTACHMENT_IMAGE_BYTES_PER_MESSAGE,
  MAX_ATTACHMENT_PDF_BYTES,
  MAX_ATTACHMENT_PDFS_PER_MESSAGE,
  MAX_ATTACHMENT_TEXT_BYTES,
} from '../../shared/memory-policy'
import type { ChatAttachmentKind } from '../../shared/chat'

export interface BudgetedAttachment {
  id: string
  kind: ChatAttachmentKind
  bytes?: Uint8Array
  byteSize?: number
  previewUrl?: string
}

export interface DraftAttachmentBudgetResult<T extends BudgetedAttachment> {
  kept: T[]

  rejected: T[]
}

function bytesOf(attachment: BudgetedAttachment): number {
  return attachment.byteSize ?? attachment.bytes?.byteLength ?? 0
}

/** Images and PDFs share the per-message binary budget; text attachments do not count toward it. */
const isBinary = (attachment: BudgetedAttachment): boolean => attachment.kind === 'image' || attachment.kind === 'pdf'

export function boundDraftAttachments<T extends BudgetedAttachment>(
  current: readonly T[],
  incoming: readonly T[]
): DraftAttachmentBudgetResult<T> {
  const kept: T[] = [...current]
  const rejected: T[] = []
  let binaryBytes = kept.reduce((sum, attachment) => sum + (isBinary(attachment) ? bytesOf(attachment) : 0), 0)
  for (const item of incoming) {
    if (item.kind === 'image' || item.kind === 'pdf') {
      const bytes = bytesOf(item)
      const [maxBytes, maxCount] =
        item.kind === 'image'
          ? [MAX_ATTACHMENT_IMAGE_BYTES, MAX_ATTACHMENT_IMAGES_PER_MESSAGE]
          : [MAX_ATTACHMENT_PDF_BYTES, MAX_ATTACHMENT_PDFS_PER_MESSAGE]
      if (bytes > maxBytes) {
        rejected.push(item)
        continue
      }
      if (kept.filter((k) => k.kind === item.kind).length >= maxCount) {
        rejected.push(item)
        continue
      }
      if (binaryBytes + bytes > MAX_ATTACHMENT_IMAGE_BYTES_PER_MESSAGE) {
        rejected.push(item)
        continue
      }
      binaryBytes += bytes
      kept.push(item)
    } else {
      if (bytesOf(item) > MAX_ATTACHMENT_TEXT_BYTES) {
        rejected.push(item)
        continue
      }
      kept.push(item)
    }
  }
  return { kept, rejected }
}
