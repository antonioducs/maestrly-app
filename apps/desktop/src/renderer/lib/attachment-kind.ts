import type { ChatAttachmentKind } from '../../shared/chat'

/** Classifies a composer file. PDFs are also matched by extension because some sources omit the MIME type. */
export function draftAttachmentKind(file: { name: string; type: string }): ChatAttachmentKind {
  if (file.type.startsWith('image/')) return 'image'
  if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) return 'pdf'
  return 'text'
}

/**
 * Images and PDFs become artifacts when the message is saved, so the optimistic bubble must be replaced by the saved
 * message (thumbnails and PDF opening need the artifact) as soon as it exists.
 */
export function hasArtifactAttachment(attachments: readonly { kind: ChatAttachmentKind }[]): boolean {
  return attachments.some((attachment) => attachment.kind === 'image' || attachment.kind === 'pdf')
}

/** A drag carries files from the operating system (as opposed to text or elements dragged inside the app). */
export function hasDraggedFiles(types: readonly string[]): boolean {
  return types.includes('Files')
}
