import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  manager: {
    deleteManagedSession: vi.fn(),
  },
}))

vi.mock('../../src/main/chat/claude-agent-sdk/manager', () => ({
  getClaudeSubscriptionManager: () => h.manager,
}))

import {
  deleteAllManagedClaudeSessions,
  deleteClaudeSessionForConversation,
  retryManagedClaudeSessionCleanup,
} from '../../src/main/chat/claude-agent-sdk/lifecycle'
import {
  getClaudeSessionBinding,
  listClaudeSessionBindings,
  listClaudeSessionCleanup,
  putClaudeSessionBinding,
  queueClaudeSessionCleanup,
} from '../../src/main/chat/claude-agent-sdk/session-store'
import { closeDb, freshDb } from '../helpers/db'
import { makeConversation, makeWorkspace } from '../helpers/factories'

function bind(conversationId: string, sessionId: string, cwd = '/repo'): void {
  putClaudeSessionBinding({
    conversationId,
    sessionId,
    modelId: 'sonnet',
    effort: '',
    fastMode: false,
    cwd,
    harnessProfile: 'maestrly-claude-v1',
    promptHash: 'prompt',
    toolSignature: 'tools',
    lastMessageId: `last-${sessionId}`,
    lastAssistantUuid: `uuid-${sessionId}`,
    accountFingerprint: 'sha256:account',
    accountEpoch: 1,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
      turns: 0,
      durationMs: 0,
      durationApiMs: 0,
    },
    context: null,
  })
}

describe('Claude session lifecycle', () => {
  beforeEach(() => {
    freshDb()
    h.manager.deleteManagedSession.mockReset().mockResolvedValue(undefined)
  })

  afterEach(() => {
    closeDb()
    vi.restoreAllMocks()
  })

  it('invalidates locally before hard-delete and passes the exact cwd', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    bind(conversation.id, 'session-1', '/private/worktree')
    h.manager.deleteManagedSession.mockImplementation(async () => {
      expect(getClaudeSessionBinding(conversation.id)).toBeNull()
      expect(listClaudeSessionCleanup()).toEqual([
        expect.objectContaining({ conversationId: conversation.id, sessionId: 'session-1' }),
      ])
    })

    await deleteClaudeSessionForConversation(conversation.id)

    expect(h.manager.deleteManagedSession).toHaveBeenCalledWith('session-1', '/private/worktree')
    expect(listClaudeSessionCleanup()).toEqual([])
  })

  it('keeps a durable tombstone on failure and reports it for strict deletion', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    bind(conversation.id, 'session-offline')
    h.manager.deleteManagedSession.mockRejectedValue(new Error('runtime offline'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    await deleteClaudeSessionForConversation(conversation.id)
    expect(listClaudeSessionCleanup()).toEqual([
      expect.objectContaining({
        conversationId: conversation.id,
        sessionId: 'session-offline',
        attempts: 1,
        lastError: 'runtime offline',
      }),
    ])
    await expect(deleteClaudeSessionForConversation(conversation.id, { strict: true })).rejects.toThrow(
      'runtime offline'
    )
  })

  it('drains old tombstones and all bindings on account boundaries', async () => {
    const workspace = makeWorkspace()
    const first = makeConversation(workspace.id, {})
    const second = makeConversation(workspace.id, {})
    bind(first.id, 'session-first')
    bind(second.id, 'session-second')
    queueClaudeSessionCleanup('old-conversation', 'session-old', '/old-repo')

    await deleteAllManagedClaudeSessions()

    expect(listClaudeSessionBindings()).toEqual([])
    expect(h.manager.deleteManagedSession.mock.calls.map(([id]) => id).sort()).toEqual([
      'session-first',
      'session-old',
      'session-second',
    ])
    expect(listClaudeSessionCleanup()).toEqual([])

    queueClaudeSessionCleanup('retry-conversation', 'session-retry', '/repo')
    await retryManagedClaudeSessionCleanup()
    expect(h.manager.deleteManagedSession).toHaveBeenCalledWith('session-retry', '/repo')
    expect(listClaudeSessionCleanup()).toEqual([])
  })
})
