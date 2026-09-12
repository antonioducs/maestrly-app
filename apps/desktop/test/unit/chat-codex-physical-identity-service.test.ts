import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/main/chat/virtual-subagents', () => ({
  listEffectiveAgents: vi.fn(async () => []),
}))

const h = vi.hoisted(() => {
  let accountUpdated: (() => void) | null = null
  const manager = {
    getStatus: vi.fn(async () => ({
      state: 'ready',
      available: true,
      connected: true,
      authenticated: true,
      account: { type: 'chatgpt', email: 'default@example.com', planType: 'pro' },
      requiresOpenaiAuth: true,
      runtime: null,
      error: null,
    })),
    getStatusSnapshot: vi.fn(() => null),
    startLogin: vi.fn(async () => ({
      loginId: 'login-1',
      authUrl: 'https://auth.test',
      state: 'pending',
      completion: null,
    })),
    waitForLogin: vi.fn(() => new Promise<never>(() => {})),
    logout: vi.fn(async () => undefined),
    resetLocalData: vi.fn(async () => undefined),
    dispose: vi.fn(async () => undefined),
    listModels: vi.fn(async () => [
      {
        id: 'gpt-test',
        model: 'gpt-test',
        supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Medium' }],
        inputModalities: ['text', 'image'],
        serviceTiers: [],
      },
    ]),
    preferredServiceTier: vi.fn(async () => null),
    observeModelContextWindow: vi.fn(),
    getClient: vi.fn(async () => ({})),
    onAccountUpdated: vi.fn((listener: () => void) => {
      accountUpdated = listener
      return () => {
        if (accountUpdated === listener) accountUpdated = null
      }
    }),
  }
  return {
    manager,
    deleteOne: vi.fn(async () => ({
      conversationId: '',
      threadId: null as string | null,
      remoteDeleted: false,
    })),
    deleteAll: vi.fn(async () => []),
    runCodex: vi.fn(async (_args: any) => ({ planSubmitted: false, threadId: 'thread-test' })),
    runChat: vi.fn(async (_args: any) => ({ planSubmitted: false })),
    retryCleanup: vi.fn(async () => []),
    clearAllBindings: vi.fn(() => 0),
    getBinding: vi.fn(() => null),
    resolveCodexRuntimeTarget: vi.fn(),
    resetCodexRateLimitBinding: vi.fn(),
    summarizeCodex: vi.fn(async (_args: any) => ({ text: 'summary' })),
    emitAccountUpdated: () => accountUpdated?.(),
  }
})

vi.mock('../../src/main/chat/runner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/chat/runner')>()
  return { ...actual, runChat: (args: unknown) => h.runChat(args) }
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

vi.mock('../../src/main/chat/codex-subscription/manager', () => ({
  getCodexSubscriptionManager: () => h.manager,
  listCodexSubscriptionManagers: () => [h.manager],
}))

vi.mock('../../src/main/chat/subscription-failover', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/chat/subscription-failover')>()
  return {
    ...actual,
    resolveCodexRuntimeTarget: (...args: unknown[]) => h.resolveCodexRuntimeTarget(...args),
    resetCodexRateLimitBinding: (...args: unknown[]) => h.resetCodexRateLimitBinding(...args),
  }
})

vi.mock('../../src/main/chat/portable-summarizer', () => ({
  summarizeWithCodexRuntime: (args: unknown) => h.summarizeCodex(args),
  summarizeWithGitHubCopilotRuntime: vi.fn(),
}))

vi.mock('../../src/main/chat/diag-log', () => ({ chatDiag: vi.fn() }))

import type { ChatIpcDeps } from '../../src/main/chat/service'
import { disposeChat, registerChatIpc } from '../../src/main/chat/service'
import {
  addSubscriptionAccount,
  CODEX_SUBSCRIPTION_PROVIDER_ID,
  getSubscriptionAccount,
  subscriptionProviderIdFor,
} from '../../src/main/chat/catalog'
import {
  getSubscriptionFailoverRouter,
  listFailoverRoutes,
  resetSubscriptionFailoverRouterForTests,
  runCodexEphemeralWithFailover,
  setFailoverRoute,
} from '../../src/main/chat/subscription-failover'
import { closeDb, freshDb } from '../helpers/db'
import { makeConversation, makeWorkspace } from '../helpers/factories'
import { patchConvUiPrefs } from '../../src/main/store'
import { clearApiKey, setApiKey } from '../../src/main/chat/credentials'
import { addProvider } from '../../src/main/chat/catalog'
import { upsertChatMessage } from '../../src/main/chat/chat-store'

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

function defaultTarget(overrides: Record<string, unknown> = {}) {
  return {
    ok: true as const,
    target: {
      providerId: CODEX_SUBSCRIPTION_PROVIDER_ID,
      accountId: null,
      manager: h.manager,
      client: {},
      model: {
        id: 'gpt-test',
        model: 'gpt-test',
        supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Medium' }],
        inputModalities: ['text', 'image'],
      },
      runtimeModelId: 'gpt-test',
      serviceTier: 'default',
      dropImages: false,
      ...overrides,
    },
  }
}

describe('Codex logical vs physical provider identity', () => {
  beforeEach(async () => {
    freshDb()
    h.deleteOne.mockReset()
    h.deleteOne.mockResolvedValue({ conversationId: '', threadId: null, remoteDeleted: false })
    h.deleteAll.mockClear()
    h.runCodex.mockReset()
    h.runCodex.mockImplementation(async () => ({ planSubmitted: false, threadId: 'thread-test' }))
    h.runChat.mockReset()
    h.runChat.mockImplementation(async () => ({ planSubmitted: false }))
    h.summarizeCodex.mockReset()
    h.summarizeCodex.mockImplementation(async () => ({ text: 'summary' }))
    h.manager.getStatus.mockClear()
    h.manager.logout.mockClear()
    h.manager.resetLocalData.mockClear()
    h.resetCodexRateLimitBinding.mockClear()
    h.resolveCodexRuntimeTarget.mockReset()
    h.resolveCodexRuntimeTarget.mockImplementation(async () => defaultTarget())
    h.manager.listModels.mockReset()
    h.manager.listModels.mockResolvedValue([
      {
        id: 'gpt-test',
        model: 'gpt-test',
        supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Medium' }],
        inputModalities: ['text', 'image'],
        serviceTiers: [],
      },
    ])
    h.getBinding.mockReset()
    h.getBinding.mockReturnValue(null)
    resetSubscriptionFailoverRouterForTests()
    await disposeChat()
  })

  afterEach(async () => {
    vi.useRealTimers()
    await disposeChat()
    resetSubscriptionFailoverRouterForTests()
    closeDb()
  })

  it('preserves logical selection when physical slots differ', async () => {
    const handlers = register()
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    const slot = addSubscriptionAccount('codex-subscription', 'Fallback')
    const slotProviderId = subscriptionProviderIdFor('codex-subscription', slot.id)
    patchConvUiPrefs(conversation.id, {
      chat: { providerId: CODEX_SUBSCRIPTION_PROVIDER_ID, modelId: 'gpt-test' },
    })
    h.resolveCodexRuntimeTarget.mockResolvedValue(defaultTarget({ providerId: slotProviderId, accountId: slot.id }))

    const sender = { isDestroyed: () => false, send: vi.fn() }
    await expect(
      handlers.get('chat:send')?.({ sender }, { conversationId: conversation.id, text: 'hello' })
    ).resolves.toEqual({ ok: true })
    await vi.waitFor(() => expect(h.runCodex).toHaveBeenCalledTimes(1))

    const args = h.runCodex.mock.calls[0][0]
    expect(args.selection).toEqual({
      providerId: CODEX_SUBSCRIPTION_PROVIDER_ID,
      modelId: 'gpt-test',
    })
    expect(args.effectiveProviderId).toBe(slotProviderId)
    expect(args.initialAccountId).toBe(slot.id)
  })

  it('preflights against smaller physical fallback windows', async () => {
    const handlers = register()
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    const slot = addSubscriptionAccount('codex-subscription', 'Fallback')
    const slotProviderId = subscriptionProviderIdFor('codex-subscription', slot.id)
    setFailoverRoute({
      primaryProviderId: CODEX_SUBSCRIPTION_PROVIDER_ID,
      enabled: true,
      fallbackProviderIds: [slotProviderId],
    })
    getSubscriptionFailoverRouter().markExhausted(CODEX_SUBSCRIPTION_PROVIDER_ID, {
      reason: 'account A quota',
      source: 'structured-error',
      resetsAt: Date.now() + 60_000,
    })
    patchConvUiPrefs(conversation.id, {
      chat: { providerId: CODEX_SUBSCRIPTION_PROVIDER_ID, modelId: 'gpt-test' },
    })
    upsertChatMessage({
      id: 'logical-a-history',
      conversationId: conversation.id,
      role: 'user',
      parts: [{ type: 'text', id: 'logical-a-history-text', text: 'x'.repeat(220_000) }],
      createdAt: 1,
    })
    h.resolveCodexRuntimeTarget.mockResolvedValue(
      defaultTarget({ providerId: slotProviderId, accountId: slot.id, contextWindow: 64_000 })
    )

    await expect(
      handlers.get('chat:send')?.(
        { sender: { isDestroyed: () => false, send: vi.fn() } },
        { conversationId: conversation.id, text: 'new turn' }
      )
    ).resolves.toEqual({ ok: true })
    await vi.waitFor(() => expect(h.runCodex).toHaveBeenCalledOnce())

    expect(h.summarizeCodex).toHaveBeenCalled()
    expect(h.resolveCodexRuntimeTarget.mock.calls[0][0]).toMatchObject({ admit: false })
    expect(h.runCodex.mock.calls[0][0]).toMatchObject({
      selection: { providerId: CODEX_SUBSCRIPTION_PROVIDER_ID, modelId: 'gpt-test' },
      effectiveProviderId: slotProviderId,
      contextWindow: 64_000,
    })
  })

  it('avoids premature bootstrap compaction before requesting 1M context', async () => {
    const handlers = register()
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    patchConvUiPrefs(conversation.id, {
      chat: { providerId: CODEX_SUBSCRIPTION_PROVIDER_ID, modelId: 'gpt-test' },
    })
    // estimateTextTokens uses UTF-8 bytes / 3, so this models a transcript near 400k tokens.
    upsertChatMessage({
      id: 'long-context-history',
      conversationId: conversation.id,
      role: 'user',
      parts: [{ type: 'text', id: 'long-context-history-text', text: 'x'.repeat(1_200_000) }],
      createdAt: 1,
    })
    h.resolveCodexRuntimeTarget.mockResolvedValue(
      defaultTarget({
        contextWindow: 258_400,
        requestedContextWindow: 1_000_000,
        effectiveContextWindow: 950_000,
      })
    )

    await expect(
      handlers.get('chat:send')?.(
        { sender: { isDestroyed: () => false, send: vi.fn() } },
        { conversationId: conversation.id, text: 'new turn' }
      )
    ).resolves.toEqual({ ok: true })
    await vi.waitFor(() => expect(h.runCodex).toHaveBeenCalledOnce())

    expect(h.summarizeCodex).not.toHaveBeenCalled()
    expect(h.resolveCodexRuntimeTarget.mock.calls[0][0]).toMatchObject({
      admit: false,
      configureContextWindow: true,
    })
    expect(h.runCodex.mock.calls[0][0]).toMatchObject({
      contextWindow: 950_000,
      requestedContextWindow: 1_000_000,
    })
  })

  it('repreflights reduced estimates for manual 300k limits', async () => {
    const handlers = register()
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    patchConvUiPrefs(conversation.id, {
      chat: { providerId: CODEX_SUBSCRIPTION_PROVIDER_ID, modelId: 'gpt-test' },
    })
    upsertChatMessage({
      id: 'manual-context-history',
      conversationId: conversation.id,
      role: 'user',
      parts: [{ type: 'text', id: 'manual-context-history-text', text: 'x'.repeat(1_200_000) }],
      createdAt: 1,
    })
    h.resolveCodexRuntimeTarget.mockResolvedValue(
      defaultTarget({
        contextWindow: 258_400,
        requestedContextWindow: 300_000,
        effectiveContextWindow: 285_000,
      })
    )

    await expect(
      handlers.get('chat:send')?.(
        { sender: { isDestroyed: () => false, send: vi.fn() } },
        { conversationId: conversation.id, text: 'new turn' }
      )
    ).resolves.toEqual({ ok: true })
    await vi.waitFor(() => expect(h.runCodex).toHaveBeenCalledOnce())

    expect(h.summarizeCodex).toHaveBeenCalled()
    expect(h.runCodex.mock.calls[0][0]).toMatchObject({
      contextWindow: 285_000,
      requestedContextWindow: 300_000,
    })
  })

  it('preserves measured occupancy without projecting stale Codex windows', async () => {
    const handlers = register()
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    patchConvUiPrefs(conversation.id, {
      chat: { providerId: CODEX_SUBSCRIPTION_PROVIDER_ID, modelId: 'gpt-test' },
    })
    h.manager.listModels.mockResolvedValue([
      {
        id: 'gpt-test',
        model: 'gpt-test',
        contextWindow: 258_400,
        nominalContextWindow: 1_000_000,
        maxContextWindow: 1_000_000,
        effectiveContextWindowPercent: 95,
        supportedReasoningEfforts: [],
        inputModalities: ['text'],
        serviceTiers: [],
        defaultServiceTier: null,
        legacySpeedTiers: [],
      },
    ] as any)
    upsertChatMessage({
      id: 'codex-user',
      conversationId: conversation.id,
      role: 'user',
      parts: [{ type: 'text', id: 'codex-user-text', text: 'history' }],
      createdAt: 1,
    })
    upsertChatMessage({
      id: 'codex-assistant',
      conversationId: conversation.id,
      role: 'assistant',
      parts: [{ type: 'text', id: 'codex-answer', text: 'done' }],
      model: { providerId: CODEX_SUBSCRIPTION_PROVIDER_ID, modelId: 'gpt-test' },
      usage: {
        usageVersion: 2,
        input: 58_000,
        output: 2_000,
        contextInput: 58_000,
        contextOutput: 2_000,
        modelContextWindow: 950_000,
      },
      createdAt: 2,
    })
    h.getBinding.mockReturnValue({
      conversationId: conversation.id,
      threadId: 'thread-test',
      modelId: 'gpt-test',
      toolSignature: 'tools',
      instructionHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      lastMessageId: 'codex-assistant',
      usage: { inputTokens: 58_000, cachedInputTokens: 0, outputTokens: 2_000, reasoningOutputTokens: 0 },
      accountId: null,
      updatedAt: 2,
    } as any)

    const setLimit = handlers.get('chat:context-limit:set')
    expect(setLimit?.(undefined, CODEX_SUBSCRIPTION_PROVIDER_ID, 'gpt-test', 1_000_000)).toEqual({ ok: true })
    const before = (await handlers.get('chat:history:stats')?.({}, conversation.id)) as any
    expect(before.contextProjection).toHaveProperty('modelContextWindow', 950_000)

    expect(setLimit?.(undefined, CODEX_SUBSCRIPTION_PROVIDER_ID, 'gpt-test', 300_000)).toEqual({ ok: true })

    const stats = (await handlers.get('chat:history:stats')?.({}, conversation.id)) as any
    expect(stats.contextProjection).toMatchObject({
      usedTokens: 60_000,
      source: 'runtime-usage',
      quality: 'measured',
    })
    expect(stats.contextProjection).not.toHaveProperty('modelContextWindow')
  })

  it('does not increase host windows after smaller-target validation', async () => {
    const handlers = register()
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    patchConvUiPrefs(conversation.id, {
      chat: { providerId: CODEX_SUBSCRIPTION_PROVIDER_ID, modelId: 'gpt-test' },
    })
    h.resolveCodexRuntimeTarget.mockImplementation(async (args: { admit?: boolean }) =>
      args.admit === false
        ? defaultTarget({ requestedContextWindow: 300_000, effectiveContextWindow: 285_000 })
        : defaultTarget({ requestedContextWindow: 1_000_000, effectiveContextWindow: 950_000 })
    )

    await expect(
      handlers.get('chat:send')?.(
        { sender: { isDestroyed: () => false, send: vi.fn() } },
        { conversationId: conversation.id, text: 'new turn' }
      )
    ).resolves.toEqual({ ok: true })
    await vi.waitFor(() => expect(h.runCodex).toHaveBeenCalledOnce())

    // The physical runtime may receive its own maximum, but this admitted turn remains bounded by the smaller
    // target used during the TOCTOU-safe preflight. A fresh following turn may resolve 1M again.
    expect(h.runCodex.mock.calls[0][0]).toMatchObject({
      requestedContextWindow: 1_000_000,
      contextWindow: 285_000,
    })
  })

  it('revalidates limits and readmits returned account leases', async () => {
    const handlers = register()
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    const fallback = addSubscriptionAccount('codex-subscription', 'Fallback')
    const fallbackProviderId = subscriptionProviderIdFor('codex-subscription', fallback.id)
    setFailoverRoute({
      primaryProviderId: CODEX_SUBSCRIPTION_PROVIDER_ID,
      enabled: true,
      fallbackProviderIds: [fallbackProviderId],
    })
    patchConvUiPrefs(conversation.id, {
      chat: { providerId: CODEX_SUBSCRIPTION_PROVIDER_ID, modelId: 'gpt-test' },
    })
    upsertChatMessage({
      id: 'race-history',
      conversationId: conversation.id,
      role: 'user',
      parts: [{ type: 'text', id: 'race-history-text', text: 'x'.repeat(220_000) }],
      createdAt: 1,
    })

    const router = getSubscriptionFailoverRouter()
    const now = Date.now()

    let resolutionCount = 0
    let competingLease: { leaseId: string; generation: number } | undefined
    let discardedLease: { leaseId: string; generation: number } | undefined
    h.resolveCodexRuntimeTarget.mockImplementation(async (args: any) => {
      resolutionCount += 1
      if (args.admit === false) {
        return defaultTarget({
          providerId: CODEX_SUBSCRIPTION_PROVIDER_ID,
          contextWindow: 256_000,
        })
      }
      if (!discardedLease) {
        router.markExhausted(CODEX_SUBSCRIPTION_PROVIDER_ID, {
          reason: 'account A quota',
          source: 'probe',
          resetsAt: now - 1,
          now: now - 2,
        })
        const competingAdmission = router.tryAdmit(CODEX_SUBSCRIPTION_PROVIDER_ID, now)
        if (!competingAdmission.ok || !competingAdmission.lease) throw new Error('expected competing account A lease')
        competingLease = competingAdmission.lease
        router.markExhausted(fallbackProviderId, {
          reason: 'account B quota',
          source: 'probe',
          resetsAt: now - 1,
          now: now - 2,
        })
        const admittedFallback = router.tryAdmit(fallbackProviderId, now)
        if (!admittedFallback.ok || !admittedFallback.lease) throw new Error('expected account B lease')
        discardedLease = admittedFallback.lease
        return defaultTarget({
          providerId: fallbackProviderId,
          accountId: fallback.id,
          contextWindow: 64_000,
          availabilityLease: discardedLease,
        })
      }
      return defaultTarget({
        providerId: fallbackProviderId,
        accountId: fallback.id,
        contextWindow: 64_000,
      })
    })

    const events: string[] = []
    h.summarizeCodex.mockImplementation(async () => {
      events.push('preflight')
      return { text: 'summary' }
    })
    h.runCodex.mockImplementationOnce(async () => {
      events.push('runner')
      return { planSubmitted: false, threadId: 'thread-race' }
    })
    const settleOther = vi.spyOn(router, 'confirmAttemptOther')

    await expect(
      handlers.get('chat:send')?.(
        { sender: { isDestroyed: () => false, send: vi.fn() } },
        { conversationId: conversation.id, text: 'new turn' }
      )
    ).resolves.toEqual({ ok: true })
    await vi.waitFor(() => expect(h.runCodex).toHaveBeenCalledOnce())

    expect(resolutionCount).toBe(4)
    expect(h.resolveCodexRuntimeTarget.mock.calls.map(([args]) => args.admit)).toEqual([
      false,
      false,
      undefined,
      undefined,
    ])
    expect(events.indexOf('preflight')).toBeGreaterThanOrEqual(0)
    expect(events.indexOf('preflight')).toBeLessThan(events.indexOf('runner'))
    expect(settleOther).toHaveBeenCalledOnce()
    expect(settleOther).toHaveBeenCalledWith(fallbackProviderId, discardedLease)
    expect(h.summarizeCodex).toHaveBeenCalled()
    expect(router.getHealth(fallbackProviderId).state).toBe('available')
    expect(h.runCodex.mock.calls[0][0]).toMatchObject({
      effectiveProviderId: fallbackProviderId,
      contextWindow: 64_000,
    })

    if (!competingLease) throw new Error('expected competing account A lease')
    router.confirmAttemptOther(CODEX_SUBSCRIPTION_PROVIDER_ID, competingLease)
    settleOther.mockRestore()
  })

  it('preserves account routes after teardown failure until retry', async () => {
    const handlers = register()
    const account = addSubscriptionAccount('codex-subscription', 'Fallback')
    const providerId = subscriptionProviderIdFor('codex-subscription', account.id)
    const route = setFailoverRoute({
      primaryProviderId: providerId,
      enabled: true,
      fallbackProviderIds: [CODEX_SUBSCRIPTION_PROVIDER_ID],
    })
    h.deleteAll.mockRejectedValueOnce(new Error('thread cleanup failed'))

    await expect(handlers.get('chat:subscription-account:remove')?.({}, account.id)).resolves.toEqual({
      ok: false,
      error: 'thread cleanup failed',
    })
    expect(getSubscriptionAccount(account.id)).toEqual(account)
    expect(listFailoverRoutes()).toEqual([route])

    h.deleteAll.mockResolvedValue([])
    await expect(handlers.get('chat:subscription-account:remove')?.({}, account.id)).resolves.toEqual({ ok: true })
    expect(getSubscriptionAccount(account.id)).toBeUndefined()
    expect(listFailoverRoutes()).toEqual([])
  })

  it('does not abort physical B runs on logical A logout', async () => {
    const handlers = register()
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    const slot = addSubscriptionAccount('codex-subscription', 'Fallback')
    const slotProviderId = subscriptionProviderIdFor('codex-subscription', slot.id)
    patchConvUiPrefs(conversation.id, {
      chat: { providerId: CODEX_SUBSCRIPTION_PROVIDER_ID, modelId: 'gpt-test' },
    })
    h.resolveCodexRuntimeTarget.mockResolvedValue(defaultTarget({ providerId: slotProviderId, accountId: slot.id }))

    let releaseTurn!: () => void
    let turnSignal: AbortSignal | undefined
    h.runCodex.mockImplementationOnce(async (args: any) => {
      turnSignal = args.signal
      args.onThreadReady?.('thread-physical-b', {
        providerId: slotProviderId,
        accountId: slot.id,
      })
      await new Promise<void>((resolve) => {
        releaseTurn = resolve
        args.signal.addEventListener('abort', () => resolve(), { once: true })
      })
      return { planSubmitted: false, threadId: 'thread-physical-b' }
    })

    const sender = { isDestroyed: () => false, send: vi.fn() }
    const sendPromise = handlers.get('chat:send')?.({ sender }, { conversationId: conversation.id, text: 'turn longo' })
    await vi.waitFor(() => expect(h.runCodex).toHaveBeenCalledTimes(1))

    await expect(handlers.get('chat:codex-subscription:logout')?.({})).resolves.toMatchObject({ ok: true })
    expect(turnSignal?.aborted).toBe(false)

    releaseTurn()
    await expect(sendPromise).resolves.toEqual({ ok: true })
  })

  it('aborts physical B runs with active default-account subagents on default logout', async () => {
    const handlers = register()
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    const slot = addSubscriptionAccount('codex-subscription', 'Fallback')
    const slotProviderId = subscriptionProviderIdFor('codex-subscription', slot.id)
    patchConvUiPrefs(conversation.id, {
      chat: { providerId: CODEX_SUBSCRIPTION_PROVIDER_ID, modelId: 'gpt-test' },
    })
    h.resolveCodexRuntimeTarget.mockResolvedValue(defaultTarget({ providerId: slotProviderId, accountId: slot.id }))

    let turnSignal: AbortSignal | undefined
    h.runCodex.mockImplementationOnce(async (args: any) => {
      turnSignal = args.signal
      args.onThreadReady?.('thread-physical-b-with-default-subagent', {
        providerId: slotProviderId,
        accountId: slot.id,
      })
      args.acquirePhysicalProvider?.(CODEX_SUBSCRIPTION_PROVIDER_ID)
      await new Promise<void>((resolve) => {
        args.signal.addEventListener(
          'abort',
          () => {
            args.releasePhysicalProvider?.(CODEX_SUBSCRIPTION_PROVIDER_ID)
            resolve()
          },
          { once: true }
        )
      })
      return { planSubmitted: false, threadId: 'thread-physical-b-with-default-subagent' }
    })

    const sender = { isDestroyed: () => false, send: vi.fn() }
    const sendPromise = handlers.get('chat:send')?.(
      { sender },
      { conversationId: conversation.id, text: 'turn with subagent' }
    )
    await vi.waitFor(() => expect(h.runCodex).toHaveBeenCalledTimes(1))

    await expect(handlers.get('chat:codex-subscription:logout')?.({})).resolves.toMatchObject({ ok: true })
    await vi.waitFor(() => expect(turnSignal?.aborted).toBe(true))
    await expect(sendPromise).resolves.toEqual({ ok: true })
  })

  it('aborts logical B runs using physical A on A logout', async () => {
    const handlers = register()
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    const slot = addSubscriptionAccount('codex-subscription', 'Primary slot')
    const slotProviderId = subscriptionProviderIdFor('codex-subscription', slot.id)
    patchConvUiPrefs(conversation.id, {
      chat: { providerId: slotProviderId, modelId: 'gpt-test' },
    })
    // Logical selection targets B while physical execution uses default A.
    h.resolveCodexRuntimeTarget.mockResolvedValue(
      defaultTarget({ providerId: CODEX_SUBSCRIPTION_PROVIDER_ID, accountId: null })
    )

    let turnSignal: AbortSignal | undefined
    h.runCodex.mockImplementationOnce(async (args: any) => {
      turnSignal = args.signal
      args.onThreadReady?.('thread-physical-a', {
        providerId: CODEX_SUBSCRIPTION_PROVIDER_ID,
        accountId: null,
      })
      await new Promise<void>((resolve) => {
        args.signal.addEventListener('abort', () => resolve(), { once: true })
      })
      return { planSubmitted: false, threadId: 'thread-physical-a' }
    })

    const sender = { isDestroyed: () => false, send: vi.fn() }
    const sendPromise = handlers.get('chat:send')?.({ sender }, { conversationId: conversation.id, text: 'turn longo' })
    await vi.waitFor(() => expect(h.runCodex).toHaveBeenCalledTimes(1))

    await expect(handlers.get('chat:codex-subscription:logout')?.({})).resolves.toMatchObject({ ok: true })
    await vi.waitFor(() => expect(turnSignal?.aborted).toBe(true))
    await expect(sendPromise).resolves.toEqual({ ok: true })
  })

  it('clears only default-provider health after default logout teardown', async () => {
    const handlers = register()
    const slot = addSubscriptionAccount('codex-subscription', 'Fallback')
    const slotProviderId = subscriptionProviderIdFor('codex-subscription', slot.id)
    const router = getSubscriptionFailoverRouter()
    router.markExhausted(CODEX_SUBSCRIPTION_PROVIDER_ID, {
      reason: 'default quota',
      source: 'structured-error',
      resetsAt: Date.now() + 60_000,
    })
    router.markExhausted(slotProviderId, {
      reason: 'slot quota',
      source: 'structured-error',
      resetsAt: Date.now() + 60_000,
    })
    const resetProvider = vi.spyOn(router, 'resetProvider')

    await expect(handlers.get('chat:codex-subscription:logout')?.({})).resolves.toMatchObject({ ok: true })

    expect(router.getHealth(CODEX_SUBSCRIPTION_PROVIDER_ID).state).toBe('unknown')
    expect(router.getHealth(slotProviderId).state).toBe('exhausted')
    expect(resetProvider).toHaveBeenCalledWith(CODEX_SUBSCRIPTION_PROVIDER_ID)
    expect(h.deleteAll.mock.invocationCallOrder[0]).toBeLessThan(resetProvider.mock.invocationCallOrder[0])
    expect(h.resetCodexRateLimitBinding).toHaveBeenCalledWith(h.manager, CODEX_SUBSCRIPTION_PROVIDER_ID)
    expect(h.deleteAll.mock.invocationCallOrder[0]).toBeLessThan(
      h.resetCodexRateLimitBinding.mock.invocationCallOrder[0]
    )
    expect(h.resetCodexRateLimitBinding.mock.invocationCallOrder[0]).toBeLessThan(
      resetProvider.mock.invocationCallOrder[0]
    )
  })

  it('clears only selected-slot health after teardown', async () => {
    const handlers = register()
    const slot = addSubscriptionAccount('codex-subscription', 'Fallback')
    const slotProviderId = subscriptionProviderIdFor('codex-subscription', slot.id)
    const router = getSubscriptionFailoverRouter()
    router.markExhausted(CODEX_SUBSCRIPTION_PROVIDER_ID, {
      reason: 'default quota',
      source: 'structured-error',
      resetsAt: Date.now() + 60_000,
    })
    router.markExhausted(slotProviderId, {
      reason: 'slot quota',
      source: 'structured-error',
      resetsAt: Date.now() + 60_000,
    })
    const resetProvider = vi.spyOn(router, 'resetProvider')

    await expect(handlers.get('chat:codex-subscription:logout')?.({}, { accountId: slot.id })).resolves.toMatchObject({
      ok: true,
    })

    expect(router.getHealth(CODEX_SUBSCRIPTION_PROVIDER_ID).state).toBe('exhausted')
    expect(router.getHealth(slotProviderId).state).toBe('unknown')
    expect(resetProvider).toHaveBeenCalledWith(slotProviderId)
    expect(h.deleteAll.mock.invocationCallOrder[0]).toBeLessThan(resetProvider.mock.invocationCallOrder[0])
    expect(h.resetCodexRateLimitBinding).toHaveBeenCalledWith(h.manager, slotProviderId)
    expect(h.deleteAll.mock.invocationCallOrder[0]).toBeLessThan(
      h.resetCodexRateLimitBinding.mock.invocationCallOrder[0]
    )
    expect(h.resetCodexRateLimitBinding.mock.invocationCallOrder[0]).toBeLessThan(
      resetProvider.mock.invocationCallOrder[0]
    )
  })

  it('aborts active Codex helpers in BYOK conversations on logout', async () => {
    const handlers = register()
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    const byok = addProvider({ name: 'BYOK', baseURL: 'https://byok.test/v1', kind: 'openai' })
    setApiKey(byok.id, 'byok-key')
    patchConvUiPrefs(conversation.id, { chat: { providerId: byok.id, modelId: 'byok-model' } })

    let helperSignal: AbortSignal | undefined
    h.runChat.mockImplementationOnce(async (args: any) => {
      helperSignal = args.signal
      await runCodexEphemeralWithFailover({
        logicalProviderId: CODEX_SUBSCRIPTION_PROVIDER_ID,
        modelId: 'gpt-test',
        conversationId: conversation.id,
        signal: args.signal,
        operation: async () =>
          new Promise<never>((_resolve, reject) => {
            const onAbort = () => reject(args.signal.reason ?? new Error('helper aborted'))
            if (args.signal.aborted) onAbort()
            else args.signal.addEventListener('abort', onAbort, { once: true })
          }),
      })
      return { planSubmitted: false }
    })

    const sender = { isDestroyed: () => false, send: vi.fn() }
    const sendPromise = handlers.get('chat:send')?.(
      { sender },
      { conversationId: conversation.id, text: 'BYOK root with Codex helper' }
    )
    await vi.waitFor(() => expect(h.runChat).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(helperSignal).toBeDefined())

    await expect(handlers.get('chat:codex-subscription:logout')?.({})).resolves.toMatchObject({ ok: true })
    expect(helperSignal?.aborted).toBe(true)
    await expect(sendPromise).resolves.toEqual({ ok: true })
    clearApiKey(byok.id)
  })

  it('preserves BYOK conversations without physical Codex usage', async () => {
    const handlers = register()
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    const byok = addProvider({ name: 'BYOK only', baseURL: 'https://byok-only.test/v1', kind: 'openai' })
    setApiKey(byok.id, 'byok-key')
    patchConvUiPrefs(conversation.id, { chat: { providerId: byok.id, modelId: 'byok-model' } })

    let rootSignal: AbortSignal | undefined
    let releaseRoot!: () => void
    h.runChat.mockImplementationOnce(async (args: any) => {
      rootSignal = args.signal
      await new Promise<void>((resolve) => {
        releaseRoot = resolve
      })
      return { planSubmitted: false }
    })

    const sender = { isDestroyed: () => false, send: vi.fn() }
    const sendPromise = handlers.get('chat:send')?.({ sender }, { conversationId: conversation.id, text: 'BYOK only' })
    await vi.waitFor(() => expect(rootSignal).toBeDefined())

    await expect(handlers.get('chat:codex-subscription:logout')?.({})).resolves.toMatchObject({ ok: true })
    expect(rootSignal?.aborted).toBe(false)
    releaseRoot()
    await expect(sendPromise).resolves.toEqual({ ok: true })
    clearApiKey(byok.id)
  })

  it('settles half-open leases when epochs change after resolution', async () => {
    const handlers = register()
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    patchConvUiPrefs(conversation.id, {
      chat: { providerId: CODEX_SUBSCRIPTION_PROVIDER_ID, modelId: 'gpt-test' },
    })

    const router = getSubscriptionFailoverRouter()
    const now = Date.now()
    router.markExhausted(CODEX_SUBSCRIPTION_PROVIDER_ID, {
      reason: 'quota',
      source: 'probe',
      resetsAt: now - 1,
      now: now - 2,
    })
    const admitted = router.tryAdmit(CODEX_SUBSCRIPTION_PROVIDER_ID, now)
    if (!admitted.ok || !admitted.lease) throw new Error('expected half-open lease')

    const settleOther = vi.spyOn(router, 'confirmAttemptOther')
    h.resolveCodexRuntimeTarget.mockImplementationOnce(async () => {
      h.emitAccountUpdated()
      return defaultTarget({ availabilityLease: admitted.lease })
    })

    const sender = { isDestroyed: () => false, send: vi.fn() }
    await expect(
      handlers.get('chat:send')?.({ sender }, { conversationId: conversation.id, text: 'concurrent epoch' })
    ).resolves.toEqual({ ok: false, error: 'busy' })

    expect(settleOther).toHaveBeenCalledTimes(1)
    expect(settleOther).toHaveBeenCalledWith(CODEX_SUBSCRIPTION_PROVIDER_ID, admitted.lease)
    expect(router.getHealth(CODEX_SUBSCRIPTION_PROVIDER_ID)).toEqual({
      providerId: CODEX_SUBSCRIPTION_PROVIDER_ID,
      state: 'unknown',
    })
    expect(router.isAdmissible(CODEX_SUBSCRIPTION_PROVIDER_ID)).toBe(true)
    expect(h.runCodex).not.toHaveBeenCalled()
    settleOther.mockRestore()
  })
})
