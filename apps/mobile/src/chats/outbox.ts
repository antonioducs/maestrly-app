import { MobileBridgeError } from '@maestrly/bot-fleet-protocol'
import { z } from 'zod'
import type { OutboxAttachment } from '../fleet/attachments'
import { MissingFileError } from '../fleet/outbox'

export type ChatOutboxErrorKey = 'invalid' | 'chatGone' | 'noModel' | 'blockedByHook' | 'missingFile' | 'generic'

/** A message written on the phone for a chat that the host has not admitted yet. Its id is the host's send key. */
export type ChatOutboxEntry = {
  id: string
  serverId: string
  conversationId: string
  text: string
  attachments: OutboxAttachment[]
  createdAt: string
  state: 'waiting' | 'sending' | 'failed'
  error: ChatOutboxErrorKey | null
  attempts: number
}

export const chatOutboxEntriesSchema = z.array(
  z.object({
    id: z.string().min(1),
    serverId: z.string(),
    conversationId: z.string(),
    text: z.string(),
    attachments: z.array(
      z.object({
        name: z.string(),
        kind: z.enum(['image', 'pdf', 'text']),
        mediaType: z.string(),
        uri: z.string(),
        byteSize: z.number(),
      })
    ),
    createdAt: z.string(),
    state: z.enum(['waiting', 'sending', 'failed']),
    error: z.enum(['invalid', 'chatGone', 'noModel', 'missingFile', 'generic']).nullable(),
    attempts: z.number(),
  })
)

/**
 * One message per chat at a time, its oldest waiting one, and none to a chat whose turn is running: the host takes a
 * message when the chat is free, as the desktop's queue does.
 */
export function nextChatsToSend(
  entries: ChatOutboxEntry[],
  serverId: string,
  busy: (conversationId: string) => boolean
): ChatOutboxEntry[] {
  const mine = entries.filter((entry) => entry.serverId === serverId)
  const sending = new Set(mine.filter((entry) => entry.state === 'sending').map((entry) => entry.conversationId))
  const next = new Map<string, ChatOutboxEntry>()
  for (const entry of [...mine].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    if (entry.state === 'failed') {
      // A message that failed holds back the later ones of its chat, which would otherwise arrive out of order.
      sending.add(entry.conversationId)
      continue
    }
    if (entry.state !== 'waiting' || sending.has(entry.conversationId) || next.has(entry.conversationId)) continue
    if (busy(entry.conversationId)) continue
    next.set(entry.conversationId, entry)
  }
  return [...next.values()]
}

const failed = (entry: ChatOutboxEntry, error: ChatOutboxErrorKey): ChatOutboxEntry => ({
  ...entry,
  state: 'failed',
  error,
})

/**
 * What a message becomes after a failed send: back in line when the connection dropped or the chat was busy, or not
 * sent with a reason. `busy` and the connection never count as attempts.
 */
export function afterChatSendFailure(entry: ChatOutboxEntry, error: unknown): ChatOutboxEntry {
  if (error instanceof MissingFileError) return failed(entry, 'missingFile')
  if (!(error instanceof MobileBridgeError)) return failed(entry, 'generic')
  if (error.retryable || error.code === 'busy') return { ...entry, state: 'waiting', error: null }
  if (error.code === 'invalid' || error.code === 'invalid-attachment' || error.code === 'empty')
    return failed(entry, 'invalid')
  if (error.code === 'not-found' || error.code === 'invalid-conversation') return failed(entry, 'chatGone')
  if (error.code === 'no-provider' || error.code === 'no-model') return failed(entry, 'noModel')
  // A plugin hook on the server refused the message: sending it again would be refused too.
  if (error.code === 'blocked-by-hook') return failed(entry, 'blockedByHook')
  return failed(entry, 'generic')
}
