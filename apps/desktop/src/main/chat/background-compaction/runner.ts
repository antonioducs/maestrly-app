import type { ChatMessage, ChatStreamEvent, MessagePart } from '../../../shared/chat'
import { runnerContextHistory, type StoredChatMessage } from '../chat-store'
import { estimatePortableContextTokens } from '../portable-context'

export interface BackgroundCompactionBoundary {
  messageId: string
  partId: string
}

export interface PreparedBackgroundCompaction {
  messageId: string
  afterPartId: string
  partId: string
}

export interface PreparedCompactionActivation {
  history: StoredChatMessage[]
  assistant: StoredChatMessage
  assistantIndex: number
  event: Extract<ChatStreamEvent, { kind: 'compaction' }>
  contextTokens: number
}

type HistoryScope = {
  ephemeralSession?: boolean
  executionScope?: import('../../../shared/chat').ChatExecutionScope
}

function terminalToolPart(part: Extract<MessagePart, { type: 'tool' }>): boolean {
  return part.state.status === 'completed' || part.state.status === 'error' || part.state.status === 'denied'
}

/** Last contiguous durable part; an open stream or tool blocks every later part. */
export function durableClosedPrefixBoundary(
  message: Pick<ChatMessage, 'id' | 'parts'>,
  openPartIds: ReadonlySet<string>
): BackgroundCompactionBoundary | null {
  let partId: string | null = null
  for (const part of message.parts) {
    if (openPartIds.has(part.id)) break
    if (part.type === 'tool' && !terminalToolPart(part)) break
    partId = part.id
  }
  return partId ? { messageId: message.id, partId } : null
}

/** Fire-and-forget by contract; both synchronous throws and async rejections are isolated. */
export function notifyBackgroundCompactionPrefix(
  callback: ((boundary: BackgroundCompactionBoundary) => void) | undefined,
  boundary: BackgroundCompactionBoundary
): void {
  if (!callback) return
  queueMicrotask(() => {
    try {
      void Promise.resolve(callback(boundary)).catch(() => undefined)
    } catch {
      // Background preparation must never affect the foreground turn.
    }
  })
}

export function createBackgroundCompactionPrefixNotifier(args: {
  callback?: (boundary: BackgroundCompactionBoundary) => void
  message: () => ChatMessage
}) {
  const openPartIds = new Set<string>()
  let lastNotifiedPartId: string | null = null

  return {
    open(partId: string): void {
      openPartIds.add(partId)
    },
    close(partId: string): void {
      openPartIds.delete(partId)
    },
    closeMany(partIds: Iterable<string>): void {
      for (const partId of partIds) openPartIds.delete(partId)
    },
    closeAll(): void {
      openPartIds.clear()
    },
    /** Call only after the current message has been synchronously persisted. */
    notifyAfterPersist(): void {
      const boundary = durableClosedPrefixBoundary(args.message(), openPartIds)
      if (!boundary || boundary.partId === lastNotifiedPartId) return
      lastNotifiedPartId = boundary.partId
      notifyBackgroundCompactionPrefix(args.callback, boundary)
    },
  }
}

/** Reinsert the mutable assistant where durable reload found it, preserving later steering/messages. */
export function historyWithCurrentAssistant(
  history: StoredChatMessage[],
  assistant: StoredChatMessage,
  assistantIndex: number | null
): StoredChatMessage[] {
  if (assistantIndex == null) return [...history, assistant]
  return [...history.slice(0, assistantIndex), assistant, ...history.slice(assistantIndex)]
}

/**
 * A prepared result is already committed by the service. Reload it instead of appending a second marker,
 * and remove the live assistant from history while retaining its durable position for native reseeds.
 */
export function activatePreparedCompaction(args: {
  conversationId: string
  assistantMessageId: string
  prepared: PreparedBackgroundCompaction
  scope?: HistoryScope
}): PreparedCompactionActivation {
  const loaded = runnerContextHistory(args.conversationId, args.scope)
  const markerMessage = loaded.find((message) => message.id === args.prepared.messageId)
  const markerIndex = markerMessage?.parts.findIndex(
    (part) => part.type === 'compaction' && part.id === args.prepared.partId
  )
  if (!markerMessage) {
    throw new Error('Prepared compaction message was not found in durable history')
  }
  if (markerIndex == null || markerIndex < 0) {
    throw new Error('Prepared compaction marker was not found in durable history')
  }
  if (markerIndex === 0 || markerMessage.parts[markerIndex - 1]?.id !== args.prepared.afterPartId) {
    throw new Error('Prepared compaction marker is not at its committed boundary')
  }
  const marker = markerMessage.parts[markerIndex]
  if (marker.type !== 'compaction') throw new Error('Prepared compaction marker is invalid')

  const assistantIndex = loaded.findIndex((message) => message.id === args.assistantMessageId)
  const assistant = loaded[assistantIndex]
  if (assistant?.role !== 'assistant') {
    throw new Error('Current assistant message was not found after prepared compaction')
  }
  const history = loaded.filter((message) => message.id !== args.assistantMessageId)
  return {
    history,
    assistant,
    assistantIndex,
    event: {
      kind: 'compaction',
      messageId: args.prepared.messageId,
      partId: args.prepared.partId,
      afterPartId: args.prepared.afterPartId,
      text: marker.text,
      strategy: 'summary',
    },
    contextTokens: estimatePortableContextTokens(loaded),
  }
}
