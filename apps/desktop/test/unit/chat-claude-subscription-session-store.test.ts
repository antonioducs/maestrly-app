import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  getClaudeMessageMapping,
  getClaudeSessionBinding,
  listClaudeSessionCleanup,
  putClaudeMessageMapping,
  putClaudeSessionBinding,
  retireClaudeSessionBinding,
} from '../../src/main/chat/claude-agent-sdk/session-store'
import { upsertChatMessage } from '../../src/main/chat/chat-store'
import { closeDb, freshDb } from '../helpers/db'
import { makeConversation, makeWorkspace } from '../helpers/factories'

function binding(conversationId: string, sessionId = 'claude-session-1') {
  return {
    conversationId,
    sessionId,
    modelId: 'sonnet',
    effort: 'high',
    fastMode: true,
    cwd: '/repo',
    harnessProfile: 'maestrly-claude-v1',
    promptHash: 'prompt-hash',
    toolSignature: 'tool-signature',
    lastMessageId: 'assistant-1',
    lastAssistantUuid: 'sdk-assistant-1',
    accountFingerprint: 'sha256:account',
    accountEpoch: 3,
    usage: {
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 40,
      cacheWriteTokens: 10,
      costUsd: 0.02,
      turns: 2,
      durationMs: 500,
      durationApiMs: 450,
    },
    context: { totalTokens: 500, maxTokens: 200_000, percentage: 0.25, model: 'claude-sonnet' },
  }
}

describe('Claude session store', () => {
  beforeEach(freshDb)
  afterEach(closeDb)

  it('persists every compatibility dimension and Maestrly-to-SDK UUID mapping', () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd: '/repo' })
    upsertChatMessage({
      id: 'assistant-1',
      conversationId: conversation.id,
      role: 'assistant',
      parts: [],
      createdAt: 1,
    })

    putClaudeSessionBinding(binding(conversation.id))
    putClaudeMessageMapping({
      conversationId: conversation.id,
      maestrlyMessageId: 'assistant-1',
      sessionId: 'claude-session-1',
      sdkUserUuid: 'sdk-user-1',
      sdkAssistantUuid: 'sdk-assistant-1',
    })

    expect(getClaudeSessionBinding(conversation.id)).toMatchObject(binding(conversation.id))
    expect(getClaudeMessageMapping(conversation.id, 'assistant-1')).toMatchObject({
      conversationId: conversation.id,
      maestrlyMessageId: 'assistant-1',
      sessionId: 'claude-session-1',
      sdkUserUuid: 'sdk-user-1',
      sdkAssistantUuid: 'sdk-assistant-1',
    })
  })

  it('queues the replaced or retired session before dropping its binding', () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    putClaudeSessionBinding(binding(conversation.id, 'session-old'))

    putClaudeSessionBinding(binding(conversation.id, 'session-new'))

    expect(getClaudeSessionBinding(conversation.id)?.sessionId).toBe('session-new')
    expect(listClaudeSessionCleanup()).toEqual([
      expect.objectContaining({
        conversationId: conversation.id,
        sessionId: 'session-old',
        cwd: '/repo',
      }),
    ])

    retireClaudeSessionBinding(conversation.id, 'session-new')
    expect(getClaudeSessionBinding(conversation.id)).toBeNull()
    expect(
      listClaudeSessionCleanup()
        .map((entry) => entry.sessionId)
        .sort()
    ).toEqual(['session-new', 'session-old'])
  })
})
