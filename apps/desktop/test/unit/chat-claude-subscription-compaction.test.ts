import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chatHistoryStats, upsertChatMessage } from '../../src/main/chat/chat-store'
import { activeChatContext } from '../../src/main/chat/message'
import { closeDb, freshDb } from '../helpers/db'
import { makeConversation, makeWorkspace } from '../helpers/factories'

describe('Claude provider-native compaction marker', () => {
  beforeEach(freshDb)
  afterEach(closeDb)

  it('is opaque to portable context and only reduces stats while the Claude binding is reusable', () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    const messages = [
      {
        id: 'user-before',
        conversationId: conversation.id,
        role: 'user' as const,
        parts: [{ type: 'text' as const, id: 'text-before', text: 'important original context' }],
        createdAt: 1,
      },
      {
        id: 'claude-boundary',
        conversationId: conversation.id,
        role: 'assistant' as const,
        parts: [
          {
            type: 'compaction' as const,
            id: 'compact',
            text: 'Opaque Claude native boundary',
            strategy: 'claude-native' as const,
          },
        ],
        model: { providerId: 'builtin_claude_subscription', modelId: 'sonnet' },
        usage: {
          usageVersion: 2 as const,
          input: 0,
          output: 0,
          contextInput: 300,
          contextOutput: 0,
          modelContextWindow: 200_000,
          billingOnly: true,
        },
        createdAt: 2,
      },
    ]
    messages.forEach(upsertChatMessage)

    expect(activeChatContext(messages).messages).toHaveLength(2)
    expect(activeChatContext(messages).summary).toBe('')

    const invalid = chatHistoryStats(conversation.id)
    expect(invalid.lastUsage).toBeNull()

    const reusable = chatHistoryStats(conversation.id, {
      isNativeCompactionActive: (messageId) => messageId === 'claude-boundary',
    })
    expect(reusable.lastUsage).toMatchObject({
      contextInput: 300,
      modelContextWindow: 200_000,
    })
  })
})
