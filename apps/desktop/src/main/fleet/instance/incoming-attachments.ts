import {
  FLEET_FILE_LIMITS,
  FLEET_IMAGE_LIMITS,
  fleetImageMediaTypeSchema,
  type FleetAttachmentInput,
} from '@maestrly/bot-fleet-protocol'
import { imageMediaType } from './images'

/** Decode strictly: replacement characters must never silently corrupt source files. */
export function attachmentText(bytes: Uint8Array): string {
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  if (text.includes('\0')) throw new Error('Attachment contains binary text')
  return text
}
export function validateAttachmentBytes(
  attachment: Pick<FleetAttachmentInput, 'kind' | 'mediaType'>,
  bytes: Uint8Array
): void {
  const max =
    attachment.kind === 'text'
      ? FLEET_FILE_LIMITS.textMaxBytes
      : attachment.kind === 'pdf'
        ? FLEET_FILE_LIMITS.pdfMaxBytes
        : FLEET_IMAGE_LIMITS.attachmentMaxBytes
  const validType =
    attachment.kind === 'image'
      ? fleetImageMediaTypeSchema.safeParse(attachment.mediaType).success
      : attachment.mediaType === (attachment.kind === 'pdf' ? 'application/pdf' : 'text/plain')
  if (!validType || bytes.length > max || (bytes.length === 0 && attachment.kind !== 'text'))
    throw new Error('Invalid attachment type or size')
  if (attachment.kind === 'text') {
    attachmentText(bytes)
  } else if (attachment.kind === 'pdf') {
    if (!Buffer.from(bytes.subarray(0, 5)).equals(Buffer.from('%PDF-'))) throw new Error('Invalid PDF signature')
  } else if (imageMediaType(bytes) !== attachment.mediaType) throw new Error('Attachment bytes do not match media type')
}
