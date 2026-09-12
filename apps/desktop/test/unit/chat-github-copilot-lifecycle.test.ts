import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  manager: {
    deleteSession: vi.fn(),
  },
}))

vi.mock('../../src/main/chat/github-copilot/manager', () => ({
  getGitHubCopilotSubscriptionManager: () => h.manager,
}))

import {
  deleteAllManagedGitHubCopilotSessions,
  deleteGitHubCopilotSessionForConversation,
  retryManagedGitHubCopilotSessionCleanup,
} from '../../src/main/chat/github-copilot/lifecycle'
import {
  getGitHubCopilotSessionBinding,
  listGitHubCopilotSessionBindings,
  listGitHubCopilotSessionCleanup,
  putGitHubCopilotSessionBinding,
  queueGitHubCopilotSessionCleanup,
} from '../../src/main/chat/github-copilot/session-store'
import { closeDb, freshDb } from '../helpers/db'
import { makeConversation, makeWorkspace } from '../helpers/factories'

function bind(conversationId: string, sessionId: string): void {
  putGitHubCopilotSessionBinding({
    conversationId,
    sessionId,
    modelId: 'gpt-5.6-sol',
    harnessProfile: 'copilot-openai-v1',
    toolSignature: 'tools',
    lastMessageId: `last-${sessionId}`,
    accountFingerprint: 'sha256:account',
  })
}

describe('GitHub Copilot session lifecycle', () => {
  beforeEach(() => {
    freshDb()
    h.manager.deleteSession.mockReset().mockResolvedValue(undefined)
  })

  afterEach(() => {
    closeDb()
    vi.restoreAllMocks()
  })

  it('invalidates the binding and creates a tombstone before remote hard deletion', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    bind(conversation.id, 'session-1')
    h.manager.deleteSession.mockImplementation(async (sessionId: string) => {
      expect(sessionId).toBe('session-1')
      expect(getGitHubCopilotSessionBinding(conversation.id)).toBeNull()
      expect(listGitHubCopilotSessionCleanup()).toEqual([
        expect.objectContaining({ conversationId: conversation.id, sessionId: 'session-1', attempts: 0 }),
      ])
    })

    await deleteGitHubCopilotSessionForConversation(conversation.id)

    expect(h.manager.deleteSession).toHaveBeenCalledOnce()
    expect(getGitHubCopilotSessionBinding(conversation.id)).toBeNull()
    expect(listGitHubCopilotSessionCleanup()).toEqual([])
  })

  it('remote failure does not block local teardown and remains durable for retry', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    bind(conversation.id, 'session-offline')
    h.manager.deleteSession.mockRejectedValue(new Error('runtime offline'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    await deleteGitHubCopilotSessionForConversation(conversation.id)

    expect(getGitHubCopilotSessionBinding(conversation.id)).toBeNull()
    expect(listGitHubCopilotSessionCleanup()).toEqual([
      expect.objectContaining({
        conversationId: conversation.id,
        sessionId: 'session-offline',
        attempts: 1,
        lastError: 'runtime offline',
      }),
    ])
  })

  it('idempotent hard deletion treats an already absent session as success', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    bind(conversation.id, 'session-gone')
    h.manager.deleteSession.mockRejectedValue(new Error('Unknown session session-gone'))

    await deleteGitHubCopilotSessionForConversation(conversation.id)

    expect(listGitHubCopilotSessionCleanup()).toEqual([])
  })

  it('bounds a stalled RPC, persists a tombstone, and releases teardown', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    bind(conversation.id, 'session-hung')
    h.manager.deleteSession.mockReturnValue(new Promise<void>(() => {}))
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    await deleteGitHubCopilotSessionForConversation(conversation.id, { timeoutMs: 10 })

    expect(listGitHubCopilotSessionCleanup()).toEqual([
      expect.objectContaining({
        conversationId: conversation.id,
        sessionId: 'session-hung',
        attempts: 1,
        lastError: expect.stringContaining('Timed out deleting GitHub Copilot session'),
      }),
    ])
  })

  it('permanent deletion reports failure even when retrying without a binding', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    bind(conversation.id, 'session-private')
    h.manager.deleteSession.mockRejectedValue(new Error('runtime offline'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(
      deleteGitHubCopilotSessionForConversation(conversation.id, { strict: true, timeoutMs: 10 })
    ).rejects.toThrow('runtime offline')
    expect(getGitHubCopilotSessionBinding(conversation.id)).toBeNull()

    await expect(
      deleteGitHubCopilotSessionForConversation(conversation.id, { strict: true, timeoutMs: 10 })
    ).rejects.toThrow('runtime offline')
    expect(h.manager.deleteSession).toHaveBeenCalledTimes(2)
  })

  it('retry drains old tombstones without touching valid bindings', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    bind(conversation.id, 'session-current')
    queueGitHubCopilotSessionCleanup('deleted-conversation', 'session-pending')

    await retryManagedGitHubCopilotSessionCleanup()

    expect(h.manager.deleteSession).toHaveBeenCalledWith('session-pending')
    expect(h.manager.deleteSession).toHaveBeenCalledOnce()
    expect(getGitHubCopilotSessionBinding(conversation.id)?.sessionId).toBe('session-current')
    expect(listGitHubCopilotSessionCleanup()).toEqual([])
  })

  it('the account boundary clears current bindings and tombstones from previous attempts', async () => {
    const workspace = makeWorkspace()
    const first = makeConversation(workspace.id, {})
    const second = makeConversation(workspace.id, {})
    bind(first.id, 'session-first')
    bind(second.id, 'session-second')
    queueGitHubCopilotSessionCleanup('old-conversation', 'session-old-tombstone')

    await deleteAllManagedGitHubCopilotSessions()

    expect(listGitHubCopilotSessionBindings()).toEqual([])
    expect(h.manager.deleteSession.mock.calls.map(([sessionId]) => sessionId).sort()).toEqual([
      'session-first',
      'session-old-tombstone',
      'session-second',
    ])
    expect(listGitHubCopilotSessionCleanup()).toEqual([])
  })
})
