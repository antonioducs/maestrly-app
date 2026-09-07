import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const modelMeta = vi.hoisted(() => ({
  getClaudeHarnessModelMeta: vi.fn(),
}))

vi.mock('../../src/main/chat/model-meta', async () => {
  const actual = await vi.importActual<typeof import('../../src/main/chat/model-meta')>(
    '../../src/main/chat/model-meta'
  )
  return { ...actual, getClaudeHarnessModelMeta: modelMeta.getClaudeHarnessModelMeta }
})

const h = vi.hoisted(() => {
  let authenticationRequiredListener: ((status: any) => void) | null = null
  const state = {
    status: {
      state: 'ready',
      available: true,
      authenticated: true,
      account: {
        email: 'dev@example.com',
        organizationId: 'org-1',
        organizationName: 'Engineering',
        subscriptionType: 'max',
        authMethod: 'claude.ai',
        apiProvider: 'firstParty',
      },
      accountFingerprint: 'sha256:claude-account',
      accountEpoch: 2,
      cliVersion: '2.1.263',
      sdkVersion: '0.3.263',
      error: null,
    } as any,
    models: [
      {
        value: 'sonnet',
        resolvedModel: 'claude-sonnet-5',
        displayName: 'Claude Sonnet',
        description: 'Balanced',
        supportsEffort: true,
        supportedEffortLevels: ['low', 'high', 'max'],
        supportsAdaptiveThinking: true,
        supportsFastMode: true,
      },
    ] as any[],
  }
  const manager = {
    isDisposed: false,
    status: vi.fn(async () => state.status),
    getStatusSnapshot: vi.fn(() => state.status),
    listModels: vi.fn(async () => state.models),
    accountIdentity: vi.fn(async () => ({
      fingerprint: state.status.accountFingerprint,
      epoch: state.status.accountEpoch,
    })),
    assertAccountIdentity: vi.fn(),
    observeModelContextWindow: vi.fn(),
    getObservedModelContextWindow: vi.fn((): number | undefined => undefined),
    getResolvedModelId: vi.fn((modelId: string) => (modelId === 'sonnet' ? 'claude-sonnet-5' : modelId)),
    resolveModelId: vi.fn(async (modelId: string) => {
      const model = state.models.find((entry) => entry.value === modelId || entry.resolvedModel === modelId)
      return model?.resolvedModel ?? model?.value ?? null
    }),
    abortAllQueries: vi.fn(),
    onAuthenticationRequired: vi.fn((listener: (status: any) => void) => {
      authenticationRequiredListener = listener
      return () => {
        authenticationRequiredListener = null
      }
    }),
    login: vi.fn(async () => ({ ok: true, status: state.status })),
    cancelLogin: vi.fn(),
    logout: vi.fn(async () => {
      state.status = {
        ...state.status,
        state: 'signed-out',
        authenticated: false,
        account: null,
        accountFingerprint: null,
        accountEpoch: state.status.accountEpoch + 1,
      }
      return { ok: true, status: state.status }
    }),
    wipe: vi.fn(async () => {}),
    dispose: vi.fn(),
  }
  const webContents = {
    isDestroyed: vi.fn(() => false),
    send: vi.fn(),
  }
  return {
    state,
    manager,
    webContents,
    getMainWebContents: vi.fn(() => webContents),
    runClaude: vi.fn(async () => ({ planSubmitted: false, sessionId: 'claude-session-1' })),
    compactSession: vi.fn(),
    summarizePortable: vi.fn(async () => ({
      text: 'portable Claude summary',
      usage: { input: 80, output: 16, cacheRead: 0, cacheCreate: 0, totalInput: 80 },
    })),
    deleteAll: vi.fn(async () => {}),
    deleteOne: vi.fn(async () => {}),
    retryCleanup: vi.fn(async () => {}),
    emitAuthenticationRequired(status: any) {
      authenticationRequiredListener?.(status)
    },
  }
})

vi.mock('../../src/main/window-ipc', () => ({
  getMainWebContents: h.getMainWebContents,
}))
vi.mock('../../src/main/chat/claude-agent-sdk', () => ({
  claudeSubscriptionErrorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
  compactClaudeSession: h.compactSession,
  deleteAllManagedClaudeSessions: h.deleteAll,
  deleteClaudeSessionForConversation: h.deleteOne,
  getClaudeSessionBinding: vi.fn(() => null),
  getClaudeSubscriptionManager: () => h.manager,
  inspectClaudeSessionCompatibility: vi.fn(async () => true),
  putClaudeSessionBinding: vi.fn(),
  retryManagedClaudeSessionCleanup: h.retryCleanup,
  runClaudeChat: h.runClaude,
}))
vi.mock('../../src/main/chat/codex-subscription', () => ({
  deleteAllManagedCodexThreads: vi.fn(async () => {}),
  deleteCodexThreadForConversation: vi.fn(async () => {}),
  deleteManagedCodexThread: vi.fn(async () => {}),
  getCodexThreadBinding: vi.fn(() => null),
  retryManagedCodexThreadCleanup: vi.fn(async () => {}),
  runCodexSubscriptionChat: vi.fn(),
  getCodexSubscriptionManager: () => ({
    isDisposed: false,
    getStatus: vi.fn(async () => ({
      state: 'ready',
      available: true,
      authenticated: false,
      account: null,
      error: null,
    })),
    getStatusSnapshot: vi.fn(() => null),
    listModels: vi.fn(async () => []),
    onAccountUpdated: vi.fn(() => () => {}),
    dispose: vi.fn(),
  }),
}))
vi.mock('../../src/main/chat/github-copilot', () => ({
  deleteAllManagedGitHubCopilotSessions: vi.fn(async () => {}),
  deleteGitHubCopilotSessionForConversation: vi.fn(async () => {}),
  getGitHubCopilotSessionBinding: vi.fn(() => null),
  githubCopilotErrorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
  retryManagedGitHubCopilotSessionCleanup: vi.fn(async () => {}),
  runGitHubCopilotChat: vi.fn(),
  getGitHubCopilotSubscriptionManager: () => ({
    isDisposed: false,
    getStatus: vi.fn(async () => ({
      state: 'ready',
      available: true,
      connected: false,
      authenticated: false,
      account: null,
      error: null,
    })),
    getStatusSnapshot: vi.fn(() => null),
    listModels: vi.fn(async () => []),
    onAuthUpdated: vi.fn(() => () => {}),
    dispose: vi.fn(),
  }),
}))
vi.mock('../../src/main/chat/portable-summarizer', () => ({
  summarizeWithClaudeRuntime: h.summarizePortable,
  summarizeWithCodexRuntime: vi.fn(),
  summarizeWithGitHubCopilotRuntime: vi.fn(),
}))

import { CLAUDE_SUBSCRIPTION_PROVIDER_ID } from '../../src/main/chat/catalog'
import {
  compactReserved,
  registerChatIpc,
  revalidateReviewLoopSelection,
  resolveReviewLoopSelection,
  type ChatIpcDeps,
} from '../../src/main/chat/service'
import { listChatMessages, upsertChatMessage } from '../../src/main/chat/chat-store'
import { createLocalMemory, getLocalMemory } from '../../src/main/memory/local-memory-service'
import { getConvUiPrefs, patchConvUiPrefs, setAppFlag } from '../../src/main/store'
import { closeDb, freshDb } from '../helpers/db'
import { makeConversation, makeWorkspace } from '../helpers/factories'

type Handler = (event: any, ...args: any[]) => unknown

function register() {
  const handlers = new Map<string, Handler>()
  const emitStatus = vi.fn()
  registerChatIpc({
    mhandle: (channel, handler) => void handlers.set(channel, handler as Handler),
    mon: vi.fn(),
    emitStatus,
  } satisfies ChatIpcDeps)
  return { handlers, emitStatus }
}

describe('Claude subscription service integration', () => {
  beforeEach(() => {
    freshDb()
    vi.clearAllMocks()
    h.state.status = {
      state: 'ready',
      available: true,
      authenticated: true,
      account: {
        email: 'dev@example.com',
        organizationId: 'org-1',
        organizationName: 'Engineering',
        subscriptionType: 'max',
        authMethod: 'claude.ai',
        apiProvider: 'firstParty',
      },
      accountFingerprint: 'sha256:claude-account',
      accountEpoch: 2,
      cliVersion: '2.1.263',
      sdkVersion: '0.3.263',
      error: null,
    }
    h.state.models = [
      {
        value: 'sonnet',
        resolvedModel: 'claude-sonnet-5',
        displayName: 'Claude Sonnet',
        description: 'Balanced',
        supportsEffort: true,
        supportedEffortLevels: ['low', 'high', 'max'],
        supportsAdaptiveThinking: true,
        supportsFastMode: true,
      },
    ] as any[]
    h.manager.status.mockImplementation(async () => h.state.status)
    h.manager.getStatusSnapshot.mockImplementation(() => h.state.status)
    h.manager.listModels.mockImplementation(async () => h.state.models)
    h.manager.getObservedModelContextWindow.mockReturnValue(undefined)
    modelMeta.getClaudeHarnessModelMeta.mockResolvedValue(null)
    h.runClaude.mockResolvedValue({ planSubmitted: false, sessionId: 'claude-session-1' })
  })
  afterEach(closeDb)

  it('registers exhaustive auth IPC, exposes runtime models and marks the provider connected', async () => {
    const { handlers } = register()

    expect(handlers.has('chat:claude-subscription:status')).toBe(true)
    expect(handlers.has('chat:claude-subscription:login')).toBe(true)
    expect(handlers.has('chat:claude-subscription:logout')).toBe(true)
    await expect(handlers.get('chat:claude-subscription:status')?.({}, { refresh: true })).resolves.toMatchObject({
      state: 'signed-in',
      authenticated: true,
      email: 'dev@example.com',
      planType: 'max',
    })
    await expect(handlers.get('chat:models')?.({}, CLAUDE_SUBSCRIPTION_PROVIDER_ID, true)).resolves.toEqual(['sonnet'])
    const config = await handlers.get('chat:config')?.({})
    expect(config).toMatchObject({
      providers: expect.arrayContaining([
        expect.objectContaining({
          id: CLAUDE_SUBSCRIPTION_PROVIDER_ID,
          kind: 'claude-subscription',
          builtIn: true,
          connected: true,
          apiKeyPresent: false,
        }),
      ]),
    })
  })

  it('admits Claude before persisting the user turn and forwards runtime capabilities to the runner', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd: '/repo' })
    const memory = createLocalMemory({
      workspaceId: workspace.id,
      title: 'Implementation rule',
      content: 'Implement this with the durable project rule.',
      type: 'constraint',
      source: 'user',
      pinned: true,
    }).memory
    patchConvUiPrefs(conversation.id, {
      chat: {
        providerId: CLAUDE_SUBSCRIPTION_PROVIDER_ID,
        modelId: 'sonnet',
        mode: 'agent',
        permMode: 'ask',
        reasoning: 'max',
        fastMode: true,
      },
    })
    const { handlers } = register()

    await expect(
      handlers.get('chat:send')?.(
        { sender: h.webContents },
        { conversationId: conversation.id, text: 'Implement this.' }
      )
    ).resolves.toEqual({ ok: true })
    await vi.waitFor(() => expect(h.runClaude).toHaveBeenCalledOnce())

    expect(h.runClaude).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: conversation.id,
        cwd: '/repo',
        selection: { providerId: CLAUDE_SUBSCRIPTION_PROVIDER_ID, modelId: 'sonnet' },
        mode: 'agent',
        permMode: 'ask',
        reasoningEffort: 'max',
        fastMode: true,
        maestrlyUltra: false,
        accountIdentity: { fingerprint: 'sha256:claude-account', epoch: 2 },
      })
    )
    const runClaudeCalls = h.runClaude.mock.calls as unknown as Array<[Record<string, unknown>]>
    expect(runClaudeCalls[0]?.[0]).not.toHaveProperty('turnMemoryContext')
    expect(getLocalMemory(workspace.id, memory.id)).toMatchObject({ useCount: 0 })
    expect(getLocalMemory(workspace.id, memory.id)?.lastUsedAt).toBeUndefined()
    expect(listChatMessages(conversation.id).some((message) => message.role === 'user')).toBe(true)
    expect(
      listChatMessages(conversation.id).find((message) => message.role === 'assistant')?.memoryContext
    ).toBeUndefined()
  })

  it('isolates A → Fable 5.1 → A behavior without changing saved model or effort preferences', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd: '/repo' })
    h.state.models = [
      ...h.state.models,
      {
        value: 'fable',
        resolvedModel: 'claude-fable-5-1',
        displayName: 'Claude Fable 5.1',
        supportsEffort: true,
        supportedEffortLevels: ['high', 'max'],
        supportsAdaptiveThinking: true,
        supportsFastMode: true,
      },
    ] as any[]
    const setModel = (modelId: string) =>
      patchConvUiPrefs(conversation.id, {
        chat: {
          providerId: CLAUDE_SUBSCRIPTION_PROVIDER_ID,
          modelId,
          mode: 'agent',
          permMode: 'ask',
          reasoning: 'high',
          fastMode: false,
        },
      })
    const { handlers } = register()
    const send = async (text: string, calls: number) => {
      await expect(
        handlers.get('chat:send')?.({ sender: h.webContents }, { conversationId: conversation.id, text })
      ).resolves.toEqual({ ok: true })
      await vi.waitFor(() => expect(h.runClaude).toHaveBeenCalledTimes(calls))
    }
    const claudeCalls = h.runClaude.mock.calls as unknown as Array<
      [{ behaviorProfile?: unknown; resolvedModelId?: string }]
    >

    setModel('sonnet')
    await send('First A turn.', 1)
    expect(claudeCalls[0]?.[0].behaviorProfile).toBeNull()

    setModel('fable')
    await send('Fable turn.', 2)
    expect(claudeCalls[1]?.[0]).toMatchObject({
      resolvedModelId: 'claude-fable-5-1',
      behaviorProfile: { id: 'maestrly-fable-5.1-v1' },
    })

    setModel('sonnet')
    await send('Second A turn.', 3)
    expect(claudeCalls[2]?.[0].behaviorProfile).toBeNull()
    expect(getConvUiPrefs(conversation.id).chat).toMatchObject({
      modelId: 'sonnet',
      reasoning: 'high',
      fastMode: false,
    })
  })

  it('freezes the behavior version and fails closed on an incompatible frozen identity', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd: '/repo' })
    h.state.models = [
      {
        value: 'fable',
        resolvedModel: 'claude-fable-5-1',
        supportsEffort: true,
        supportedEffortLevels: ['high'],
        supportsFastMode: true,
      },
    ] as any[]
    patchConvUiPrefs(conversation.id, {
      chat: {
        providerId: CLAUDE_SUBSCRIPTION_PROVIDER_ID,
        modelId: 'fable',
        mode: 'agent',
        permMode: 'ask',
        reasoning: 'high',
        fastMode: false,
      },
    })

    const frozen = await resolveReviewLoopSelection(conversation.id)
    expect(frozen).toMatchObject({
      ok: true,
      selection: {
        modelId: 'fable',
        resolvedModelId: 'claude-fable-5-1',
        behaviorProfileId: 'maestrly-fable-5.1-v1',
      },
    })
    if (!frozen.ok) throw new Error(frozen.error)
    expect(
      await revalidateReviewLoopSelection({
        ...frozen.selection,
        resolvedModelId: 'claude-fable-5',
      })
    ).toEqual({ ok: false, error: 'executor-unavailable' })

    setAppFlag('chat.fable51Profile', false)
    const disabled = await resolveReviewLoopSelection(conversation.id)
    expect(disabled).toMatchObject({ ok: true, selection: { behaviorProfileId: null } })
  })

  it('uses portable summaries and invalidates previous native sessions', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd: '/repo' })
    patchConvUiPrefs(conversation.id, {
      chat: { providerId: CLAUDE_SUBSCRIPTION_PROVIDER_ID, modelId: 'sonnet' },
    })
    upsertChatMessage({
      id: 'claude-user-before',
      conversationId: conversation.id,
      role: 'user',
      parts: [{ type: 'text', id: 'claude-user-text', text: 'Implement the feature.' }],
      createdAt: 1,
    })
    upsertChatMessage({
      id: 'claude-assistant-before',
      conversationId: conversation.id,
      role: 'assistant',
      parts: [{ type: 'text', id: 'claude-assistant-text', text: 'Work completed.' }],
      model: { providerId: CLAUDE_SUBSCRIPTION_PROVIDER_ID, modelId: 'sonnet' },
      createdAt: 2,
    })
    const { handlers } = register()

    await expect(handlers.get('chat:compact')?.({}, conversation.id)).resolves.toEqual({
      ok: true,
      summary: 'portable Claude summary',
      usage: { input: 80, output: 16, cacheRead: 0, cacheCreate: 0, totalInput: 80 },
    })

    expect(h.compactSession).not.toHaveBeenCalled()
    expect(h.summarizePortable).toHaveBeenCalledWith(expect.objectContaining({ modelId: 'sonnet', cwd: '/repo' }))
    expect(h.deleteOne).toHaveBeenCalledWith(conversation.id)
    expect(listChatMessages(conversation.id).at(-1)?.parts).toEqual([
      expect.objectContaining({ type: 'compaction', text: 'portable Claude summary', strategy: 'summary' }),
    ])
  })

  it('uses frozen identity and effort for isolated compaction', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd: '/repo' })
    // Divergent live preferences cannot affect isolated compaction.
    patchConvUiPrefs(conversation.id, {
      chat: { providerId: CLAUDE_SUBSCRIPTION_PROVIDER_ID, modelId: 'sonnet', reasoning: 'off' },
    })
    const scope = {
      kind: 'review-loop' as const,
      executionId: 'exec-1',
      loopId: 'rl_1',
      iteration: 1,
      maxIterations: 5,
    }
    upsertChatMessage({
      id: 'round-user',
      conversationId: conversation.id,
      role: 'user',
      parts: [{ type: 'text', id: 'round-user-text', text: 'round findings' }],
      internal: true,
      source: 'chatgpt-web-review-loop',
      executionScope: scope,
      createdAt: 1,
    })
    upsertChatMessage({
      id: 'round-asst',
      conversationId: conversation.id,
      role: 'assistant',
      parts: [{ type: 'text', id: 'round-asst-text', text: 'work in progress' }],
      model: { providerId: CLAUDE_SUBSCRIPTION_PROVIDER_ID, modelId: 'sonnet' },
      source: 'chatgpt-web-review-loop',
      executionScope: scope,
      createdAt: 2,
    })
    const frozen = {
      providerId: CLAUDE_SUBSCRIPTION_PROVIDER_ID,
      modelId: 'sonnet',
      // Use frozen resolved model IDs instead of mutable aliases.
      resolvedModelId: 'claude-sonnet-5',
      // Forward frozen Fast to auxiliary queries.
      fastMode: true,
      // Compaction uses frozen effective max rather than raw Ultra sentinels.
      reasoning: 'ultra',
      reasoningEffort: 'max',
      identityFingerprint: 'sha256:claude-account',
      identityEpoch: 2,
    }
    h.summarizePortable.mockResolvedValue({
      text: 'summary frozen',
      usage: { input: 80, output: 16, cacheRead: 0, cacheCreate: 0, totalInput: 80 },
      runtimeEstimatedCostUsd: 0.002,
    } as never)

    const result = await compactReserved(conversation.id, {
      executionId: 'exec-1',
      selectionOverride: frozen,
      persist: false,
      skipRetireBinding: true,
    })

    expect(result.ok).toBe(true)
    // Propagate auxiliary native estimates to the runner.
    expect(result.runtimeEstimatedCostUsd).toBe(0.002)
    // Use frozen effective effort and identity, never raw Ultra.
    // nor the live preferences' reasoning off.
    expect(h.summarizePortable).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: 'claude-sonnet-5',
        effort: 'max',
        fastMode: true,
        accountIdentity: { fingerprint: 'sha256:claude-account', epoch: 2 },
      })
    )
  })

  it('aborts isolated compaction after identity mismatch', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd: '/repo' })
    const scope = {
      kind: 'review-loop' as const,
      executionId: 'exec-1',
      loopId: 'rl_1',
      iteration: 1,
      maxIterations: 5,
    }
    upsertChatMessage({
      id: 'round-user',
      conversationId: conversation.id,
      role: 'user',
      parts: [{ type: 'text', id: 'round-user-text', text: 'round findings' }],
      internal: true,
      source: 'chatgpt-web-review-loop',
      executionScope: scope,
      createdAt: 1,
    })
    upsertChatMessage({
      id: 'round-asst',
      conversationId: conversation.id,
      role: 'assistant',
      parts: [{ type: 'text', id: 'round-asst-text', text: 'work in progress' }],
      model: { providerId: CLAUDE_SUBSCRIPTION_PROVIDER_ID, modelId: 'sonnet' },
      source: 'chatgpt-web-review-loop',
      executionScope: scope,
      createdAt: 2,
    })
    const frozen = {
      providerId: CLAUDE_SUBSCRIPTION_PROVIDER_ID,
      modelId: 'sonnet',
      fastMode: false,
      identityFingerprint: 'sha256:claude-account',
      identityEpoch: 2,
    }
    // Account changed DURING the round (fingerprint/epoch differs from the freeze).
    h.state.status = { ...h.state.status, accountFingerprint: 'sha256:other-conta', accountEpoch: 9 }

    const result = await compactReserved(conversation.id, {
      executionId: 'exec-1',
      selectionOverride: frozen,
      persist: false,
      skipRetireBinding: true,
    })

    // Aborts BEFORE any summary call without falling back to live credentials.
    expect(result).toEqual({ ok: false, error: 'executor-unavailable' })
    expect(h.summarizePortable).not.toHaveBeenCalled()
  })

  it('uses the frozen Fable compaction contract without reusing signed thinking', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { cwd: '/repo' })
    const scope = {
      kind: 'review-loop' as const,
      executionId: 'exec-fable',
      loopId: 'rl-fable',
      iteration: 1,
      maxIterations: 5,
    }
    upsertChatMessage({
      id: 'round-fable-user',
      conversationId: conversation.id,
      role: 'user',
      parts: [{ type: 'text', id: 'round-fable-user-text', text: 'Keep the rejected approach.' }],
      internal: true,
      source: 'chatgpt-web-review-loop',
      executionScope: scope,
      createdAt: 1,
    })
    upsertChatMessage({
      id: 'round-fable-assistant',
      conversationId: conversation.id,
      role: 'assistant',
      parts: [{ type: 'text', id: 'round-fable-assistant-text', text: 'Attempt A was rejected.' }],
      model: { providerId: CLAUDE_SUBSCRIPTION_PROVIDER_ID, modelId: 'fable' },
      source: 'chatgpt-web-review-loop',
      executionScope: scope,
      createdAt: 2,
    })
    h.state.models = [
      {
        value: 'fable',
        resolvedModel: 'claude-fable-5-1',
        supportsEffort: true,
        supportedEffortLevels: ['high'],
        supportsFastMode: true,
      },
    ] as any[]

    const result = await compactReserved(conversation.id, {
      executionId: 'exec-fable',
      selectionOverride: {
        providerId: CLAUDE_SUBSCRIPTION_PROVIDER_ID,
        modelId: 'fable',
        resolvedModelId: 'claude-fable-5-1',
        behaviorProfileId: 'maestrly-fable-5.1-v1',
        reasoning: 'off',
        fastMode: false,
        identityFingerprint: 'sha256:claude-account',
        identityEpoch: 2,
      },
      persist: false,
      skipRetireBinding: true,
    })

    expect(result.ok).toBe(true)
    expect(h.summarizePortable).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: 'claude-fable-5-1',
        system: expect.stringMatching(/rejected attempts[\s\S]*user constraints and decisions[\s\S]*Never invent/),
      })
    )
    const summaryCalls = h.summarizePortable.mock.calls as unknown as Array<[Record<string, unknown>]>
    expect(summaryCalls.at(-1)?.[0]).not.toHaveProperty('thinking')
  })

  it('Claude effective axes changing between freeze and round return executor_unavailable', async () => {
    const frozen = {
      providerId: CLAUDE_SUBSCRIPTION_PROVIDER_ID,
      modelId: 'sonnet',
      resolvedModelId: 'claude-sonnet-5',
      reasoning: 'high',
      reasoningEffort: 'high',
      fastMode: true,
      identityFingerprint: 'sha256:claude-account',
      identityEpoch: 2,
    }
    expect(await revalidateReviewLoopSelection(frozen)).toEqual({ ok: true })

    // Missing frozen efforts cannot fall back to another level.
    h.state.models = [
      {
        value: 'sonnet',
        resolvedModel: 'claude-sonnet-5',
        supportsEffort: true,
        supportedEffortLevels: ['low', 'medium'],
        supportsFastMode: true,
      },
    ] as any[]
    expect(await revalidateReviewLoopSelection(frozen)).toEqual({
      ok: false,
      error: 'executor-unavailable',
    })

    // Fast also fails closed when its capability disappears.
    h.state.models = [
      {
        value: 'sonnet',
        resolvedModel: 'claude-sonnet-5',
        supportsEffort: true,
        supportedEffortLevels: ['high'],
        supportsFastMode: false,
      },
    ] as any[]
    expect(await revalidateReviewLoopSelection(frozen)).toEqual({
      ok: false,
      error: 'executor-unavailable',
    })
  })

  it('prices Claude aliases without importing catalog windows', async () => {
    h.state.models = [{ value: 'opus[1m]', displayName: 'Opus (1M context)' }] as any[]
    h.manager.getObservedModelContextWindow.mockReturnValue(200_000)
    h.manager.listModels.mockResolvedValue(h.state.models)
    modelMeta.getClaudeHarnessModelMeta.mockResolvedValue({
      contextWindow: 1_000_000,
      maxOutput: 64_000,
      inputPer1M: 5,
      outputPer1M: 25,
      cacheReadPer1M: 0.5,
      cacheWritePer1M: 6.25,
      reasoning: true,
      vision: true,
      chatCapable: true,
    })
    const { handlers } = register()
    const modelMetaHandler = handlers.get('chat:model-meta')!

    await expect(modelMetaHandler({}, 'opus[1m]', CLAUDE_SUBSCRIPTION_PROVIDER_ID)).resolves.toMatchObject({
      contextWindow: 200_000,
      inputPer1M: 5,
      outputPer1M: 25,
      cacheReadPer1M: 0.5,
      cacheWritePer1M: 6.25,
    })
    expect(modelMeta.getClaudeHarnessModelMeta).toHaveBeenCalledWith('opus[1m]')

    h.manager.listModels.mockRejectedValue(new Error('Claude model list unavailable'))
    await expect(modelMetaHandler({}, 'opus[1m]', CLAUDE_SUBSCRIPTION_PROVIDER_ID)).resolves.toMatchObject({
      contextWindow: 200_000,
      inputPer1M: 5,
      outputPer1M: 25,
    })
  })

  it('uses an explicit identity barrier for login/logout and only wipes managed sessions', async () => {
    const { handlers } = register()
    h.state.status = {
      ...h.state.status,
      state: 'signed-out',
      authenticated: false,
      account: null,
      accountFingerprint: null,
    }
    h.manager.login.mockResolvedValueOnce({
      ok: true,
      status: {
        ...h.state.status,
        state: 'ready',
        authenticated: true,
        account: {
          email: 'dev@example.com',
          organizationId: 'org-1',
          organizationName: 'Engineering',
          subscriptionType: 'max',
          authMethod: 'claude.ai',
          apiProvider: 'firstParty',
        },
        accountFingerprint: 'sha256:claude-account',
      },
    })

    await expect(handlers.get('chat:claude-subscription:login')?.({})).resolves.toMatchObject({
      ok: true,
      status: { state: 'signing-in', authenticated: false },
    })
    await vi.waitFor(() => expect(h.manager.login).toHaveBeenCalledOnce())
    expect(h.deleteAll).toHaveBeenCalled()

    await expect(handlers.get('chat:claude-subscription:logout')?.({})).resolves.toMatchObject({ ok: true })
    expect(h.manager.cancelLogin).toHaveBeenCalled()
    expect(h.manager.logout).toHaveBeenCalled()
    expect(h.deleteAll).toHaveBeenCalledTimes(3)
    expect(h.webContents.send).toHaveBeenCalledWith(
      'chat:claude-subscription:auth-changed',
      expect.objectContaining({ authenticated: false })
    )
  })

  it('publishes signed-out auth state and clears managed sessions after terminal OAuth failure', async () => {
    register()
    const expired = {
      ...h.state.status,
      state: 'error',
      authenticated: false,
      account: null,
      accountFingerprint: null,
      accountEpoch: h.state.status.accountEpoch + 1,
      error: 'Claude authentication expired or became invalid. Sign in again to continue.',
      errorCode: 'claude-authentication-required',
    }
    h.state.status = expired

    h.emitAuthenticationRequired(expired)

    expect(h.webContents.send).toHaveBeenCalledWith(
      'chat:claude-subscription:auth-changed',
      expect.objectContaining({
        state: 'error',
        authenticated: false,
        error: expect.stringContaining('Sign in again'),
        errorCode: 'claude-authentication-required',
      })
    )
    await vi.waitFor(() => expect(h.deleteAll).toHaveBeenCalled())
    expect(h.manager.abortAllQueries).toHaveBeenCalled()
  })
})
