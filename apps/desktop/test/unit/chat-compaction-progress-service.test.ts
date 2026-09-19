import type { WebContents } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatCompactionProgress, ChatStreamEvent } from '../../src/shared/chat'

const h = vi.hoisted(() => ({
  generateText: vi.fn(),
  runChat: vi.fn(async () => ({ planSubmitted: false })),
  resolveLanguageModel: vi.fn(async () => ({ modelId: 'synthetic-model' })),
  webContents: { isDestroyed: () => false, send: vi.fn<(channel: string, event: ChatStreamEvent) => void>() },
  summarizeNative: vi.fn(),
  deleteNativeBinding: vi.fn(async () => {}),
  nativeTarget: {
    providerId: 'synthetic-physical-provider',
    runtimeModelId: 'resolved-native-model',
    manager: {},
    client: {},
    accountIdentity: { fingerprint: 'synthetic-identity', epoch: 1 },
    contextWindow: 20_000,
    reasoningEffort: 'high',
    fastMode: true,
  },
}))

vi.mock('ai', async (original) => ({ ...(await original<typeof import('ai')>()), generateText: h.generateText }))
vi.mock('../../src/main/chat/runner', async (original) => ({
  ...(await original<typeof import('../../src/main/chat/runner')>()),
  runChat: h.runChat,
}))
vi.mock('../../src/main/chat/provider', async (original) => ({
  ...(await original<typeof import('../../src/main/chat/provider')>()),
  resolveLanguageModel: h.resolveLanguageModel,
}))
vi.mock('../../src/main/chat/credentials', async (original) => ({
  ...(await original<typeof import('../../src/main/chat/credentials')>()),
  hasApiKey: () => true,
}))
vi.mock('../../src/main/window-ipc', () => ({ getMainWebContents: () => h.webContents }))
vi.mock('../../src/main/chat/model-meta', async (original) => ({
  ...(await original<typeof import('../../src/main/chat/model-meta')>()),
  getProviderModelMeta: async () => ({
    contextWindow: 20_000,
    reasoning: true,
    reasoningEfforts: ['low', 'high', 'max'],
  }),
}))
vi.mock('../../src/main/chat/models', async (original) => ({
  ...(await original<typeof import('../../src/main/chat/models')>()),
  fetchModelWindow: async () => 20_000,
}))
vi.mock('../../src/main/chat/portable-summarizer', async (original) => ({
  ...(await original<typeof import('../../src/main/chat/portable-summarizer')>()),
  summarizeWithCodexRuntime: h.summarizeNative,
  summarizeWithClaudeRuntime: h.summarizeNative,
}))
vi.mock('../../src/main/chat/claude-agent-sdk', async (original) => ({
  ...(await original<typeof import('../../src/main/chat/claude-agent-sdk')>()),
  deleteClaudeSessionForConversation: h.deleteNativeBinding,
}))
vi.mock('../../src/main/chat/subscription-failover', async (original) => {
  const actual = await original<typeof import('../../src/main/chat/subscription-failover')>()
  return {
    ...actual,
    runCodexEphemeralWithFailover: (args: Parameters<typeof actual.runCodexEphemeralWithFailover>[0]) =>
      args.operation(
        h.nativeTarget as unknown as Parameters<typeof args.operation>[0],
        args.signal ?? new AbortController().signal
      ),
  }
})
vi.mock('../../src/main/chat/subscription-failover/claude-adapter', async (original) => ({
  ...(await original<typeof import('../../src/main/chat/subscription-failover/claude-adapter')>()),
  resolveClaudeRuntimeTarget: async () => ({ ok: true, target: h.nativeTarget }),
}))
vi.mock('../../src/main/chat/subscription-failover/claude-ephemeral', async (original) => {
  const actual = await original<typeof import('../../src/main/chat/subscription-failover/claude-ephemeral')>()
  return {
    ...actual,
    runClaudeEphemeralWithFailover: async (args: Parameters<typeof actual.runClaudeEphemeralWithFailover>[0]) => {
      const target = h.nativeTarget as unknown as Parameters<typeof args.operation>[0]
      const observe = (value: unknown) => {
        const detail = value as { usage?: typeof usage; partialUsage?: typeof usage; runtimeEstimatedCostUsd?: number }
        args.onAttemptUsage?.({
          target,
          attempt: 1,
          outcome: detail.partialUsage ? 'failed' : 'success',
          usage: detail.partialUsage ??
            detail.usage ?? { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, totalInput: 0 },
          runtimeEstimatedCostUsd: detail.runtimeEstimatedCostUsd,
        })
      }
      try {
        const result = await args.operation(target, args.signal)
        observe(result)
        return result
      } catch (error) {
        observe(error)
        throw error
      }
    },
  }
})

import { addProvider } from '../../src/main/chat/catalog'
import { getChatMessage, listChatMessages, upsertChatMessage } from '../../src/main/chat/chat-store'
import {
  compactReserved,
  chatRuntimeState,
  registerChatIpc,
  subscribeChatStream,
  unsubscribeChatStream,
  type ChatIpcDeps,
} from '../../src/main/chat/service'
import { getConvUiPrefs, patchConvUiPrefs } from '../../src/main/store'
import { closeDb, freshDb, restartDb } from '../helpers/db'
import { selectContextObservation } from '../../src/renderer/components/chat/context-observation'
import { makeConversation, makeWorkspace } from '../helpers/factories'

const usage = { input: 80, output: 16, cacheRead: 0, cacheCreate: 0, totalInput: 80 }
const success = (text = 'Complete portable summary') => ({
  text,
  totalUsage: { inputTokens: 80, outputTokens: 16 },
})
let conversationId: string
let model: { providerId: string; modelId: string }
const wc = h.webContents as unknown as WebContents

function progressEvents(): ChatCompactionProgress[] {
  return h.webContents.send.mock.calls.flatMap(([channel, event]: [string, ChatStreamEvent]) =>
    channel === `chat:delta:${conversationId}` && event.kind === 'compaction-progress' ? [event.progress] : []
  )
}

function compact(opts: Parameters<typeof compactReserved>[1] = {}) {
  return compactReserved(conversationId, { contextWindow: 20_000, ...opts })
}

describe('service-owned compaction progress', () => {
  beforeEach(() => {
    freshDb()
    vi.clearAllMocks()
    h.webContents.send.mockReset()
    h.generateText.mockReset().mockResolvedValue(success())
    h.summarizeNative.mockReset()
    h.deleteNativeBinding.mockReset().mockResolvedValue(undefined)
    const provider = addProvider({
      name: 'Synthetic compactor',
      baseURL: 'https://provider.invalid/v1',
      kind: 'openai',
    })
    model = { providerId: provider.id, modelId: 'synthetic-model' }
    conversationId = makeConversation(makeWorkspace().id).id
    patchConvUiPrefs(conversationId, { chat: { ...model, reasoning: 'high', fastMode: true } })
    upsertChatMessage({
      id: 'user',
      conversationId,
      role: 'user',
      createdAt: 1,
      parts: [{ type: 'text', id: 'user-text', text: 'Source context. '.repeat(4_000) }],
    })
    upsertChatMessage({
      id: 'assistant',
      conversationId,
      role: 'assistant',
      model,
      createdAt: 2,
      parts: [{ type: 'text', id: 'assistant-text', text: 'Prior decisions and completed work.' }],
    })
    subscribeChatStream(wc, conversationId)
  })

  afterEach(() => {
    unsubscribeChatStream(wc, conversationId)
    vi.useRealTimers()
    closeDb()
  })

  it('persists and emits stages before backend work finishes without invalidating its history guard', async () => {
    const beforePrefs = getConvUiPrefs(conversationId)
    h.generateText.mockImplementation(async () => {
      const progress = getChatMessage(conversationId, 'assistant')?.compactionProgress
      expect(progress).toMatchObject({ status: 'running', phase: expect.stringMatching(/chunk|consolidate/) })
      expect(progressEvents().at(-1)).toEqual(progress)
      restartDb()
      expect(getChatMessage(conversationId, 'assistant')?.compactionProgress).toEqual(progress)
      expect(
        listChatMessages(conversationId)
          .flatMap((message) => message.parts)
          .some((part) => part.type === 'compaction')
      ).toBe(false)
      return success()
    })

    const result = await compact()

    expect(result.ok).toBe(true)
    expect(progressEvents()[0]).toMatchObject({ status: 'running' })
    expect(progressEvents().some((event) => event.phase === 'consolidate')).toBe(true)
    expect(progressEvents().at(-1)).toMatchObject({ status: 'completed', afterQuality: 'estimated' })
    expect(listChatMessages(conversationId).at(-1)?.parts).toEqual([
      expect.objectContaining({ type: 'compaction', text: 'Complete portable summary' }),
    ])
    expect(
      selectContextObservation(listChatMessages(conversationId), {
        conversationId,
        model,
        streaming: false,
      })
    ).toMatchObject({
      progress: { status: 'completed', scope: 'conversation', model },
      snapshot: { quality: 'estimated' },
    })
    expect(getConvUiPrefs(conversationId)).toEqual(beforePrefs)
  })

  it('keeps the last real observation when a manual compaction fails', async () => {
    const assistant = getChatMessage(conversationId, 'assistant')!
    const snapshot = {
      model,
      usedTokens: 18_500,
      modelContextWindow: 20_000,
      quality: 'measured' as const,
      observedAt: 50,
      sequence: 5,
    }
    upsertChatMessage({ ...assistant, finishReason: 'stop', contextSnapshot: snapshot })
    h.generateText.mockImplementation(async () => {
      expect(
        selectContextObservation(listChatMessages(conversationId), {
          conversationId,
          model,
          streaming: false,
          compacting: true,
        })
      ).toMatchObject({ progress: { status: 'running' }, snapshot })
      throw Object.assign(new Error('Invalid request'), { status: 400 })
    })
    expect(await compact()).toMatchObject({ ok: false, error: 'Invalid request' })
    expect(getChatMessage(conversationId, 'assistant')?.contextSnapshot).toEqual(snapshot)
  })

  it('retains the diagnostic, records partial usage once, and never commits a partial summary', async () => {
    h.generateText.mockResolvedValueOnce(success('First completed chunk')).mockRejectedValue(
      Object.assign(new Error('Summary service rejected request: OPENAI_API_KEY=synthetic-secret-123'), {
        status: 400,
        partialUsage: usage,
      })
    )
    const originalParts = listChatMessages(conversationId).map((message) => message.parts)

    const result = await compact()

    expect(result).toMatchObject({ ok: false, usage: { input: 160, output: 32, totalInput: 160 } })
    expect(result.error).toContain('Summary service rejected request:')
    expect(result.error).not.toContain('synthetic-secret-123')
    expect(progressEvents().at(-1)).toMatchObject({ status: 'failed', error: result.error })
    const stored = listChatMessages(conversationId)
    expect(stored.slice(0, 2).map((message) => message.parts)).toEqual(originalParts)
    expect(stored.flatMap((message) => message.parts).some((part) => part.type === 'compaction')).toBe(false)
    expect(stored.filter((message) => message.usage?.billingOnly)).toHaveLength(1)
    expect(stored.reduce((total, message) => total + (message.usage?.input ?? 0), 0)).toBe(160)
  })

  it('cancels the backend stage and leaves a durable cancelled state', async () => {
    const controller = new AbortController()
    let stageSignal: AbortSignal | undefined
    h.generateText.mockImplementation(({ abortSignal }: { abortSignal: AbortSignal }) => {
      stageSignal = abortSignal
      return new Promise((_, reject) => abortSignal.addEventListener('abort', () => reject(abortSignal.reason)))
    })
    const result = compact({ signal: controller.signal })
    await vi.waitFor(() => expect(stageSignal).toBeDefined())
    expect(stageSignal).not.toBe(controller.signal)
    controller.abort(new Error('User cancelled compaction'))

    expect(await result).toMatchObject({ ok: false, error: 'User cancelled compaction' })
    expect(stageSignal?.aborted).toBe(true)
    expect(getChatMessage(conversationId, 'assistant')?.compactionProgress?.status).toBe('cancelled')
    expect(progressEvents().at(-1)?.status).toBe('cancelled')
    expect(listChatMessages(conversationId)).toHaveLength(2)
  })

  it('forwards stage progress to an active runner without writing a second progress owner', async () => {
    const onProgress = vi.fn()
    const result = await compact({ persist: false, allowActive: true, onProgress })
    expect(result.ok).toBe(true)
    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ phase: 'chunk', status: 'running' }))
    expect(progressEvents()).toEqual([])
    expect(listChatMessages(conversationId)).toHaveLength(2)
    expect(getChatMessage(conversationId, 'assistant')?.compactionProgress).toBeUndefined()
  })

  it('aborts a timed-out stage, retries only that chunk, and preserves the completed chunks', async () => {
    vi.useFakeTimers()
    const signals: AbortSignal[] = []
    const prompts: string[] = []
    h.generateText.mockImplementation(({ abortSignal, prompt }: { abortSignal: AbortSignal; prompt: string }) => {
      signals.push(abortSignal)
      prompts.push(prompt)
      if (signals.length === 2) {
        return new Promise((_, reject) => abortSignal.addEventListener('abort', () => reject(abortSignal.reason)))
      }
      return Promise.resolve(success())
    })
    const result = compact()
    await vi.waitFor(() => expect(signals).toHaveLength(2))
    await vi.advanceTimersByTimeAsync(3 * 60_000)

    expect((await result).ok).toBe(true)
    expect(signals[1].aborted).toBe(true)
    expect(signals[2].aborted).toBe(false)
    expect(prompts[1]).toBe(prompts[2])
    expect(prompts.filter((prompt) => prompt === prompts[0])).toHaveLength(1)
    expect(progressEvents()).toContainEqual(expect.objectContaining({ status: 'retrying', completed: 1, attempt: 2 }))
  })

  it('rejects a real history edit without overwriting it and accounts for completed helper calls', async () => {
    h.generateText.mockImplementation(async () => {
      const latest = getChatMessage(conversationId, 'assistant')!
      upsertChatMessage({ ...latest, error: 'New diagnostic from another operation' })
      return success()
    })
    const result = await compact()
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('Conversation changed') })
    expect(getChatMessage(conversationId, 'assistant')?.error).toBe('New diagnostic from another operation')
    expect(progressEvents().at(-1)?.status).toBe('failed')
    expect(
      listChatMessages(conversationId)
        .flatMap((message) => message.parts)
        .some((part) => part.type === 'compaction')
    ).toBe(false)
    expect(listChatMessages(conversationId).at(-1)?.usage?.input).toBe(result.usage?.input)
    expect(result.usage?.input).toBeGreaterThan(0)
  })

  it('never replaces progress or snapshots belonging to a newer operation', async () => {
    const newer = {
      id: 'new-operation',
      status: 'running' as const,
      phase: 'native' as const,
      updatedAt: Date.now() + 1_000,
    }
    h.generateText.mockImplementation(async () => {
      const latest = getChatMessage(conversationId, 'assistant')!
      upsertChatMessage({
        ...latest,
        compactionProgress: newer,
        contextSnapshot: {
          model,
          usedTokens: 333,
          quality: 'measured',
          observedAt: Date.now() + 1_000,
          sequence: 999,
        },
      })
      return success()
    })
    const result = await compact()
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('operation changed') })
    expect(getChatMessage(conversationId, 'assistant')?.compactionProgress).toEqual(newer)
    expect(getChatMessage(conversationId, 'assistant')?.contextSnapshot?.sequence).toBe(999)
    expect(listChatMessages(conversationId)).toHaveLength(2)
  })

  it('uses the selected logical model for snapshots while preserving the old assistant model', async () => {
    const oldModel = { providerId: model.providerId, modelId: 'old-model' }
    const assistant = getChatMessage(conversationId, 'assistant')!
    upsertChatMessage({
      ...assistant,
      model: oldModel,
      contextSnapshot: {
        model: oldModel,
        usedTokens: 123,
        quality: 'measured',
        observedAt: 1,
        sequence: 50,
      },
    })
    expect((await compact()).ok).toBe(true)
    expect(getChatMessage(conversationId, 'assistant')?.model).toEqual(oldModel)
    expect(getChatMessage(conversationId, 'assistant')?.contextSnapshot).toMatchObject({ model, sequence: 52 })
    expect(listChatMessages(conversationId).at(-1)?.model).toEqual(model)
  })

  it('preserves a frozen effective profile and returns failed usage for its runner to account once', async () => {
    patchConvUiPrefs(conversationId, { chat: { ...model, modelId: 'live-model', reasoning: 'off', fastMode: false } })
    const preferences = getConvUiPrefs(conversationId)
    const onProgress = vi.fn()
    h.generateText
      .mockResolvedValueOnce(success('Completed chunk'))
      .mockRejectedValue(Object.assign(new Error('Frozen helper failed'), { status: 400, partialUsage: usage }))
    const result = await compact({
      persist: false,
      allowActive: true,
      onProgress,
      selectionOverride: {
        ...model,
        reasoning: 'ultra',
        reasoningEffort: 'max',
        fastMode: true,
      },
    })
    expect(result).toMatchObject({ ok: false, error: 'Frozen helper failed', usage: { input: 160, output: 32 } })
    expect(h.resolveLanguageModel).toHaveBeenCalledWith(model.providerId, model.modelId)
    expect(h.generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        providerOptions: { 'openai-compatible': { reasoningEffort: 'max' } },
      })
    )
    expect(getConvUiPrefs(conversationId)).toEqual(preferences)
    expect(listChatMessages(conversationId)).toHaveLength(2)
    expect(progressEvents()).toEqual([])
  })

  it('publishes manual IPC progress and releases its reservation after cancellation', async () => {
    const handlers = new Map<string, Parameters<ChatIpcDeps['mhandle']>[1]>()
    const listeners = new Map<string, Parameters<ChatIpcDeps['mon']>[1]>()
    registerChatIpc({
      mhandle: (channel, handler) => {
        handlers.set(channel, handler)
      },
      mon: (channel, listener) => {
        listeners.set(channel, listener)
      },
      emitStatus: vi.fn(),
    })
    let stageSignal: AbortSignal | undefined
    h.generateText.mockImplementation(({ abortSignal }: { abortSignal: AbortSignal }) => {
      stageSignal = abortSignal
      return new Promise((_, reject) => abortSignal.addEventListener('abort', () => reject(abortSignal.reason)))
    })
    const result = handlers.get('chat:compact')!({ sender: wc } as never, conversationId)
    await vi.waitFor(() => expect(stageSignal).toBeDefined())
    expect(progressEvents().at(-1)?.status).toBe('running')
    listeners.get('chat:stop')!({ sender: wc } as never, conversationId)
    expect(await result).toMatchObject({ ok: false })
    expect(stageSignal?.aborted).toBe(true)
    expect(progressEvents().at(-1)?.status).toBe('cancelled')
    h.generateText.mockResolvedValue(success())
    expect(await handlers.get('chat:compact')!({ sender: wc } as never, conversationId)).toMatchObject({ ok: true })
  })

  it('projects pending input on navigation without adding it to compaction, then persists it once', async () => {
    const handlers = new Map<string, Parameters<ChatIpcDeps['mhandle']>[1]>()
    registerChatIpc({
      mhandle: (channel, handler) => {
        handlers.set(channel, handler)
      },
      mon: vi.fn(),
      emitStatus: vi.fn(),
    })
    let projectedId: string | undefined
    h.generateText.mockImplementation(async ({ prompt }: { prompt: string }) => {
      const page = (await handlers.get('chat:history:page')!({ sender: wc } as never, conversationId)) as {
        messages: { id: string; parts: { text?: string }[] }[]
      }
      const pending = page.messages.filter((message) => message.parts.some((part) => part.text === 'Pending task'))
      expect(pending).toHaveLength(1)
      projectedId ??= pending[0].id
      expect(pending[0].id).toBe(projectedId)
      expect(chatRuntimeState(conversationId)).toMatchObject({ streaming: true, compacting: true })
      expect(prompt).not.toContain('Pending task')
      expect(listChatMessages(conversationId).some((message) => message.id === projectedId)).toBe(false)
      const older = (await handlers.get('chat:history:page')!({ sender: wc } as never, conversationId, {
        beforeSeq: 2,
      })) as { messages: { id: string }[] }
      expect(older.messages.some((message) => message.id === projectedId)).toBe(false)
      return success()
    })
    expect(
      await handlers.get('chat:send')!({ sender: wc } as never, { conversationId, text: 'Pending task' })
    ).toMatchObject({ ok: true })
    await vi.waitFor(() => expect(chatRuntimeState(conversationId).streaming).toBe(false))
    expect(h.runChat).toHaveBeenCalledTimes(1)
    expect(listChatMessages(conversationId).filter((message) => message.id === projectedId)).toHaveLength(1)
    const page = (await handlers.get('chat:history:page')!({ sender: wc } as never, conversationId)) as {
      messages: { id: string }[]
    }
    expect(page.messages.filter((message) => message.id === projectedId)).toHaveLength(1)
  })

  it.each([
    'completed',
    'failed',
    'cancelled',
  ] as const)('releases manual compaction before publishing %s to the queue', async (status) => {
    const handlers = new Map<string, Parameters<ChatIpcDeps['mhandle']>[1]>()
    const listeners = new Map<string, Parameters<ChatIpcDeps['mon']>[1]>()
    const emitStatus = vi.fn()
    registerChatIpc({
      mhandle: (channel, handler) => {
        handlers.set(channel, handler)
      },
      mon: (channel, handler) => {
        listeners.set(channel, handler)
      },
      emitStatus,
    })
    h.generateText.mockImplementation(async () => {
      expect(emitStatus).toHaveBeenLastCalledWith(conversationId, 'working', { silent: true })
      expect(chatRuntimeState(conversationId)).toMatchObject({ streaming: true, compacting: true })
      if (status === 'cancelled') listeners.get('chat:stop')!({ sender: wc } as never, conversationId)
      if (status !== 'completed') throw Object.assign(new Error('Summary failed'), { status: 400 })
      return success()
    })
    const terminalStates: ReturnType<typeof chatRuntimeState>[] = []
    h.webContents.send.mockImplementation((_channel, event) => {
      if (event.kind === 'compaction-finished') terminalStates.push(chatRuntimeState(conversationId))
    })
    await handlers.get('chat:compact')!({ sender: wc } as never, conversationId)
    expect(h.webContents.send).toHaveBeenCalledWith(
      `chat:delta:${conversationId}`,
      expect.objectContaining({ kind: 'compaction-finished', status })
    )
    expect(terminalStates).toEqual([expect.objectContaining({ streaming: false, compacting: false })])
    expect(emitStatus).toHaveBeenCalledTimes(2)
    expect(emitStatus.mock.calls[1][1]).not.toBe('working')
    expect(h.runChat).not.toHaveBeenCalled()
    h.webContents.send.mockReset()
  })

  it.each([
    'failed',
    'cancelled',
  ] as const)('removes %s preflight input from the projection without persisting or running it', async (status) => {
    const handlers = new Map<string, Parameters<ChatIpcDeps['mhandle']>[1]>()
    const listeners = new Map<string, Parameters<ChatIpcDeps['mon']>[1]>()
    registerChatIpc({
      mhandle: (channel, handler) => {
        handlers.set(channel, handler)
      },
      mon: (channel, handler) => {
        listeners.set(channel, handler)
      },
      emitStatus: vi.fn(),
    })
    let stageSignal: AbortSignal | undefined
    let rejectStage!: (error: Error) => void
    h.generateText.mockImplementation(({ abortSignal }: { abortSignal: AbortSignal }) => {
      stageSignal = abortSignal
      return new Promise((_, reject) => {
        rejectStage = reject
        abortSignal.addEventListener('abort', () => reject(abortSignal.reason))
      })
    })
    const result = handlers.get('chat:send')!({ sender: wc } as never, { conversationId, text: 'Pending task' })
    await vi.waitFor(() => expect(stageSignal).toBeDefined())
    expect(await handlers.get('chat:history:page')!({ sender: wc } as never, conversationId)).toMatchObject({
      messages: expect.arrayContaining([
        expect.objectContaining({
          role: 'user',
          parts: expect.arrayContaining([expect.objectContaining({ text: 'Pending task' })]),
        }),
      ]),
    })
    if (status === 'cancelled') listeners.get('chat:stop')!({ sender: wc } as never, conversationId)
    else rejectStage(Object.assign(new Error('Summary rejected'), { status: 400 }))
    expect(await result).toMatchObject({ ok: false })
    const page = (await handlers.get('chat:history:page')!({ sender: wc } as never, conversationId)) as {
      messages: unknown[]
    }
    expect(page.messages).toHaveLength(2)
    expect(listChatMessages(conversationId)).toHaveLength(2)
    expect(chatRuntimeState(conversationId)).toMatchObject({ streaming: false, compacting: false })
    expect(h.runChat).not.toHaveBeenCalled()
  })

  it('publishes preflight failure before rejecting turn admission and preserves the pending user input', async () => {
    const handlers = new Map<string, Parameters<ChatIpcDeps['mhandle']>[1]>()
    registerChatIpc({
      mhandle: (channel, handler) => {
        handlers.set(channel, handler)
      },
      mon: vi.fn(),
      emitStatus: vi.fn(),
    })
    h.generateText.mockRejectedValue(Object.assign(new Error('Preflight summary rejected'), { status: 400 }))
    const result = await handlers.get('chat:send')!({ sender: wc } as never, { conversationId, text: 'Pending task' })
    expect(result).toMatchObject({ ok: false, error: 'context-compaction-failed' })
    expect(progressEvents().at(-1)).toMatchObject({ status: 'failed', error: 'Preflight summary rejected' })
    expect(listChatMessages(conversationId)).toHaveLength(2)
  })

  it.each([
    'builtin_codex_subscription',
    'builtin_claude_subscription',
  ])('forwards engine stage cancellation through the %s adapter to the native backend', async (providerId) => {
    patchConvUiPrefs(conversationId, { chat: { providerId, modelId: 'native-model' } })
    const controller = new AbortController()
    let stageSignal: AbortSignal | undefined
    h.summarizeNative.mockImplementation(({ signal }: { signal: AbortSignal }) => {
      stageSignal = signal
      return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)))
    })
    const result = compact({ signal: controller.signal })
    await vi.waitFor(() => expect(stageSignal).toBeDefined())
    expect(stageSignal).not.toBe(controller.signal)
    expect(getChatMessage(conversationId, 'assistant')?.compactionProgress).toMatchObject({
      status: 'running',
      phase: 'chunk',
    })
    controller.abort(new Error('Cancel native compactor'))
    expect(await result).toMatchObject({ ok: false, error: 'Cancel native compactor' })
    expect(stageSignal?.aborted).toBe(true)
    expect(progressEvents().at(-1)?.status).toBe('cancelled')
    expect(listChatMessages(conversationId)).toHaveLength(2)
  })

  it('does not double count Claude usage reported by both attempt observation and the engine failure', async () => {
    patchConvUiPrefs(conversationId, { chat: { providerId: 'builtin_claude_subscription', modelId: 'native-model' } })
    h.summarizeNative
      .mockResolvedValueOnce({ text: 'Completed chunk', usage, runtimeEstimatedCostUsd: 0.1 })
      .mockRejectedValue(
        Object.assign(new Error('Native helper rejected'), {
          status: 400,
          partialUsage: usage,
          runtimeEstimatedCostUsd: 0.2,
        })
      )
    const result = await compact()
    expect(result).toMatchObject({ ok: false, usage: { input: 160, output: 32, totalInput: 160 } })
    expect(result.runtimeEstimatedCostUsd).toBeCloseTo(0.3)
    const billingRows = listChatMessages(conversationId).filter((message) => message.usage?.billingOnly)
    expect(billingRows).toHaveLength(1)
    expect(billingRows[0].usage?.input).toBe(160)
    expect(billingRows[0].usage?.runtimeEstimatedCostUsd).toBeCloseTo(0.3)
  })

  it('persists native cost estimates even when the backend reports no token counts', async () => {
    patchConvUiPrefs(conversationId, { chat: { providerId: 'builtin_claude_subscription', modelId: 'native-model' } })
    h.summarizeNative.mockResolvedValue({ text: 'Complete summary', runtimeEstimatedCostUsd: 0.125 })
    const result = await compact()
    expect(result.ok).toBe(true)
    expect(result.runtimeEstimatedCostUsd).toBe(h.summarizeNative.mock.calls.length * 0.125)
    expect(listChatMessages(conversationId).at(-1)?.usage?.runtimeEstimatedCostUsd).toBe(result.runtimeEstimatedCostUsd)
  })

  it('keeps a committed summary completed when cancellation arrives during native binding cleanup', async () => {
    patchConvUiPrefs(conversationId, { chat: { providerId: 'builtin_claude_subscription', modelId: 'native-model' } })
    const controller = new AbortController()
    h.summarizeNative.mockResolvedValue({ text: 'Complete summary', usage })
    h.deleteNativeBinding.mockImplementation(async () => {
      controller.abort(new Error('Cancelled during cleanup'))
    })
    const result = await compact({ signal: controller.signal })
    expect(result.ok).toBe(true)
    expect(progressEvents().at(-1)?.status).toBe('completed')
    expect(listChatMessages(conversationId).filter((message) => message.usage?.billingOnly)).toHaveLength(1)
  })
})
