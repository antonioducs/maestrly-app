import type { MessagePart } from '../../../shared/chat'
import { listVisibleConversationMessages, type VisibleConversationMessageRow } from '../chat-store'
import { activeChatContext } from '../message'

const BRIEF_MAX_MESSAGES = 20
const BRIEF_MAX_CHARS = 24_000
const BRIEF_MESSAGE_MAX_CHARS = 4_000

export interface ConversationBriefMessage {
  seq: number
  message_id: string
  role: 'user' | 'assistant'
  created_at: number
  content: string
  truncated?: true
}

/**
 * Only user-visible requirement text is projected; reasoning, tool state/I/O, hidden metadata, attachment payloads
 * and expanded skill bodies are ignored.
 */
export function conversationVisibleText(parts: readonly MessagePart[]): string {
  const visible: string[] = []
  for (const part of parts) {
    if (part.type === 'text') {
      if (part.checkpoint !== 'openai-native') visible.push(part.text)
    } else if (part.type === 'context') {
      visible.push(part.text)
    } else if ((part.type === 'file' && !part.hidden) || part.type === 'generated-image') {
      visible.push(`[Attachment: ${part.name}]`)
    } else if (part.type === 'skill-invocation') {
      visible.push(`/${part.name}${part.args ? ` ${part.args}` : ''}`)
    }
  }
  return visible.filter((text) => text.trim().length > 0).join('\n')
}

function clipMiddle(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false }
  if (maxChars <= 1) return { text: '…'.slice(0, maxChars), truncated: true }
  const marker = '\n… [truncated] …\n'
  if (maxChars <= marker.length) return { text: text.slice(0, maxChars - 1) + '…', truncated: true }
  const available = Math.max(0, maxChars - marker.length)
  const start = Math.ceil(available / 2)
  const end = Math.floor(available / 2)
  return { text: text.slice(0, start) + marker + text.slice(text.length - end), truncated: true }
}

function projectRow(
  row: VisibleConversationMessageRow,
  parts: readonly MessagePart[]
): ConversationBriefMessage | null {
  const visible = conversationVisibleText(parts)
  if (!visible.trim()) return null
  const clipped = clipMiddle(visible, BRIEF_MESSAGE_MAX_CHARS)
  return {
    seq: row.seq,
    message_id: row.message.id,
    role: row.message.role,
    created_at: row.message.createdAt,
    content: clipped.text,
    ...(clipped.truncated ? { truncated: true as const } : {}),
  }
}

/** Keeps the most recent messages that fit the serialized budget, shortening the oldest one that only fits partly. */
function boundedMessages(messages: readonly ConversationBriefMessage[]): ConversationBriefMessage[] {
  const selected: ConversationBriefMessage[] = []
  const serializedSize = (candidate: readonly ConversationBriefMessage[]) => JSON.stringify(candidate).length
  const withContent = (message: ConversationBriefMessage, maxChars: number): ConversationBriefMessage => {
    const clipped = clipMiddle(message.content, maxChars)
    return {
      ...message,
      content: clipped.text,
      ...(message.truncated || clipped.truncated ? { truncated: true } : {}),
    }
  }

  for (const message of messages.slice(-BRIEF_MAX_MESSAGES).reverse()) {
    const full = withContent(message, BRIEF_MESSAGE_MAX_CHARS)
    if (serializedSize([...selected, full]) <= BRIEF_MAX_CHARS) {
      selected.push(full)
      continue
    }
    const fits = (maxChars: number) => serializedSize([...selected, withContent(message, maxChars)]) <= BRIEF_MAX_CHARS
    if (!fits(0)) continue
    let low = 0
    let high = BRIEF_MESSAGE_MAX_CHARS
    while (low < high) {
      const middle = Math.ceil((low + high) / 2)
      if (fits(middle)) low = middle
      else high = middle - 1
    }
    selected.push(withContent(message, low))
  }
  return selected.reverse()
}

/** Recent visible messages of the conversation's active context, as the reviewers read them. */
export function conversationBrief(conversationId: string): ConversationBriefMessage[] {
  const rows = listVisibleConversationMessages(conversationId)
  const active = activeChatContext(rows.map((row) => row.message))
  const rowById = new Map(rows.map((row) => [row.message.id, row]))
  const projected = active.messages.flatMap((message) => {
    const row = rowById.get(message.id)
    const result = row ? projectRow(row, message.parts) : null
    return result ? [result] : []
  })
  return boundedMessages(projected)
}
