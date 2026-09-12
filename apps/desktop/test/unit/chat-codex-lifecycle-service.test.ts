import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Control effective catalogs because fake workspaces lack agent files;
// real discovery would return no agents and discard structured mentions.
const hAgents = vi.hoisted(() => ({
  listEffectiveAgents: vi.fn(async (): Promise<Array<{ name: string; description: string; category: string }>> => []),
}))
vi.mock('../../src/main/chat/virtual-subagents', () => ({
  listEffectiveAgents: hAgents.listEffectiveAgents,
}))

const h = vi.hoisted(() => {
  const order: string[] = []
  const state: { binding: any } = { binding: null }
  let accountUpdated: (() => void) | null = null
  const manager = {
    getStatus: vi.fn(async () => ({
      state: 'ready',
      available: true,
      connected: true,
      authenticated: false,
      account: null as null | { type: string; email: string; planType: string },
      requiresOpenaiAuth: true,
      runtime: null,
      error: null,
    })),
    getStatusSnapshot: vi.fn(() => null),
    startLogin: vi.fn(async () => {
      order.push('start-login')
      return { loginId: 'login-1', authUrl: 'https://auth.test', state: 'pending', completion: null }
    }),
    waitForLogin: vi.fn(() => new Promise<never>(() => {})),
    logout: vi.fn(async () => {
      order.push('logout')
    }),
    dispose: vi.fn(async () => {}),
    listModels: vi.fn(async (): Promise<any[]> => []),
    preferredServiceTier: vi.fn(async (_modelId: string): Promise<string | null> => null),
    observeModelContextWindow: vi.fn(),
    getClient: vi.fn(),
    onAccountUpdated: vi.fn((listener: () => void) => {
      accountUpdated = listener
      return () => {
        if (accountUpdated === listener) accountUpdated = null
      }
    }),
  }
  return {
    order,
    state,
    manager,
    deleteOne: vi.fn(async () => {
      order.push('delete-one')
      return { conversationId: '', threadId: null as string | null, remoteDeleted: false }
    }),
    deleteAll: vi.fn(async () => {
      order.push('delete-all')
      return []
    }),
    runCodex: vi.fn(async (_args: any) => ({ planSubmitted: false, threadId: 'thread-test' })),
    retryCleanup: vi.fn(async () => []),
    clearAllBindings: vi.fn(() => 0),
    getBinding: vi.fn(() => state.binding),
    summarizeCodex: vi.fn(async () => ({ text: 'portable summary' })),
    emitAccountUpdated: () => accountUpdated?.(),
  }
})

vi.mock('../../src/main/chat/codex-subscription', () => ({
  compactCodexSubscriptionThread: vi.fn(),
  clearAllCodexThreadBindings: h.clearAllBindings,
  deleteAllManagedCodexThreads: h.deleteAll,
  deleteCodexThreadForConversation: h.deleteOne,
  deleteManagedCodexThread: h.deleteOne,
  retryManagedCodexThreadCleanup: h.retryCleanup,
  getCodexSubscriptionManager: () => h.manager,
  listCodexSubscriptionManagers: () => [h.manager],
  getCodexThreadBinding: h.getBinding,
  putCodexThreadBinding: vi.fn(),
  runCodexSubscriptionChat: h.runCodex,
}))

// Direct manager imports require mocks beyond the index module.
vi.mock('../../src/main/chat/codex-subscription/manager', () => ({
  getCodexSubscriptionManager: () => h.manager,
  listCodexSubscriptionManagers: () => [h.manager],
}))

vi.mock('../../src/main/chat/portable-summarizer', () => ({
  summarizeWithCodexRuntime: h.summarizeCodex,
  summarizeWithGitHubCopilotRuntime: vi.fn(),
}))

const hDiag = vi.hoisted(() => ({ chatDiag: vi.fn() }))
vi.mock('../../src/main/chat/diag-log', () => ({ chatDiag: hDiag.chatDiag }))

import type { ChatIpcDeps } from '../../src/main/chat/service'
import { disposeChat, registerChatIpc, stopChat, stopChatAndWait } from '../../src/main/chat/service'
import { listChatMessages, upsertChatMessage } from '../../src/main/chat/chat-store'
import { CODEX_SUBSCRIPTION_PROVIDER_ID } from '../../src/main/chat/catalog'
import { closeDb, freshDb } from '../helpers/db'
import { makeConversation, makeWorkspace } from '../helpers/factories'
import { getConvUiPrefs, patchConvUiPrefs } from '../../src/main/store'
import { MAESTRLY_ULTRA_EFFORT } from '../../src/shared/chat'
import { addProvider, getProviderKind } from '../../src/main/chat/catalog'
import { clearApiKey, setApiKey } from '../../src/main/chat/credentials'
import { buildOpenAIProviderFingerprint } from '../../src/main/chat/provider'

type Handler = (event: any, ...args: any[]) => unknown

function register(): Map<string, Handler> {
  const handlers = new Map<string, Handler>()
  registerChatIpc({
    mhandle: (channel, fn) => void handlers.set(channel, fn as Handler),
    mon: vi.fn(),
    emitStatus: vi.fn(),
  } satisfies ChatIpcDeps)
  return handlers
}

describe('Codex lifecycle chat IPC integration', () => {
  beforeEach(() => {
    freshDb()
    hAgents.listEffectiveAgents.mockReset()
    hAgents.listEffectiveAgents.mockResolvedValue([{ name: 'testing', description: 'x', category: 'test' }])
    h.order.length = 0
    h.state.binding = null
    h.deleteOne.mockReset()
    h.deleteOne.mockResolvedValue({ conversationId: '', threadId: null, remoteDeleted: false })
    h.deleteAll.mockClear()
    h.retryCleanup.mockClear()
    h.runCodex.mockClear()
    h.manager.startLogin.mockClear()
    h.manager.logout.mockClear()
    h.manager.dispose.mockClear()
    h.manager.getStatus.mockClear()
    h.manager.listModels.mockReset()
    h.manager.listModels.mockResolvedValue([])
    h.manager.getClient.mockReset()
    h.manager.preferredServiceTier.mockReset()
    h.manager.preferredServiceTier.mockResolvedValue(null)
    h.manager.observeModelContextWindow.mockClear()
    h.clearAllBindings.mockClear()
    h.getBinding.mockClear()
    h.summarizeCodex.mockReset()
    h.summarizeCodex.mockResolvedValue({ text: 'portable summary' })
    hDiag.chatDiag.mockClear()
  })

  afterEach(closeDb)

  it('chat:clear requests remote deletion before deleting local messages', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    upsertChatMessage({
      id: 'user-1',
      conversationId: conversation.id,
      role: 'user',
      parts: [{ type: 'text', id: 'text-1', text: 'hello' }],
      createdAt: 1,
    })
    h.deleteOne.mockImplementationOnce(async () => {
      expect(listChatMessages(conversation.id)).toHaveLength(1)
      h.order.push('delete-one')
      return { conversationId: conversation.id, threadId: 'thread-1', remoteDeleted: true }
    })

    const result = await register().get('chat:clear')?.({}, conversation.id)

    expect(result).toEqual({ ok: true })
    expect(h.deleteOne).toHaveBeenCalledWith(
      conversation.id,
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
    expect(listChatMessages(conversation.id)).toEqual([])
  })

  it('preserves threads while selection changes remain reversible', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    patchConvUiPrefs(conversation.id, {
      chat: { providerId: CODEX_SUBSCRIPTION_PROVIDER_ID, modelId: 'gpt-old' },
    })
    const result = await register().get('chat:set-selection')?.({}, conversation.id, {
      providerId: CODEX_SUBSCRIPTION_PROVIDER_ID,
      modelId: 'gpt-new',
    })

    expect(result).toEqual({ ok: true })
    expect(h.deleteOne).not.toHaveBeenCalled()
    expect(getConvUiPrefs(conversation.id).chat).toMatchObject({
      providerId: CODEX_SUBSCRIPTION_PROVIDER_ID,
      modelId: 'gpt-new',
    })

    await register().get('chat:set-selection')?.({}, conversation.id, {
      providerId: CODEX_SUBSCRIPTION_PROVIDER_ID,
      modelId: 'gpt-old',
    })
    expect(h.deleteOne).not.toHaveBeenCalled()
    expect(getConvUiPrefs(conversation.id).chat?.modelId).toBe('gpt-old')
  })

  it('projects portable transcripts instead of stale Codex measurements after BYOK switches', async () => {
    const handlers = register()
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    const byok = addProvider({ name: 'Anthropic compatible', baseURL: 'https://example.test/v1', kind: 'anthropic' })
    patchConvUiPrefs(conversation.id, {
      chat: { providerId: CODEX_SUBSCRIPTION_PROVIDER_ID, modelId: 'gpt-sol' },
    })
    upsertChatMessage({
      id: 'user-large',
      conversationId: conversation.id,
      role: 'user',
      parts: [{ type: 'text', id: 'large-text', text: 'x'.repeat(1_200_000) }],
      createdAt: 1,
    })
    upsertChatMessage({
      id: 'assistant-codex',
      conversationId: conversation.id,
      role: 'assistant',
      parts: [{ type: 'text', id: 'answer', text: 'done' }],
      model: { providerId: CODEX_SUBSCRIPTION_PROVIDER_ID, modelId: 'gpt-sol' },
      usage: {
        usageVersion: 2,
        input: 58_000,
        output: 2_000,
        contextInput: 58_000,
        contextOutput: 2_000,
        modelContextWindow: 256_000,
      },
      createdAt: 2,
    })
    h.state.binding = {
      conversationId: conversation.id,
      threadId: 'thread-sol',
      modelId: 'gpt-sol',
      toolSignature: 'tools',
      instructionHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      lastMessageId: 'assistant-codex',
      usage: { inputTokens: 58_000, cachedInputTokens: 0, outputTokens: 2_000 },
      accountId: null,
    }

    expect(await handlers.get('chat:history:stats')?.({}, conversation.id)).toMatchObject({
      contextProjection: { usedTokens: 60_000, source: 'runtime-usage', quality: 'measured' },
    })
    await handlers.get('chat:set-selection')?.({}, conversation.id, {
      providerId: CODEX_SUBSCRIPTION_PROVIDER_ID,
      modelId: 'gpt-luna',
    })
    const switchedModel = (await handlers.get('chat:history:stats')?.({}, conversation.id)) as any
    expect(switchedModel).toMatchObject({
      contextProjection: { usedTokens: 60_000, source: 'runtime-usage', quality: 'measured' },
    })
    // Occupancy belongs to the thread, while the old model reported the window.
    expect(switchedModel.contextProjection).not.toHaveProperty('modelContextWindow')

    await handlers.get('chat:set-selection')?.({}, conversation.id, { providerId: byok.id, modelId: 'fable' })
    expect(await handlers.get('chat:history:stats')?.({}, conversation.id)).toMatchObject({
      contextProjection: { source: 'portable-transcript', quality: 'estimated' },
    })
    expect(
      ((await handlers.get('chat:history:stats')?.({}, conversation.id)) as any).contextProjection.usedTokens
    ).toBeGreaterThan(390_000)
    await handlers.get('chat:set-selection')?.({}, conversation.id, {
      providerId: CODEX_SUBSCRIPTION_PROVIDER_ID,
      modelId: 'gpt-sol',
    })
    expect(await handlers.get('chat:history:stats')?.({}, conversation.id)).toMatchObject({
      contextProjection: { usedTokens: 60_000, source: 'runtime-usage', quality: 'measured' },
    })
    expect(h.deleteOne).not.toHaveBeenCalled()
  })

  it('projects only bounded reseed transcripts without Codex bindings', async () => {
    const handlers = register()
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    patchConvUiPrefs(conversation.id, {
      chat: { providerId: CODEX_SUBSCRIPTION_PROVIDER_ID, modelId: 'gpt-luna' },
    })
    upsertChatMessage({
      id: 'assistant-tool-heavy',
      conversationId: conversation.id,
      role: 'assistant',
      parts: [
        {
          type: 'tool',
          id: 'tool-heavy',
          toolCallId: 'tool-call-heavy',
          toolName: 'bash',
          input: { command: 'huge-output' },
          state: { status: 'completed', output: 'x'.repeat(1_200_000) },
        },
      ],
      createdAt: 1,
    })

    const projected = (await handlers.get('chat:history:stats')?.({}, conversation.id)) as any
    expect(projected).toMatchObject({
      contextProjection: {
        source: 'portable-transcript',
        quality: 'estimated',
      },
    })
    expect(projected.contextProjection.usedTokens).toBeLessThan(6_000)
  })

  it('reuses BYOK usage only for exact provider, model and credentials', async () => {
    const handlers = register()
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    const provider = addProvider({
      name: 'Anthropic compatible',
      baseURL: 'https://identity.example.test/v1',
      kind: 'anthropic',
    })
    try {
      setApiKey(provider.id, 'first-key')
      patchConvUiPrefs(conversation.id, {
        chat: { providerId: provider.id, modelId: 'fable' },
      })
      upsertChatMessage({
        id: 'user-portable',
        conversationId: conversation.id,
        role: 'user',
        parts: [{ type: 'text', id: 'portable-text', text: 'x'.repeat(300_000) }],
        createdAt: 1,
      })
      upsertChatMessage({
        id: 'assistant-measured',
        conversationId: conversation.id,
        role: 'assistant',
        parts: [{ type: 'text', id: 'answer', text: 'done' }],
        model: { providerId: provider.id, modelId: 'fable' },
        usage: {
          usageVersion: 2,
          input: 48_000,
          output: 2_000,
          contextInput: 48_000,
          contextOutput: 2_000,
          contextIdentity: buildOpenAIProviderFingerprint(provider, getProviderKind(provider), 'first-key'),
        },
        createdAt: 2,
      })

      expect(await handlers.get('chat:history:stats')?.({}, conversation.id)).toMatchObject({
        contextProjection: { usedTokens: 50_000, source: 'runtime-usage', quality: 'measured' },
      })

      setApiKey(provider.id, 'rotated-key')
      expect(await handlers.get('chat:history:stats')?.({}, conversation.id)).toMatchObject({
        contextProjection: { source: 'portable-transcript', quality: 'estimated' },
      })
      const projected = (await handlers.get('chat:history:stats')?.({}, conversation.id)) as any
      expect(projected.contextProjection.usedTokens).toBeGreaterThan(90_000)
    } finally {
      clearApiKey(provider.id)
    }
  })

  it('compacts large BYOK history before starting smaller Codex sessions', async () => {
    const handlers = register()
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    patchConvUiPrefs(conversation.id, {
      chat: { providerId: CODEX_SUBSCRIPTION_PROVIDER_ID, modelId: 'gpt-small' },
    })
    upsertChatMessage({
      id: 'user-large-byok',
      conversationId: conversation.id,
      role: 'user',
      parts: [{ type: 'text', id: 'large-byok-text', text: 'x'.repeat(1_200_000) }],
      createdAt: 1,
    })
    upsertChatMessage({
      id: 'assistant-large-byok',
      conversationId: conversation.id,
      role: 'assistant',
      parts: [{ type: 'text', id: 'large-byok-answer', text: 'done' }],
      model: { providerId: 'old-byok', modelId: 'opus-large' },
      createdAt: 2,
    })
    h.manager.getStatus.mockResolvedValue({
      state: 'ready',
      available: true,
      connected: true,
      authenticated: true,
      account: { type: 'chatgpt', email: 'user@example.test', planType: 'pro' },
      requiresOpenaiAuth: true,
      runtime: null,
      error: null,
    })
    h.manager.listModels.mockResolvedValue([
      {
        id: 'gpt-small',
        model: 'gpt-small',
        contextWindow: 256_000,
        supportedReasoningEfforts: [],
        serviceTiers: [],
        legacySpeedTiers: [],
        inputModalities: ['text'],
      },
    ])
    h.manager.getClient.mockResolvedValue({})

    await expect(
      handlers.get('chat:send')?.(
        { sender: { isDestroyed: () => false, send: vi.fn() } },
        { conversationId: conversation.id, text: 'continue no Codex' }
      )
    ).resolves.toEqual({ ok: true })
    await vi.waitFor(() => expect(h.runCodex).toHaveBeenCalledTimes(1))

    const messages = listChatMessages(conversation.id)
    const markerIndex = messages.findIndex((message) => message.parts.some((part) => part.type === 'compaction'))
    const pendingIndex = messages.findIndex((message) =>
      message.parts.some((part) => part.type === 'text' && part.text === 'continue no Codex')
    )
    expect(markerIndex).toBeGreaterThan(0)
    expect(pendingIndex).toBeGreaterThan(markerIndex)
    expect(h.summarizeCodex).toHaveBeenCalled()
    expect(
      messages[markerIndex].parts.some(
        (part) => part.type === 'compaction' && part.strategy === 'summary' && part.text === 'portable summary'
      )
    ).toBe(true)
    expect(h.deleteOne).toHaveBeenCalledWith(
      conversation.id,
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
  })

  it('blocks oversized sends when portable compaction fails', async () => {
    const handlers = register()
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    patchConvUiPrefs(conversation.id, {
      chat: { providerId: CODEX_SUBSCRIPTION_PROVIDER_ID, modelId: 'gpt-test' },
    })
    upsertChatMessage({
      id: 'user-large',
      conversationId: conversation.id,
      role: 'user',
      parts: [{ type: 'text', id: 'large', text: 'x'.repeat(900_000) }],
      createdAt: 1,
    })
    upsertChatMessage({
      id: 'assistant-large',
      conversationId: conversation.id,
      role: 'assistant',
      parts: [{ type: 'text', id: 'large-answer', text: 'y'.repeat(30_000) }],
      createdAt: 2,
    })
    h.manager.getStatus.mockResolvedValue({
      state: 'ready',
      available: true,
      connected: true,
      authenticated: true,
      account: { type: 'chatgpt', email: 'user@example.com', planType: 'pro' },
      requiresOpenaiAuth: true,
      runtime: null,
      error: null,
    })
    h.manager.listModels.mockResolvedValue([
      {
        id: 'gpt-test',
        model: 'gpt-test',
        contextWindow: 256_000,
        supportedReasoningEfforts: [],
        serviceTiers: [],
        legacySpeedTiers: [],
        inputModalities: ['text'],
      },
    ])
    h.manager.getClient.mockResolvedValue({})
    h.summarizeCodex.mockRejectedValueOnce(new Error('compact failed'))

    const result = await handlers.get('chat:send')?.(
      { sender: { isDestroyed: () => false, send: vi.fn() } },
      { conversationId: conversation.id, text: 'new turn' }
    )

    expect(result).toEqual({ ok: false, error: 'context-compaction-failed' })
    expect(listChatMessages(conversation.id).map((message) => message.id)).toEqual(['user-large', 'assistant-large'])
    expect(h.runCodex).not.toHaveBeenCalled()
    expect(hDiag.chatDiag).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'preflight-compact-failed',
        admitted: false,
        overflow: true,
        error: expect.any(String),
      })
    )
  })

  it('blocks required-compaction failures below overflow', async () => {
    const handlers = register()
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    patchConvUiPrefs(conversation.id, {
      chat: { providerId: CODEX_SUBSCRIPTION_PROVIDER_ID, modelId: 'gpt-test' },
    })
    // Around 210k tokens in 256k requires reserved-budget compaction before overflow.
    upsertChatMessage({
      id: 'user-mid',
      conversationId: conversation.id,
      role: 'user',
      parts: [{ type: 'text', id: 'mid', text: 'x'.repeat(620_000) }],
      createdAt: 1,
    })
    upsertChatMessage({
      id: 'assistant-mid',
      conversationId: conversation.id,
      role: 'assistant',
      parts: [{ type: 'text', id: 'mid-answer', text: 'y'.repeat(10_000) }],
      createdAt: 2,
    })
    h.manager.getStatus.mockResolvedValue({
      state: 'ready',
      available: true,
      connected: true,
      authenticated: true,
      account: { type: 'chatgpt', email: 'user@example.com', planType: 'pro' },
      requiresOpenaiAuth: true,
      runtime: null,
      error: null,
    })
    h.manager.listModels.mockResolvedValue([
      {
        id: 'gpt-test',
        model: 'gpt-test',
        contextWindow: 256_000,
        supportedReasoningEfforts: [],
        serviceTiers: [],
        legacySpeedTiers: [],
        inputModalities: ['text'],
      },
    ])
    h.manager.getClient.mockResolvedValue({})
    h.summarizeCodex.mockRejectedValueOnce(new Error('provider 502 during compact'))

    const result = await handlers.get('chat:send')?.(
      { sender: { isDestroyed: () => false, send: vi.fn() } },
      { conversationId: conversation.id, text: 'still fits' }
    )

    expect(result).toEqual({ ok: false, error: 'context-compaction-failed' })
    expect(hDiag.chatDiag).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'preflight-compact-failed',
        admitted: false,
        overflow: false,
        error: expect.stringMatching(/502|compact/i),
      })
    )
    expect(h.runCodex).not.toHaveBeenCalled()
    expect(
      listChatMessages(conversation.id).some(
        (m) => m.role === 'user' && m.parts.some((p) => p.type === 'text' && p.text === 'still fits')
      )
    ).toBe(false)
  })

  it('defaults Standard and persists conversation Fast opt-in', () => {
    const handlers = register()
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})

    expect(handlers.get('chat:get-fast-mode')?.({}, conversation.id)).toBe(false)
    expect(handlers.get('chat:set-fast-mode')?.({}, conversation.id, true)).toEqual({ ok: true })
    expect(handlers.get('chat:get-fast-mode')?.({}, conversation.id)).toBe(true)
    expect(getConvUiPrefs(conversation.id).chat?.fastMode).toBe(true)
  })

  it('deletes threads before truncating resend history', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    h.manager.getStatus.mockResolvedValue({
      state: 'ready',
      available: true,
      connected: true,
      authenticated: false,
      account: null,
      requiresOpenaiAuth: true,
      runtime: null,
      error: null,
    })
    patchConvUiPrefs(conversation.id, {
      chat: { providerId: CODEX_SUBSCRIPTION_PROVIDER_ID, modelId: 'gpt-test' },
    })
    for (const [id, role, text, createdAt] of [
      ['user-1', 'user', 'first', 1],
      ['assistant-1', 'assistant', 'answer', 2],
      ['user-2', 'user', 'editar', 3],
    ] as const) {
      upsertChatMessage({
        id,
        conversationId: conversation.id,
        role,
        parts: [{ type: 'text', id: `${id}-text`, text }],
        createdAt,
      })
    }
    h.deleteOne.mockImplementationOnce(async () => {
      expect(listChatMessages(conversation.id).map((message) => message.id)).toEqual([
        'user-1',
        'assistant-1',
        'user-2',
      ])
      h.order.push('delete-one')
      return { conversationId: conversation.id, threadId: 'thread-1', remoteDeleted: true }
    })

    const result = await register().get('chat:resend')?.(
      { sender: { isDestroyed: () => false, send: vi.fn() } },
      { conversationId: conversation.id, fromMessageId: 'user-2', text: 'editada' }
    )

    expect(result).toEqual({ ok: false, error: 'no-key' })
    expect(h.deleteOne).toHaveBeenCalledWith(
      conversation.id,
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
    expect(listChatMessages(conversation.id).map((message) => message.id)).toEqual(['user-1', 'assistant-1'])
  })

  it('persists valid structured mention ranges on resend', async () => {
    const handlers = register()
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    h.manager.getStatus.mockResolvedValue({
      state: 'ready',
      available: true,
      connected: true,
      authenticated: true,
      account: { type: 'chatgpt', email: 'user@example.com', planType: 'pro' },
      requiresOpenaiAuth: true,
      runtime: null,
      error: null,
    })
    h.manager.listModels.mockResolvedValue([
      {
        id: 'gpt-test',
        model: 'gpt-test',
        contextWindow: 256_000,
        supportedReasoningEfforts: [],
        serviceTiers: [],
        legacySpeedTiers: [],
        inputModalities: ['text'],
      },
    ])
    h.manager.getClient.mockResolvedValue({})
    patchConvUiPrefs(conversation.id, {
      chat: { providerId: CODEX_SUBSCRIPTION_PROVIDER_ID, modelId: 'gpt-test' },
    })
    // Original messages include text, structured mentions and attachments.
    upsertChatMessage({
      id: 'user-original',
      conversationId: conversation.id,
      role: 'user',
      parts: [
        { type: 'text', id: 'text-original', text: 'test #testing' },
        { type: 'agent-mention', id: 'mention-original', name: 'testing', start: 5, end: 13 },
        {
          type: 'file',
          id: 'file-original',
          name: 'img.png',
          mediaType: 'image/png',
          kind: 'image',
          data: 'data:image/png;base64,iVBORw0KGgo=',
          description: 'already billed description',
          descriptionModel: 'gpt-5.6-mini',
        },
      ],
      createdAt: 1,
    })

    const result = await handlers.get('chat:resend')?.(
      { sender: { isDestroyed: () => false, send: vi.fn() } },
      {
        conversationId: conversation.id,
        fromMessageId: 'user-original',
        text: 'test #testing',
        agentMentions: [{ id: 'mention-original', name: 'testing', start: 5, end: 13 }],
      }
    )

    expect(result).toEqual({ ok: true })
    // Resend removes originals and preserves attachments alongside new mention parts.
    const messages = listChatMessages(conversation.id)
    const newUser = messages.find((message) => message.role === 'user')
    expect(newUser).toBeDefined()
    const parts = newUser!.parts
    expect(parts).toEqual(
      expect.arrayContaining([
        { type: 'text', id: expect.any(String), text: 'test #testing' },
        { type: 'agent-mention', id: 'mention-original', name: 'testing', start: 5, end: 13 },
      ])
    )
    expect(parts).toContainEqual(
      expect.objectContaining({
        type: 'file',
        name: 'img.png',
        description: 'already billed description',
        descriptionModel: 'gpt-5.6-mini',
      })
    )
    expect(parts.filter((p) => p.type === 'agent-mention')).toHaveLength(1)
  })

  it('discards forged catalog entries and invalid mention ranges', async () => {
    const handlers = register()
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    h.manager.getStatus.mockResolvedValue({
      state: 'ready',
      available: true,
      connected: true,
      authenticated: true,
      account: { type: 'chatgpt', email: 'user@example.com', planType: 'pro' },
      requiresOpenaiAuth: true,
      runtime: null,
      error: null,
    })
    h.manager.listModels.mockResolvedValue([
      {
        id: 'gpt-test',
        model: 'gpt-test',
        contextWindow: 256_000,
        supportedReasoningEfforts: [],
        serviceTiers: [],
        legacySpeedTiers: [],
        inputModalities: ['text'],
      },
    ])
    h.manager.getClient.mockResolvedValue({})
    patchConvUiPrefs(conversation.id, {
      chat: { providerId: CODEX_SUBSCRIPTION_PROVIDER_ID, modelId: 'gpt-test' },
    })
    upsertChatMessage({
      id: 'user-original',
      conversationId: conversation.id,
      role: 'user',
      parts: [{ type: 'text', id: 'text-original', text: 'test #testing' }],
      createdAt: 1,
    })

    // Combine unknown agents and ranges mismatching visible text.
    const result = await handlers.get('chat:resend')?.(
      { sender: { isDestroyed: () => false, send: vi.fn() } },
      {
        conversationId: conversation.id,
        fromMessageId: 'user-original',
        text: 'test #testing',
        agentMentions: [
          { id: 'ghost-1', name: 'ghost', start: 5, end: 12 },
          { id: 'bad-range', name: 'testing', start: 0, end: 8 },
        ],
      }
    )

    expect(result).toEqual({ ok: true })
    const messages = listChatMessages(conversation.id)
    const newUser = messages.find((message) => message.role === 'user')
    // Host validation discards both invalid occurrences.
    expect(newUser!.parts.filter((p) => p.type === 'agent-mention')).toHaveLength(0)
  })

  it('tolerates mixed resend payloads and persists only valid occurrences', async () => {
    const handlers = register()
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    h.manager.getStatus.mockResolvedValue({
      state: 'ready',
      available: true,
      connected: true,
      authenticated: true,
      account: { type: 'chatgpt', email: 'user@example.com', planType: 'pro' },
      requiresOpenaiAuth: true,
      runtime: null,
      error: null,
    })
    h.manager.listModels.mockResolvedValue([
      {
        id: 'gpt-test',
        model: 'gpt-test',
        contextWindow: 256_000,
        supportedReasoningEfforts: [],
        serviceTiers: [],
        legacySpeedTiers: [],
        inputModalities: ['text'],
      },
    ])
    h.manager.getClient.mockResolvedValue({})
    patchConvUiPrefs(conversation.id, {
      chat: { providerId: CODEX_SUBSCRIPTION_PROVIDER_ID, modelId: 'gpt-test' },
    })
    upsertChatMessage({
      id: 'user-original',
      conversationId: conversation.id,
      role: 'user',
      parts: [{ type: 'text', id: 'text-original', text: '#testing' }],
      createdAt: 1,
    })

    // Arbitrary IPC mixes invalid entries with one valid occurrence;
    // sort comparators must not throw and only valid parts persist.
    const result = await handlers.get('chat:resend')?.(
      { sender: { isDestroyed: () => false, send: vi.fn() } },
      {
        conversationId: conversation.id,
        fromMessageId: 'user-original',
        text: '#testing',
        agentMentions: [
          null,
          undefined,
          'testing',
          42,
          {},
          { id: 'bad' },
          { id: 'ok', name: 'testing', start: 0, end: 8 },
        ],
      }
    )

    expect(result).toEqual({ ok: true })
    const messages = listChatMessages(conversation.id)
    const newUser = messages.find((message) => message.role === 'user')
    const mentions = newUser!.parts.filter((p) => p.type === 'agent-mention')
    expect(mentions).toEqual([{ type: 'agent-mention', id: 'ok', name: 'testing', start: 0, end: 8 }])
  })

  it('does not preserve mention parts removed by inline editors', async () => {
    const handlers = register()
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    h.manager.getStatus.mockResolvedValue({
      state: 'ready',
      available: true,
      connected: true,
      authenticated: true,
      account: { type: 'chatgpt', email: 'user@example.com', planType: 'pro' },
      requiresOpenaiAuth: true,
      runtime: null,
      error: null,
    })
    h.manager.listModels.mockResolvedValue([
      {
        id: 'gpt-test',
        model: 'gpt-test',
        contextWindow: 256_000,
        supportedReasoningEfforts: [],
        serviceTiers: [],
        legacySpeedTiers: [],
        inputModalities: ['text'],
      },
    ])
    h.manager.getClient.mockResolvedValue({})
    patchConvUiPrefs(conversation.id, {
      chat: { providerId: CODEX_SUBSCRIPTION_PROVIDER_ID, modelId: 'gpt-test' },
    })
    // The original had a chip that the editor removed: resend does NOT carry agentMentions.
    upsertChatMessage({
      id: 'user-original',
      conversationId: conversation.id,
      role: 'user',
      parts: [
        { type: 'text', id: 'text-original', text: 'test #testing' },
        { type: 'agent-mention', id: 'mention-original', name: 'testing', start: 5, end: 13 },
      ],
      createdAt: 1,
    })

    const result = await handlers.get('chat:resend')?.(
      { sender: { isDestroyed: () => false, send: vi.fn() } },
      { conversationId: conversation.id, fromMessageId: 'user-original', text: 'test #testing' }
    )

    expect(result).toEqual({ ok: true })
    const messages = listChatMessages(conversation.id)
    const newUser = messages.find((message) => message.role === 'user')
    // Removed old mentions are not automatically retained without occurrences.
    expect(newUser!.parts.filter((p) => p.type === 'agent-mention')).toHaveLength(0)
  })

  it('clears account bindings before authentication changes', async () => {
    const handlers = register()
    h.manager.getStatus.mockResolvedValueOnce({
      state: 'ready',
      available: true,
      connected: true,
      authenticated: false,
      account: null,
      requiresOpenaiAuth: true,
      runtime: null,
      error: null,
    })

    await expect(handlers.get('chat:codex-subscription:login')?.({})).resolves.toMatchObject({
      ok: true,
      authUrl: 'https://auth.test',
    })
    expect(h.order).toEqual(['delete-all', 'start-login'])

    h.order.length = 0
    await expect(handlers.get('chat:codex-subscription:logout')?.({})).resolves.toMatchObject({ ok: true })
    expect(h.order).toEqual(['delete-all', 'logout', 'delete-all', 'delete-all'])
  })

  it('returns recoverable status after failed login', async () => {
    h.manager.getStatus.mockResolvedValueOnce({
      state: 'ready',
      available: true,
      connected: true,
      authenticated: false,
      account: null,
      requiresOpenaiAuth: true,
      runtime: null,
      error: null,
    })
    h.manager.startLogin.mockRejectedValueOnce(new Error('OAuth unavailable'))

    await expect(register().get('chat:codex-subscription:login')?.({})).resolves.toEqual({
      ok: false,
      error: 'OAuth unavailable',
      status: { state: 'error', authenticated: false, error: 'OAuth unavailable' },
    })
  })

  it('preserves already-authenticated accounts recovered by probes', async () => {
    const handlers = register()

    await expect(handlers.get('chat:codex-subscription:login')?.({})).resolves.toMatchObject({
      ok: true,
      status: { state: 'signed-in', authenticated: true, email: 'user@example.com' },
    })
    expect(h.manager.startLogin).not.toHaveBeenCalled()
    expect(h.deleteAll).not.toHaveBeenCalled()
  })

  it('external account/updated invalidates bindings when ChatGPT identity changes', async () => {
    const handlers = register()
    h.manager.getStatus.mockResolvedValueOnce({
      state: 'ready',
      available: true,
      connected: true,
      authenticated: true,
      account: { type: 'chatgpt', email: 'old@example.com', planType: 'pro' },
      requiresOpenaiAuth: true,
      runtime: null,
      error: null,
    })
    await handlers.get('chat:codex-subscription:status')?.({}, { refresh: true })
    h.deleteAll.mockClear()

    h.manager.getStatus.mockResolvedValueOnce({
      state: 'ready',
      available: true,
      connected: true,
      authenticated: true,
      account: { type: 'chatgpt', email: 'new@example.com', planType: 'pro' },
      requiresOpenaiAuth: true,
      runtime: null,
      error: null,
    })
    h.emitAccountUpdated()

    await vi.waitFor(() => expect(h.deleteAll).toHaveBeenCalledTimes(1))
  })

  it('repeats account reads for updates arriving during refresh', async () => {
    const handlers = register()
    const accountA = {
      state: 'ready',
      available: true,
      connected: true,
      authenticated: true,
      account: { type: 'chatgpt', email: 'account-a@example.com', planType: 'pro' },
      requiresOpenaiAuth: true,
      runtime: null,
      error: null,
    }
    const accountB = {
      ...accountA,
      account: { type: 'chatgpt', email: 'account-b@example.com', planType: 'pro' },
    }

    h.manager.getStatus.mockResolvedValueOnce(accountA)
    await handlers.get('chat:codex-subscription:status')?.({}, { refresh: true })
    h.manager.getStatus.mockClear()
    h.deleteAll.mockClear()

    let resolveFirstRead!: (status: typeof accountA) => void
    let resolveFinalRead!: (status: typeof accountB) => void
    const firstRead = new Promise<typeof accountA>((resolve) => {
      resolveFirstRead = resolve
    })
    const finalRead = new Promise<typeof accountB>((resolve) => {
      resolveFinalRead = resolve
    })
    h.manager.getStatus.mockImplementationOnce(() => firstRead).mockImplementationOnce(() => finalRead)

    h.emitAccountUpdated()
    await vi.waitFor(() => expect(h.manager.getStatus).toHaveBeenCalledTimes(1))
    h.emitAccountUpdated()
    resolveFirstRead(accountA)

    await vi.waitFor(() => expect(h.manager.getStatus).toHaveBeenCalledTimes(2))
    expect(h.deleteAll).not.toHaveBeenCalled()
    resolveFinalRead(accountB)

    await vi.waitFor(() => expect(h.deleteAll).toHaveBeenCalledTimes(1))
    expect(h.manager.getStatus.mock.calls).toEqual([[true], [true]])
  })

  it('deduplicates initial identity reconciliation', async () => {
    const handlers = register()
    let resolveStatus!: (status: Awaited<ReturnType<typeof h.manager.getStatus>>) => void
    const pendingStatus = new Promise<Awaited<ReturnType<typeof h.manager.getStatus>>>((resolve) => {
      resolveStatus = resolve
    })
    h.manager.getStatus.mockReturnValue(pendingStatus)

    const first = handlers.get('chat:codex-subscription:status')?.({}, { refresh: true })
    const second = handlers.get('chat:codex-subscription:status')?.({}, { refresh: true })
    resolveStatus({
      state: 'ready',
      available: true,
      connected: true,
      authenticated: true,
      account: { type: 'chatgpt', email: 'same@example.com', planType: 'pro' },
      requiresOpenaiAuth: true,
      runtime: null,
      error: null,
    })

    await Promise.all([first, second])
    expect(h.deleteAll).toHaveBeenCalledTimes(1)
  })

  it('keeps concurrent admissions alive during shared initial reconciliation', async () => {
    const handlers = register()
    const workspace = makeWorkspace()
    const firstConversation = makeConversation(workspace.id, {})
    const secondConversation = makeConversation(workspace.id, {})
    for (const conversation of [firstConversation, secondConversation]) {
      patchConvUiPrefs(conversation.id, {
        chat: { providerId: CODEX_SUBSCRIPTION_PROVIDER_ID, modelId: 'gpt-test' },
      })
    }
    patchConvUiPrefs(firstConversation.id, {
      chat: {
        providerId: CODEX_SUBSCRIPTION_PROVIDER_ID,
        modelId: 'gpt-test',
        reasoning: 'ultra',
      },
    })
    patchConvUiPrefs(secondConversation.id, {
      chat: {
        providerId: CODEX_SUBSCRIPTION_PROVIDER_ID,
        modelId: 'gpt-test',
        fastMode: true,
        reasoning: MAESTRLY_ULTRA_EFFORT,
      },
    })
    const status = {
      state: 'ready' as const,
      available: true,
      connected: true,
      authenticated: true,
      account: { type: 'chatgpt', email: 'concurrent@example.com', planType: 'pro' },
      requiresOpenaiAuth: true,
      runtime: null,
      error: null,
    }
    let resolveStatus!: (value: typeof status) => void
    const pendingStatus = new Promise<typeof status>((resolve) => {
      resolveStatus = resolve
    })
    h.manager.getStatus.mockReturnValue(pendingStatus)
    h.manager.getClient.mockResolvedValue({})
    h.manager.preferredServiceTier.mockResolvedValue('priority')
    h.manager.listModels.mockResolvedValue([
      {
        id: 'gpt-test',
        model: 'gpt-test',
        supportedReasoningEfforts: [
          { reasoningEffort: 'max', description: 'Maximum' },
          { reasoningEffort: 'ultra', description: 'Maximum with delegation' },
        ],
        serviceTiers: [],
      },
    ])
    const sender = { isDestroyed: () => false, send: vi.fn() }

    const first = handlers.get('chat:send')?.({ sender }, { conversationId: firstConversation.id, text: 'first' })
    const second = handlers.get('chat:send')?.({ sender }, { conversationId: secondConversation.id, text: 'second' })
    resolveStatus(status)

    await expect(Promise.all([first, second])).resolves.toEqual([{ ok: true }, { ok: true }])
    expect(h.deleteAll).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(h.runCodex).toHaveBeenCalledTimes(2))
    expect(h.runCodex.mock.calls.find(([args]) => args.conversationId === firstConversation.id)?.[0].serviceTier).toBe(
      'default'
    )
    expect(h.runCodex.mock.calls.find(([args]) => args.conversationId === secondConversation.id)?.[0].serviceTier).toBe(
      'priority'
    )
    expect(h.runCodex.mock.calls.find(([args]) => args.conversationId === firstConversation.id)?.[0]).toMatchObject({
      reasoningEffort: 'ultra',
      maestrlyUltra: false,
    })
    expect(h.runCodex.mock.calls.find(([args]) => args.conversationId === secondConversation.id)?.[0]).toMatchObject({
      reasoningEffort: 'ultra',
      maestrlyUltra: true,
    })
  })

  it('waits for active-run finally blocks before resolving stop', async () => {
    const handlers = register()
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    patchConvUiPrefs(conversation.id, {
      chat: { providerId: CODEX_SUBSCRIPTION_PROVIDER_ID, modelId: 'gpt-test' },
    })
    h.manager.getStatus.mockResolvedValue({
      state: 'ready',
      available: true,
      connected: true,
      authenticated: true,
      account: { type: 'chatgpt', email: 'wait@example.com', planType: 'pro' },
      requiresOpenaiAuth: true,
      runtime: null,
      error: null,
    })
    h.manager.getClient.mockResolvedValue({})
    h.manager.listModels.mockResolvedValue([
      {
        id: 'gpt-test',
        model: 'gpt-test',
        supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Medium' }],
        inputModalities: ['text', 'image'],
        serviceTiers: [],
      },
    ])
    let releaseRun!: () => void
    h.runCodex.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseRun = () => resolve({ planSubmitted: false, threadId: 'thread-wait' })
        })
    )

    const result = await handlers.get('chat:send')?.(
      { sender: { isDestroyed: () => false, send: vi.fn() } },
      { conversationId: conversation.id, text: 'aguarde' }
    )
    expect(result).toEqual({ ok: true })
    await vi.waitFor(() => expect(h.runCodex).toHaveBeenCalledTimes(1))

    let settled = false
    const stopped = stopChatAndWait(conversation.id, 1_000).then((value) => {
      settled = true
      return value
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    releaseRun()
    await expect(stopped).resolves.toBe(true)
  })

  it('revokes lifecycle before late thread creation', async () => {
    const handlers = register()
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    patchConvUiPrefs(conversation.id, {
      chat: { providerId: CODEX_SUBSCRIPTION_PROVIDER_ID, modelId: 'gpt-test' },
    })
    h.manager.getStatus.mockResolvedValue({
      state: 'ready',
      available: true,
      connected: true,
      authenticated: true,
      account: { type: 'chatgpt', email: 'late@example.com', planType: 'pro' },
      requiresOpenaiAuth: true,
      runtime: null,
      error: null,
    })
    h.manager.getClient.mockResolvedValue({})
    h.manager.listModels.mockResolvedValue([
      {
        id: 'gpt-test',
        model: 'gpt-test',
        displayName: 'gpt-test',
        description: '',
        hidden: false,
        supportedReasoningEfforts: [],
        defaultReasoningEffort: '',
        inputModalities: ['text'],
        supportsPersonality: false,
        serviceTiers: [],
        defaultServiceTier: null,
        legacySpeedTiers: [],
        contextWindow: null,
        isDefault: true,
      },
    ])
    let releaseRun!: () => void
    let codexArgs!: { onThreadReady: (threadId: string) => boolean }
    h.runCodex.mockImplementationOnce(
      (args) =>
        new Promise((resolve) => {
          codexArgs = args
          releaseRun = () => resolve({ planSubmitted: false, threadId: 'thread-late' })
        })
    )

    await expect(
      handlers.get('chat:send')?.(
        { sender: { isDestroyed: () => false, send: vi.fn() } },
        { conversationId: conversation.id, text: 'aguarde' }
      )
    ).resolves.toEqual({ ok: true })
    await vi.waitFor(() => expect(h.runCodex).toHaveBeenCalledTimes(1))

    const stopping = stopChat(conversation.id)
    await Promise.resolve()
    expect(codexArgs.onThreadReady('thread-late-after-stop')).toBe(false)
    releaseRun()
    await stopping
  })

  it('returns idempotent disposal promises and awaits manager closure', async () => {
    let release!: () => void
    h.manager.dispose.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )

    const first = disposeChat()
    const second = disposeChat()
    expect(second).toBe(first)
    await vi.waitFor(() => expect(h.manager.dispose).toHaveBeenCalledTimes(1))

    let settled = false
    void first.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    release()
    await expect(first).resolves.toBeUndefined()
  })
})
