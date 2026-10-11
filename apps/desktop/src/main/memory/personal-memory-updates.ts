import { createHash } from 'node:crypto'
import type { LocalMemory } from '../../shared/memory'
import type { MemoryCoreSource } from '../store/conversation-memory-state'
import { latestCompactionMarkers } from '../chat/chat-store'
import { getConversationMemoryState, saveConversationMemoryState } from '../store/conversation-memory-state'
import { memorySpaceForConversation } from './spaces'
import { getLocalMemory } from './local-memory-service'

export function personalMemorySource(memory: LocalMemory): MemoryCoreSource {
  return {
    key: `personal:${memory.id}`,
    text: `[${memory.id.slice(0, 8)}] ${memory.title}: ${memory.content.slice(0, 700)}`,
    hash: createHash('sha256')
      .update(JSON.stringify([memory.title, memory.content, memory.type, memory.status]))
      .digest('hex')
      .slice(0, 16),
  }
}

/** Invalidate every change on this admission, using a blanket reset when details exceed the budget. */
export function personalMemoryUpdates(
  spaceId: string,
  previous: readonly MemoryCoreSource[]
): {
  baseline: MemoryCoreSource[]
  text: string | null
  changedIds: string[]
} {
  const baseline: MemoryCoreSource[] = []
  const changedIds: string[] = []
  const prefix = '<maestrly-memory kind="updates">\nPersonal memory changes replace the matching earlier entries.\n'
  const suffix = '\n</maestrly-memory>'
  const lines: string[] = []
  for (const old of previous) {
    if (!old.key.startsWith('personal:')) {
      baseline.push(old)
      continue
    }
    const id = old.key.slice(9)
    const memory = getLocalMemory(spaceId, id)
    const current = memory?.status === 'active' ? personalMemorySource(memory) : undefined
    if (current?.hash === old.hash) {
      baseline.push(old)
      continue
    }
    const line = current
      ? `~ Updated: ${current.text}`
      : `- No longer valid, stop relying on it: ${old.text.slice(0, 300)}`
    lines.push(line)
    changedIds.push(id)
    if (current) baseline.push(current)
  }
  const details = prefix + lines.join('\n') + suffix
  const text =
    details.length <= 1500
      ? details
      : prefix +
        'Invalidate all earlier personal memory entries, including previous tool reads and recalls. The current # Memory section replaces the old core. Read any other personal fact again with memory_read before relying on it; archived, deleted, and superseded entries are no longer valid.' +
        suffix
  return { baseline, changedIds, text: lines.length ? text : null }
}

/** Record only evidence actually returned by an authorized personal memory tool. */
export function trackPersonalMemoryRead(conversationId: string, memory: LocalMemory): void {
  const space = memorySpaceForConversation(conversationId)
  if (space?.kind !== 'personal' || memory.workspaceId !== space.id || memory.status !== 'active') return
  const previous = getConversationMemoryState(conversationId)
  if (previous && previous.spaceId !== space.id) return
  const markers = latestCompactionMarkers(conversationId)
  const state = previous ?? {
    conversationId,
    spaceId: space.id,
    coreEpoch: markers.portable,
    coreText: '',
    baseline: [],
    recallEpoch: markers.any,
    recalledIds: [],
    updatedAt: Date.now(),
  }
  const source = personalMemorySource(memory)
  const baseline = state.baseline.filter((entry) => entry.key !== source.key)
  saveConversationMemoryState({
    ...state,
    baseline: [
      ...baseline.filter((entry) => !entry.key.startsWith('personal:')),
      ...baseline.filter((entry) => entry.key.startsWith('personal:')).slice(-239),
      source,
    ],
  })
}
