import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ChatMessage, ChatStreamEvent } from '../../src/shared/chat'
import { upsertChatMessage } from '../../src/main/chat/chat-store'
import type { CodexAppServerClient } from '../../src/main/chat/codex-subscription/client'
import type { CodexNotification } from '../../src/main/chat/codex-subscription/protocol'
import {
  getCodexThreadBinding,
  listCodexThreadCleanup,
  putCodexThreadBinding,
} from '../../src/main/chat/codex-subscription/thread-store'
import type { RunCodexSubscriptionChatArgs } from '../../src/main/chat/codex-subscription/runner'
import { closeDb, freshDb } from '../helpers/db'
import { makeConversation, makeWorkspace } from '../helpers/factories'

const h = vi.hoisted(() => {
  const managers = new Map<
    string,
    {
      deleteThread: ReturnType<typeof vi.fn>
      getClient: ReturnType<typeof vi.fn>
    }
  >()

  function managerFor(accountId: string | null) {
    const key = accountId ?? ''
    let manager = managers.get(key)
    if (!manager) {
      manager = {
        deleteThread: vi.fn(async () => undefined),
        getClient: vi.fn(async () => {
          throw new Error(`getClient not expected for account ${key || 'default'}`)
        }),
      }
      managers.set(key, manager)
    }
    return manager
  }

  return {
    managers,
    managerFor,
    getCodexSubscriptionManager: vi.fn((accountId: string | null = null) => managerFor(accountId)),
    reset() {
      managers.clear()
      this.getCodexSubscriptionManager.mockClear()
    },
  }
})

vi.mock('../../src/main/chat/codex-subscription/manager', () => ({
  getCodexSubscriptionManager: (accountId: string | null = null) => h.getCodexSubscriptionManager(accountId),
}))

vi.mock('../../src/main/chat/diag-log', () => ({ chatDiag: vi.fn() }))

const { runCodexSubscriptionChat } = await import('../../src/main/chat/codex-subscription/runner')

type NotificationListener = (notification: CodexNotification) => void

class FakeCodexClient {
  readonly startThreadCalls: unknown[] = []
  readonly deleteThreadCalls: unknown[] = []
  private threadSequence = 0
  private readonly listeners = new Set<NotificationListener>()
  private readonly turnScripts: Array<{ turnId: string; notifications: CodexNotification[] }> = []

  queueTurn(script: { turnId: string; notifications: CodexNotification[] }): void {
    this.turnScripts.push(script)
  }

  async startThread(params: unknown): Promise<{ thread: { id: string } }> {
    this.startThreadCalls.push(params)
    this.threadSequence += 1
    return { thread: { id: `thread_${this.threadSequence}` } }
  }

  async resumeThread(params: { threadId: string }): Promise<{ thread: { id: string } }> {
    return { thread: { id: params.threadId } }
  }

  async deleteThread(params: unknown): Promise<Record<string, never>> {
    this.deleteThreadCalls.push(params)
    return {}
  }

  async startTurn(_params: unknown): Promise<{ turn: { id: string } }> {
    const script = this.turnScripts.shift()
    if (!script) throw new Error('FakeCodexClient received startTurn without a queued script')
    setImmediate(() => {
      for (const notification of script.notifications) {
        for (const listener of [...this.listeners]) listener(notification)
      }
    })
    return { turn: { id: script.turnId } }
  }

  async interruptTurn(): Promise<void> {}

  onNotification(listener: NotificationListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  setServerRequestHandler(): void {}

  waitForExit(): Promise<never> {
    return new Promise<never>(() => {})
  }
}

function persistUser(conversationId: string, id: string, text: string, createdAt: number): ChatMessage {
  const message: ChatMessage = {
    id,
    conversationId,
    role: 'user',
    parts: [{ type: 'text', id: `${id}_text`, text }],
    createdAt,
  }
  upsertChatMessage(message)
  return message
}

function completedNotification(threadId: string, turnId: string): CodexNotification {
  return {
    method: 'turn/completed',
    params: {
      threadId,
      turn: { id: turnId, status: 'completed', error: null },
    },
  }
}

function runArgs(
  conversationId: string,
  projectId: string,
  cwd: string,
  client: FakeCodexClient,
  providerId: string
): RunCodexSubscriptionChatArgs {
  return {
    conversationId,
    projectId,
    cwd,
    selection: { providerId, modelId: 'gpt-5.6-sol' },
    mode: 'ask',
    permMode: 'ask',
    reasoningEffort: 'xhigh',
    fastMode: true,
    serviceTier: 'priority',
    client: client as unknown as CodexAppServerClient,
    broker: {
      assert: vi.fn(async () => {}),
      assertDecision: vi.fn(async () => 'once' as const),
    } as unknown as RunCodexSubscriptionChatArgs['broker'],
    questionBroker: {
      ask: vi.fn(async () => []),
    } as unknown as RunCodexSubscriptionChatArgs['questionBroker'],
    emit: (_event: ChatStreamEvent) => {},
    signal: new AbortController().signal,
  }
}

describe('Codex retireCodexThread ownership', () => {
  beforeEach(() => {
    freshDb()
    h.reset()
  })

  afterEach(() => {
    closeDb()
    vi.restoreAllMocks()
  })

  it('retires account A bindings through manager A during account B execution', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    persistUser(conversation.id, 'user_owned_a', 'Continue with the other account', 1)

    putCodexThreadBinding({
      conversationId: conversation.id,
      threadId: 'thread_owned_by_A',
      modelId: 'gpt-5.6-sol',
      toolSignature: 'stale-signature',
      lastMessageId: 'user_owned_a',
      usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 2, reasoningOutputTokens: 0 },
      accountId: 'acc_A',
    })

    const managerA = h.managerFor('acc_A')
    const managerB = h.managerFor('acc_B')
    managerB.deleteThread.mockRejectedValue(new Error('thread not found'))

    const clientB = new FakeCodexClient()
    clientB.queueTurn({
      turnId: 'turn_on_b',
      notifications: [completedNotification('thread_1', 'turn_on_b')],
    })

    await runCodexSubscriptionChat(
      runArgs(conversation.id, workspace.id, conversation.cwd, clientB, 'builtin_codex_subscription@acc_B')
    )

    expect(managerA.deleteThread).toHaveBeenCalledWith(
      'thread_owned_by_A',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
    expect(managerB.deleteThread).not.toHaveBeenCalled()
    expect(clientB.deleteThreadCalls).toEqual([])
    expect(listCodexThreadCleanup().find((item) => item.threadId === 'thread_owned_by_A')).toBeUndefined()
    expect(getCodexThreadBinding(conversation.id)?.threadId).toBe('thread_1')
    expect(getCodexThreadBinding(conversation.id)?.accountId).toBe('acc_B')
  })

  it('preserves account A tombstones after account B misses', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    persistUser(conversation.id, 'user_owned_a_fail', 'Switch accounts', 1)

    putCodexThreadBinding({
      conversationId: conversation.id,
      threadId: 'thread_owned_by_A',
      modelId: 'gpt-5.6-sol',
      toolSignature: 'stale-signature',
      lastMessageId: 'user_owned_a_fail',
      usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 2, reasoningOutputTokens: 0 },
      accountId: 'acc_A',
    })

    const managerA = h.managerFor('acc_A')
    const managerB = h.managerFor('acc_B')
    managerA.deleteThread.mockRejectedValue(new Error('app-server offline'))
    managerB.deleteThread.mockRejectedValue(new Error('thread not found'))

    const clientB = new FakeCodexClient()
    clientB.queueTurn({
      turnId: 'turn_on_b_fail',
      notifications: [completedNotification('thread_1', 'turn_on_b_fail')],
    })

    await runCodexSubscriptionChat(
      runArgs(conversation.id, workspace.id, conversation.cwd, clientB, 'builtin_codex_subscription@acc_B')
    )

    expect(managerA.deleteThread).toHaveBeenCalledWith(
      'thread_owned_by_A',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
    expect(managerB.deleteThread).not.toHaveBeenCalled()
    expect(clientB.deleteThreadCalls).toEqual([])
    expect(listCodexThreadCleanup()).toEqual([
      expect.objectContaining({
        conversationId: conversation.id,
        threadId: 'thread_owned_by_A',
        accountId: 'acc_A',
        lastError: 'app-server offline',
      }),
    ])
  })
})
