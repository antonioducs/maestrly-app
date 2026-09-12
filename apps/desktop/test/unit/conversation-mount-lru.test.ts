import { describe, expect, it } from 'vitest'
import {
  MAX_MOUNTED_CHAT_VIEWS,
  MAX_SAFE_MOUNTED_CHAT_VIEWS,
  pruneMountedChatViews,
} from '../../src/renderer/lib/conversation-mount-lru'
import type { Conversation } from '../../src/preload'
import {
  applyChatEvent,
  findPendingChatQuestion,
  mergePendingChatQuestions,
  type ChatMessage,
  type PendingChatQuestion,
} from '../../src/shared/chat'

function conversation(id: string): Conversation {
  return { id } as Conversation
}

function questionMessage(): ChatMessage {
  return {
    id: 'assistant-1',
    conversationId: 'chat-0',
    role: 'assistant',
    createdAt: 1,
    parts: [
      {
        type: 'tool',
        id: 'question-1',
        toolCallId: 'question-1',
        toolName: 'ask_question',
        input: {
          questions: [{ header: 'Next step', question: 'Continue?', options: [{ label: 'Yes' }] }],
        },
        state: { status: 'pending' },
      },
    ],
  }
}

describe('conversation renderer mount LRU', () => {
  it('evicts oldest inactive BYOK chats at the soft cap', () => {
    const mounted = Array.from({ length: MAX_MOUNTED_CHAT_VIEWS + 2 }, (_, i) => conversation(`chat-${i}`))
    const result = pruneMountedChatViews(mounted, {}, 'chat-11')

    expect(result).toHaveLength(MAX_SAFE_MOUNTED_CHAT_VIEWS)
    expect(result.map((item) => item.id)).toEqual(mounted.slice(-MAX_SAFE_MOUNTED_CHAT_VIEWS).map((item) => item.id))
  })

  it('evicts inactive working chats while retaining the active chat', () => {
    const mounted = Array.from({ length: MAX_MOUNTED_CHAT_VIEWS + 2 }, (_, i) => conversation(`chat-${i}`))
    const result = pruneMountedChatViews(mounted, { 'chat-0': 'working' }, `chat-${MAX_MOUNTED_CHAT_VIEWS + 1}`)

    expect(result).toHaveLength(MAX_SAFE_MOUNTED_CHAT_VIEWS + 1)
    expect(result.map((item) => item.id)).not.toContain('chat-0')
    expect(result.map((item) => item.id)).not.toContain('chat-1')
    expect(result.map((item) => item.id)).toContain(`chat-${MAX_MOUNTED_CHAT_VIEWS + 1}`)
  })

  it('protects a chat with non-evictable compose state even when it is inactive', () => {
    const mounted = Array.from({ length: MAX_MOUNTED_CHAT_VIEWS + 2 }, (_, i) => conversation(`chat-${i}`))
    const result = pruneMountedChatViews(mounted, {}, 'chat-9', new Set(['chat-0']))

    expect(result.map((item) => item.id)).toContain('chat-0')
    expect(result.map((item) => item.id)).toContain('chat-9')
    expect(result).toHaveLength(MAX_SAFE_MOUNTED_CHAT_VIEWS + 2)
  })

  it('allows the chat again after its eviction safety signal is cleared', () => {
    const mounted = Array.from({ length: MAX_MOUNTED_CHAT_VIEWS + 2 }, (_, i) => conversation(`chat-${i}`))

    const result = pruneMountedChatViews(mounted, {}, 'chat-9', new Set())

    expect(result.map((item) => item.id)).not.toContain('chat-0')
    expect(result.map((item) => item.id)).not.toContain('chat-1')
  })

  it('keeps both paired review panes mounted under hard pressure', () => {
    const mounted = Array.from({ length: MAX_MOUNTED_CHAT_VIEWS + 2 }, (_, i) => conversation(`chat-${i}`))
    const result = pruneMountedChatViews(mounted, {}, 'chat-9', new Set(), undefined, undefined, {
      hardPressure: true,
      protectedIds: new Set(['chat-0', 'chat-1']),
    })

    expect(result.map((item) => item.id)).toEqual(expect.arrayContaining(['chat-0', 'chat-1', 'chat-9']))
  })

  it('pauses automatic TTL/LRU pruning while disabled and resumes when re-enabled', () => {
    const mounted = Array.from({ length: MAX_SAFE_MOUNTED_CHAT_VIEWS + 1 }, (_, i) => conversation(`chat-${i}`))
    const lastVisibleAt = Object.fromEntries(mounted.map((item) => [item.id, 0]))
    const activeId = mounted.at(-1)!.id

    const disabled = pruneMountedChatViews(mounted, {}, activeId, new Set(), undefined, undefined, {
      autoReclaimEnabled: false,
      lastVisibleAt,
      now: 100,
      ttlMs: 1,
    })
    expect(disabled).toBe(mounted)
    expect(disabled).toHaveLength(mounted.length)

    const reenabled = pruneMountedChatViews(mounted, {}, activeId, new Set(), undefined, undefined, {
      autoReclaimEnabled: true,
      lastVisibleAt,
      now: 100,
      ttlMs: 1,
    })
    expect(reenabled.map((item) => item.id)).toEqual([activeId])
  })

  it('protects a pending question and releases the view when the tool resolves', () => {
    const mounted = Array.from({ length: MAX_MOUNTED_CHAT_VIEWS + 2 }, (_, i) => conversation(`chat-${i}`))
    const pending = [questionMessage()]
    const pendingQuestion = findPendingChatQuestion(pending)

    expect(pendingQuestion?.toolCallId).toBe('question-1')
    const protectedResult = pruneMountedChatViews(
      mounted,
      {},
      'chat-9',
      pendingQuestion ? new Set(['chat-0']) : new Set(),
      undefined,
      undefined,
      { hardPressure: true }
    )
    expect(protectedResult.map((item) => item.id)).toContain('chat-0')

    const resolved = applyChatEvent(pending, {
      kind: 'tool-state',
      messageId: 'assistant-1',
      toolCallId: 'question-1',
      state: { status: 'completed', output: 'answered' },
    })
    expect(findPendingChatQuestion(resolved)).toBeNull()

    const releasedResult = pruneMountedChatViews(mounted, {}, 'chat-9', new Set(), undefined, undefined, {
      hardPressure: true,
    })
    expect(releasedResult.map((item) => item.id)).not.toContain('chat-0')
  })

  it('rehydrates the composer when the remounted view missed background question deltas', () => {
    const staleHistory: ChatMessage[] = [
      {
        id: 'assistant-1',
        conversationId: 'chat-0',
        role: 'assistant',
        createdAt: 1,
        parts: [{ type: 'text', id: 'text-1', text: 'Two questions before writing:' }],
      },
    ]
    const snapshot: PendingChatQuestion[] = [
      {
        messageId: 'assistant-1',
        toolCallId: 'question-1',
        questions: [{ header: 'Next step', question: 'Continue?', options: [{ label: 'Yes' }] }],
      },
    ]

    expect(findPendingChatQuestion(staleHistory)).toBeNull()

    const hydrated = mergePendingChatQuestions(staleHistory, 'chat-0', snapshot)
    expect(findPendingChatQuestion(hydrated)).toEqual(snapshot[0])
    expect(hydrated).toHaveLength(1)
    expect(hydrated[0].parts).toHaveLength(2)
  })
})
