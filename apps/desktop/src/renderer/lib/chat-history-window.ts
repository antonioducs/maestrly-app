import type { ChatMessage } from '../../shared/chat'
import { CHAT_HISTORY_MAX_BYTES, CHAT_HISTORY_MAX_MESSAGES, CHAT_HISTORY_PAGE_SIZE } from '../../shared/memory-policy'

export { CHAT_HISTORY_MAX_BYTES, CHAT_HISTORY_MAX_MESSAGES, CHAT_HISTORY_PAGE_SIZE }

export interface HistoryWindowInput {
  messages: readonly ChatMessage[]
  incoming: readonly ChatMessage[]
  side: 'prepend' | 'replace'
  keepIds?: ReadonlySet<string>
}

export interface HistoryWindowResult {
  messages: ChatMessage[]
  trimmedFront: boolean
  trimmedBack: boolean
  estimatedBytes: number
}

const weightCache = new WeakMap<ChatMessage, number>()

function messageWeight(message: ChatMessage): number {
  const cached = weightCache.get(message)
  if (cached !== undefined) return cached
  let weight: number
  try {
    weight = JSON.stringify(message).length
  } catch {
    weight = 256
  }
  weightCache.set(message, weight)
  return weight
}

export function estimateHistoryWindowBytes(messages: readonly ChatMessage[]): number {
  return messages.reduce((sum, message) => sum + messageWeight(message), 0)
}

export function boundChatHistoryWindow(input: HistoryWindowInput): HistoryWindowResult {
  const keepIds = input.keepIds ?? new Set<string>()
  const merged = input.side === 'replace' ? [...input.incoming] : [...input.incoming, ...input.messages]
  const seen = new Set<string>()
  const unique: ChatMessage[] = []
  for (const message of merged) {
    if (seen.has(message.id)) continue
    seen.add(message.id)
    unique.push(message)
  }

  let start = 0
  let end = unique.length
  let bytes = estimateHistoryWindowBytes(unique)
  let trimmedFront = false
  let trimmedBack = false

  const canDrop = (index: number): boolean => !keepIds.has(unique[index]!.id)

  while (end - start > CHAT_HISTORY_MAX_MESSAGES || bytes > CHAT_HISTORY_MAX_BYTES) {
    if (input.side === 'prepend') {
      let drop = end - 1
      while (drop >= start && !canDrop(drop)) drop--
      if (drop < start) break
      bytes -= messageWeight(unique[drop]!)
      unique.splice(drop, 1)
      end = unique.length
      trimmedBack = true
      continue
    }
    let drop = start
    while (drop < end && !canDrop(drop)) drop++
    if (drop >= end) break
    bytes -= messageWeight(unique[drop]!)
    unique.splice(drop, 1)
    end = unique.length
    trimmedFront = true
  }

  return {
    messages: unique,
    trimmedFront,
    trimmedBack,
    estimatedBytes: bytes,
  }
}
