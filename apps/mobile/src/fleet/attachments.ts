import { FLEET_FILE_LIMITS, FLEET_IMAGE_LIMITS, FLEET_IMAGE_MEDIA_TYPES } from '@maestrly/bot-fleet-protocol'

/** A file chosen on the phone for a message. Only its location is kept; its bytes are read when it is sent. */
export type OutboxAttachment = {
  name: string
  kind: 'image' | 'pdf' | 'text'
  mediaType: string
  uri: string
  byteSize: number
}
export type AttachmentIssue = 'count' | 'size' | 'total' | 'pdfs' | 'unsupported' | 'type'

const TEXT_NAME =
  /\.(txt|md|markdown|json|jsonl|csv|log|ya?ml|toml|ini|conf|xml|html?|css|[cm]?[jt]sx?|py|go|rs|rb|sh|sql)$/i
const IMAGE_TYPES: readonly string[] = FLEET_IMAGE_MEDIA_TYPES

/** The kind a file is sent as, from its media type and name; null when the gateway would refuse it. */
export function classifyAttachment(name: string, mediaType: string | null): OutboxAttachment['kind'] | null {
  if (mediaType && IMAGE_TYPES.includes(mediaType)) return 'image'
  if (mediaType?.startsWith('image/')) return null
  if (mediaType === 'application/pdf' || (!mediaType && /\.pdf$/i.test(name))) return 'pdf'
  if (mediaType?.startsWith('text/') || mediaType === 'application/json' || TEXT_NAME.test(name)) return 'text'
  return null
}

/** The media type the gateway accepts for each kind: text files are always sent as text/plain. */
export const sentMediaType = (attachment: OutboxAttachment): string =>
  attachment.kind === 'pdf' ? 'application/pdf' : attachment.kind === 'text' ? 'text/plain' : attachment.mediaType

const maxBytes = (kind: OutboxAttachment['kind']) =>
  kind === 'pdf'
    ? FLEET_FILE_LIMITS.pdfMaxBytes
    : kind === 'text'
      ? FLEET_FILE_LIMITS.textMaxBytes
      : FLEET_IMAGE_LIMITS.attachmentMaxBytes

/** The first gateway limit adding these files would break, checked on the phone so the message is never refused. */
export function validateAttachments(
  existing: OutboxAttachment[],
  adding: OutboxAttachment[],
  filesEnabled: boolean
): AttachmentIssue | null {
  if (adding.some((item) => item.kind === 'image' && !IMAGE_TYPES.includes(item.mediaType))) return 'type'
  if (!filesEnabled && adding.some((item) => item.kind !== 'image')) return 'unsupported'
  if (adding.some((item) => item.byteSize > maxBytes(item.kind) || (item.byteSize === 0 && item.kind !== 'text')))
    return 'size'
  const all = [...existing, ...adding]
  if (all.length > FLEET_FILE_LIMITS.attachmentsMax) return 'count'
  if (all.filter((item) => item.kind === 'pdf').length > FLEET_FILE_LIMITS.pdfsMax) return 'pdfs'
  if (all.reduce((sum, item) => sum + item.byteSize, 0) > FLEET_FILE_LIMITS.attachmentsTotalMaxBytes) return 'total'
  return null
}
