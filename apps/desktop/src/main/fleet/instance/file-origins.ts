import type { FleetFileOrigin } from '@maestrly/bot-fleet-protocol'
import { findLatestChatMessage } from '../../chat/chat-store'
import { publishedFileRefs } from './attachment-files'
import { toolOutputTextOf } from './transcript'

/**
 * Where each file a bot shared was shared, read from its conversations' completed `bot_share_file` calls: for files
 * from before origins were kept. The first conversation that names a file wins, so list the bot's own first.
 */
export function findFileOrigins(
  conversations: ReadonlyArray<{ conversationId: string; origin: FleetFileOrigin }>
): Map<string, { origin: FleetFileOrigin; sharedAt: string }> {
  const found = new Map<string, { origin: FleetFileOrigin; sharedAt: string }>()
  for (const { conversationId, origin } of conversations)
    // Never matches: it only visits, newest first, every message that mentions the tool.
    findLatestChatMessage(
      conversationId,
      (message) => {
        for (const part of message.parts) {
          if (part.type !== 'tool' || part.state.status !== 'completed') continue
          for (const ref of publishedFileRefs(part.toolName, toolOutputTextOf(part.state.output ?? '')) ?? [])
            if (!found.has(ref.id)) found.set(ref.id, { origin, sharedAt: new Date(message.createdAt).toISOString() })
        }
        return false
      },
      { partsContaining: 'bot_share_file' }
    )
  return found
}
