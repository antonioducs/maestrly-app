import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  manager: {
    getStatus: vi.fn(),
    deleteThread: vi.fn(),
  },
}))

vi.mock('../../src/main/chat/codex-subscription/manager', () => ({
  getCodexSubscriptionManager: () => h.manager,
}))

import {
  deleteAllManagedCodexThreads,
  deleteCodexThreadForConversation,
  retryManagedCodexThreadCleanup,
} from '../../src/main/chat/codex-subscription/lifecycle'
import {
  getCodexThreadBinding,
  listCodexThreadCleanup,
  listCodexThreadBindings,
  putCodexThreadBinding,
} from '../../src/main/chat/codex-subscription/thread-store'
import { closeDb, freshDb } from '../helpers/db'
import { makeConversation, makeWorkspace } from '../helpers/factories'

function bind(conversationId: string, threadId: string): void {
  putCodexThreadBinding({
    conversationId,
    threadId,
    modelId: 'gpt-5.6-sol',
    toolSignature: 'tools',
    lastMessageId: `last-${threadId}`,
    usage: {
      inputTokens: 10,
      cachedInputTokens: 2,
      outputTokens: 3,
      reasoningOutputTokens: 1,
    },
  })
}

describe('Codex thread lifecycle', () => {
  beforeEach(() => {
    freshDb()
    h.manager.getStatus.mockReset().mockResolvedValue({ authenticated: true })
    h.manager.deleteThread.mockReset().mockResolvedValue(undefined)
  })

  afterEach(() => {
    closeDb()
    vi.restoreAllMocks()
  })

  it('creates tombstones before remote deletion', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    bind(conversation.id, 'thread-1')
    h.manager.deleteThread.mockImplementation(async (threadId: string, options: { signal?: AbortSignal }) => {
      expect(threadId).toBe('thread-1')
      expect(options.signal).toBeInstanceOf(AbortSignal)
      expect(getCodexThreadBinding(conversation.id)).toBeNull()
      expect(listCodexThreadCleanup()).toEqual([
        expect.objectContaining({ conversationId: conversation.id, threadId: 'thread-1', attempts: 0 }),
      ])
    })

    await expect(deleteCodexThreadForConversation(conversation.id)).resolves.toEqual({
      conversationId: conversation.id,
      threadId: 'thread-1',
      remoteDeleted: true,
    })

    expect(h.manager.getStatus).not.toHaveBeenCalled()
    expect(h.manager.deleteThread).toHaveBeenCalledWith(
      'thread-1',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
    expect(getCodexThreadBinding(conversation.id)).toBeNull()
    expect(listCodexThreadCleanup()).toEqual([])
  })

  it('allows local actions after remote failure without reusing context', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    bind(conversation.id, 'thread-unavailable')
    h.manager.deleteThread.mockRejectedValue(new Error('app-server offline'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(deleteCodexThreadForConversation(conversation.id)).resolves.toMatchObject({
      conversationId: conversation.id,
      threadId: 'thread-unavailable',
      remoteDeleted: false,
      error: 'app-server offline',
    })
    expect(getCodexThreadBinding(conversation.id)).toBeNull()
    expect(listCodexThreadCleanup()).toEqual([
      expect.objectContaining({
        conversationId: conversation.id,
        threadId: 'thread-unavailable',
        attempts: 1,
        lastError: 'app-server offline',
      }),
    ])
  })

  it('distinguishes database failure from missing threads and preserves durable retries', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    bind(conversation.id, 'thread-database-error')
    h.manager.deleteThread.mockRejectedValue(new Error('cleanup database not found'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(deleteCodexThreadForConversation(conversation.id)).resolves.toMatchObject({
      threadId: 'thread-database-error',
      remoteDeleted: false,
      error: 'cleanup database not found',
    })
    expect(listCodexThreadCleanup()).toEqual([
      expect.objectContaining({
        threadId: 'thread-database-error',
        attempts: 1,
        lastError: 'cleanup database not found',
      }),
    ])
  })

  it('deletes threads independently of ChatGPT authentication', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    bind(conversation.id, 'thread-from-old-account')
    h.manager.getStatus.mockResolvedValue({ authenticated: false, account: { type: 'apiKey' } })

    await expect(deleteCodexThreadForConversation(conversation.id)).resolves.toMatchObject({
      threadId: 'thread-from-old-account',
      remoteDeleted: true,
    })
    expect(h.manager.getStatus).not.toHaveBeenCalled()
    expect(h.manager.deleteThread).toHaveBeenCalledWith(
      'thread-from-old-account',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
    expect(getCodexThreadBinding(conversation.id)).toBeNull()
  })

  it('isolates failures while deleting only Codex bindings', async () => {
    const workspace = makeWorkspace()
    const first = makeConversation(workspace.id, {})
    const second = makeConversation(workspace.id, {})
    const byok = makeConversation(workspace.id, {})
    bind(first.id, 'thread-first')
    bind(second.id, 'thread-second')
    h.manager.deleteThread.mockImplementation(async (threadId: string) => {
      if (threadId === 'thread-second') throw new Error('already gone')
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const results = await deleteAllManagedCodexThreads()

    expect(h.manager.getStatus).not.toHaveBeenCalled()
    expect(h.manager.deleteThread).toHaveBeenCalledTimes(2)
    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ conversationId: first.id, threadId: 'thread-first', remoteDeleted: true }),
        expect.objectContaining({
          conversationId: second.id,
          threadId: 'thread-second',
          remoteDeleted: false,
          error: 'already gone',
        }),
      ])
    )
    expect(listCodexThreadBindings()).toEqual([])
    // The BYOK conversation has no binding and appears in neither calls nor results.
    expect(results.some((result) => result.conversationId === byok.id)).toBe(false)
    expect(listCodexThreadCleanup()).toEqual([
      expect.objectContaining({ threadId: 'thread-second', attempts: 1, lastError: 'already gone' }),
    ])
  })

  it('preserves durable tombstones and retries only pending thread deletion', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    bind(conversation.id, 'thread-retry')
    h.manager.deleteThread.mockRejectedValueOnce(new Error('runtime offline')).mockResolvedValueOnce(undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(deleteCodexThreadForConversation(conversation.id)).resolves.toMatchObject({
      threadId: 'thread-retry',
      remoteDeleted: false,
    })
    expect(listCodexThreadCleanup()).toEqual([
      expect.objectContaining({ threadId: 'thread-retry', attempts: 1, lastError: 'runtime offline' }),
    ])

    await expect(retryManagedCodexThreadCleanup()).resolves.toEqual([
      expect.objectContaining({
        conversationId: conversation.id,
        threadId: 'thread-retry',
        remoteDeleted: true,
      }),
    ])
    expect(h.manager.deleteThread).toHaveBeenCalledTimes(2)
    expect(listCodexThreadCleanup()).toEqual([])
  })
})
