import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
  const flags = new Map<string, boolean>()
  const settings = new Map<string, string>()
  const apiKeyProviders = new Set<string>()
  const defaultProviders = [
    {
      id: 'builtin-codex-subscription',
      name: 'ChatGPT subscription',
      baseURL: 'codex-app-server://local',
      kind: 'codex-subscription',
    },
  ]
  const availableProviders = [...defaultProviders]
  const signedOutStatus = {
    state: 'ready',
    available: true,
    connected: true,
    authenticated: false,
    account: null,
    requiresOpenaiAuth: true,
    runtime: null,
    error: null,
  }
  const managerState: { snapshot: unknown; status: unknown } = {
    snapshot: null,
    status: signedOutStatus,
  }
  const getStatusSnapshot = vi.fn(() => managerState.snapshot)
  const getStatus = vi.fn(() => Promise.resolve(managerState.status))
  const listModels = vi.fn(async (): Promise<any[]> => [])
  const getModelMeta = vi.fn(async (_modelId?: string, _providerId?: string): Promise<any> => null)
  const manager = { isDisposed: false, getStatusSnapshot, getStatus, listModels }
  const send = vi.fn()
  const webContents = { isDestroyed: vi.fn(() => false), send }
  return {
    flags,
    settings,
    apiKeyProviders,
    defaultProviders,
    availableProviders,
    signedOutStatus,
    managerState,
    manager,
    getStatusSnapshot,
    getStatus,
    listModels,
    getModelMeta,
    send,
    webContents,
    getMainWebContents: vi.fn(() => webContents),
    listAvailableChatProviders: vi.fn(() => availableProviders),
    hasApiKey: vi.fn((providerId: string) => apiKeyProviders.has(providerId)),
    fetchModels: vi.fn((providerId: string) => Promise.resolve(providerId === 'byok-openai' ? ['gpt-4o'] : [])),
    getAppFlag: vi.fn((key: string, fallback: boolean) => flags.get(key) ?? fallback),
    setAppFlag: vi.fn((key: string, value: boolean) => void flags.set(key, value)),
    getAppSetting: vi.fn((key: string) => settings.get(key) ?? null),
    setAppSetting: vi.fn((key: string, value: string) => void settings.set(key, value)),
    deleteAllManagedCodexThreads: vi.fn(async () => {}),
    retryManagedCodexThreadCleanup: vi.fn(async () => {}),
  }
})

vi.mock('../../src/main/window-ipc', () => ({
  getMainWebContents: h.getMainWebContents,
}))

vi.mock('../../src/main/store', () => ({
  getAppFlag: h.getAppFlag,
  setAppFlag: h.setAppFlag,
  getAppSetting: h.getAppSetting,
  setAppSetting: h.setAppSetting,
}))

vi.mock('../../src/main/chat/catalog', () => ({
  PROVIDER_PRESETS: [],
  CODEX_SUBSCRIPTION_PROVIDER_ID: 'builtin_codex_subscription',
  listProviders: vi.fn(() => []),
  listAvailableChatProviders: h.listAvailableChatProviders,
  getProviderKind: vi.fn((provider?: { baseURL: string; kind?: string }) =>
    provider?.baseURL === 'https://api.openai.com/v1' ? 'openai-responses' : (provider?.kind ?? 'openai')
  ),
  isCodexSubscriptionProvider: vi.fn(
    (providerId: string) =>
      providerId.startsWith('builtin-codex-subscription') || providerId.startsWith('builtin_codex_subscription')
  ),
  isGitHubCopilotSubscriptionProvider: vi.fn(() => false),
  isClaudeSubscriptionProvider: vi.fn(() => false),
  isGrokSubscriptionProvider: vi.fn(() => false),
  isSubscriptionProvider: vi.fn(
    (providerId: string) => providerId.startsWith('builtin-') || providerId.startsWith('builtin_')
  ),
  isChatGptWebProvider: vi.fn(() => false),
  isChatGptWebEnabled: vi.fn(() => false),
  setChatGptWebEnabled: vi.fn(),
  isManagedProvider: vi.fn((providerId: string) => providerId.startsWith('builtin-')),
  CHATGPT_WEB_PROVIDER_ID: 'builtin_chatgpt_web',
  subscriptionAccountId: vi.fn(() => null),
  subscriptionProviderIdFor: vi.fn((_kind: string, accountId: string | null) => accountId ?? 'builtin'),
  getSubscriptionAccount: vi.fn(() => undefined),
  addSubscriptionAccount: vi.fn(),
  renameSubscriptionAccount: vi.fn(),
  removeSubscriptionAccount: vi.fn(),
}))

vi.mock('../../src/main/chat/codex-subscription', () => ({
  getCodexSubscriptionManager: vi.fn(() => h.manager),
  deleteAllManagedCodexThreads: h.deleteAllManagedCodexThreads,
  retryManagedCodexThreadCleanup: h.retryManagedCodexThreadCleanup,
}))

vi.mock('../../src/main/chat/github-copilot', () => ({
  getGitHubCopilotSubscriptionManager: vi.fn(() => ({
    isDisposed: false,
    getStatusSnapshot: vi.fn(() => null),
    getStatus: vi.fn(async () => ({
      state: 'ready',
      available: true,
      connected: false,
      authenticated: false,
      account: null,
      storageMode: 'memory',
      accountFingerprint: null,
      accountEpoch: 0,
      error: null,
    })),
    onAuthUpdated: vi.fn(() => () => {}),
  })),
  deleteAllManagedGitHubCopilotSessions: vi.fn(async () => {}),
  deleteGitHubCopilotSessionForConversation: vi.fn(async () => {}),
  retryManagedGitHubCopilotSessionCleanup: vi.fn(async () => {}),
}))

vi.mock('../../src/main/chat/credentials', () => ({
  apiKeyStorageMode: vi.fn(() => 'secure'),
  hasApiKey: h.hasApiKey,
}))

vi.mock('../../src/main/chat/models', () => ({
  fetchModels: h.fetchModels,
  fetchModelWindow: vi.fn(),
  invalidateModels: vi.fn(),
}))

vi.mock('../../src/main/chat/model-meta', () => ({
  getModelMeta: h.getModelMeta,
  catalogProviderForBaseURL: vi.fn(() => null),
  composeEffectiveMeta: vi.fn((exact, canonical) => exact ?? canonical),
  filterChatModels: vi.fn((models) => models),
  filterChatModelsSnapshot: vi.fn((models) => models),
}))

vi.mock('../../src/main/chat/mcp', () => ({
  listMcpServers: vi.fn(() => []),
}))

vi.mock('../../src/main/chat/runner', () => ({
  normalizeAiUsage: vi.fn(() => ({ input: 0, output: 0, totalInput: 0, cacheRead: 0, cacheCreate: 0 })),
  runChat: vi.fn(),
}))

import {
  listChatExecutionModels,
  listChatRunnerCapabilities,
  registerChatIpc,
  type ChatIpcDeps,
} from '../../src/main/chat/service'

type Handler = (event: never, ...args: unknown[]) => unknown

function register(): Map<string, Handler> {
  const handlers = new Map<string, Handler>()
  registerChatIpc({
    mhandle: (channel, fn) => void handlers.set(channel, fn as Handler),
    mon: vi.fn(),
    emitStatus: vi.fn(),
  } satisfies ChatIpcDeps)
  return handlers
}

describe('OpenAI harness kill switch', () => {
  beforeEach(() => {
    h.flags.clear()
    h.settings.clear()
    h.apiKeyProviders.clear()
    h.availableProviders.splice(0, h.availableProviders.length, ...h.defaultProviders)
    h.manager.isDisposed = false
    h.managerState.snapshot = null
    h.managerState.status = h.signedOutStatus
    h.getStatusSnapshot.mockClear()
    h.getStatus.mockReset()
    h.getStatus.mockImplementation(() => Promise.resolve(h.managerState.status))
    h.listModels.mockReset()
    h.listModels.mockResolvedValue([])
    h.getModelMeta.mockReset()
    h.getModelMeta.mockResolvedValue(null)
    h.listAvailableChatProviders.mockClear()
    h.hasApiKey.mockClear()
    h.fetchModels.mockClear()
    h.getMainWebContents.mockClear()
    h.getMainWebContents.mockReturnValue(h.webContents)
    h.webContents.isDestroyed.mockClear()
    h.webContents.isDestroyed.mockReturnValue(false)
    h.send.mockClear()
    h.getAppFlag.mockClear()
    h.setAppFlag.mockClear()
    h.setAppSetting.mockClear()
    h.getAppSetting.mockClear()
    h.deleteAllManagedCodexThreads.mockClear()
    h.retryManagedCodexThreadCleanup.mockClear()
  })

  it('defaults enabled when flags are absent', async () => {
    const config = (await register().get('chat:config')?.(undefined as never)) as {
      bashFiltersEnabled: boolean
      openAIHarnessEnabled: boolean
      astraHarnessEnabled: boolean
    }

    expect(config.bashFiltersEnabled).toBe(true)
    expect(config.openAIHarnessEnabled).toBe(true)
    expect(config.astraHarnessEnabled).toBe(true)
    expect(h.getAppFlag).toHaveBeenCalledWith('chat.bashFilters', true)
    expect(h.getAppFlag).toHaveBeenCalledWith('chat.openAIHarness', true)
    expect(h.getAppFlag).toHaveBeenCalledWith('chat.astraHarness', true)
  })

  it('defaults image generation on and persists global kill switches', async () => {
    const handlers = register()

    expect(
      ((await handlers.get('chat:config')?.(undefined as never)) as { imageGenEnabled: boolean }).imageGenEnabled
    ).toBe(true)
    expect(h.getAppFlag).toHaveBeenCalledWith('chat.imageGen', true)

    expect(handlers.get('chat:set-image-gen')?.(undefined as never, false)).toEqual({ ok: true })
    expect(h.setAppFlag).toHaveBeenCalledWith('chat.imageGen', false)
    expect(
      ((await handlers.get('chat:config')?.(undefined as never)) as { imageGenEnabled: boolean }).imageGenEnabled
    ).toBe(false)
  })

  it('persists bash filters across configuration reads', async () => {
    const handlers = register()

    expect(handlers.get('chat:set-bash-filters')?.(undefined as never, false)).toEqual({ ok: true })
    expect(h.setAppFlag).toHaveBeenCalledWith('chat.bashFilters', false)
    expect(
      ((await handlers.get('chat:config')?.(undefined as never)) as { bashFiltersEnabled: boolean }).bashFiltersEnabled
    ).toBe(false)
  })

  it('exposes Responses for official OpenAI despite legacy kinds', async () => {
    h.availableProviders.push({
      id: 'byok-openai',
      name: 'OpenAI BYOK',
      baseURL: 'https://api.openai.com/v1',
      kind: 'openai',
    })

    const config = register().get('chat:config')?.(undefined as never) as {
      openAIHarnessEnabled: boolean
      providers: Array<{ id: string; kind?: string }>
    }

    expect(config.openAIHarnessEnabled).toBe(true)
    expect(config.providers.find((provider) => provider.id === 'byok-openai')?.kind).toBe('openai-responses')
  })

  it('persists disabled state across configuration reads', async () => {
    const handlers = register()

    expect(handlers.get('chat:set-openai-harness')?.(undefined as never, false)).toEqual({ ok: true })
    expect(h.setAppFlag).toHaveBeenCalledWith('chat.openAIHarness', false)
    expect(
      ((await handlers.get('chat:config')?.(undefined as never)) as { openAIHarnessEnabled: boolean })
        .openAIHarnessEnabled
    ).toBe(false)
  })

  it('round-trips disabled and enabled state over IPC', async () => {
    const handlers = register()
    handlers.get('chat:set-openai-harness')?.(undefined as never, false)
    expect(handlers.get('chat:set-openai-harness')?.(undefined as never, true)).toEqual({ ok: true })
    expect(h.setAppFlag).toHaveBeenLastCalledWith('chat.openAIHarness', true)
    expect(
      ((await handlers.get('chat:config')?.(undefined as never)) as { openAIHarnessEnabled: boolean })
        .openAIHarnessEnabled
    ).toBe(true)
  })

  it('persists the dedicated Astra kill switch independently', async () => {
    const handlers = register()
    expect(handlers.get('chat:set-astra-harness')?.(undefined as never, false)).toEqual({ ok: true })
    expect(h.setAppFlag).toHaveBeenCalledWith('chat.astraHarness', false)
    expect(
      ((await handlers.get('chat:config')?.(undefined as never)) as { astraHarnessEnabled: boolean })
        .astraHarnessEnabled
    ).toBe(false)
  })

  it('does not block cold config and publishes only actual refresh changes', async () => {
    let resolveStatus!: (status: unknown) => void
    const pendingStatus = new Promise<unknown>((resolve) => {
      resolveStatus = resolve
    })
    h.getStatus.mockReturnValueOnce(pendingStatus)
    const handlers = register()

    const firstResult = handlers.get('chat:config')?.(undefined as never)
    const secondResult = handlers.get('chat:config')?.(undefined as never)

    expect(firstResult).not.toBeInstanceOf(Promise)
    expect(secondResult).not.toBeInstanceOf(Promise)
    expect(
      (firstResult as { providers: Array<{ id: string; connected: boolean }> }).providers.find(
        (provider) => provider.id === 'builtin-codex-subscription'
      )?.connected
    ).toBe(false)
    expect(h.getStatus).toHaveBeenCalledTimes(1)
    expect(h.send).not.toHaveBeenCalled()

    const signedInStatus = {
      ...h.signedOutStatus,
      authenticated: true,
      account: { type: 'chatgpt', email: 'user@example.com', planType: 'pro' },
    }
    h.managerState.snapshot = signedInStatus
    h.managerState.status = signedInStatus
    resolveStatus(signedInStatus)

    await vi.waitFor(() => {
      expect(h.send).toHaveBeenCalledWith('chat:codex-subscription:auth-changed', {
        state: 'signed-in',
        authenticated: true,
        email: 'user@example.com',
        planType: 'pro',
      })
    })
    await Promise.resolve()
    await Promise.resolve()

    const refreshed = handlers.get('chat:config')?.(undefined as never) as {
      providers: Array<{ id: string; connected: boolean }>
    }
    expect(refreshed.providers.find((provider) => provider.id === 'builtin-codex-subscription')?.connected).toBe(true)
    await vi.waitFor(() => expect(h.getStatus).toHaveBeenCalledTimes(2))
    await Promise.resolve()
    await Promise.resolve()
    // Configuration also refreshes Copilot and Claude independently;
    // their broadcasts may overlap this test, whose contract is one Codex
    // change event rather than suppressing other providers.
    expect(h.send.mock.calls.filter(([channel]) => channel === 'chat:codex-subscription:auth-changed')).toHaveLength(1)
  })

  it('waits for real runtime reads in explicit status requests', async () => {
    let resolveStatus!: (status: unknown) => void
    h.getStatus.mockReturnValueOnce(
      new Promise<unknown>((resolve) => {
        resolveStatus = resolve
      })
    )
    const result = register().get('chat:codex-subscription:status')?.(undefined as never)
    let settled = false
    void Promise.resolve(result).then(() => {
      settled = true
    })

    await Promise.resolve()
    expect(result).toBeInstanceOf(Promise)
    expect(settled).toBe(false)

    resolveStatus(h.signedOutStatus)
    await expect(result).resolves.toEqual({ state: 'signed-out', authenticated: false })
  })

  it('lists BYOK models without starting Codex', async () => {
    h.availableProviders.splice(0, h.availableProviders.length, {
      id: 'byok-openai',
      name: 'OpenAI BYOK',
      baseURL: 'https://api.openai.com/v1',
      kind: 'openai-responses',
    })
    h.apiKeyProviders.add('byok-openai')
    h.managerState.snapshot = null

    await expect(listChatExecutionModels()).resolves.toEqual([
      { id: 'byok-openai', name: 'OpenAI BYOK', models: ['gpt-4o'] },
    ])
    // Without Codex catalog entries, do not read manager snapshots.
    expect(h.getStatusSnapshot).not.toHaveBeenCalled()
    expect(h.getStatus).not.toHaveBeenCalled()
    expect(h.listModels).not.toHaveBeenCalled()
  })

  it('builds exact subscription slots without BYOK probes', async () => {
    const secondary = 'builtin_codex_subscription@acc_12345678-1234-4123-8123-123456789abc'
    h.availableProviders.splice(
      0,
      h.availableProviders.length,
      {
        id: 'builtin_codex_subscription',
        name: 'Codex',
        baseURL: 'codex-app-server://local',
        kind: 'codex-subscription',
      },
      {
        id: secondary,
        name: 'Codex secondary',
        baseURL: 'codex-app-server://local',
        kind: 'codex-subscription',
      },
      {
        id: 'slow-byok',
        name: 'Slow BYOK',
        baseURL: 'https://slow.invalid/v1',
        kind: 'openai',
      }
    )
    h.apiKeyProviders.add('slow-byok')
    h.managerState.status = {
      ...h.signedOutStatus,
      authenticated: true,
      account: { type: 'chatgpt', email: 'runner@example.com', planType: 'pro' },
    }
    h.listModels.mockResolvedValue([
      {
        id: 'gpt-5',
        model: 'gpt-5',
        hidden: false,
        inputModalities: ['text'],
        supportedReasoningEfforts: [{ reasoningEffort: 'high', description: 'Deep' }],
        serviceTiers: [],
        defaultServiceTier: null,
        legacySpeedTiers: [],
      },
    ])

    await expect(listChatRunnerCapabilities()).resolves.toEqual([
      {
        providerId: 'builtin_codex_subscription',
        providerLabel: 'Codex',
        modelId: 'gpt-5',
        reasoningEfforts: ['high'],
        fastMode: false,
      },
      {
        providerId: secondary,
        providerLabel: 'Codex secondary',
        modelId: 'gpt-5',
        reasoningEfforts: ['high'],
        fastMode: false,
      },
    ])
    expect(h.fetchModels).not.toHaveBeenCalled()
  })

  it('bounds hung subscription runtime discovery', async () => {
    vi.useFakeTimers()
    try {
      h.availableProviders.splice(0, h.availableProviders.length, {
        id: 'builtin_codex_subscription',
        name: 'Codex',
        baseURL: 'codex-app-server://local',
        kind: 'codex-subscription',
      })
      h.getStatus.mockReturnValue(new Promise(() => undefined))

      const result = listChatExecutionModels({
        refreshSubscriptionAuth: true,
        portableExecutionOnly: true,
        subscriptionProviderTimeoutMs: 50,
      })
      await vi.advanceTimersByTimeAsync(50)

      await expect(result).resolves.toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('uses configurable Codex limits for long-context defaults', async () => {
    h.getModelMeta.mockResolvedValue({ contextWindow: 1_100_000, inputPer1M: 5, outputPer1M: 25 })
    h.listModels.mockResolvedValue([
      {
        id: 'gpt-5.6-sol',
        model: 'gpt-5.6-sol',
        contextWindow: 258_400,
        maxContextWindow: 1_000_000,
        effectiveContextWindowPercent: 95,
        supportedReasoningEfforts: [
          { reasoningEffort: 'xhigh', description: 'Deep' },
          { reasoningEffort: 'ultra', description: 'Deep with delegation' },
        ],
        inputModalities: ['text', 'image'],
        serviceTiers: [{ id: 'priority', name: 'Fast', description: '1.5x speed' }],
        defaultServiceTier: null,
        legacySpeedTiers: ['fast'],
      },
    ])

    const meta = await register().get('chat:model-meta')?.(
      undefined as never,
      'gpt-5.6-sol',
      'builtin-codex-subscription'
    )

    expect(meta).toMatchObject({
      contextWindow: 950_000,
      inputPer1M: 5,
      outputPer1M: 25,
      reasoning: true,
      reasoningEfforts: ['xhigh', 'ultra'],
      vision: true,
      fastModeCapability: true,
      nativeUltraMode: true,
      contextLimitEditable: true,
    })
  })

  it('persists nominal Codex limits and exposes effective estimates', async () => {
    h.getModelMeta.mockResolvedValue({ contextWindow: 1_100_000 })
    h.listModels.mockResolvedValue([
      {
        id: 'gpt-5.6-sol',
        model: 'gpt-5.6-sol',
        contextWindow: 258_400,
        maxContextWindow: 1_000_000,
        effectiveContextWindowPercent: 95,
        supportedReasoningEfforts: [],
        inputModalities: ['text'],
        serviceTiers: [],
        defaultServiceTier: null,
        legacySpeedTiers: [],
      },
    ])
    const handlers = register()

    await expect(
      handlers.get('chat:context-limit:set')?.(undefined as never, 'builtin-codex-subscription', 'gpt-5.6-sol', 300_000)
    ).toEqual({ ok: true })
    await expect(
      handlers.get('chat:context-limit:get')?.(undefined as never, 'builtin-codex-subscription', 'gpt-5.6-sol')
    ).resolves.toEqual({
      limit: 300_000,
      providerWindow: 1_000_000,
      catalogWindow: 1_100_000,
      effective: 285_000,
    })
    await expect(
      handlers.get('chat:model-meta')?.(undefined as never, 'gpt-5.6-sol', 'builtin-codex-subscription')
    ).resolves.toMatchObject({ contextWindow: 285_000, contextLimitEditable: true })

    await expect(
      handlers.get('chat:context-limit:set')?.(undefined as never, 'builtin-codex-subscription', 'gpt-5.6-sol', null)
    ).toEqual({ ok: true })
    await expect(
      handlers.get('chat:context-limit:get')?.(undefined as never, 'builtin-codex-subscription', 'gpt-5.6-sol')
    ).resolves.toMatchObject({ limit: null, providerWindow: 1_000_000, effective: 950_000 })
  })

  it('allows Codex account limits while blocking other managed providers', () => {
    const handlers = register()
    expect(
      handlers.get('chat:context-limit:set')?.(undefined as never, 'builtin-codex-subscription', 'gpt-5.6-sol', 300_000)
    ).toEqual({ ok: true })
    expect(
      handlers.get('chat:context-limit:set')?.(
        undefined as never,
        'builtin-codex-subscription@acc_b',
        'gpt-5.6-sol',
        500_000
      )
    ).toEqual({ ok: true })
    expect(
      handlers.get('chat:context-limit:set')?.(undefined as never, 'builtin-claude-subscription', 'claude', 300_000)
    ).toEqual({ ok: false, error: 'unsupported' })
  })

  it('does not invent 1.1M context before runtime discovery', async () => {
    h.getModelMeta.mockResolvedValue({ contextWindow: 1_100_000, inputPer1M: 5 })
    h.listModels.mockResolvedValue([
      {
        id: 'gpt-runtime',
        model: 'gpt-runtime',
        contextWindow: null,
        supportedReasoningEfforts: [],
        inputModalities: ['text'],
        serviceTiers: [],
        defaultServiceTier: null,
        legacySpeedTiers: [],
      },
    ])

    const meta = (await register().get('chat:model-meta')?.(
      undefined as never,
      'gpt-runtime',
      'builtin-codex-subscription'
    )) as Record<string, unknown>

    expect(meta.inputPer1M).toBe(5)
    expect(meta).not.toHaveProperty('contextWindow')
    expect(meta.contextLimitEditable).toBe(false)
  })
})
