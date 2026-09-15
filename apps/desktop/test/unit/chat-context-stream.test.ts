import { describe, expect, it } from 'vitest'
import { applyChatEvent, type ChatContextSnapshot, type ChatMessage } from '../../src/shared/chat'

const initial: ChatMessage = {
  id: 'assistant',
  conversationId: 'conversation',
  role: 'assistant',
  parts: [],
  createdAt: 1,
}
const snapshot = (sequence: number, usedTokens: number): ChatContextSnapshot => ({
  usedTokens,
  sequence,
  modelContextWindow: 1_000_000,
  model: { providerId: 'claude', modelId: 'opus' },
  quality: 'measured',
  observedAt: sequence,
})

describe('context stream observations', () => {
  it('updates occupancy before finish without adding billing usage', () => {
    let messages = applyChatEvent([initial], {
      kind: 'context-usage',
      messageId: initial.id,
      snapshot: snapshot(1, 269_000),
    })
    messages = applyChatEvent(messages, {
      kind: 'context-usage',
      messageId: initial.id,
      snapshot: snapshot(2, 902_365),
    })
    expect(messages[0].contextSnapshot?.usedTokens).toBe(902_365)
    expect(messages[0].usage).toBeUndefined()
    expect(messages[0].finishReason).toBeUndefined()
  })

  it('allows a lower post-compaction measurement and rejects a late older sample', () => {
    let messages = applyChatEvent([initial], {
      kind: 'context-usage',
      messageId: initial.id,
      snapshot: snapshot(2, 902_365),
    })
    messages = applyChatEvent(messages, { kind: 'context-usage', messageId: initial.id, snapshot: snapshot(3, 45_000) })
    messages = applyChatEvent(messages, {
      kind: 'context-usage',
      messageId: initial.id,
      snapshot: snapshot(2, 902_365),
    })
    expect(messages[0].contextSnapshot).toEqual(snapshot(3, 45_000))
  })

  it.each(['finish', 'error', 'aborted'] as const)('preserves the last observation on %s', (kind) => {
    const messages = applyChatEvent([initial], {
      kind: 'context-usage',
      messageId: initial.id,
      snapshot: snapshot(1, 902_365),
    })
    const result = applyChatEvent(
      messages,
      kind === 'finish'
        ? { kind, messageId: initial.id, finishReason: 'stop', responseDurationMs: 100 }
        : kind === 'error'
          ? { kind, messageId: initial.id, message: 'Compaction timed out' }
          : { kind, messageId: initial.id }
    )
    expect(result[0].contextSnapshot).toEqual(snapshot(1, 902_365))
  })

  it('retains a compaction failure when a delayed progress event arrives', () => {
    const progress = { id: 'compact', status: 'failed' as const, error: 'Step timed out', updatedAt: 2 }
    let messages = applyChatEvent([initial], { kind: 'compaction-progress', messageId: initial.id, progress })
    messages = applyChatEvent(messages, {
      kind: 'compaction-progress',
      messageId: initial.id,
      progress: { id: 'compact', status: 'running', completed: 1, total: 2, updatedAt: 1 },
    })
    expect(messages[0].compactionProgress).toEqual(progress)
  })
})
