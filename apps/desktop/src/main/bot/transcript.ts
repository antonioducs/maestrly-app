/**
 * What a bot reads back from a chat the person released for their own messages.
 *
 * The relay's own projection only carries what a bot command produced, so a message the person wrote
 * here, and the answer it received, are invisible to it. This reads the chat itself instead, page by
 * page, and keeps the same promise as every other bot surface: only public message text crosses, never
 * reasoning, tool work, attachments, another chat or a chat of another connection.
 */
import { createHash } from 'node:crypto'
import type { BotIdentity } from '../../shared/bot'
import type { MessagePart } from '../../shared/chat'
import { getConversation } from '../store'
import { latestVisibleConversationSeq, listVisibleConversationMessagePage } from '../chat/chat-store'
import { botPublicText } from './projection'
import { findBotConversation } from './store'

export const BOT_TRANSCRIPT_DEFAULT_LIMIT = 100
export const BOT_TRANSCRIPT_MAX_LIMIT = 500

/** Refusal a bot can act on: what it asked for is unusable, not merely empty. */
export class BotTranscriptError extends Error {
  readonly statusCode: number
  constructor(message: string, statusCode: number) {
    super(message)
    this.name = 'BotTranscriptError'
    this.statusCode = statusCode
  }
}

export interface BotTranscriptMessage {
  id: string
  role: 'user' | 'assistant'
  /** The bot that sent it. Absent means the person at this computer wrote it. */
  botName?: string
  text: string
  createdAt: string
  /** The chat was still working when this was read; read it again for the settled text. */
  partial?: boolean
}

export interface BotTranscriptPage {
  conversationId: string
  messages: BotTranscriptMessage[]
  /** Pass it back to continue this same read; null when the page reached the end. */
  nextCursor: string | null
  hasMore: boolean
}

interface Cursor {
  v: 1
  /** The chat this cursor was issued for; one from another chat is refused. */
  c: string
  /** Last position already returned; -1 means the read has not started yet. */
  a: number
  /** Ceiling fixed when the read started, so later messages never shift a page. */
  t: number
}

const encodeCursor = (cursor: Cursor): string => Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')

function decodeCursor(value: string, conversationId: string): Cursor {
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
  } catch {
    throw new BotTranscriptError('That cursor is not one this chat issued.', 400)
  }
  const cursor = parsed as Partial<Cursor> | null
  if (
    cursor?.v !== 1 ||
    typeof cursor.c !== 'string' ||
    !Number.isSafeInteger(cursor.a) ||
    !Number.isSafeInteger(cursor.t) ||
    (cursor.a as number) < -1 ||
    (cursor.t as number) < -1
  )
    throw new BotTranscriptError('That cursor is not one this chat issued.', 400)
  if (cursor.c !== conversationId) throw new BotTranscriptError('That cursor belongs to another chat.', 400)
  return cursor as Cursor
}

/** Stable public identity of one chat message, minted the same way on every read and restart. */
function publicMessageId(instanceId: string, conversationId: string, messageId: string): string {
  const hash = createHash('sha256').update(`transcript:${instanceId}:${conversationId}:${messageId}`).digest('hex')
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`
}

/** Public text of a message: its own words, and nothing the chat did to produce them. */
function publicTextOf(parts: readonly MessagePart[]): string {
  return botPublicText(
    parts
      .filter((part): part is Extract<MessagePart, { type: 'text' }> => part.type === 'text')
      .map((part) => part.text)
      .join('\n')
      .trim()
  )
}

/**
 * Read one page of a released chat, oldest first.
 *
 * The first call fixes the ceiling of the read and returns the cursor for the next page; messages that
 * arrive afterwards belong to a later read, so a page never shifts underneath the bot.
 */
export function readBotChatHistory(input: {
  identity: BotIdentity
  /** Chat id the bot knows, from `bot_list_chats`. */
  conversationId: string
  cursor?: string | null
  limit?: number
}): BotTranscriptPage {
  const binding = findBotConversation(input.identity, input.conversationId)
  const localId = binding?.conversationId
  const conversation = localId ? getConversation(localId) : undefined
  if (!binding || !localId || !conversation)
    throw new BotTranscriptError(
      'This chat has no conversation on this computer yet; there is nothing to read back.',
      404
    )

  const limit = Math.min(
    BOT_TRANSCRIPT_MAX_LIMIT,
    Math.max(1, Math.floor(Number(input.limit ?? BOT_TRANSCRIPT_DEFAULT_LIMIT)) || BOT_TRANSCRIPT_DEFAULT_LIMIT)
  )
  const cursor = input.cursor ? decodeCursor(input.cursor, input.conversationId) : null
  const through = cursor ? cursor.t : latestVisibleConversationSeq(localId)
  // `seq` starts at zero, so an unstarted read sits one before the first message rather than on it.
  const after = cursor ? cursor.a : -1
  // One extra row answers whether another page exists without reading the whole chat into memory.
  const rows = listVisibleConversationMessagePage(localId, after, through, limit + 1)
  const page = rows.slice(0, limit)
  const hasMore = rows.length > limit
  const last = page.at(-1)?.seq ?? after
  const working = conversation.status === 'working' || conversation.status === 'asking'
  const latest = latestVisibleConversationSeq(localId)

  return {
    conversationId: input.conversationId,
    messages: page.flatMap(({ seq, message }) => {
      const text = publicTextOf(message.parts)
      if (!text) return []
      return [
        {
          id: publicMessageId(input.identity.instanceId, input.conversationId, message.id),
          role: message.role,
          ...(message.botName ? { botName: botPublicText(message.botName, 160) } : {}),
          text,
          createdAt: new Date(message.createdAt).toISOString(),
          ...(working && message.role === 'assistant' && seq === latest ? { partial: true } : {}),
        },
      ]
    }),
    nextCursor: hasMore ? encodeCursor({ v: 1, c: input.conversationId, a: last, t: through }) : null,
    hasMore,
  }
}
