import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BackgroundCompactionConfig } from '../../src/shared/background-compaction'
import type { ChatMessage, ChatStreamEvent, FrozenChatSelection } from '../../src/shared/chat'

const h = vi.hoisted(() => ({
  generateText: vi.fn(),
  resolveLanguageModel: vi.fn(async () => ({ modelId: 'synthetic-model' })),
  webContents: { isDestroyed: () => false, send: vi.fn<(channel: string, event: ChatStreamEvent) => void>() },
}))

vi.mock('ai', async (original) => ({ ...(await original<typeof import('ai')>()), generateText: h.generateText }))
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
  getProviderModelMeta: async () => ({ contextWindow: 200_000, reasoning: false }),
}))
vi.mock('../../src/main/chat/models', async (original) => ({
  ...(await original<typeof import('../../src/main/chat/models')>()),
  fetchModelWindow: async () => 200_000,
}))

import {
  ChatBackgroundCompactionCoordinator,
  type BackgroundCompactionCoordinatorDeps,
} from '../../src/main/chat/background-compaction'
import { BackgroundCompactionStore } from '../../src/main/chat/background-compaction/store'
import { addProvider } from '../../src/main/chat/catalog'
import { upsertChatMessage } from '../../src/main/chat/chat-store'
import {
  chatRuntimeState,
  retryBackgroundCompaction,
  setConversationCompactionOverride,
} from '../../src/main/chat/service'
import { getAppSetting, patchConvUiPrefs } from '../../src/main/store'
import { closeDb, freshDb } from '../helpers/db'
import { makeConversation, makeWorkspace } from '../helpers/factories'

const frozen: FrozenChatSelection = {
  providerId: 'provider',
  modelId: 'summarizer',
  reasoning: 'off',
  fastMode: false,
  providerFingerprint: 'opaque-fingerprint',
}

const enabled = (intervalTokens = 1): BackgroundCompactionConfig => ({
  enabled: true,
  intervalTokens,
  selection: { providerId: 'provider', modelId: 'summarizer', effort: 'off', fastMode: false },
})
const disabled: BackgroundCompactionConfig = { enabled: false, intervalTokens: 100_000, selection: null }

function assistant(conversationId: string, id: string): ChatMessage {
  return {
    id,
    conversationId,
    role: 'assistant',
    parts: [{ type: 'text', id: `${id}:part`, text: 'source' }],
    finishReason: 'stop',
    createdAt: 1,
  }
}

function harness(
  configs: Map<string, BackgroundCompactionConfig>,
  overridden: Set<string>,
  summarize: BackgroundCompactionCoordinatorDeps['summarize'] = async (input) => {
    input.onAttempt('chunk').settle({ outcome: 'success' })
    return { summary: `summary:${input.conversationId}` }
  }
) {
  const messages = new Map<string, ChatMessage[]>()
  let sequence = 0
  const deps: BackgroundCompactionCoordinatorDeps = {
    getConfig: (conversationId) => configs.get(conversationId) ?? disabled,
    hasConfigOverride: (conversationId) => overridden.has(conversationId),
    getConversation: (id) => ({ id, archived: false }),
    getMessages: (id) => messages.get(id) ?? [],
    resolveSelection: async () => ({ selection: frozen, contextWindow: 128_000 }),
    summarize: vi.fn(summarize),
    publish: vi.fn(),
    recordAttempt: vi.fn(),
    revalidate: () => true,
    randomId: () => `id-${++sequence}`,
  }
  return { coordinator: new ChatBackgroundCompactionCoordinator(deps), deps, messages }
}

function conversation(): string {
  return makeConversation(makeWorkspace().id).id
}

describe('background compaction configuration per conversation', () => {
  beforeEach(freshDb)
  afterEach(closeDb)

  it('prepares only the conversation whose own configuration is enabled', async () => {
    const a = conversation()
    const b = conversation()
    const test = harness(new Map([[a, enabled()]]), new Set([a]))
    test.messages.set(a, [assistant(a, 'a-1')])
    test.messages.set(b, [assistant(b, 'b-1')])

    test.coordinator.notify(a, { conversationWindow: 128_000 })
    test.coordinator.notify(b, { conversationWindow: 128_000 })
    await test.coordinator.settled()

    expect(test.deps.summarize).toHaveBeenCalledTimes(1)
    expect(vi.mocked(test.deps.summarize).mock.calls[0][0].conversationId).toBe(a)
    expect(test.coordinator.status(a).status).toBe('ready')
    expect(test.coordinator.status(b).status).toBe('idle')
    expect(test.coordinator.getCandidate(b)).toBeNull()
  })

  it('resets only the conversation whose configuration changed', async () => {
    const a = conversation()
    const b = conversation()
    const configs = new Map([
      [a, enabled()],
      [b, enabled()],
    ])
    const test = harness(configs, new Set([a]))
    test.messages.set(a, [assistant(a, 'a-1')])
    test.messages.set(b, [assistant(b, 'b-1')])
    test.coordinator.notify(a, { conversationWindow: 128_000 })
    test.coordinator.notify(b, { conversationWindow: 128_000 })
    await test.coordinator.settled()
    const beforeA = test.coordinator.record(a)!
    const beforeB = test.coordinator.record(b)!

    configs.set(a, enabled(2))
    test.coordinator.configureChanged(a)

    expect(test.coordinator.record(a)).toMatchObject({
      generation: beforeA.generation + 1,
      ready: null,
      work: null,
      state: { status: 'idle' },
    })
    expect(test.coordinator.record(b)).toEqual(beforeB)
  })

  it('keeps a candidate prepared under the same configuration when the override is applied again', async () => {
    const a = conversation()
    const test = harness(new Map([[a, enabled()]]), new Set([a]))
    test.messages.set(a, [assistant(a, 'a-1')])
    test.coordinator.notify(a, { conversationWindow: 128_000 })
    await test.coordinator.settled()
    const before = test.coordinator.record(a)!

    test.coordinator.configureChanged(a)

    expect(test.coordinator.record(a)).toEqual(before)
    expect(test.coordinator.getCandidate(a)).not.toBeNull()
  })

  it('pauses a conversation whose own configuration is disabled', async () => {
    const a = conversation()
    const configs = new Map([[a, enabled()]])
    const test = harness(configs, new Set([a]))
    test.messages.set(a, [assistant(a, 'a-1')])
    test.coordinator.notify(a, { conversationWindow: 128_000 })
    await test.coordinator.settled()

    configs.set(a, disabled)
    test.coordinator.configureChanged(a)

    expect(test.coordinator.record(a)).toMatchObject({ pauseReason: 'disabled', ready: null, work: null })
    test.coordinator.notify(a, { conversationWindow: 128_000 })
    await test.coordinator.settled()
    expect(test.deps.summarize).toHaveBeenCalledTimes(1)
  })

  it('leaves conversations with their own configuration alone when the global configuration changes', async () => {
    const a = conversation()
    const b = conversation()
    const test = harness(
      new Map([
        [a, enabled()],
        [b, enabled()],
      ]),
      new Set([a])
    )
    test.messages.set(a, [assistant(a, 'a-1')])
    test.messages.set(b, [assistant(b, 'b-1')])
    test.coordinator.notify(a, { conversationWindow: 128_000 })
    test.coordinator.notify(b, { conversationWindow: 128_000 })
    await test.coordinator.settled()
    const beforeA = test.coordinator.record(a)!
    const beforeB = test.coordinator.record(b)!

    test.coordinator.configureChanged()

    expect(test.coordinator.record(a)).toEqual(beforeA)
    expect(test.coordinator.record(b)).toMatchObject({ generation: beforeB.generation + 1, ready: null })
  })

  it('cancels only the running round of the conversation whose configuration changed', async () => {
    const a = conversation()
    const b = conversation()
    const configs = new Map([
      [a, enabled()],
      [b, enabled()],
    ])
    const signals = new Map<string, AbortSignal>()
    const releases: Array<() => void> = []
    const test = harness(configs, new Set([a, b]), async (input) => {
      signals.set(input.conversationId, input.signal)
      input.onAttempt('chunk').settle({ outcome: 'success' })
      await new Promise<void>((resolve) => releases.push(resolve))
      return { summary: 'prepared' }
    })
    test.messages.set(a, [assistant(a, 'a-1')])
    test.messages.set(b, [assistant(b, 'b-1')])
    test.coordinator.notify(a, { conversationWindow: 128_000 })
    await vi.waitFor(() => expect(signals.has(a)).toBe(true))

    configs.set(b, enabled(2))
    test.coordinator.configureChanged(b)
    expect(signals.get(a)?.aborted).toBe(false)

    configs.set(a, enabled(2))
    test.coordinator.configureChanged(a)
    expect(signals.get(a)?.aborted).toBe(true)
    for (const release of releases) release()
    await test.coordinator.settled()
    expect(test.coordinator.getCandidate(a)).toBeNull()
  })
})

describe('conversation compaction override in the chat service', () => {
  let a: string
  let b: string
  let model: { providerId: string; modelId: string }

  function seed(conversationId: string): void {
    patchConvUiPrefs(conversationId, { chat: { ...model, reasoning: 'off', fastMode: false } })
    upsertChatMessage({
      id: `${conversationId}:user`,
      conversationId,
      role: 'user',
      createdAt: 1,
      parts: [{ type: 'text', id: `${conversationId}:user-text`, text: 'Source context. '.repeat(4_000) }],
    })
    upsertChatMessage({
      id: `${conversationId}:assistant`,
      conversationId,
      role: 'assistant',
      model,
      createdAt: 2,
      finishReason: 'stop',
      parts: [{ type: 'text', id: `${conversationId}:assistant-text`, text: 'Prior decisions and completed work.' }],
    })
  }

  beforeEach(() => {
    freshDb()
    vi.clearAllMocks()
    h.generateText.mockReset().mockResolvedValue({
      text: 'Complete portable summary',
      totalUsage: { inputTokens: 80, outputTokens: 16 },
    })
    const provider = addProvider({
      name: 'Synthetic compactor',
      baseURL: 'https://provider.invalid/v1',
      kind: 'openai',
    })
    model = { providerId: provider.id, modelId: 'synthetic-model' }
    a = makeConversation(makeWorkspace().id).id
    b = makeConversation(makeWorkspace().id).id
    seed(a)
    seed(b)
  })

  afterEach(() => {
    setConversationCompactionOverride(a, null)
    closeDb()
  })

  it('prepares the overridden conversation while the global setting and other conversations stay disabled', async () => {
    const override: BackgroundCompactionConfig = {
      enabled: true,
      intervalTokens: 10_000,
      selection: { providerId: model.providerId, modelId: 'synthetic-helper', effort: 'off', fastMode: false },
    }
    setConversationCompactionOverride(a, override)

    chatRuntimeState(a)
    chatRuntimeState(b)
    await vi.waitFor(() => expect(chatRuntimeState(a).backgroundCompaction?.status).toBe('ready'))
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(getAppSetting('chat.backgroundCompaction')).toBeNull()
    expect(new BackgroundCompactionStore().get(a)?.ready?.summary).toBe('Complete portable summary')
    expect(new BackgroundCompactionStore().get(b)).toBeNull()
    expect(chatRuntimeState(b).backgroundCompaction?.status).toBe('idle')
    expect(await retryBackgroundCompaction(b)).toEqual({ ok: false, error: 'not-configured' })

    // Applying the same override again (for example after a restart) keeps the prepared summary.
    setConversationCompactionOverride(a, { ...override })
    expect(new BackgroundCompactionStore().get(a)?.ready).not.toBeNull()

    // Removing it returns the conversation to the global setting, which is disabled.
    setConversationCompactionOverride(a, null)
    expect(new BackgroundCompactionStore().get(a)).toMatchObject({ pauseReason: 'disabled', ready: null, work: null })
    expect(await retryBackgroundCompaction(a)).toEqual({ ok: false, error: 'not-configured' })
    const calls = h.generateText.mock.calls.length
    chatRuntimeState(a)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(h.generateText).toHaveBeenCalledTimes(calls)
  })

  it('rejects a structurally invalid override without changing the conversation', () => {
    expect(() =>
      setConversationCompactionOverride(a, { enabled: true, intervalTokens: 10_000, selection: null })
    ).toThrow('invalid-input')
    expect(new BackgroundCompactionStore().get(a)).toBeNull()
  })
})
