import { createHash } from 'node:crypto'
import type { ChatMessage, MessagePart } from '../../../shared/chat'
import { estimatePortablePartsTokens } from '../portable-context'
import type {
  BackgroundCompactionBoundary,
  BackgroundCompactionCandidate,
  BackgroundCompactionSafeBoundary,
} from './types'

interface Cursor {
  messageIndex: number
  partIndex: number
}

interface ActiveSource {
  start: Cursor
  summary: string
  marker: BackgroundCompactionSafeBoundary | null
}

export interface BackgroundCompactionTarget {
  boundary: BackgroundCompactionBoundary
  sourceHash: string
  coveredTokens: number
  newTokens: number
}

function isPortableMarker(part: MessagePart): part is Extract<MessagePart, { type: 'compaction' }> {
  return (
    part.type === 'compaction' &&
    part.strategy !== 'openai-native' &&
    part.strategy !== 'claude-native' &&
    part.strategy !== 'codex-native'
  )
}

function activeSource(messages: readonly ChatMessage[]): ActiveSource {
  let marker: Cursor | null = null
  let summary = ''
  for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
    for (let partIndex = 0; partIndex < messages[messageIndex].parts.length; partIndex += 1) {
      const part = messages[messageIndex].parts[partIndex]
      if (!isPortableMarker(part)) continue
      marker = { messageIndex, partIndex }
      summary = part.text
    }
  }
  if (!marker) return { start: { messageIndex: 0, partIndex: 0 }, summary: '', marker: null }
  const markerMessage = messages[marker.messageIndex]
  const next =
    marker.partIndex + 1 < markerMessage.parts.length
      ? { messageIndex: marker.messageIndex, partIndex: marker.partIndex + 1 }
      : { messageIndex: marker.messageIndex + 1, partIndex: 0 }
  return {
    start: next,
    summary,
    marker: { messageId: markerMessage.id, partId: markerMessage.parts[marker.partIndex].id },
  }
}

function locate(
  messages: readonly ChatMessage[],
  boundary: BackgroundCompactionSafeBoundary | BackgroundCompactionBoundary
): Cursor | null {
  const messageIndex = messages.findIndex((message) => message.id === boundary.messageId)
  if (messageIndex < 0) return null
  const partIndex = messages[messageIndex].parts.findIndex((part) => part.id === boundary.partId)
  if (partIndex < 0) return null
  if ('partIndex' in boundary && boundary.partIndex !== partIndex) return null
  return { messageIndex, partIndex }
}

function compare(left: Cursor, right: Cursor): number {
  return left.messageIndex === right.messageIndex
    ? left.partIndex - right.partIndex
    : left.messageIndex - right.messageIndex
}

function nextCursor(messages: readonly ChatMessage[], cursor: Cursor): Cursor | null {
  if (cursor.partIndex + 1 < messages[cursor.messageIndex].parts.length) {
    return { messageIndex: cursor.messageIndex, partIndex: cursor.partIndex + 1 }
  }
  for (let messageIndex = cursor.messageIndex + 1; messageIndex < messages.length; messageIndex += 1) {
    if (messages[messageIndex].parts.length > 0) return { messageIndex, partIndex: 0 }
  }
  return null
}

function firstCursor(messages: readonly ChatMessage[], cursor: Cursor): Cursor | null {
  for (let messageIndex = cursor.messageIndex; messageIndex < messages.length; messageIndex += 1) {
    const partIndex = messageIndex === cursor.messageIndex ? cursor.partIndex : 0
    if (partIndex < messages[messageIndex].parts.length) return { messageIndex, partIndex }
  }
  return null
}

function isOpenTool(part: MessagePart): boolean {
  return (
    part.type === 'tool' &&
    (part.state.status === 'pending' || part.state.status === 'awaiting-permission' || part.state.status === 'running')
  )
}

function isPortableContent(part: MessagePart): boolean {
  if (part.type === 'reasoning' || part.type === 'agent-mention') return false
  if (part.type === 'text' && part.checkpoint === 'openai-native') return false
  return !isPortableMarker(part)
}

function sourceMessages(
  messages: readonly ChatMessage[],
  start: Cursor,
  through: Cursor,
  after: Cursor | null = null
): ChatMessage[] {
  const output: ChatMessage[] = []
  for (let messageIndex = start.messageIndex; messageIndex <= through.messageIndex; messageIndex += 1) {
    const message = messages[messageIndex]
    if (!message) break
    let from = messageIndex === start.messageIndex ? start.partIndex : 0
    if (after && messageIndex === after.messageIndex) from = Math.max(from, after.partIndex + 1)
    if (after && messageIndex < after.messageIndex) continue
    const to = messageIndex === through.messageIndex ? through.partIndex + 1 : message.parts.length
    const parts = message.parts.slice(from, to)
    if (parts.length > 0) output.push({ ...message, parts })
  }
  return output
}

function sourceIdentityValue(messages: readonly ChatMessage[], through: Cursor): unknown | null {
  const active = activeSource(messages)
  const start = firstCursor(messages, active.start)
  if (!start || compare(through, start) < 0) return null
  const source = sourceMessages(messages, start, through).map((message) => ({
    id: message.id,
    role: message.role,
    parts: message.parts,
  }))
  return { marker: active.marker, summary: active.summary, source }
}

export function backgroundCompactionSourceHash(
  messages: readonly ChatMessage[],
  boundary: BackgroundCompactionBoundary
): string | null {
  const through = locate(messages, boundary)
  if (!through) return null
  const value = sourceIdentityValue(messages, through)
  if (!value) return null
  try {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex')
  } catch {
    return null
  }
}

export function validateBackgroundCompactionCandidate(
  messages: readonly ChatMessage[],
  candidate: Pick<BackgroundCompactionCandidate, 'boundary' | 'sourceHash'>
): boolean {
  return backgroundCompactionSourceHash(messages, candidate.boundary) === candidate.sourceHash
}

function estimateSourceTokens(
  messages: readonly ChatMessage[],
  start: Cursor,
  through: Cursor,
  after: Cursor | null
): number {
  return sourceMessages(messages, start, through, after).reduce(
    (total, message) => total + estimatePortablePartsTokens(message.parts) + 16,
    0
  )
}

function boundaryAt(messages: readonly ChatMessage[], cursor: Cursor): BackgroundCompactionBoundary {
  return {
    messageId: messages[cursor.messageIndex].id,
    partId: messages[cursor.messageIndex].parts[cursor.partIndex].id,
    partIndex: cursor.partIndex,
  }
}

/**
 * Selects exactly one interval. Explicit runner boundaries permit a closed same-message prefix;
 * the conservative fallback ends only at a completed assistant message.
 */
export function selectBackgroundCompactionTarget(
  messages: readonly ChatMessage[],
  intervalTokens: number,
  safeBoundary?: BackgroundCompactionSafeBoundary,
  base?: BackgroundCompactionCandidate | null
): BackgroundCompactionTarget | null {
  const active = activeSource(messages)
  const activeStart = firstCursor(messages, active.start)
  if (!activeStart) return null

  let after: Cursor | null = null
  if (base) {
    after = locate(messages, base.boundary)
    if (!after || compare(after, activeStart) < 0 || !validateBackgroundCompactionCandidate(messages, base)) return null
  }
  let cursor = after ? nextCursor(messages, after) : activeStart
  if (!cursor) return null

  const explicitLimit = safeBoundary ? locate(messages, safeBoundary) : null
  if (safeBoundary && !explicitLimit) return null
  let incrementalTokens = 0
  let countedMessage = -1
  const threshold = Math.max(1, Math.floor(intervalTokens))

  while (cursor && (!explicitLimit || compare(cursor, explicitLimit) <= 0)) {
    const message = messages[cursor.messageIndex]
    const part = message.parts[cursor.partIndex]
    if (
      !safeBoundary &&
      cursor.partIndex === 0 &&
      message.role === 'assistant' &&
      !message.finishReason &&
      !message.error
    ) {
      break
    }
    // An unresolved call makes everything after it unsafe, even if the runner reports a later persisted part.
    if (isOpenTool(part)) break
    if (countedMessage !== cursor.messageIndex) {
      incrementalTokens += 16
      countedMessage = cursor.messageIndex
    }
    incrementalTokens += estimatePortablePartsTokens([part])

    const fallbackBoundary =
      !safeBoundary &&
      message.role === 'assistant' &&
      isPortableContent(part) &&
      Boolean(message.finishReason || message.error)
    const eligible = safeBoundary ? isPortableContent(part) : fallbackBoundary
    if (eligible && incrementalTokens >= threshold) {
      const boundary = boundaryAt(messages, cursor)
      const sourceHash = backgroundCompactionSourceHash(messages, boundary)
      if (!sourceHash) return null
      return {
        boundary,
        sourceHash,
        newTokens: estimateSourceTokens(messages, activeStart, cursor, after),
        coveredTokens: estimateSourceTokens(messages, activeStart, cursor, null),
      }
    }
    cursor = nextCursor(messages, cursor)
  }
  return null
}

/** Reconstructs only the prepared base summary and source delta used by the selected round. */
export function backgroundCompactionHistory(
  conversationId: string,
  messages: readonly ChatMessage[],
  boundary: BackgroundCompactionBoundary,
  base?: BackgroundCompactionCandidate | null
): ChatMessage[] | null {
  const active = activeSource(messages)
  const start = firstCursor(messages, active.start)
  const through = locate(messages, boundary)
  if (!start || !through || compare(through, start) < 0) return null
  const after = base ? locate(messages, base.boundary) : null
  if (base && !after) return null
  const summary = base?.summary ?? active.summary
  const history: ChatMessage[] = []
  if (summary) {
    const id = base ? `background-base:${base.id}` : `background-active:${active.marker?.partId ?? 'summary'}`
    history.push({
      id,
      conversationId,
      role: 'assistant',
      parts: [{ type: 'compaction', id: `${id}:part`, text: summary, strategy: 'summary' }],
      createdAt: base?.createdAt ?? 0,
      finishReason: 'stop',
    })
  }
  history.push(...sourceMessages(messages, start, through, after))
  return history
}
