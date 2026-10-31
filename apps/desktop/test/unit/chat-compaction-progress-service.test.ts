import type { WebContents } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BackgroundCompactionStore } from '../../src/main/chat/background-compaction/store'
import type { ChatCompactionProgress, ChatStreamEvent, MessagePart } from '../../src/shared/chat'

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
  getApiKey: () => 'synthetic-key',
}))
vi.mock('../../src/main/window-ipc', () => ({ getMainWebContents: () => h.webContents }))
vi.mock('../../src/main/chat/model-meta', async (original) => ({
  ...(await original<typeof import('../../src/main/chat/model-meta')>()),
  getProviderModelMeta: async (id: string) => ({
    contextWindow:
      id === 'large-model' ? 1_000_000 : ['background-helper', 'small-model'].includes(id) ? 200_000 : 20_000,
    reasoning: true,
    reasoningEfforts: ['low', 'high', 'max'],
  }),
}))
vi.mock('../../src/main/chat/models', async (original) => ({
  ...(await original<typeof import('../../src/main/chat/models')>()),
  fetchModelWindow: async (_provider: string, id: string) =>
    id === 'large-model' ? 1_000_000 : ['background-helper', 'small-model'].includes(id) ? 200_000 : 20_000,
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
import { chatHistoryStats, getChatMessage, listChatMessages, upsertChatMessage } from '../../src/main/chat/chat-store'
import {
  compactReserved,
  startManualCompaction,
  chatRuntimeState,
  registerChatIpc,
  subscribeChatStream,
  unsubscribeChatStream,
  type ChatIpcDeps,
} from '../../src/main/chat/service'
import { getConvUiPrefs, patchConvUiPrefs } from '../../src/main/store'
import { closeDb, freshDb, restartDb } from '../helpers/db'
import { selectContextObservation } from '../../src/renderer/components/chat/context-observation'
import {
  clearCompactionSummarizer,
  setCompactionFocus,
  setCompactionSummarizer,
} from '../../src/main/chat/compaction-summarizer'
import { setConversationContextLimit } from '../../src/main/chat/conversation-context-limit'
import { makeConversation, makeWorkspace } from '../helpers/factories'
import { structuredSummary } from '../helpers/compaction'
import { activatePreparedCompaction } from '../../src/main/chat/background-compaction/runner'
import { renderNativeSeedTranscript, toModelMessages } from '../../src/main/chat/message'
import { listConversationContextMessages } from '../../src/main/chat/chat-store'
import { FALLBACK_SUMMARY_NOTICE } from '../../src/main/chat/compaction/fallback-summary'
import {
  compactionBreakerKey,
  recordAutomaticCompaction,
  resetCompactionBreaker,
} from '../../src/main/chat/compaction/breaker'

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
    clearCompactionSummarizer(conversationId)
    setConversationContextLimit(conversationId, null)
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

  it('uses a registered summarizer for billing while preserving conversation progress', async () => {
    setCompactionSummarizer(conversationId, () => ({
      ...model,
      modelId: 'background-helper',
      effort: 'off',
      fastMode: false,
    }))
    const result = await compact()
    expect(result.ok).toBe(true)
    expect(h.resolveLanguageModel).toHaveBeenCalledWith(model.providerId, 'background-helper')
    expect(progressEvents().at(-1)?.model).toEqual(model)
    expect(listChatMessages(conversationId).at(-1)?.model).toEqual(model)
    expect(
      chatHistoryStats(conversationId).perModel.find((item) => item.modelId === 'background-helper')?.subInput
    ).toBeGreaterThan(0)
  })

  it('marks a requested compaction as manual and reports completion after persistence', async () => {
    setCompactionSummarizer(conversationId, () => ({
      ...model,
      modelId: 'background-helper',
      effort: 'off',
      fastMode: false,
    }))
    const finished = vi.fn()
    expect(startManualCompaction(conversationId, finished)).toEqual({ ok: true })
    await vi.waitFor(() => expect(finished).toHaveBeenCalledWith(expect.objectContaining({ ok: true })))
    expect(listChatMessages(conversationId).at(-1)?.parts).toEqual([
      expect.objectContaining({ type: 'compaction', origin: 'manual' }),
    ])
  })

  it("tells the summarizer what a conversation's summary must keep", async () => {
    setCompactionFocus(conversationId, 'Keep each question and the answer it got.')
    try {
      expect((await compact()).ok).toBe(true)
    } finally {
      setCompactionFocus(conversationId, null)
    }
    const systems = h.generateText.mock.calls.map(([options]) => (options as { system?: string }).system)
    expect(systems.length).toBeGreaterThan(0)
    for (const system of systems) expect(system).toContain('Keep each question and the answer it got.')
  })

  it('fails closed when the registered summarizer is unavailable', async () => {
    setCompactionSummarizer(conversationId, () => null)
    expect(await compact()).toEqual({ ok: false, error: 'compaction-model-unavailable' })
    expect(h.generateText).not.toHaveBeenCalled()
  })

  it('prepares only on use, then consumes at the covered part without inference on send', async () => {
    const handlers = new Map<string, Parameters<ChatIpcDeps['mhandle']>[1]>()
    registerChatIpc({
      mhandle: (channel, handler) => {
        handlers.set(channel, handler)
      },
      mon: vi.fn(),
      emitStatus: vi.fn(),
    })
    upsertChatMessage({ ...getChatMessage(conversationId, 'assistant')!, finishReason: 'stop' })
    await expect(
      handlers.get('chat:background-compaction:set')!({ sender: wc } as never, {
        enabled: true,
        intervalTokens: 10_000,
        selection: { providerId: model.providerId, modelId: 'background-helper', effort: 'off', fastMode: false },
      })
    ).resolves.toEqual({ ok: true })
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(h.generateText).not.toHaveBeenCalled()
    chatRuntimeState(conversationId)
    await vi.waitFor(() => expect(chatRuntimeState(conversationId).backgroundCompaction?.status).toBe('ready'))
    expect(
      listChatMessages(conversationId).some((message) => message.parts.some((part) => part.type === 'compaction'))
    ).toBe(false)
    const calls = h.generateText.mock.calls.length
    await expect(
      handlers.get('chat:send')!({ sender: wc } as never, { conversationId, text: 'Pending task' })
    ).resolves.toMatchObject({ ok: true })
    await vi.waitFor(() => expect(chatRuntimeState(conversationId).streaming).toBe(false))
    expect(h.generateText).toHaveBeenCalledTimes(calls)
    const messages = listChatMessages(conversationId)
    expect(messages.flatMap((message) => message.parts).filter((part) => part.type === 'compaction')).toEqual([
      expect.objectContaining({ text: 'Complete portable summary' }),
    ])
    expect(messages.flatMap((message) => message.parts)).toEqual(
      expect.arrayContaining([expect.objectContaining({ text: 'Pending task' })])
    )
    expect(chatRuntimeState(conversationId).backgroundCompaction).toMatchObject({ status: 'idle' })
    expect(h.runChat).toHaveBeenCalledOnce()
  })

  it('switches an 800k conversation from a 1M model to 200k using prepared context without another model call', async () => {
    const handlers = new Map<string, Parameters<ChatIpcDeps['mhandle']>[1]>()
    registerChatIpc({
      mhandle: (channel, handler) => {
        handlers.set(channel, handler)
      },
      mon: vi.fn(),
      emitStatus: vi.fn(),
    })
    patchConvUiPrefs(conversationId, { chat: { ...model, modelId: 'large-model', reasoning: 'off', fastMode: false } })
    upsertChatMessage({
      ...getChatMessage(conversationId, 'user')!,
      parts: [{ type: 'text', id: 'user-text', text: 'Original request' }],
    })
    upsertChatMessage({ ...getChatMessage(conversationId, 'assistant')!, finishReason: 'stop' })
    for (let index = 0; index < 8; index++)
      upsertChatMessage({
        id: `block-${index}`,
        conversationId,
        role: 'assistant',
        model: { ...model, modelId: 'large-model' },
        createdAt: index + 3,
        finishReason: 'stop',
        parts: [{ type: 'text', id: `block-part-${index}`, text: 'x'.repeat(300_000) }],
      })
    await handlers.get('chat:background-compaction:set')!({ sender: wc } as never, {
      enabled: true,
      intervalTokens: 100_000,
      selection: { providerId: model.providerId, modelId: 'background-helper', effort: 'off', fastMode: false },
    })
    chatRuntimeState(conversationId)
    await vi.waitFor(
      () => expect(new BackgroundCompactionStore().get(conversationId)?.ready?.boundary.messageId).toBe('block-7'),
      { timeout: 5000 }
    )
    const calls = h.generateText.mock.calls.length
    await handlers.get('chat:set-selection')!({ sender: wc } as never, conversationId, {
      ...model,
      modelId: 'small-model',
    })
    await expect(
      handlers.get('chat:send')!({ sender: wc } as never, { conversationId, text: 'Continue in smaller model' })
    ).resolves.toMatchObject({ ok: true })
    await vi.waitFor(() => expect(chatRuntimeState(conversationId).streaming).toBe(false))
    expect(h.generateText).toHaveBeenCalledTimes(calls)
    expect(new BackgroundCompactionStore().get(conversationId)?.ready).toBeNull()
    expect(listChatMessages(conversationId).flatMap((message) => message.parts)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'compaction', text: 'Complete portable summary' }),
        expect.objectContaining({ text: 'Continue in smaller model' }),
      ])
    )
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
    await vi.advanceTimersByTimeAsync(10 * 60_000)

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

  it.each(['completed', 'failed', 'cancelled'] as const)(
    'releases manual compaction before publishing %s to the queue',
    async (status) => {
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
    }
  )

  it('uses the registered summarizer for required preflight compaction', async () => {
    setCompactionSummarizer(conversationId, () => ({
      ...model,
      modelId: 'background-helper',
      effort: 'off',
      fastMode: false,
    }))
    const handlers = new Map<string, Parameters<ChatIpcDeps['mhandle']>[1]>()
    registerChatIpc({
      mhandle: (channel, handler) => {
        handlers.set(channel, handler)
      },
      mon: vi.fn(),
      emitStatus: vi.fn(),
    })
    const result = await handlers.get('chat:send')!({ sender: wc } as never, { conversationId, text: 'Pending task' })
    expect(result).toMatchObject({ ok: true })
    expect(h.resolveLanguageModel).toHaveBeenCalledWith(model.providerId, 'background-helper')
    expect(listChatMessages(conversationId).flatMap((message) => message.parts)).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'compaction' })])
    )
  })

  const sendHandler = () => {
    const handlers = new Map<string, Parameters<ChatIpcDeps['mhandle']>[1]>()
    registerChatIpc({
      mhandle: (channel, handler) => void handlers.set(channel, handler),
      mon: vi.fn(),
      emitStatus: vi.fn(),
    })
    return handlers.get('chat:send')!
  }

  it('compacts before a turn at the conversation limit, below the model window, and runs the turn inside it', async () => {
    patchConvUiPrefs(conversationId, { chat: { ...model, modelId: 'small-model', reasoning: 'high', fastMode: true } })
    setConversationContextLimit(conversationId, 30_000)
    const result = await sendHandler()({ sender: wc } as never, { conversationId, text: 'Pending task' })
    expect(result).toMatchObject({ ok: true })
    expect(listChatMessages(conversationId).flatMap((message) => message.parts)).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'compaction' })])
    )
    await vi.waitFor(() => expect(h.runChat).toHaveBeenCalledWith(expect.objectContaining({ contextWindow: 30_000 })))
  })

  it('keeps the model window of a conversation without a limit', async () => {
    patchConvUiPrefs(conversationId, { chat: { ...model, modelId: 'small-model', reasoning: 'high', fastMode: true } })
    const result = await sendHandler()({ sender: wc } as never, { conversationId, text: 'Pending task' })
    expect(result).toMatchObject({ ok: true })
    expect(listChatMessages(conversationId).flatMap((message) => message.parts)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'compaction' })])
    )
    await vi.waitFor(() => expect(h.runChat).toHaveBeenCalledWith(expect.objectContaining({ contextWindow: 200_000 })))
  })

  // A failed summary no longer blocks the turn (see the mechanical fallback below); cancelling still does.
  it.each(['cancelled'] as const)(
    'removes %s preflight input from the projection without persisting or running it',
    async (status) => {
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
    }
  )

  it('publishes preflight failure before rejecting turn admission and preserves the pending user input', async () => {
    const handlers = new Map<string, Parameters<ChatIpcDeps['mhandle']>[1]>()
    registerChatIpc({
      mhandle: (channel, handler) => {
        handlers.set(channel, handler)
      },
      mon: vi.fn(),
      emitStatus: vi.fn(),
    })
    // A conversation that changed under the summary is never committed, not even as a mechanical digest.
    h.generateText.mockImplementation(async () => {
      const latest = getChatMessage(conversationId, 'assistant')!
      upsertChatMessage({ ...latest, error: 'Edited during the preflight' })
      return success()
    })
    const result = await handlers.get('chat:send')!({ sender: wc } as never, { conversationId, text: 'Pending task' })
    expect(result).toMatchObject({ ok: false, error: 'context-compaction-failed' })
    expect(progressEvents().at(-1)).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('Conversation changed'),
    })
    // Only the bill of the attempted summary is recorded; the pending input is not persisted.
    expect(listChatMessages(conversationId).filter((message) => !message.usage?.billingOnly)).toHaveLength(2)
    expect(
      listChatMessages(conversationId).some((message) =>
        message.parts.some((part) => part.type === 'text' && part.text === 'Pending task')
      )
    ).toBe(false)
    expect(h.runChat).not.toHaveBeenCalled()
  })

  it.each(['builtin_codex_subscription', 'builtin_claude_subscription'])(
    'forwards engine stage cancellation through the %s adapter to the native backend',
    async (providerId) => {
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
    }
  )

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

  describe('prepared summary reuse', () => {
    const largeModel = () => ({ ...model, modelId: 'large-model' })
    const prompts = () =>
      h.generateText.mock.calls.map((call: unknown[]) => (call[0] as { prompt: string }).prompt).join('\n')
    const compactionTexts = () =>
      listChatMessages(conversationId)
        .flatMap((message) => message.parts)
        .flatMap((part) => (part.type === 'compaction' ? [part.text] : []))

    async function prepare(): Promise<void> {
      const handlers = new Map<string, Parameters<ChatIpcDeps['mhandle']>[1]>()
      registerChatIpc({
        mhandle: (channel, handler) => {
          handlers.set(channel, handler)
        },
        mon: vi.fn(),
        emitStatus: vi.fn(),
      })
      patchConvUiPrefs(conversationId, { chat: { ...largeModel(), reasoning: 'off', fastMode: false } })
      upsertChatMessage({
        ...getChatMessage(conversationId, 'user')!,
        parts: [{ type: 'text', id: 'user-text', text: 'EARLY_SOURCE_MARKER' }],
      })
      upsertChatMessage({ ...getChatMessage(conversationId, 'assistant')!, finishReason: 'stop' })
      for (let index = 0; index < 2; index++)
        upsertChatMessage({
          id: `block-${index}`,
          conversationId,
          role: 'assistant',
          model: largeModel(),
          createdAt: index + 3,
          finishReason: 'stop',
          parts: [{ type: 'text', id: `block-part-${index}`, text: 'x'.repeat(300_000) }],
        })
      h.generateText.mockResolvedValue(success('PREPARED_SUMMARY'))
      await handlers.get('chat:background-compaction:set')!({ sender: wc } as never, {
        enabled: true,
        intervalTokens: 100_000,
        selection: { providerId: model.providerId, modelId: 'background-helper', effort: 'off', fastMode: false },
      })
      chatRuntimeState(conversationId)
      await vi.waitFor(
        () => expect(new BackgroundCompactionStore().get(conversationId)?.ready?.boundary.messageId).toBe('block-1'),
        { timeout: 5000 }
      )
      await vi.waitFor(() => expect(chatRuntimeState(conversationId).backgroundCompaction?.status).toBe('ready'))
      h.generateText.mockClear()
      h.generateText.mockResolvedValue(success('FOLDED_SUMMARY'))
    }

    function appendDelta(): void {
      upsertChatMessage({
        id: 'delta-user',
        conversationId,
        role: 'user',
        createdAt: 10,
        parts: [{ type: 'text', id: 'delta-user-text', text: 'DELTA_USER_MARKER' }],
      })
      upsertChatMessage({
        id: 'delta-assistant',
        conversationId,
        role: 'assistant',
        model: largeModel(),
        createdAt: 11,
        finishReason: 'stop',
        parts: [{ type: 'text', id: 'delta-assistant-text', text: 'DELTA_ASSISTANT_MARKER' }],
      })
    }

    function manualCompaction(): Promise<{ ok: boolean; error?: string }> {
      return new Promise((resolve) => {
        expect(startManualCompaction(conversationId, resolve)).toEqual({ ok: true })
      })
    }

    it('folds the prepared summary with only the newer suffix on manual compaction', async () => {
      await prepare()
      appendDelta()
      expect(await manualCompaction()).toMatchObject({ ok: true })
      expect(prompts()).toContain('Previous summary:\nPREPARED_SUMMARY')
      expect(prompts()).toContain('DELTA_USER_MARKER')
      expect(prompts()).toContain('DELTA_ASSISTANT_MARKER')
      expect(prompts()).not.toContain('EARLY_SOURCE_MARKER')
      expect(prompts()).not.toContain('x'.repeat(1_000))
      expect(compactionTexts()).toEqual(['FOLDED_SUMMARY'])
      expect(new BackgroundCompactionStore().get(conversationId)?.ready).toBeNull()
    })

    it('commits the prepared summary without a model call when nothing follows its boundary', async () => {
      await prepare()
      expect(await manualCompaction()).toMatchObject({ ok: true })
      expect(h.generateText).not.toHaveBeenCalled()
      expect(compactionTexts()).toEqual(['PREPARED_SUMMARY'])
      expect(new BackgroundCompactionStore().get(conversationId)?.ready).toBeNull()
    })

    it('folds from the prepared summary for automatic in-turn compaction without persisting a marker', async () => {
      await prepare()
      appendDelta()
      expect(await compact({ contextWindow: 1_000_000, allowActive: true, persist: false })).toMatchObject({
        ok: true,
        summary: 'FOLDED_SUMMARY',
      })
      expect(prompts()).toContain('Previous summary:\nPREPARED_SUMMARY')
      expect(prompts()).not.toContain('EARLY_SOURCE_MARKER')
      expect(compactionTexts()).toEqual([])
    })

    it('falls back to the full active history when the prepared source changed', async () => {
      await prepare()
      upsertChatMessage({
        ...getChatMessage(conversationId, 'user')!,
        parts: [{ type: 'text', id: 'user-text', text: 'EDITED_SOURCE_MARKER' }],
      })
      appendDelta()
      expect(await compact({ contextWindow: 1_000_000 })).toMatchObject({ ok: true })
      expect(prompts()).toContain('EDITED_SOURCE_MARKER')
      expect(prompts()).not.toContain('PREPARED_SUMMARY')
    })

    it('folds the prepared summary with only the delta up to the cut, keeping the latest turn verbatim', async () => {
      await prepare()
      appendDelta()
      upsertChatMessage({
        id: 'delta-user-2',
        conversationId,
        role: 'user',
        createdAt: 12,
        parts: [{ type: 'text', id: 'delta-user-2-text', text: 'LATEST_USER_MARKER' }],
      })
      upsertChatMessage({
        id: 'delta-assistant-2',
        conversationId,
        role: 'assistant',
        model: largeModel(),
        createdAt: 13,
        finishReason: 'stop',
        parts: [{ type: 'text', id: 'delta-assistant-2-text', text: 'LATEST_ASSISTANT_MARKER' }],
      })
      expect(await manualCompaction()).toMatchObject({ ok: true })
      expect(prompts()).toContain('Previous summary:\nPREPARED_SUMMARY')
      expect(prompts()).toContain('DELTA_USER_MARKER')
      expect(prompts()).not.toContain('LATEST_USER_MARKER')
      expect(prompts()).not.toContain('EARLY_SOURCE_MARKER')
      expect(compactionTexts()).toEqual(['FOLDED_SUMMARY'])
      expect(getChatMessage(conversationId, 'delta-assistant')?.parts.map((part) => part.type)).toEqual([
        'text',
        'compaction',
      ])
      expect(new BackgroundCompactionStore().get(conversationId)?.ready).toBeNull()
    })
  })

  describe('verbatim tail', () => {
    const recentModel = () => model
    function addRecentTurn(text = 'RECENT_USER_MARKER'): void {
      upsertChatMessage({ ...getChatMessage(conversationId, 'assistant')!, finishReason: 'stop' })
      upsertChatMessage({
        id: 'recent-user',
        conversationId,
        role: 'user',
        createdAt: 3,
        parts: [{ type: 'text', id: 'recent-user-text', text }],
      })
      upsertChatMessage({
        id: 'recent-assistant',
        conversationId,
        role: 'assistant',
        model: recentModel(),
        createdAt: 4,
        finishReason: 'stop',
        parts: [{ type: 'text', id: 'recent-assistant-text', text: 'RECENT_ASSISTANT_MARKER' }],
      })
    }
    const prompts = () =>
      h.generateText.mock.calls.map((call: unknown[]) => (call[0] as { prompt: string }).prompt).join('\n')
    const sentEvents = () =>
      h.webContents.send.mock.calls.flatMap(([channel, event]: [string, ChatStreamEvent]) =>
        channel === `chat:delta:${conversationId}` ? [event] : []
      )
    const billedInput = () => chatHistoryStats(conversationId).perModel.reduce((total, item) => total + item.input, 0)

    it('summarizes only the older turns, commits the boundary in place and bills it once', async () => {
      addRecentTurn()
      h.generateText.mockResolvedValue(success(structuredSummary('TAIL_SUMMARY')))

      const result = await compact({ contextWindow: 200_000 })

      expect(result).toMatchObject({ ok: true, marker: { messageId: 'assistant', afterPartId: 'assistant-text' } })
      expect(h.generateText).toHaveBeenCalledOnce()
      expect(prompts()).toContain('Source context.')
      expect(prompts()).not.toContain('RECENT_USER_MARKER')
      expect(listChatMessages(conversationId).map((message) => message.id)).toEqual([
        'user',
        'assistant',
        'recent-user',
        'recent-assistant',
      ])
      expect(getChatMessage(conversationId, 'assistant')?.parts).toEqual([
        expect.objectContaining({ id: 'assistant-text' }),
        expect.objectContaining({ type: 'compaction', id: result.marker!.partId, strategy: 'summary' }),
      ])
      expect(sentEvents()).toContainEqual(
        expect.objectContaining({ kind: 'compaction', partId: result.marker!.partId, afterPartId: 'assistant-text' })
      )
      // Any runtime seeded next sees the summary followed by the verbatim tail.
      const seed = renderNativeSeedTranscript(listConversationContextMessages(conversationId))
      expect(seed).toContain('TAIL_SUMMARY')
      expect(seed).toContain('RECENT_USER_MARKER')
      expect(seed).toContain('RECENT_ASSISTANT_MARKER')
      expect(seed).not.toContain('Source context.')
      expect(billedInput()).toBe(80)
      expect(
        selectContextObservation(listChatMessages(conversationId), { conversationId, model, streaming: false })
      ).toMatchObject({ progress: { status: 'completed' } })
    })

    it('retires the native binding so the next native turn reseeds summary and tail', async () => {
      addRecentTurn()
      patchConvUiPrefs(conversationId, { chat: { providerId: 'builtin_claude_subscription', modelId: 'native-model' } })
      h.summarizeNative.mockResolvedValue({ text: structuredSummary('NATIVE_TAIL_SUMMARY'), usage })

      const result = await compact({ contextWindow: 200_000 })

      expect(result).toMatchObject({ ok: true, marker: { messageId: 'assistant' } })
      expect(h.deleteNativeBinding).toHaveBeenCalledWith(conversationId)
      expect(renderNativeSeedTranscript(listConversationContextMessages(conversationId))).toContain(
        'RECENT_ASSISTANT_MARKER'
      )
    })

    it('does not repeat an approved plan that the verbatim tail still holds', async () => {
      addRecentTurn('Implement it.\n<approved_plan>\nPLAN_STEP_ONE\n</approved_plan>')
      upsertChatMessage({
        id: 'plan-source',
        conversationId,
        role: 'user',
        createdAt: 0,
        parts: [{ type: 'text', id: 'plan-source-text', text: '<approved_plan>\nOLD_PLAN\n</approved_plan>' }],
      })
      h.generateText.mockResolvedValue(success(structuredSummary('PLAN_SUMMARY')))

      const result = await compact({ contextWindow: 200_000 })

      expect(result.ok).toBe(true)
      expect(result.summary).not.toContain('<approved_plan>')
      expect(listChatMessages(conversationId).map((message) => message.id)).toContain('recent-user')
    })

    it('keeps the live step verbatim mid-turn, carries the turn request, and leaves the bill to the runner', async () => {
      upsertChatMessage({ ...getChatMessage(conversationId, 'assistant')!, finishReason: 'stop' })
      upsertChatMessage({
        id: 'turn-user',
        conversationId,
        role: 'user',
        createdAt: 3,
        parts: [{ type: 'text', id: 'turn-user-text', text: 'TURN_REQUEST_MARKER' }],
      })
      // Persistence keeps about 50k characters of each output (~17k tokens): two of them exceed the 20k tail.
      const log = (title: string) =>
        `${title}\n${Array.from({ length: 3_000 }, (_, line) => `build log line ${line}: compiled module`).join('\n')}`
      const toolPart = (id: string, output: string) => ({
        type: 'tool' as const,
        id,
        toolCallId: id,
        toolName: 'bash',
        input: { command: 'ls' },
        state: { status: 'completed' as const, output },
      })
      upsertChatMessage({
        id: 'live',
        conversationId,
        role: 'assistant',
        model,
        createdAt: 4,
        parts: [
          { type: 'text', id: 'live-1', text: 'Inspecting.' },
          toolPart('tool-big', log('BIG_TOOL_OUTPUT')),
          { type: 'text', id: 'live-mid', text: 'Building.' },
          toolPart('tool-mid', log('MID_TOOL_OUTPUT')),
          { type: 'text', id: 'live-2', text: 'LAST_STEP_MARKER' },
          toolPart('tool-small', 'small output'),
        ],
      })
      h.generateText.mockResolvedValue(success(structuredSummary('LIVE_SUMMARY')))

      const result = await compact({ contextWindow: 200_000, allowActive: true, persist: false, positional: true })

      expect(result).toMatchObject({
        ok: true,
        usage: { input: 80, output: 16 },
        marker: { messageId: 'live', afterPartId: 'tool-big' },
      })
      expect(result.summary).toContain('<current_turn_request>\nTURN_REQUEST_MARKER\n</current_turn_request>')
      expect(prompts()).toContain('BIG_TOOL_OUTPUT')
      expect(prompts()).not.toContain('MID_TOOL_OUTPUT')
      expect(prompts()).not.toContain('LAST_STEP_MARKER')
      expect(billedInput()).toBe(0)
      const activated = activatePreparedCompaction({
        conversationId,
        assistantMessageId: 'live',
        prepared: result.marker!,
      })
      expect(activated.assistant.parts.map((part) => part.id)).toEqual([
        'live-1',
        'tool-big',
        result.marker!.partId,
        'live-mid',
        'tool-mid',
        'live-2',
        'tool-small',
      ])
      expect(activated.history.map((message) => message.id)).not.toContain('live')
    })

    it('summarizes the whole history as before when no tail fits the window', async () => {
      addRecentTurn()
      h.generateText.mockResolvedValue(success(structuredSummary('NO_TAIL_SUMMARY')))
      // A 20k window leaves no room for a tail once the summary, reserve and pending input are counted.
      const result = await compact({ contextWindow: 20_000 })
      expect(result.ok).toBe(true)
      expect(result.marker).toBeUndefined()
      expect(prompts()).toContain('RECENT_USER_MARKER')
      expect(listChatMessages(conversationId).at(-1)?.parts).toEqual([
        expect.objectContaining({ type: 'compaction', text: result.summary }),
      ])
    })

    it('compacts before a turn keeping the latest turn verbatim and admits it', async () => {
      addRecentTurn()
      patchConvUiPrefs(conversationId, {
        chat: { ...model, modelId: 'small-model', reasoning: 'high', fastMode: true },
      })
      setConversationContextLimit(conversationId, 30_000)
      h.generateText.mockResolvedValue(success(structuredSummary('PREFLIGHT_SUMMARY')))

      const result = await sendHandler()({ sender: wc } as never, { conversationId, text: 'Pending task' })

      expect(result).toMatchObject({ ok: true })
      await vi.waitFor(() => expect(h.runChat).toHaveBeenCalled())
      expect(getChatMessage(conversationId, 'assistant')?.parts.map((part) => part.type)).toEqual([
        'text',
        'compaction',
      ])
      expect(prompts()).not.toContain('RECENT_USER_MARKER')
      const ids = listChatMessages(conversationId).map((message) => message.id)
      expect(ids.indexOf('recent-assistant')).toBeGreaterThan(ids.indexOf('assistant'))
    })
  })

  describe('degrading instead of blocking', () => {
    const compactionParts = () =>
      listChatMessages(conversationId)
        .flatMap((message) => message.parts)
        .filter((part) => part.type === 'compaction')
    const rejected = (message = 'Summary rejected') => Object.assign(new Error(message), { status: 400 })

    it('admits the turn on a mechanical summary when the preflight summary fails', async () => {
      h.generateText.mockRejectedValue(rejected())
      const handlers = new Map<string, Parameters<ChatIpcDeps['mhandle']>[1]>()
      registerChatIpc({
        mhandle: (channel, handler) => void handlers.set(channel, handler),
        mon: vi.fn(),
        emitStatus: vi.fn(),
      })

      const result = await handlers.get('chat:send')!({ sender: wc } as never, { conversationId, text: 'Pending task' })

      expect(result).toMatchObject({ ok: true })
      await vi.waitFor(() => expect(h.runChat).toHaveBeenCalledOnce())
      expect(compactionParts()).toEqual([
        expect.objectContaining({ degraded: true, text: expect.stringContaining(FALLBACK_SUMMARY_NOTICE) }),
      ])
      expect(
        listChatMessages(conversationId).filter((message) =>
          message.parts.some((part) => part.type === 'text' && part.text === 'Pending task')
        )
      ).toHaveLength(1) // The renderer reloads the history, where the divider learns the summary is degraded.
      const page = (await handlers.get('chat:history:page')!({ sender: wc } as never, conversationId)) as {
        messages: { parts: { type: string; degraded?: boolean }[] }[]
      }
      expect(page.messages.flatMap((message) => message.parts).filter((part) => part.type === 'compaction')).toEqual([
        expect.objectContaining({ degraded: true }),
      ])
    })

    it('never degrades a manual compaction: the person sees the failure', async () => {
      h.generateText.mockRejectedValue(rejected('Manual summary rejected'))
      const result = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
        expect(startManualCompaction(conversationId, resolve)).toEqual({ ok: true })
      })
      expect(result).toMatchObject({ ok: false, error: 'Manual summary rejected' })
      expect(compactionParts()).toEqual([])
    })

    it('shrinks the chunks when the summarizer reports a context overflow, and bills every attempt', async () => {
      h.generateText
        .mockRejectedValueOnce(
          Object.assign(new Error("This model's maximum context length is 20000 tokens"), {
            status: 400,
            usage: { inputTokens: 5, outputTokens: 0 },
          })
        )
        .mockResolvedValue(success(structuredSummary('LADDER_SUMMARY')))

      const result = await compact({ contextWindow: 20_000, fallback: true })

      expect(result).toMatchObject({ ok: true })
      expect(result.degraded).toBeUndefined()
      expect(result.summary).toContain('LADDER_SUMMARY')
      expect(h.generateText.mock.calls.length).toBeGreaterThan(2)
      const prompt = (index: number) => (h.generateText.mock.calls[index][0] as { prompt: string }).prompt
      expect(prompt(1).length).toBeLessThan(prompt(0).length)
      expect(compactionParts()).toEqual([expect.not.objectContaining({ degraded: true })])
    })

    it('commits a degraded marker mid-turn for the runner to reload, leaving the bill to it', async () => {
      h.generateText.mockRejectedValue(rejected())

      const result = await compact({
        contextWindow: 200_000,
        allowActive: true,
        persist: false,
        positional: true,
        fallback: true,
      })

      expect(result).toMatchObject({
        ok: true,
        degraded: true,
        marker: { messageId: 'assistant', afterPartId: 'assistant-text' },
      })
      expect(getChatMessage(conversationId, 'assistant')?.parts).toEqual([
        expect.objectContaining({ id: 'assistant-text' }),
        expect.objectContaining({ type: 'compaction', id: result.marker!.partId, degraded: true }),
      ])
      const activated = activatePreparedCompaction({
        conversationId,
        assistantMessageId: 'assistant',
        prepared: result.marker!,
      })
      expect(activated.event).toMatchObject({ kind: 'compaction', degraded: true })
      expect(activated.event.origin).toBeUndefined()
    })

    it('never degrades a cancelled compaction', async () => {
      const controller = new AbortController()
      h.generateText.mockImplementation(async () => {
        controller.abort(new Error('Cancelled by the person'))
        throw rejected()
      })
      const result = await compact({ signal: controller.signal, fallback: true })
      expect(result).toMatchObject({ ok: false })
      expect(compactionParts()).toEqual([])
    })

    it('skips automatic compaction while the breaker is open and the context has not grown', async () => {
      patchConvUiPrefs(conversationId, {
        chat: { ...model, modelId: 'small-model', reasoning: 'high', fastMode: true },
      })
      setConversationContextLimit(conversationId, 40_000)
      const key = compactionBreakerKey(model.providerId, 'small-model', 40_000)
      resetCompactionBreaker(conversationId)
      for (let round = 0; round < 2; round += 1)
        recordAutomaticCompaction(conversationId, key, { before: 39_000, after: 38_500, threshold: 36_000 })

      expect(await sendHandler()({ sender: wc } as never, { conversationId, text: 'Pending task' })).toMatchObject({
        ok: true,
      })

      await vi.waitFor(() => expect(h.runChat).toHaveBeenCalledOnce())
      expect(h.generateText).not.toHaveBeenCalled()
      expect(compactionParts()).toEqual([])
      resetCompactionBreaker(conversationId)
    })
  })

  describe('older tool outputs', () => {
    const log = (title: string) =>
      `${title}\n${Array.from({ length: 1_100 }, (_, line) => `${title} line ${line}: compiled module`).join('\n')}`
    const toolPart = (id: string, output: string) => ({
      type: 'tool' as const,
      id,
      toolCallId: id,
      toolName: 'bash',
      input: { command: `run ${id}` },
      state: { status: 'completed' as const, output },
    })
    function seedHistory(): void {
      upsertChatMessage({
        ...getChatMessage(conversationId, 'user')!,
        parts: [{ type: 'text', id: 'user-text', text: 'Start the migration.' }],
      })
      upsertChatMessage({
        ...getChatMessage(conversationId, 'assistant')!,
        finishReason: 'stop',
        parts: [
          { type: 'text', id: 'assistant-text', text: 'Building.' },
          toolPart('old-1', log('OLD_BUILD_ONE')),
          toolPart('old-2', log('OLD_BUILD_TWO')),
          toolPart('old-3', log('OLD_BUILD_THREE')),
        ],
      })
      for (let index = 1; index <= 3; index += 1) {
        upsertChatMessage({
          id: `recent-user-${index}`,
          conversationId,
          role: 'user',
          createdAt: 2 + index * 2,
          parts: [{ type: 'text', id: `recent-user-${index}-text`, text: `RECENT_REQUEST_${index}` }],
        })
        upsertChatMessage({
          id: `recent-assistant-${index}`,
          conversationId,
          role: 'assistant',
          model,
          createdAt: 3 + index * 2,
          finishReason: 'stop',
          parts: [{ type: 'text', id: `recent-assistant-${index}-text`, text: `RECENT_ANSWER_${index}` }],
        })
      }
    }
    const storedTool = (id: string) =>
      getChatMessage(conversationId, 'assistant')!.parts.find((part) => part.id === id) as Extract<
        MessagePart,
        { type: 'tool' }
      >

    it('frees the context by pruning alone when that reaches half the window, without a summary', async () => {
      seedHistory()
      patchConvUiPrefs(conversationId, {
        chat: { ...model, modelId: 'small-model', reasoning: 'high', fastMode: true },
      })
      setConversationContextLimit(conversationId, 60_000)

      expect(await sendHandler()({ sender: wc } as never, { conversationId, text: 'Pending task' })).toMatchObject({
        ok: true,
      })

      await vi.waitFor(() => expect(h.runChat).toHaveBeenCalledOnce())
      expect(h.generateText).not.toHaveBeenCalled()
      expect(
        listChatMessages(conversationId)
          .flatMap((message) => message.parts)
          .some((part) => part.type === 'compaction')
      ).toBe(false)
      for (const id of ['old-1', 'old-2', 'old-3']) {
        expect(storedTool(id).contextStub).toContain('output removed')
        // The person and history_read keep the original.
        expect(storedTool(id).state).toMatchObject({ output: expect.stringContaining('line 1099') })
      }
      const sent = JSON.stringify(toModelMessages(listConversationContextMessages(conversationId)))
      expect(sent).not.toContain('OLD_BUILD_ONE line 1099')
      expect(sent).toContain('RECENT_ANSWER_1')
      expect(getChatMessage(conversationId, 'recent-assistant-3')?.contextSnapshot).toMatchObject({
        quality: 'estimated',
        modelContextWindow: 60_000,
      })
    })

    it('summarizes instead, without persisting the pruning, when pruning alone is not enough', async () => {
      seedHistory()
      upsertChatMessage({
        ...getChatMessage(conversationId, 'user')!,
        parts: [{ type: 'text', id: 'user-text', text: 'Source context. '.repeat(4_000) }],
      })
      patchConvUiPrefs(conversationId, {
        chat: { ...model, modelId: 'small-model', reasoning: 'high', fastMode: true },
      })
      setConversationContextLimit(conversationId, 60_000)
      h.generateText.mockResolvedValue(success(structuredSummary('SUMMARY_AFTER_PRUNING')))

      expect(await sendHandler()({ sender: wc } as never, { conversationId, text: 'Pending task' })).toMatchObject({
        ok: true,
      })

      await vi.waitFor(() => expect(h.runChat).toHaveBeenCalledOnce())
      expect(h.generateText).toHaveBeenCalled()
      expect(storedTool('old-1').contextStub).toBeUndefined()
    })

    it('gives the summarizer only the head and tail of older outputs', async () => {
      seedHistory()
      h.generateText.mockResolvedValue(success(structuredSummary('CLIPPED_INPUT_SUMMARY')))

      expect(await compact({ contextWindow: 200_000 })).toMatchObject({ ok: true })

      const prompts = h.generateText.mock.calls
        .map((call: unknown[]) => (call[0] as { prompt: string }).prompt)
        .join('\n')
      expect(prompts).toContain('OLD_BUILD_ONE line 0')
      expect(prompts).toContain('OLD_BUILD_ONE line 1099')
      expect(prompts).toContain('older output clipped for the summary')
      expect(prompts).not.toContain('OLD_BUILD_ONE line 500')
      expect(storedTool('old-1').contextStub).toBeUndefined()
    })
  })
})
