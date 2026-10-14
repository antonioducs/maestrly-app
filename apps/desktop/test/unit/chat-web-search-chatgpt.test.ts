import os from 'node:os'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ recordModelCallUsage: vi.fn() }))
vi.mock('../../src/main/chat/usage-diagnostics', () => ({ recordModelCallUsage: h.recordModelCallUsage }))

import type { CodexAppServerClient } from '../../src/main/chat/codex-subscription/client'
import type { CodexNotification } from '../../src/main/chat/codex-subscription/protocol'
import { searchWithCodexRuntime } from '../../src/main/chat/web-search/chatgpt'

type NotificationListener = (notification: CodexNotification) => void

class FakeSearchClient {
  readonly startThreadCalls: unknown[] = []
  readonly startTurnCalls: unknown[] = []
  readonly deleteThreadCalls: unknown[] = []
  readonly interruptTurnCalls: unknown[] = []
  failure: Error | null = null
  /** Scripted notifications emitted immediately after startTurn. */
  notifications: CodexNotification[] = []
  /** When true, the turn never completes on its own (to exercise abort). */
  hang = false

  private readonly listeners = new Set<NotificationListener>()

  async startThread(params: unknown): Promise<{ thread: { id: string } }> {
    this.startThreadCalls.push(params)
    return { thread: { id: 'thread_search' } }
  }

  async startTurn(params: unknown): Promise<{ turn: { id: string } }> {
    this.startTurnCalls.push(params)
    if (!this.hang) {
      setImmediate(() => {
        for (const notification of this.notifications) this.emit(notification)
      })
    }
    return { turn: { id: 'turn_search' } }
  }

  emit(notification: CodexNotification): void {
    for (const listener of [...this.listeners]) listener(notification)
  }

  async interruptTurn(params: unknown): Promise<void> {
    this.interruptTurnCalls.push(params)
  }

  async deleteThread(params: unknown): Promise<Record<string, never>> {
    this.deleteThreadCalls.push(params)
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

const notification = (method: string, params: Record<string, unknown>): CodexNotification =>
  ({ method, params: { threadId: 'thread_search', ...params } }) as unknown as CodexNotification

const asClient = (client: FakeSearchClient): CodexAppServerClient => client as unknown as CodexAppServerClient

const ANSWER = 'Answer.\n\nSources:\n1. Docs — https://docs.example.test'
const searchItem = notification('item/completed', {
  item: { type: 'webSearch', id: 'ws1', status: 'completed', query: 'q' },
})
const answerItem = notification('item/completed', { item: { type: 'agentMessage', id: 'm1', text: ANSWER } })
const completed = (status = 'completed') => notification('turn/completed', { turn: { id: 'turn_search', status } })

const run = (client: FakeSearchClient, signal = new AbortController().signal) =>
  searchWithCodexRuntime({
    client: asClient(client),
    conversationId: 'conv_search',
    cwd: os.tmpdir(),
    modelId: 'gpt-5.6-mini',
    query: 'electron vibrancy',
    maxResults: 3,
    signal,
  })

beforeEach(() => vi.clearAllMocks())

describe('searchWithCodexRuntime', () => {
  it('returns the findings from an ephemeral thread with live search', async () => {
    const client = new FakeSearchClient()
    client.notifications = [searchItem, answerItem, completed()]
    expect(await run(client)).toEqual({ kind: 'summary', text: ANSWER })
    expect(client.startThreadCalls[0]).toMatchObject({
      ephemeral: true,
      environments: [],
      dynamicTools: [],
      config: { web_search: 'live', 'features.image_generation': false, 'features.shell_tool': false },
    })
    expect(JSON.stringify(client.startTurnCalls[0])).toContain('Search the web for: electron vibrancy')
    expect(client.deleteThreadCalls).toEqual([{ threadId: 'thread_search' }])
  })

  it('fails when the model did not search', async () => {
    const client = new FakeSearchClient()
    client.notifications = [answerItem, completed()]
    await expect(run(client)).rejects.toThrow(/did not run a web search/)
    expect(client.deleteThreadCalls).toEqual([{ threadId: 'thread_search' }])
  })

  it('fails when the turn fails', async () => {
    const client = new FakeSearchClient()
    client.notifications = [searchItem, completed('failed')]
    await expect(run(client)).rejects.toThrow(/failed/)
    expect(client.deleteThreadCalls).toEqual([{ threadId: 'thread_search' }])
  })

  it('interrupts and deletes the thread on abort', async () => {
    const client = new FakeSearchClient()
    client.hang = true
    const controller = new AbortController()
    const promise = run(client, controller.signal)
    await vi.waitFor(() => expect(client.startTurnCalls).toHaveLength(1))
    client.emit(notification('turn/started', { turn: { id: 'turn_search' } }))
    controller.abort(new Error('stopped'))
    await expect(promise).rejects.toThrow('stopped')
    expect(client.interruptTurnCalls.length).toBeGreaterThan(0)
    expect(client.deleteThreadCalls).toHaveLength(1)
  })

  it('records the auxiliary thread usage once', async () => {
    const client = new FakeSearchClient()
    client.notifications = [
      notification('thread/tokenUsage/updated', {
        tokenUsage: {
          total: { inputTokens: 120, cachedInputTokens: 20, outputTokens: 7 },
          last: { inputTokens: 120, cachedInputTokens: 20, outputTokens: 7 },
        },
      }),
      searchItem,
      answerItem,
      completed(),
    ]
    await run(client)
    expect(h.recordModelCallUsage).toHaveBeenCalledOnce()
    expect(h.recordModelCallUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        runtime: 'codex-subscription',
        providerId: 'builtin_codex_subscription',
        modelId: 'gpt-5.6-mini',
        conversationId: 'conv_search',
        usage: { input: 100, output: 7, cacheRead: 20, cacheCreate: 0, totalInput: 120 },
      })
    )
  })
})
