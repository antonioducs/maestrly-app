import { createHash } from 'node:crypto'
import type { MessagePart } from '../../../shared/chat'
import {
  listCompanionConversationMessages,
  readCompanionConversationPage,
  listCompanionConversationSearchCandidates,
  type CompanionConversationMessageRow,
} from '../chat-store'
import { activeChatContext, isPortableCompactionMarker } from '../message'

export const CONVERSATION_QUERY_MAX_CHARS = 200
export const CONVERSATION_RESULT_DEFAULT_LIMIT = 10
export const CONVERSATION_RESULT_MAX_LIMIT = 20
export const CONVERSATION_CONTEXT_MAX_MESSAGES = 20
export const CONVERSATION_CONTEXT_MAX_CHARS = 24_000
export const CONVERSATION_MESSAGE_MAX_CHARS = 4_000
export const CONVERSATION_SNIPPET_MAX_CHARS = 320

export interface CompanionConversationMessage {
  seq: number
  message_id: string
  role: 'user' | 'assistant'
  created_at: number
  content: string
  truncated?: true
}

export interface CompanionConversationContext {
  latest_seq: number | null
  revision: string
  messages: CompanionConversationMessage[]
  has_earlier_history: boolean
  truncated: boolean
  instruction: string
}

export interface CompanionConversationSearchHit {
  seq: number
  message_id: string
  role: 'user' | 'assistant'
  created_at: number
  snippet: string
}

export interface CompanionConversationReadResult {
  around_seq: number
  found: boolean
  messages: CompanionConversationMessage[]
  has_more_before: boolean
  has_more_after: boolean
  truncated: boolean
}

/**
 * Security boundary for remote conversation access. Only user-visible requirement text is projected;
 * reasoning, tool state/I/O, hidden metadata, attachment payloads and expanded skill bodies are ignored.
 */
export function companionConversationVisibleText(parts: readonly MessagePart[]): string {
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

function companionConversationRevision(rows: readonly CompanionConversationMessageRow[]): string {
  const visibleProjection = rows.map((row) => ({
    seq: row.seq,
    message_id: row.message.id,
    role: row.message.role,
    created_at: row.message.createdAt,
    content: companionConversationVisibleText(row.message.parts),
  }))
  return createHash('sha256').update(JSON.stringify(visibleProjection)).digest('hex')
}

export function getCompanionConversationRevision(conversationId: string): string {
  return companionConversationRevision(listCompanionConversationMessages(conversationId))
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
  row: CompanionConversationMessageRow,
  parts = row.message.parts,
  maxChars = CONVERSATION_MESSAGE_MAX_CHARS
): CompanionConversationMessage | null {
  const visible = companionConversationVisibleText(parts)
  if (!visible.trim()) return null
  const clipped = clipMiddle(visible, maxChars)
  return {
    seq: row.seq,
    message_id: row.message.id,
    role: row.message.role,
    created_at: row.message.createdAt,
    content: clipped.text,
    ...(clipped.truncated ? { truncated: true as const } : {}),
  }
}

function boundedMessages(
  messages: readonly CompanionConversationMessage[],
  fixedPayload: Record<string, unknown>,
  maxMessages = CONVERSATION_CONTEXT_MAX_MESSAGES
): { messages: CompanionConversationMessage[]; truncated: boolean } {
  const selected: CompanionConversationMessage[] = []
  let truncated = messages.length > maxMessages

  const serializedSize = (candidate: readonly CompanionConversationMessage[]) =>
    JSON.stringify({ ...fixedPayload, messages: candidate }).length
  const withContent = (message: CompanionConversationMessage, maxChars: number): CompanionConversationMessage => {
    const clipped = clipMiddle(message.content, maxChars)
    return {
      ...message,
      content: clipped.text,
      ...(message.truncated || clipped.truncated ? { truncated: true } : {}),
    }
  }

  for (const message of messages.slice(-maxMessages).reverse()) {
    const full = withContent(message, CONVERSATION_MESSAGE_MAX_CHARS)
    if (serializedSize([...selected, full]) <= CONVERSATION_CONTEXT_MAX_CHARS) {
      selected.push(full)
      continue
    }

    const fits = (maxChars: number) =>
      serializedSize([...selected, withContent(message, maxChars)]) <= CONVERSATION_CONTEXT_MAX_CHARS
    if (!fits(0)) {
      truncated = true
      continue
    }

    let low = 0
    let high = CONVERSATION_MESSAGE_MAX_CHARS
    while (low < high) {
      const middle = Math.ceil((low + high) / 2)
      if (fits(middle)) low = middle
      else high = middle - 1
    }
    const clipped = withContent(message, low)
    selected.push(clipped)
    truncated = true
  }
  selected.reverse()
  return { messages: selected, truncated }
}

export function getCompanionConversationContext(conversationId: string): CompanionConversationContext {
  const rows = listCompanionConversationMessages(conversationId)
  const active = activeChatContext(rows.map((row) => row.message))
  const hasPortableCompaction = rows.some((row) => row.message.parts.some(isPortableCompactionMarker))
  const rowById = new Map(rows.map((row) => [row.message.id, row]))
  const projected = active.messages.flatMap((message) => {
    const row = rowById.get(message.id)
    if (!row) return []
    const result = projectRow(row, message.parts)
    return result ? [result] : []
  })
  const latestSeq = rows.at(-1)?.seq ?? null
  const revision = companionConversationRevision(rows)
  const fixedWithoutSummary = {
    latest_seq: latestSeq,
    revision,
    has_earlier_history: false,
    truncated: false,
    instruction:
      'If a decision is not in this brief, use search_conversation and then read_conversation around the matching seq.',
  }
  const bounded = boundedMessages(projected, fixedWithoutSummary)
  const earliestReturned = bounded.messages[0]?.seq
  const hasEarlierHistory =
    rows.length > 0 &&
    (hasPortableCompaction || earliestReturned === undefined || rows.some((row) => row.seq < earliestReturned))
  return {
    latest_seq: latestSeq,
    revision,
    messages: bounded.messages,
    has_earlier_history: hasEarlierHistory,
    truncated: bounded.truncated || projected.length > bounded.messages.length,
    instruction: fixedWithoutSummary.instruction,
  }
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return CONVERSATION_RESULT_DEFAULT_LIMIT
  if (!Number.isInteger(limit) || limit < 1 || limit > CONVERSATION_RESULT_MAX_LIMIT) {
    throw new Error(`limit must be an integer between 1 and ${CONVERSATION_RESULT_MAX_LIMIT}`)
  }
  return limit
}

/**
 * Returns at most `limit` visible matches in descending seq order (most recent first), so bounded search
 * preserves the latest decision when older messages contain the same term.
 */
export function searchCompanionConversation(
  conversationId: string,
  input: { query: string; limit?: number }
): { query: string; hits: CompanionConversationSearchHit[] } {
  const query = typeof input.query === 'string' ? input.query.trim() : ''
  if (!query || query.length > CONVERSATION_QUERY_MAX_CHARS) {
    throw new Error(`query must contain 1-${CONVERSATION_QUERY_MAX_CHARS} characters`)
  }
  const limit = normalizeLimit(input.limit)
  const needle = query.toLocaleLowerCase()
  const hits: CompanionConversationSearchHit[] = []
  for (const row of listCompanionConversationSearchCandidates(conversationId)) {
    const text = companionConversationVisibleText(row.message.parts)
    const index = text.toLocaleLowerCase().indexOf(needle)
    if (index < 0) continue
    const side = Math.floor((CONVERSATION_SNIPPET_MAX_CHARS - query.length) / 2)
    const start = Math.max(0, index - side)
    const end = Math.min(text.length, index + query.length + side)
    const snippet =
      (start > 0 ? '…' : '') + text.slice(start, end).replace(/\s+/g, ' ').trim() + (end < text.length ? '…' : '')
    hits.push({
      seq: row.seq,
      message_id: row.message.id,
      role: row.message.role,
      created_at: row.message.createdAt,
      snippet,
    })
    if (hits.length >= limit) break
  }
  return { query, hits }
}

export function readCompanionConversation(
  conversationId: string,
  input: { around_seq: number; limit?: number }
): CompanionConversationReadResult {
  if (!Number.isInteger(input.around_seq) || input.around_seq < 0) {
    throw new Error('around_seq must be an integer greater than or equal to 0')
  }
  const limit = normalizeLimit(input.limit)
  const page = readCompanionConversationPage(
    conversationId,
    input.around_seq,
    limit,
    (row) => companionConversationVisibleText(row.message.parts).trim().length > 0
  )
  if (!page) {
    return {
      around_seq: input.around_seq,
      found: false,
      messages: [],
      has_more_before: false,
      has_more_after: false,
      truncated: false,
    }
  }
  const projected = page.messages.flatMap((row) => {
    const result = projectRow(row)
    return result ? [result] : []
  })
  const fixed = {
    around_seq: input.around_seq,
    found: true,
    has_more_before: page.hasMoreBefore,
    has_more_after: page.hasMoreAfter,
    truncated: false,
  }
  const bounded = boundedMessages(projected, fixed, limit)
  return {
    around_seq: input.around_seq,
    found: true,
    messages: bounded.messages,
    has_more_before: page.hasMoreBefore,
    has_more_after: page.hasMoreAfter,
    truncated: bounded.truncated || projected.length > bounded.messages.length,
  }
}
