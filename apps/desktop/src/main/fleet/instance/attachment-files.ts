import { fleetFileRefSchema, type FleetFileRef } from '@maestrly/bot-fleet-protocol'
import type { ChatMessage } from '../../../shared/chat'
import { readAttachmentPdf } from '../../chat/attachment-artifacts'
import { imageId } from './images'

/** Only a persisted file part of this conversation can resolve an attachment download. */
export async function readConversationFile(
  conversationId: string,
  fileId: string,
  messages: ChatMessage[]
): Promise<{ ref: FleetFileRef; bytes: Uint8Array } | null> {
  if (!fileId.startsWith('a-')) return null
  for (const message of messages) {
    if (message.conversationId !== conversationId || message.role !== 'user') continue
    for (const part of message.parts) {
      if (part.type !== 'file' || part.kind === 'image' || imageId('a', message.id, part.id) !== fileId) continue
      let bytes: Uint8Array
      if (part.kind === 'pdf') {
        if (!part.artifactId) return null
        const stored = await readAttachmentPdf(conversationId, part.artifactId, part.byteSize)
        if (!stored.ok) return null
        bytes = stored.bytes
      } else if (part.kind === 'text') {
        bytes = Buffer.from(part.data ?? '', 'utf8')
      } else continue
      const ref = fleetFileRefSchema.safeParse({
        id: fileId,
        name: part.name.slice(0, 200) || 'attachment',
        mediaType: part.kind === 'pdf' ? 'application/pdf' : 'text/plain',
        byteSize: bytes.byteLength,
      })
      return ref.success ? { ref: ref.data, bytes } : null
    }
  }
  return null
}

/** Read the full structured tool result before the transcript's short text preview truncates it. */
export function publishedFileRefs(toolName: string, output: string): FleetFileRef[] | undefined {
  if (toolName.split('__').at(-1) !== 'bot_share_file') return undefined
  try {
    const value: unknown = JSON.parse(output)
    const ref = fleetFileRefSchema.safeParse(value && typeof value === 'object' && 'file' in value ? value.file : null)
    return ref.success ? [ref.data] : undefined
  } catch {
    return undefined
  }
}
