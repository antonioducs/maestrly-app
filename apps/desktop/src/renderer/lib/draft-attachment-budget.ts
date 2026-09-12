import {
  MAX_ATTACHMENT_IMAGE_BYTES,
  MAX_ATTACHMENT_IMAGES_PER_MESSAGE,
  MAX_ATTACHMENT_IMAGE_BYTES_PER_MESSAGE,
  MAX_ATTACHMENT_TEXT_BYTES,
} from '../../shared/memory-policy'

export interface BudgetedAttachment {
  id: string
  kind: 'image' | 'text'
  bytes?: Uint8Array
  byteSize?: number
  previewUrl?: string
}

export interface DraftAttachmentBudgetResult<T extends BudgetedAttachment> {
  kept: T[]

  rejected: T[]
}

function imageBytesOf(attachment: BudgetedAttachment): number {
  return attachment.byteSize ?? attachment.bytes?.byteLength ?? 0
}

export function boundDraftAttachments<T extends BudgetedAttachment>(
  current: readonly T[],
  incoming: readonly T[]
): DraftAttachmentBudgetResult<T> {
  const kept: T[] = [...current]
  const rejected: T[] = []
  let imageBytes = kept.reduce(
    (sum, attachment) => sum + (attachment.kind === 'image' ? imageBytesOf(attachment) : 0),
    0
  )
  for (const item of incoming) {
    if (item.kind === 'image') {
      const bytes = imageBytesOf(item)
      if (bytes > MAX_ATTACHMENT_IMAGE_BYTES) {
        rejected.push(item)
        continue
      }
      if (kept.filter((k) => k.kind === 'image').length >= MAX_ATTACHMENT_IMAGES_PER_MESSAGE) {
        rejected.push(item)
        continue
      }
      if (imageBytes + bytes > MAX_ATTACHMENT_IMAGE_BYTES_PER_MESSAGE) {
        rejected.push(item)
        continue
      }
      imageBytes += bytes
      kept.push(item)
    } else {
      if (imageBytesOf(item) > MAX_ATTACHMENT_TEXT_BYTES) {
        rejected.push(item)
        continue
      }
      kept.push(item)
    }
  }
  return { kept, rejected }
}
