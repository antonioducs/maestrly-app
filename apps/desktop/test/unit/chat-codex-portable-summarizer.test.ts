import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/main/chat/codex-subscription/manager', () => ({
  getCodexSubscriptionManager: () => codexManagerMock,
}))

const codexManagerMock = {
  deleteThread: vi.fn(async () => undefined),
}

import { summarizeWithCodexRuntime } from '../../src/main/chat/portable-summarizer'
import type { CodexAppServerClient } from '../../src/main/chat/codex-subscription/client'
import type { CodexNotification } from '../../src/main/chat/codex-subscription/protocol'
import {
  getCodexThreadBinding,
  listCodexThreadCleanup,
  putCodexThreadBinding,
} from '../../src/main/chat/codex-subscription/thread-store'
import { closeDb, freshDb } from '../helpers/db'
import { makeConversation, makeWorkspace } from '../helpers/factories'

type NotificationListener = (notification: CodexNotification) => void

/** Minimal scripted client with thread deletion as the test gate. */
class FakeCodexClient {
  readonly startThreadCalls: unknown[] = []
  readonly startTurnCalls: unknown[] = []
  readonly deleteThreadCalls: unknown[] = []
  private readonly listeners = new Set<NotificationListener>()
  private turnScript: CodexNotification[] = []
  deleteThreadError: Error | null = null

  queueTurn(notifications: CodexNotification[]): void {
    this.turnScript = notifications
  }

  emit(notification: CodexNotification): void {
    for (const listener of [...this.listeners]) listener(notification)
  }

  async startThread(params?: unknown): Promise<{ thread: { id: string } }> {
    this.startThreadCalls.push(params)
    return { thread: { id: 'thread_ephemeral' } }
  }

  async startTurn(params: unknown): Promise<{ turn: { id: string } }> {
    this.startTurnCalls.push(params)
    const script = this.turnScript
    setImmediate(() => {
      for (const notification of script) this.emit(notification)
    })
    return { turn: { id: 'turn_ephemeral' } }
  }

  async interruptTurn(): Promise<void> {
    return undefined
  }

  async deleteThread(params: unknown): Promise<Record<string, never>> {
    this.deleteThreadCalls.push(params)
    if (this.deleteThreadError) throw this.deleteThreadError
    return {}
  }

  onNotification(listener: NotificationListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  waitForExit(): Promise<never> {
    return new Promise<never>(() => {})
  }
}

function completedTurn(): CodexNotification[] {
  return [
    {
      method: 'turn/started',
      params: { threadId: 'thread_ephemeral', turn: { id: 'turn_ephemeral', status: 'inProgress' } },
    },
    {
      method: 'item/agentMessage/delta',
      params: { threadId: 'thread_ephemeral', turnId: 'turn_ephemeral', itemId: 'summary-1', delta: 'summary ok' },
    },
    {
      method: 'turn/completed',
      params: { threadId: 'thread_ephemeral', turn: { id: 'turn_ephemeral', status: 'completed', error: null } },
    },
  ] as CodexNotification[]
}

beforeEach(() => {
  freshDb()
  vi.clearAllMocks()
})

afterEach(closeDb)

describe('durable ephemeral Codex summarizer lifecycle', () => {
  it('forwards frozen service tiers to thread and turn startup', async () => {
    const client = new FakeCodexClient()
    client.queueTurn(completedTurn())

    await summarizeWithCodexRuntime({
      client: client as unknown as CodexAppServerClient,
      cwd: '/repo',
      modelId: 'gpt-5.6-sol',
      system: 'system',
      prompt: 'resuma',
      signal: new AbortController().signal,
      serviceTier: 'priority',
    })

    expect(client.startThreadCalls[0]).toMatchObject({ serviceTier: 'priority' })
    expect(client.startTurnCalls[0]).toMatchObject({ serviceTier: 'priority' })
  })

  it('preserves tombstones and main bindings after failed deletion', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    // Ephemeral cleanup must not touch unrelated main-thread bindings.
    putCodexThreadBinding({
      conversationId: conversation.id,
      threadId: 'thread_main',
      modelId: 'gpt-5.6-sol',
      toolSignature: 'sig',
      lastMessageId: 'assistant-1',
      accountId: 'acc-1',
      usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 },
    })

    const client = new FakeCodexClient()
    client.queueTurn(completedTurn())
    // Failed managed deletion must preserve tombstones for durable retry.
    codexManagerMock.deleteThread.mockRejectedValueOnce(new Error('app-server crashed before remote deletion'))

    const result = await summarizeWithCodexRuntime({
      client: client as unknown as CodexAppServerClient,
      cwd: '/repo',
      modelId: 'gpt-5.6-sol',
      system: 'system',
      prompt: 'resuma',
      signal: new AbortController().signal,
      conversationId: conversation.id,
      accountId: 'acc-1',
    })

    expect(result.text).toBe('summary ok')
    // Tombstones retain conversation and account owners for cleanup retries.
    const cleanup = listCodexThreadCleanup()
    expect(cleanup).toHaveLength(1)
    expect(cleanup[0]).toMatchObject({
      threadId: 'thread_ephemeral',
      conversationId: conversation.id,
      accountId: 'acc-1',
    })
    expect(cleanup[0].attempts).toBe(1)
    expect(cleanup[0].lastError).toMatch(/app-server crashed/)
    // Verify managed lifecycle deletion was attempted rather than silently ignored.
    expect(codexManagerMock.deleteThread).toHaveBeenCalledWith('thread_ephemeral', expect.anything())
    // Main binding remains intact.
    expect(getCodexThreadBinding(conversation.id)?.threadId).toBe('thread_main')
  })

  it('clears tombstones after successful deletion', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    const client = new FakeCodexClient()
    client.queueTurn(completedTurn())

    const result = await summarizeWithCodexRuntime({
      client: client as unknown as CodexAppServerClient,
      cwd: '/repo',
      modelId: 'gpt-5.6-sol',
      system: 'system',
      prompt: 'resuma',
      signal: new AbortController().signal,
      conversationId: conversation.id,
    })

    expect(result.text).toBe('summary ok')
    expect(listCodexThreadCleanup()).toHaveLength(0)
    expect(codexManagerMock.deleteThread).toHaveBeenCalledTimes(1)
    expect(client.deleteThreadCalls).toHaveLength(0) // No parallel raw deletion.
  })

  it('uses direct best-effort cleanup without conversation IDs', async () => {
    const client = new FakeCodexClient()
    client.queueTurn(completedTurn())
    client.deleteThreadError = new Error('failure')

    const result = await summarizeWithCodexRuntime({
      client: client as unknown as CodexAppServerClient,
      cwd: '/repo',
      modelId: 'gpt-5.6-sol',
      system: 'system',
      prompt: 'resuma',
      signal: new AbortController().signal,
    })

    expect(result.text).toBe('summary ok')
    expect(listCodexThreadCleanup()).toHaveLength(0)
    // Legacy raw fallback ignores cleanup failure best-effort.
    expect(client.deleteThreadCalls).toHaveLength(1)
    expect(codexManagerMock.deleteThread).not.toHaveBeenCalled()
  })
})

describe('portable Codex context and failures', () => {
  const args = (client: FakeCodexClient) => ({
    client: client as unknown as CodexAppServerClient,
    cwd: '/repo',
    modelId: 'gpt-6',
    system: 'system',
    prompt: 'summary',
    signal: new AbortController().signal,
  })

  it('passes nominal context without applying the effective-context discount', async () => {
    const client = new FakeCodexClient()
    client.queueTurn(completedTurn())
    await summarizeWithCodexRuntime({
      ...args(client),
      modelId: 'gpt-6-astra',
      requestedContextWindow: 1_000_000,
      runtimeModel: { supportsExperimentalContext: true },
    })
    expect(client.startThreadCalls[0]).toMatchObject({
      config: {
        model_context_window: 1_000_000,
        'features.context_management.experimental_mode': false,
      },
    })
  })

  it.each([
    undefined,
    null,
    0,
    -1,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
  ])('omits invalid nominal context %s and unsupported experimental overrides', async (requestedContextWindow) => {
    const client = new FakeCodexClient()
    client.queueTurn(completedTurn())
    await summarizeWithCodexRuntime({
      ...args(client),
      requestedContextWindow,
      runtimeModel: { supportsExperimentalContext: false },
    })
    const config = (client.startThreadCalls[0] as { config: Record<string, unknown> }).config
    expect(config).not.toHaveProperty('model_context_window')
    expect(config).not.toHaveProperty('features.context_management.experimental_mode')
  })

  it.each(['turn/completed', 'error'])('preserves %s diagnostics and partial usage', async (method) => {
    const client = new FakeCodexClient()
    const error = { message: 'Usage limit exceeded: resets tomorrow', codexErrorInfo: 'UsageLimitExceeded' }
    const params =
      method === 'turn/completed'
        ? { threadId: 'thread_ephemeral', turn: { id: 'turn_ephemeral', status: 'failed', error } }
        : { threadId: 'thread_ephemeral', error, willRetry: false }
    client.queueTurn([
      {
        method: 'thread/tokenUsage/updated',
        params: {
          threadId: 'thread_ephemeral',
          tokenUsage: { total: { inputTokens: 100, cachedInputTokens: 20, outputTokens: 5 } },
        },
      },
      { method, params },
    ] as CodexNotification[])
    await expect(summarizeWithCodexRuntime(args(client))).rejects.toMatchObject({
      message: error.message,
      rawFailure: method === 'turn/completed' ? params : error,
      partialUsage: { input: 80, cacheRead: 20, cacheCreate: 0, totalInput: 100, output: 5 },
    })
    expect(client.deleteThreadCalls).toHaveLength(1)
  })

  it('allows runtime retry notifications to recover', async () => {
    const client = new FakeCodexClient()
    client.queueTurn([
      {
        method: 'error',
        params: { threadId: 'thread_ephemeral', willRetry: true, error: { message: 'Temporary connection failure' } },
      },
      ...completedTurn(),
    ] as CodexNotification[])
    await expect(summarizeWithCodexRuntime(args(client))).resolves.toMatchObject({ text: 'summary ok' })
  })
})

it('retains retry diagnostics if the terminal failure contains no error or usage', async () => {
  const client = new FakeCodexClient()
  const error = { message: 'Context window exhausted', additionalDetails: 'input too large' }
  client.queueTurn([
    { method: 'error', params: { threadId: 'thread_ephemeral', willRetry: true, error } },
    { method: 'turn/completed', params: { threadId: 'thread_ephemeral', turn: { status: 'failed', error: null } } },
  ] as CodexNotification[])
  await expect(
    summarizeWithCodexRuntime({
      client: client as unknown as CodexAppServerClient,
      cwd: '/repo',
      modelId: 'gpt-6-astra',
      system: 'system',
      prompt: 'summary',
      signal: new AbortController().signal,
    })
  ).rejects.toMatchObject({ message: error.message, rawFailure: error })
})
