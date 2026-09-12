import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  clearAllGitHubCopilotSessionBindings,
  clearAllGitHubCopilotSessionCleanup,
  clearGitHubCopilotSessionCleanup,
  getGitHubCopilotSessionBinding,
  listGitHubCopilotSessionBindings,
  listGitHubCopilotSessionCleanup,
  markGitHubCopilotSessionCleanupFailed,
  putGitHubCopilotSessionBinding,
  queueGitHubCopilotSessionCleanup,
  retireGitHubCopilotSessionBinding,
} from '../../src/main/chat/github-copilot/session-store'
import { deleteConversation } from '../../src/main/store'
import { closeDb, freshDb } from '../helpers/db'
import { makeConversation, makeWorkspace } from '../helpers/factories'

function bind(
  conversationId: string,
  sessionId: string,
  overrides: Partial<Parameters<typeof putGitHubCopilotSessionBinding>[0]> = {}
): void {
  putGitHubCopilotSessionBinding({
    conversationId,
    sessionId,
    modelId: 'gpt-5.6-sol',
    harnessProfile: 'copilot-openai-v1',
    toolSignature: 'tools-sha256',
    lastMessageId: `last-${sessionId}`,
    accountFingerprint: 'sha256:account-a',
    ...overrides,
  })
}

describe('GitHub Copilot session store', () => {
  beforeEach(freshDb)
  afterEach(closeDb)

  it('persists and updates the complete resume contract, including identity and harness', () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    const writtenAt = Date.now()

    bind(conversation.id, 'session-1')
    expect(getGitHubCopilotSessionBinding(conversation.id)).toEqual({
      conversationId: conversation.id,
      sessionId: 'session-1',
      modelId: 'gpt-5.6-sol',
      harnessProfile: 'copilot-openai-v1',
      toolSignature: 'tools-sha256',
      lastMessageId: 'last-session-1',
      accountFingerprint: 'sha256:account-a',
      accountId: null,
      updatedAt: expect.any(Number),
    })
    expect(getGitHubCopilotSessionBinding(conversation.id)!.updatedAt).toBeGreaterThanOrEqual(writtenAt)

    bind(conversation.id, 'session-2', {
      modelId: 'claude-sonnet-4.5',
      harnessProfile: 'copilot-anthropic-v1',
      toolSignature: 'new-tools',
      lastMessageId: 'assistant-2',
      accountFingerprint: 'sha256:account-b',
    })
    expect(getGitHubCopilotSessionBinding(conversation.id)).toMatchObject({
      sessionId: 'session-2',
      modelId: 'claude-sonnet-4.5',
      harnessProfile: 'copilot-anthropic-v1',
      toolSignature: 'new-tools',
      lastMessageId: 'assistant-2',
      accountFingerprint: 'sha256:account-b',
    })
  })

  it('retirement uses compare-and-delete and never removes a replacement binding', () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    bind(conversation.id, 'session-current')

    expect(retireGitHubCopilotSessionBinding(conversation.id, 'session-stale')).toBe(false)
    expect(getGitHubCopilotSessionBinding(conversation.id)?.sessionId).toBe('session-current')
    expect(listGitHubCopilotSessionCleanup()).toEqual([])

    expect(retireGitHubCopilotSessionBinding(conversation.id, 'session-current')).toBe(true)
    expect(getGitHubCopilotSessionBinding(conversation.id)).toBeNull()
    expect(listGitHubCopilotSessionCleanup()).toEqual([
      expect.objectContaining({
        conversationId: conversation.id,
        sessionId: 'session-current',
        attempts: 0,
        lastError: null,
      }),
    ])
  })

  it('tombstones retain counters and errors across upserts until explicit confirmation', () => {
    queueGitHubCopilotSessionCleanup('deleted-conversation', 'session-pending')
    markGitHubCopilotSessionCleanupFailed('session-pending', 'runtime offline')
    queueGitHubCopilotSessionCleanup('deleted-conversation', 'session-pending')

    expect(listGitHubCopilotSessionCleanup()).toEqual([
      expect.objectContaining({
        conversationId: 'deleted-conversation',
        sessionId: 'session-pending',
        attempts: 1,
        lastError: 'runtime offline',
      }),
    ])
    expect(clearGitHubCopilotSessionCleanup('session-pending')).toBe(true)
    expect(clearGitHubCopilotSessionCleanup('session-pending')).toBe(false)
  })

  it('clear-all invalidates every binding and the trigger keeps each session enumerable for hard deletion', () => {
    const workspace = makeWorkspace()
    const first = makeConversation(workspace.id, {})
    const second = makeConversation(workspace.id, {})
    bind(first.id, 'session-first')
    bind(second.id, 'session-second')

    expect(listGitHubCopilotSessionBindings()).toHaveLength(2)
    expect(clearAllGitHubCopilotSessionBindings()).toBe(2)
    expect(listGitHubCopilotSessionBindings()).toEqual([])
    expect(
      listGitHubCopilotSessionCleanup()
        .map((item) => item.sessionId)
        .sort()
    ).toEqual(['session-first', 'session-second'])
    expect(clearAllGitHubCopilotSessionCleanup()).toBe(2)
    expect(clearAllGitHubCopilotSessionCleanup()).toBe(0)
  })

  it('conversation CASCADE preserves the session ID in a durable tombstone', () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    bind(conversation.id, 'session-cascade')

    deleteConversation(conversation.id)

    expect(getGitHubCopilotSessionBinding(conversation.id)).toBeNull()
    expect(listGitHubCopilotSessionCleanup()).toEqual([
      expect.objectContaining({ conversationId: conversation.id, sessionId: 'session-cascade' }),
    ])
  })
})
