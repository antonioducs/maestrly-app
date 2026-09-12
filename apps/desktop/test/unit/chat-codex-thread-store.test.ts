import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeDb, freshDb } from '../helpers/db'
import { makeConversation, makeWorkspace } from '../helpers/factories'
import { deleteConversation, getDb } from '../../src/main/store'
import {
  clearAllCodexThreadBindings,
  clearAllCodexThreadCleanup,
  clearCodexThreadCleanup,
  clearCodexThreadBinding,
  getCodexThreadBinding,
  listCodexThreadCleanup,
  listCodexThreadBindings,
  markCodexThreadCleanupFailed,
  putCodexThreadBinding,
  queueCodexThreadCleanup,
  retireCodexThreadBinding,
} from '../../src/main/chat/codex-subscription/thread-store'

describe('Codex thread store', () => {
  beforeEach(freshDb)
  afterEach(closeDb)

  it('persists complete bindings and cumulative usage snapshots', () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    const writtenAt = Date.now()

    putCodexThreadBinding({
      conversationId: conversation.id,
      threadId: 'thread_123',
      modelId: 'gpt-5.6-sol',
      toolSignature: 'tools-sha256',
      instructionHash: 'instructions-sha256',
      harnessProfile: 'openai-gpt-6-astra-v1',
      lastMessageId: 'message_456',
      usage: {
        inputTokens: 1_234,
        cachedInputTokens: 345,
        outputTokens: 678,
        reasoningOutputTokens: 89,
      },
    })

    expect(getCodexThreadBinding(conversation.id)).toEqual({
      conversationId: conversation.id,
      threadId: 'thread_123',
      modelId: 'gpt-5.6-sol',
      toolSignature: 'tools-sha256',
      instructionHash: 'instructions-sha256',
      harnessProfile: 'openai-gpt-6-astra-v1',
      lastMessageId: 'message_456',
      usage: {
        inputTokens: 1_234,
        cachedInputTokens: 345,
        outputTokens: 678,
        reasoningOutputTokens: 89,
      },
      accountId: null,
      updatedAt: expect.any(Number),
    })
    expect(getCodexThreadBinding(conversation.id)!.updatedAt).toBeGreaterThanOrEqual(writtenAt)
  })

  it('clears only the selected conversation binding', () => {
    const workspace = makeWorkspace()
    const firstConversation = makeConversation(workspace.id, {})
    const secondConversation = makeConversation(workspace.id, {})

    for (const [conversationId, suffix] of [
      [firstConversation.id, 'first'],
      [secondConversation.id, 'second'],
    ] as const) {
      putCodexThreadBinding({
        conversationId,
        threadId: `thread_${suffix}`,
        modelId: 'gpt-5.6-sol',
        toolSignature: `tools_${suffix}`,
        lastMessageId: `message_${suffix}`,
        usage: {
          inputTokens: 10,
          cachedInputTokens: 2,
          outputTokens: 5,
          reasoningOutputTokens: 1,
        },
      })
    }

    clearCodexThreadBinding(firstConversation.id)

    expect(getCodexThreadBinding(firstConversation.id)).toBeNull()
    expect(getCodexThreadBinding(secondConversation.id)?.threadId).toBe('thread_second')
  })

  it('preserves bindings replaced during remote cleanup', () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    putCodexThreadBinding({
      conversationId: conversation.id,
      threadId: 'thread_new',
      modelId: 'gpt-5.6-sol',
      toolSignature: 'tools',
      lastMessageId: 'message_new',
      usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 },
    })

    expect(clearCodexThreadBinding(conversation.id, 'thread_old')).toBe(false)
    expect(getCodexThreadBinding(conversation.id)?.threadId).toBe('thread_new')
    expect(clearCodexThreadBinding(conversation.id, 'thread_new')).toBe(true)
    expect(getCodexThreadBinding(conversation.id)).toBeNull()
  })

  it('lists bindings and invalidates account boundaries atomically', () => {
    const workspace = makeWorkspace()
    const first = makeConversation(workspace.id, {})
    const second = makeConversation(workspace.id, {})
    for (const [conversationId, suffix] of [
      [first.id, 'first'],
      [second.id, 'second'],
    ] as const) {
      putCodexThreadBinding({
        conversationId,
        threadId: `thread_${suffix}`,
        modelId: 'gpt-5.6-sol',
        toolSignature: 'tools',
        lastMessageId: `message_${suffix}`,
        usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0 },
      })
    }

    expect(
      listCodexThreadBindings()
        .map((binding) => binding.threadId)
        .sort()
    ).toEqual(['thread_first', 'thread_second'])
    expect(clearAllCodexThreadBindings()).toBe(2)
    expect(listCodexThreadBindings()).toEqual([])
    expect(
      listCodexThreadCleanup()
        .map((cleanup) => cleanup.threadId)
        .sort()
    ).toEqual(['thread_first', 'thread_second'])
    expect(clearAllCodexThreadBindings()).toBe(0)
  })

  it('retires bindings and creates tombstones atomically', () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    putCodexThreadBinding({
      conversationId: conversation.id,
      threadId: 'thread_current',
      modelId: 'gpt-5.6-sol',
      toolSignature: 'tools',
      lastMessageId: 'message_current',
      usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0 },
    })

    expect(retireCodexThreadBinding(conversation.id, 'thread_stale')).toBe(false)
    expect(getCodexThreadBinding(conversation.id)?.threadId).toBe('thread_current')
    expect(listCodexThreadCleanup()).toEqual([])

    expect(retireCodexThreadBinding(conversation.id, 'thread_current')).toBe(true)
    expect(getCodexThreadBinding(conversation.id)).toBeNull()
    expect(listCodexThreadCleanup()).toEqual([
      expect.objectContaining({
        conversationId: conversation.id,
        threadId: 'thread_current',
        attempts: 0,
        lastError: null,
      }),
    ])
  })

  it('preserves cleanup errors and attempts until explicit confirmation', () => {
    queueCodexThreadCleanup('conversation-deleted', 'thread_pending')
    markCodexThreadCleanupFailed('thread_pending', 'runtime offline')
    queueCodexThreadCleanup('conversation-deleted', 'thread_pending')

    expect(listCodexThreadCleanup()).toEqual([
      expect.objectContaining({
        conversationId: 'conversation-deleted',
        threadId: 'thread_pending',
        attempts: 1,
        lastError: 'runtime offline',
      }),
    ])
    expect(clearCodexThreadCleanup('thread_pending')).toBe(true)
    expect(clearCodexThreadCleanup('thread_pending')).toBe(false)
    expect(listCodexThreadCleanup()).toEqual([])
  })

  it('wipes all tombstones including those without local conversations', () => {
    queueCodexThreadCleanup('conversation-deleted-a', 'thread_pending_a')
    queueCodexThreadCleanup('conversation-deleted-b', 'thread_pending_b')

    expect(clearAllCodexThreadCleanup()).toBe(2)
    expect(listCodexThreadCleanup()).toEqual([])
    expect(clearAllCodexThreadCleanup()).toBe(0)
  })

  it('cascades binding deletion with conversations', () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    putCodexThreadBinding({
      conversationId: conversation.id,
      threadId: 'thread_cascade',
      modelId: 'gpt-5.6-sol',
      toolSignature: 'tools_cascade',
      lastMessageId: 'message_cascade',
      usage: {
        inputTokens: 20,
        cachedInputTokens: 4,
        outputTokens: 8,
        reasoningOutputTokens: 2,
      },
    })

    deleteConversation(conversation.id)

    expect(getCodexThreadBinding(conversation.id)).toBeNull()
    const row = getDb()
      .prepare('SELECT COUNT(*) AS count FROM chat_codex_threads WHERE conversation_id = ?')
      .get(conversation.id) as { count: number }
    expect(row.count).toBe(0)
    expect(listCodexThreadCleanup()).toEqual([
      expect.objectContaining({
        conversationId: conversation.id,
        threadId: 'thread_cascade',
        attempts: 0,
        lastError: null,
      }),
    ])
  })
})
