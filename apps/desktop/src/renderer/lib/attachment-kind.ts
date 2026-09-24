import type { ChatAttachmentKind } from '../../shared/chat'

/** Classifies a composer file. PDFs are also matched by extension because some sources omit the MIME type. */
export function draftAttachmentKind(file: { name: string; type: string }): ChatAttachmentKind {
  if (file.type.startsWith('image/')) return 'image'
  if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) return 'pdf'
  return 'text'
}
