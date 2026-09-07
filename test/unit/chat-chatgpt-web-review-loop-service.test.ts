import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Internal review turns begin at ActiveRun admission,
 * resolve outcomes once, hide model-only parts and freeze selection without fallback.
 * Conversation locks permit only owner jobs; Stop aborts runners and summaries persist
 * with dedicated provenance. Mocks match skill invocation tests.
 */

/** Controlled Copilot catalog and fixed identity for effort freeze. */
const copilotH = vi.hoisted(() => ({
  models: [] as Array<{
    id: string
    supportedReasoningEfforts?: readonly string[]
    defaultReasoningEffort?: string
    policy?: { state?: string }
  }>,
}))

/** Per-account Codex status; null email means signed out and slots have isolated homes. */
const codexH = vi.hoisted(() => {
  const emails = new Map<string, string | null>()
  return {
    emails,
    setStatus: (accountId: string, email: string | null) => {
      emails.set(accountId, email)
    },
    /** Controllable preferred tiers; null means no Fast support. */
    preferredFastTier: null as string | null,
    /** Controllable runtime effort catalog. */
    codexModels: [] as Array<{
      id: string
      model?: string
      supportedReasoningEfforts?: Array<{ reasoningEffort: string }>
      defaultReasoningEffort?: string
      inputModalities?: string[]
    }>,
  }
})
vi.mock('../../src/main/chat/codex-subscription/manager', () => ({
  getCodexSubscriptionManager: (accountId: string | null) => ({
    isDisposed: false,
    getStatus: vi.fn(async () => {
      const email = codexH.emails.get(accountId ?? '') ?? null
      return {
        state: 'ready',
        available: true,
        connected: true,
        authenticated: email != null,
        account: email != null ? { type: 'chatgpt', email, planType: 'pro' } : null,
        requiresOpenaiAuth: null,
        runtime: null,
        error: null,
      }
    }),
    getStatusSnapshot: vi.fn(() => null),
    preferredServiceTier: vi.fn(async () => codexH.preferredFastTier),
    getClient: vi.fn(() => ({})),
    listModels: vi.fn(async () => codexH.codexModels),
    onAccountUpdated: vi.fn(() => () => {}),
    dispose: vi.fn(),
  }),
}))

const h = vi.hoisted(() => ({
  getMainWebContents: vi.fn(),
  getConversation: vi.fn(),
  getConvUiPrefs: vi.fn(),
  getAppFlag: vi.fn(),
  getAppSetting: vi.fn(),
  getModelMeta: vi.fn(async () => null),
  /** Controllable catalog reasoning metadata for freezing effort. */
  getProviderModelMeta: vi.fn(async () => null),
  updateConversationStatus: vi.fn(),
  upsertChatMessage: vi.fn(),
  listChatMessages: vi.fn(() => []),
  /** Controllable isolated execution transcript for compaction. */
  listExecutionContextMessages: vi.fn(() => []),
  /** Controllable Codex isolated summarizer. */
  summarizeCodex: vi.fn(async () => ({
    text: 'summary codex',
    usage: { input: 10, output: 5, cacheRead: 0, cacheCreate: 0, totalInput: 10 },
    runtimeEstimatedCostUsd: 0.001,
  })),
  /** Controllable BYOK compaction inference. */
  generateText: vi.fn(async () => ({ text: 'summary byok', usage: { totalTokens: 15 } })),

  listConversationContextMessages: vi.fn(() => []),
  chatHistoryStats: vi.fn(() => ({ lastUsage: null })),
  runCodex: vi.fn(async (_args: any) => ({ planSubmitted: false, threadId: 'thread-review-loop' })),
  runChat: vi.fn(),
  fetchModels: vi.fn(),
  reviewLoopLockFor: vi.fn((_conversationId: string) => null),
  projectEnvironmentLockFor: vi.fn((_conversationId: string): string | null => null),
  stopReviewLoop: vi.fn(),
  setChatGptWebHooks: vi.fn(),
  onChatGptWebChange: vi.fn(() => () => undefined),
  endSession: vi.fn(async () => {}),
  disposeChatGptWeb: vi.fn(async () => {}),
  status: vi.fn(() => ({
    binaryAvailable: true,
    configured: true,
    tunnelId: null,
    apiKeyPresent: false,
    appName: '',
    tunnelState: 'stopped',
    probeActive: false,
    sessions: [],
  })),
  getPendingPlan: vi.fn((_conversationId: string) => null),
  invalidateUnifiedUsageCache: vi.fn(),
}))

vi.mock('../../src/main/window-ipc', () => ({ getMainWebContents: h.getMainWebContents }))

vi.mock('../../src/main/chat/github-copilot/manager', () => ({
  getGitHubCopilotSubscriptionManager: () => ({
    getStatus: vi.fn(async () => ({
      state: 'ready',
      available: true,
      authenticated: true,
      account: { login: 'reviewer', host: 'github.com' },
    })),
    getStatusSnapshot: vi.fn(() => null),
    getAccountIdentity: vi.fn(() => ({ fingerprint: 'copilot-fp', epoch: 1 })),
    listModels: vi.fn(async () => copilotH.models),
    assertAccountIdentity: vi.fn(),
    onAuthUpdated: vi.fn(() => () => {}),
    dispose: vi.fn(),
  }),
}))

vi.mock('../../src/main/store', () => ({
  getConversation: h.getConversation,
  getConvUiPrefs: h.getConvUiPrefs,
  getAppFlag: h.getAppFlag,
  getAppSetting: h.getAppSetting,
  getDb: vi.fn(() => ({
    prepare: vi.fn(() => ({ get: vi.fn(() => undefined), all: vi.fn(() => []), run: vi.fn() })),
  })),
  getLocale: vi.fn(() => 'pt-BR'),
  updateConversationStatus: h.updateConversationStatus,
  patchConvUiPrefs: vi.fn(),
  setAppFlag: vi.fn(),
  setAppSetting: vi.fn(),
}))

vi.mock('../../src/main/chat/catalog', () => ({
  PROVIDER_PRESETS: [],
  CODEX_SUBSCRIPTION_PROVIDER_ID: 'builtin_codex_subscription',
  getProvider: vi.fn(() => ({ id: 'provider-1', name: 'Provider', baseURL: 'https://example.test/v1' })),
  getProviderKind: vi.fn(() => 'openai'),
  isClaudeSubscriptionProvider: vi.fn(() => false),
  // Codex selection may target the default or additional account slot.
  isCodexSubscriptionProvider: vi.fn(
    (providerId: string) =>
      providerId === 'builtin_codex_subscription' || providerId === 'builtin_codex_subscription@acc_1'
  ),
  // The Copilot provider is used when selected by the conversation (loop effort freeze).
  isGitHubCopilotSubscriptionProvider: vi.fn(
    (providerId: string) => providerId === 'builtin_github_copilot_subscription'
  ),
  isGrokSubscriptionProvider: vi.fn(() => false),
  isSubscriptionProvider: vi.fn((providerId: string) => providerId.startsWith('builtin_codex_subscription')),
  isManagedProvider: vi.fn((providerId: string) => providerId.startsWith('builtin_codex_subscription')),
  isChatGptWebProvider: vi.fn(() => false),
  isChatGptWebEnabled: vi.fn(() => true),
  subscriptionAccountId: vi.fn((providerId: string) =>
    providerId.startsWith('builtin_codex_subscription@') ? providerId.split('@')[1] : null
  ),
  subscriptionProviderIdFor: vi.fn(() => 'builtin'),
  getSubscriptionAccount: vi.fn(() => undefined),
  addSubscriptionAccount: vi.fn(),
  renameSubscriptionAccount: vi.fn(),
  removeSubscriptionAccount: vi.fn(),
  addProvider: vi.fn(),
  removeProvider: vi.fn(),
  updateProvider: vi.fn(),
  setChatGptWebEnabled: vi.fn(),
  listAvailableChatProviders: vi.fn(() => [{ id: 'provider-1', name: 'Provider', baseURL: 'https://example.test/v1' }]),
  listProviders: vi.fn(() => [{ id: 'provider-1', name: 'Provider', baseURL: 'https://example.test/v1' }]),
}))

vi.mock('../../src/main/chat/credentials', () => ({
  apiKeyStorageMode: vi.fn(() => 'secure'),
  hasApiKey: vi.fn(() => true),
}))

vi.mock('../../src/main/chat/chat-store', () => ({
  getChatMessage: vi.fn(() => null),
  chatHistoryStats: h.chatHistoryStats,
  listChatMessages: h.listChatMessages,

  listConversationContextMessages: h.listConversationContextMessages,
  listExecutionContextMessages: h.listExecutionContextMessages,
  lastConversationContextMessage: vi.fn(() => undefined),
  upsertChatMessage: h.upsertChatMessage,
  toPublicChatMessages: vi.fn((messages: unknown) => messages),
  toPublicChatHistoryStats: vi.fn((stats: unknown) => stats),
  listPublicChatMessagesPage: vi.fn(() => ({ messages: [], hasMore: false, earliestSeq: null, latestSeq: null })),
  searchChatMessages: vi.fn(() => []),
  clearChatMessages: vi.fn(),
  deleteChatMessagesFrom: vi.fn(),
  findGeneratedImagePart: vi.fn(() => null),
  getMessageSeq: vi.fn(() => null),
}))

vi.mock('../../src/main/usage/usage-service', () => ({
  invalidateUnifiedUsageCache: h.invalidateUnifiedUsageCache,
}))

vi.mock('../../src/main/chat/runner', () => ({
  normalizeAiUsage: vi.fn(() => ({ input: 0, output: 0, totalInput: 0, cacheRead: 0, cacheCreate: 0 })),
  runChat: h.runChat,
  // Mirror the pure helper because the actual runner module is not imported.
  applyFastModeServiceTier: (options: unknown, fastMode: boolean, providerId: string) => {
    if (!fastMode || providerId !== 'builtin_grok_subscription') return options
    const compat = ((options as Record<string, unknown> | undefined)?.['openai-compatible'] ?? {}) as Record<
      string,
      unknown
    >
    return { ...(options as object), 'openai-compatible': { ...compat, service_tier: 'priority' } }
  },
}))

vi.mock('../../src/main/chat/portable-summarizer', () => ({
  summarizeWithClaudeRuntime: vi.fn(),
  summarizeWithCodexRuntime: h.summarizeCodex,
  summarizeWithGitHubCopilotRuntime: vi.fn(),
}))

vi.mock('../../src/main/chat/codex-subscription/runner', () => ({
  runCodexSubscriptionChat: h.runCodex,
}))

// Preserve real generateText except service BYOK compaction.
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>()
  return { ...actual, generateText: h.generateText }
})

vi.mock('../../src/main/chat/models', () => ({
  fetchModels: h.fetchModels,
  fetchModelWindow: vi.fn(() => Promise.resolve(undefined)),
  invalidateModels: vi.fn(),
}))

vi.mock('../../src/main/chat/context-limits', () => ({
  getContextLimit: vi.fn(() => undefined),
  setContextLimit: vi.fn(),
  resolveContextWindow: vi.fn(() => undefined),
}))

vi.mock('../../src/main/chat/model-meta', () => ({
  catalogProviderForBaseURL: vi.fn(() => null),
  composeEffectiveMeta: vi.fn(() => null),
  getModelMeta: h.getModelMeta,
  getProviderModelMeta: h.getProviderModelMeta,
  filterChatModels: vi.fn((models: string[]) => models),
}))

vi.mock('../../src/main/chat/provider', () => ({
  ChatConfigError: class ChatConfigError extends Error {},
  invalidateProvider: vi.fn(),
  resolveChatHarnessMetadata: vi.fn(() => ({ harnessProfile: 'legacy', capabilities: {} })),
  resolveLanguageModel: vi.fn(),
}))

vi.mock('../../src/main/chat/mcp', () => ({ listMcpServers: vi.fn(() => []) }))

vi.mock('../../src/main/chat/chatgpt-web/manager', () => ({
  setChatGptWebHooks: h.setChatGptWebHooks,
  onChatGptWebChange: h.onChatGptWebChange,
  reviewLoopLockFor: h.reviewLoopLockFor,
  projectEnvironmentLockFor: h.projectEnvironmentLockFor,
  stopReviewLoop: h.stopReviewLoop,
  endSession: h.endSession,
  discardPlanReviews: vi.fn(),
  resolvePlanReview: vi.fn(() => ({ ok: true })),
  disposeChatGptWeb: h.disposeChatGptWeb,
  status: h.status,
  listSessions: vi.fn(() => []),
  sessionForConversation: vi.fn(() => null),
  companionPrompt: vi.fn(() => null),
  startSession: vi.fn(async () => ({ ok: true })),
  openCompanionWindow: vi.fn(async () => ({ ok: true })),
  stopTunnelProbe: vi.fn(async () => {}),
  startTunnelProbe: vi.fn(async () => ({ ok: true })),
  tunnelLogs: vi.fn(() => []),
  resetCompanionStorage: vi.fn(async () => {}),
  withTransportConfigurationMutation: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  transportConfigurationHasActiveResources: vi.fn(() => false),
  setPlatformApiKey: vi.fn(),
  clearPlatformApiKey: vi.fn(),
  setTunnelId: vi.fn(),
  setAppName: vi.fn(),
  getTunnelId: vi.fn(() => ''),
  listTunnelPrincipals: vi.fn(async () => ({ ok: true, data: { organizations: [], workspaces: [] } })),
  listTunnels: vi.fn(async () => ({ ok: true, data: { data: [], tunnels: [] } })),
  createTunnel: vi.fn(async () => ({ ok: true, data: { id: 'tunnel-1' } })),
}))

// These mocks avoid unused Electron and persistence imports.
vi.mock('../../src/main/chat/chatgpt-web/checks', () => ({
  getChecksConfig: vi.fn(() => ''),
  setChecksConfig: vi.fn(),
  listChecks: vi.fn(() => []),
}))
vi.mock('../../src/main/plan-broker', () => ({
  stagePlan: vi.fn(),
  getPending: h.getPendingPlan,
}))
vi.mock('../../src/main/chat/harness', () => ({ isOpenAIHarnessActive: vi.fn(() => false) }))
vi.mock('../../src/main/chat/openai/inference-store', () => ({
  canReplayOpenAIInferenceState: vi.fn(() => false),
  getOpenAIInferenceState: vi.fn(() => null),
  putOpenAIInferenceState: vi.fn(),
  putChatMessageWithOpenAIInferenceState: vi.fn(),
  deleteOpenAIInferenceState: vi.fn(),
  getToolExecution: vi.fn(() => null),
  putToolExecution: vi.fn(),
  parseOpenAIInferenceState: vi.fn(() => null),
  OPENAI_INFERENCE_STATE_VERSION: 3,
}))

import { registerChatIpc } from '../../src/main/chat/service'
import {
  startInternalChatTurn,
  cancelInternalChatTurn,
  pendingInternalTurnsCount,
  persistReviewLoopSummary,
  validateReviewLoopStart,
  forceReviewLoopAgentMode,
  resolveReviewLoopSelection,
  revalidateReviewLoopSelection,
  turnReasoning,
  resolveNativeReasoningEffort,
  claudeRuntimeAxes,
  compactReserved,
} from '../../src/main/chat/service'
import { __resetCwdActivityForTests } from '../../src/main/cwd-activity-coordinator'
import { __resetReviewLoopRegistryForTests, reserveReviewLoop } from '../../src/main/chat/review-loop/registry'
import type { MessagePart } from '../../src/shared/chat'

const wc = { isDestroyed: vi.fn(() => false), send: vi.fn() }

let cwd = ''

function register() {
  const handlers = new Map<string, (...args: any[]) => unknown>()
  registerChatIpc({ mhandle: (channel, fn) => void handlers.set(channel, fn), mon: vi.fn(), emitStatus: vi.fn() })
  return handlers
}

const SELECTION = { providerId: 'provider-1', modelId: 'model-1', fastMode: false }

describe('review loop internal service API', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    __resetCwdActivityForTests()
    __resetReviewLoopRegistryForTests()
    cwd = mkdtempSync(path.join(os.tmpdir(), 'review-loop-service-'))
    h.getMainWebContents.mockReturnValue(wc)
    h.getConversation.mockReturnValue({ id: 'conv-chat', cli: 'chat', cwd, workspaceId: 'workspace-1' })
    h.getConvUiPrefs.mockReturnValue({ chat: { providerId: 'provider-1', modelId: 'model-1', mode: 'agent' } })
    h.getAppFlag.mockImplementation((_key: string, fallback: boolean) => fallback)
    h.getAppSetting.mockReturnValue(null)
    // Default metadata is offline; positive freeze tests must provide support evidence.
    h.getProviderModelMeta.mockResolvedValue(null)
    h.runChat.mockResolvedValue({ planSubmitted: false })
    h.runCodex.mockReset()
    h.runCodex.mockResolvedValue({ planSubmitted: false, threadId: 'thread-review-loop' })
    h.fetchModels.mockResolvedValue(['model-1'])
    // Active owner loop rl_1: internal turns with this loop_id pass through the lock.
    h.reviewLoopLockFor.mockReturnValue('rl_1' as never)
    h.projectEnvironmentLockFor.mockReturnValue(null)
    h.getPendingPlan.mockReturnValue(null)

    register() // savedDeps = deps (startInternalChatTurn and related functions require service registration).
  })
  afterEach(() => rmSync(cwd, { recursive: true, force: true }))

  it('returns race-free internal handles with hidden parts', async () => {
    // Live preferences deliberately differ from frozen profiles; reasoning must never
    // Read live again: hand-built SELECTION without a materialized axis is frozen WITHOUT override, so off.
    h.getConvUiPrefs.mockReturnValue({
      chat: { providerId: 'provider-1', modelId: 'model-1', mode: 'agent', reasoning: 'high' },
    })
    const handle = await startInternalChatTurn({
      conversationId: 'conv-chat',
      prompt: 'Implement the findings from round 1/5.',
      hiddenParts: [
        {
          type: 'file',
          id: 'part-1',
          name: 'review-loop-findings.md',
          mediaType: 'text/markdown',
          kind: 'text',
          data: '# findings',
          hidden: true,
        },
      ],
      selection: SELECTION,
      source: 'chatgpt-web-review-loop',
      loopId: 'rl_1',
      iteration: 1,
      maxIterations: 5,
      signal: new AbortController().signal,
    })
    if (!handle.ok) throw new Error('esperava ok: ' + handle.error)
    const turn = handle as { ok: true; handle: { executionId: string; conversationId: string; cancel(): void } }
    expect(turn.handle.conversationId).toBe('conv-chat')
    expect(turn.handle.executionId).toBeTruthy()
    // Internal user messages contain hidden model-only parts.
    const userMessage = h.upsertChatMessage.mock.calls.find(
      ([message]) => (message as { role: string }).role === 'user'
    )?.[0] as { internal?: boolean; parts: MessagePart[] }
    expect(userMessage.internal).toBe(true)
    expect(userMessage.parts).toContainEqual(
      expect.objectContaining({ type: 'file', name: 'review-loop-findings.md', hidden: true })
    )
    // The runner receives Agent mode, frozen selection and reasoning, and ephemeral isolation.
    expect(h.runChat).toHaveBeenCalledWith(
      expect.objectContaining({
        selection: { providerId: 'provider-1', modelId: 'model-1' },
        behaviorOverride: 'agent',
        reasoningOverride: 'off',
        ephemeralSession: true,
        messageMeta: expect.objectContaining({
          source: 'chatgpt-web-review-loop',
          executionScope: expect.objectContaining({ kind: 'review-loop', iteration: 1, maxIterations: 5 }),
        }),
      })
    )
    const messageMeta = (h.runChat.mock.calls[0]?.[0] as { messageMeta?: { internal?: boolean } }).messageMeta
    expect(messageMeta?.internal).toBeUndefined()
    const assistantMessage = h.upsertChatMessage.mock.calls.find(
      ([message]) => (message as { role: string }).role === 'assistant'
    )?.[0] as { internal?: boolean; source?: string } | undefined
    expect(assistantMessage?.source).toBe('chatgpt-web-review-loop')
    expect(assistantMessage?.internal).toBeUndefined()
    expect(userMessage).toEqual(
      expect.objectContaining({
        source: 'chatgpt-web-review-loop',
        executionScope: expect.objectContaining({ kind: 'review-loop' }),
      })
    )
  })

  it('forwards paired reviewer policy and lease provenance', async () => {
    reserveReviewLoop({
      loopId: 'rl_1',
      driver: 'maestrly-pair',
      cwd,
      participants: { executor: 'executor', reviewer: 'conv-chat' },
    })
    const reviewerRuntime = {
      recordEvidence: vi.fn(),
      submitReview: vi.fn(() => ({ ok: true as const })),
      searchExecutionContext: vi.fn(),
      readExecutionContext: vi.fn(),
      decision: vi.fn(() => ({ result: 'clean' as const, summary: 'clean' })),
    }
    const started = await startInternalChatTurn({
      conversationId: 'conv-chat',
      prompt: 'Review the current checkout.',
      selection: SELECTION,
      source: 'maestrly-review-loop',
      role: 'reviewer',
      turnPolicy: 'reviewer-readonly',
      cwdActivityOwner: 'review-loop:rl_1:reviewer',
      reviewerRuntime,
      executorConversationId: 'executor',
      reviewerConversationId: 'conv-chat',
      loopId: 'rl_1',
      iteration: 1,
      maxIterations: 5,
      signal: new AbortController().signal,
    })
    expect(started.ok).toBe(true)
    expect(h.runChat).toHaveBeenCalledWith(
      expect.objectContaining({
        behaviorOverride: 'ask',
        reviewerRuntime,
        messageMeta: expect.objectContaining({
          source: 'maestrly-review-loop',
          executionScope: expect.objectContaining({
            role: 'reviewer',
            executorConversationId: 'executor',
            reviewerConversationId: 'conv-chat',
          }),
        }),
      })
    )
  })

  it('admits bootstrap-owner internal turns without active review loops', async () => {
    h.reviewLoopLockFor.mockReturnValue(null)
    h.projectEnvironmentLockFor.mockReturnValue('pej_1')
    const started = await startInternalChatTurn({
      conversationId: 'conv-chat',
      prompt: 'Siga a skill habilitada e suba o ambiente.',
      selection: SELECTION,
      source: 'chatgpt-web-review-loop',
      loopId: 'pej_1',
      iteration: 1,
      maxIterations: 1,
      signal: new AbortController().signal,
    })
    expect(started.ok).toBe(true)
    if (!started.ok) return
    await expect(started.handle.done).resolves.toMatchObject({ status: 'success' })
    expect(h.runChat).toHaveBeenCalledOnce()
  })

  it('resolves outcomes once on success, error and cancellation', async () => {
    const handle = await startInternalChatTurn({
      conversationId: 'conv-chat',
      prompt: 'round',
      selection: SELECTION,
      source: 'chatgpt-web-review-loop',
      loopId: 'rl_1',
      iteration: 1,
      maxIterations: 5,
      signal: new AbortController().signal,
    })
    if (!handle.ok) throw new Error('esperava ok')
    const outcome = await handle.handle.done
    expect(outcome).toEqual({ status: 'success', assistantMessageId: expect.any(String) })
    // Resolves once: the second read returns the SAME result.
    expect(await handle.handle.done).toEqual(outcome)

    // Runner error produces an error outcome.
    h.runChat.mockRejectedValueOnce(new Error('provider failed'))
    const failed = await startInternalChatTurn({
      conversationId: 'conv-chat',
      prompt: 'round',
      selection: SELECTION,
      source: 'chatgpt-web-review-loop',
      loopId: 'rl_1',
      iteration: 1,
      maxIterations: 5,
      signal: new AbortController().signal,
    })
    if (!failed.ok) throw new Error('esperava ok')
    expect(await failed.handle.done).toMatchObject({ status: 'error', error: 'provider failed' })
  })

  it('accepts isolated Codex threads without binding persistence', async () => {
    codexH.setStatus('', 'padrao@example.com')
    codexH.preferredFastTier = null
    codexH.codexModels = [
      {
        id: 'gpt-5.6-sol',
        supportedReasoningEfforts: [{ reasoningEffort: 'low' }],
        defaultReasoningEffort: 'low',
      },
    ]
    h.getConvUiPrefs.mockReturnValue({
      chat: {
        providerId: 'builtin_codex_subscription',
        modelId: 'gpt-5.6-sol',
        mode: 'agent',
        reasoning: 'off',
        fastMode: false,
      },
    })
    const frozen = await resolveReviewLoopSelection('conv-chat')
    if ('error' in frozen) throw new Error('expected a valid Codex selection')

    h.runCodex.mockImplementationOnce(async (args: any) => {
      expect(args.ephemeralSession).toBe(true)
      expect(args.canPersistThread()).toBe(false)
      expect(args.onThreadReady('thread-ephemeral')).toBe(true)
      return { planSubmitted: false, threadId: 'thread-ephemeral' }
    })

    const started = await startInternalChatTurn({
      conversationId: 'conv-chat',
      prompt: 'corrija os findings',
      selection: frozen.selection,
      source: 'chatgpt-web-review-loop',
      loopId: 'rl_1',
      iteration: 1,
      maxIterations: 5,
      signal: new AbortController().signal,
    })
    if (!started.ok) throw new Error('esperava ok: ' + started.error)

    await expect(started.handle.done).resolves.toMatchObject({ status: 'success' })
    expect(h.runCodex).toHaveBeenCalledTimes(1)
  })

  it('aborts active runners and returns cancelled outcomes', async () => {
    let release!: () => void
    h.runChat.mockImplementation(async (args: { signal?: AbortSignal }) => {
      await new Promise<void>((resolve) => {
        release = resolve
        args.signal?.addEventListener('abort', () => resolve(), { once: true })
      })
      return { planSubmitted: false }
    })
    const started = await startInternalChatTurn({
      conversationId: 'conv-chat',
      prompt: 'round',
      selection: SELECTION,
      source: 'chatgpt-web-review-loop',
      loopId: 'rl_1',
      iteration: 1,
      maxIterations: 5,
      signal: new AbortController().signal,
    })
    if (!started.ok) throw new Error('esperava ok')
    started.handle.cancel()
    const outcome = await started.handle.done
    expect(outcome).toMatchObject({ status: 'cancelled' })
    void release
  })

  it('blocks manual turns while admitting loop owners', async () => {
    h.reviewLoopLockFor.mockReturnValue('rl_1' as never)
    const handlers = register()
    // Manual chat:send is blocked.
    const manual = await handlers.get('chat:send')?.({ sender: wc }, { conversationId: 'conv-chat', text: 'hello' })
    expect(manual).toEqual({ ok: false, error: 'review-loop-active' })
    // Internal turn with the WRONG loop_id is blocked.
    const wrong = await startInternalChatTurn({
      conversationId: 'conv-chat',
      prompt: 'round',
      selection: SELECTION,
      source: 'chatgpt-web-review-loop',
      loopId: 'rl_outro',
      iteration: 1,
      maxIterations: 5,
      signal: new AbortController().signal,
    })
    expect(wrong).toEqual({ ok: false, error: 'review-loop-active' })
    // The loop owner's turn passes.
    const owner = await startInternalChatTurn({
      conversationId: 'conv-chat',
      prompt: 'round',
      selection: SELECTION,
      source: 'chatgpt-web-review-loop',
      loopId: 'rl_1',
      iteration: 1,
      maxIterations: 5,
      signal: new AbortController().signal,
    })
    expect(owner.ok).toBe(true)
  })

  it('rejects missing override model IDs without discovery fallback', async () => {
    const result = await startInternalChatTurn({
      conversationId: 'conv-chat',
      prompt: 'round',
      selection: { providerId: 'provider-1', modelId: '', fastMode: false },
      source: 'chatgpt-web-review-loop',
      loopId: 'rl_1',
      iteration: 1,
      maxIterations: 5,
      signal: new AbortController().signal,
    })
    expect(result).toEqual({ ok: false, error: 'no-model' })
    expect(h.fetchModels).not.toHaveBeenCalled()
  })

  it('rejects pending plans and accepts chat-domain conversations', async () => {
    expect(await validateReviewLoopStart('conv-chat')).toEqual({ ok: true })
    h.getPendingPlan.mockReturnValue({ agentId: 'conv-chat', cwd, plan: 'x', version: 1, previousPlan: null } as never)
    expect(await validateReviewLoopStart('conv-chat')).toEqual({ ok: false, error: 'pending-plan' })
    h.getPendingPlan.mockReturnValue(null)
    h.getConversation.mockReturnValue({ id: 'conv-migrated', cwd, workspaceId: 'w' })
    expect(await validateReviewLoopStart('conv-migrated')).toEqual({ ok: true })

    h.getConversation.mockReturnValue({ id: 'conv-maestro', cwd, workspaceId: 'w', experience: 'maestro' })
    expect(await validateReviewLoopStart('conv-maestro')).toEqual({ ok: false, error: 'maestro-experience' })
    await expect(
      startInternalChatTurn({
        conversationId: 'conv-maestro',
        prompt: 'legacy executor turn',
        selection: SELECTION,
        source: 'chatgpt-web-review-loop',
        loopId: 'rl-maestro',
        iteration: 1,
        maxIterations: 1,
        signal: new AbortController().signal,
      })
    ).resolves.toEqual({ ok: false, error: 'maestro-experience' })
  })

  it('persists final summaries with stable loop IDs and Agent mode', async () => {
    const first = await persistReviewLoopSummary({
      conversationId: 'conv-chat',
      loopId: 'rl_abc',
      markdown: '## Review encerrado\n- resultado: limpo',
    })
    expect(first).toEqual({ ok: true, messageId: 'review-loop-summary:rl_abc' })
    const saved = h.upsertChatMessage.mock.calls.find(
      ([m]) => (m as { source?: string }).source === 'chatgpt-web-review-loop'
    )
    expect(saved).toBeTruthy()
    expect(saved?.[0]).toMatchObject({
      id: 'review-loop-summary:rl_abc',
      conversationId: 'conv-chat',
      role: 'assistant',
      source: 'chatgpt-web-review-loop',
      // Audit scope remains visible but outside inference and resume boundaries.
      executionScope: { kind: 'review-summary', loopId: 'rl_abc' },
    })
    // Without round metadata, summaries remain summaries in the renderer.
    expect((saved?.[0] as { reviewLoop?: unknown }).reviewLoop).toBeUndefined()
    expect((saved?.[0] as { internal?: boolean }).internal).toBeUndefined()
    // Retrying the SAME loopId uses the same messageId (upsert without duplication).
    const retry = await persistReviewLoopSummary({
      conversationId: 'conv-chat',
      loopId: 'rl_abc',
      markdown: '## Review encerrado\n- resultado: limpo',
    })
    expect(retry).toEqual({ ok: true, messageId: 'review-loop-summary:rl_abc' })
    const sameId = h.upsertChatMessage.mock.calls.filter(
      ([m]) => (m as { id?: string }).id === 'review-loop-summary:rl_abc'
    )
    expect(sameId).toHaveLength(2) // Two upserts with the SAME id.

    // Force Agent mode and notify the renderer.
    h.getConvUiPrefs.mockReturnValue({ chat: { providerId: 'provider-1', modelId: 'model-1', mode: 'plan' } })
    forceReviewLoopAgentMode('conv-chat')
    expect(wc.send).toHaveBeenCalledWith('chat:mode:conv-chat', 'agent')
    expect(h.upsertChatMessage).toBeDefined()
    void cancelInternalChatTurn
  })

  it('uses deterministic paired-summary role IDs and neutral provenance', async () => {
    const result = await persistReviewLoopSummary({
      conversationId: 'conv-chat',
      loopId: 'rl_pair',
      role: 'reviewer',
      executorConversationId: 'executor',
      reviewerConversationId: 'conv-chat',
      markdown: '# Paired review',
    })
    expect(result).toEqual({ ok: true, messageId: 'review-loop-summary:rl_pair:reviewer' })
    expect(h.upsertChatMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'review-loop-summary:rl_pair:reviewer',
        source: 'maestrly-review-loop',
        executionScope: {
          kind: 'review-summary',
          loopId: 'rl_pair',
          role: 'reviewer',
          executorConversationId: 'executor',
          reviewerConversationId: 'conv-chat',
        },
      })
    )
  })

  it('cancels preflight without admission or persisted messages', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    h.getModelMeta.mockImplementationOnce(async () => {
      await gate // Pending preflight (effectiveModelMeta to preflightContext).
      return null
    })
    const ac = new AbortController()
    const started = startInternalChatTurn({
      conversationId: 'conv-chat',
      prompt: 'round',
      selection: SELECTION,
      source: 'chatgpt-web-review-loop',
      loopId: 'rl_1',
      iteration: 1,
      maxIterations: 5,
      signal: ac.signal,
    })
    await vi.waitFor(() => expect(h.getModelMeta).toHaveBeenCalled())
    ac.abort() // Stop during preflight.
    release()
    expect(await started).toEqual({ ok: false, error: 'cancelled' })
    expect(h.runChat).not.toHaveBeenCalled()
    // Persist no internal user or assistant messages.
    expect(h.upsertChatMessage.mock.calls.filter(([m]) => (m as { role?: string }).role === 'user')).toHaveLength(0)
    expect(pendingInternalTurnsCount()).toBe(0)
  })

  it('rejects loops whose locks disappear during preflight', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    h.getModelMeta.mockImplementationOnce(async () => {
      await gate
      return null
    })
    h.reviewLoopLockFor.mockReturnValue('rl_1' as never)
    const started = startInternalChatTurn({
      conversationId: 'conv-chat',
      prompt: 'round',
      selection: SELECTION,
      source: 'chatgpt-web-review-loop',
      loopId: 'rl_1',
      iteration: 1,
      maxIterations: 5,
      signal: new AbortController().signal,
    })
    await vi.waitFor(() => expect(h.getModelMeta).toHaveBeenCalled())
    h.reviewLoopLockFor.mockReturnValue(null) // Loop ended during preflight.
    release()
    expect(await started).toEqual({ ok: false, error: 'review-loop-inactive' })
    expect(h.runChat).not.toHaveBeenCalled()
    expect(pendingInternalTurnsCount()).toBe(0)
  })

  it('internalTurns cleanup removes the entry on every terminal outcome: success, error, or cancel', async () => {
    const turnArgs = (signal: AbortSignal) => ({
      conversationId: 'conv-chat',
      prompt: 'round',
      selection: SELECTION,
      source: 'chatgpt-web-review-loop' as const,
      loopId: 'rl_1',
      iteration: 1,
      maxIterations: 5,
      signal,
    })
    // Keep runChat pending long enough to inspect live admission.
    let releaseSuccess!: () => void
    h.runChat.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        releaseSuccess = resolve
      })
      return { planSubmitted: false }
    })
    const ok = await startInternalChatTurn(turnArgs(new AbortController().signal))
    if (!ok.ok) throw new Error('esperava ok')
    const execId = ok.handle.executionId
    expect(pendingInternalTurnsCount()).toBe(1)
    releaseSuccess()
    await ok.handle.done
    await vi.waitFor(() => expect(pendingInternalTurnsCount()).toBe(0))
    // Completed executions ignore cancellation by old execution IDs.
    cancelInternalChatTurn(execId)
    expect(pendingInternalTurnsCount()).toBe(0)
    // Handles fully release cwd and active slots; without ChatView consumers,
    // render-only done events do not cross IPC.
    expect(
      wc.send.mock.calls.some(([ch, ev]) => ch === 'chat:delta:conv-chat' && (ev as { kind?: string }).kind === 'done')
    ).toBe(false)
    // Outcomes resolve before final slot teardown; wait before the next
    // scenario in this sequence.
    await new Promise<void>((resolve) => setTimeout(resolve, 0))

    // error
    h.runChat.mockRejectedValueOnce(new Error('provider failed'))
    const failed = await startInternalChatTurn(turnArgs(new AbortController().signal))
    if (!failed.ok) throw new Error('esperava ok')
    await failed.handle.done
    await vi.waitFor(() => expect(pendingInternalTurnsCount()).toBe(0))

    // cancel
    let releaseCancel!: () => void
    h.runChat.mockImplementation(async (args: { signal?: AbortSignal }) => {
      await new Promise<void>((resolve) => {
        releaseCancel = resolve
        args.signal?.addEventListener('abort', () => resolve(), { once: true })
      })
      return { planSubmitted: false }
    })
    const cancelled = await startInternalChatTurn(turnArgs(new AbortController().signal))
    if (!cancelled.ok) throw new Error('esperava ok')
    cancelled.handle.cancel()
    await cancelled.handle.done
    await vi.waitFor(() => expect(pendingInternalTurnsCount()).toBe(0))
    void releaseCancel
  })

  it('rejects pre-aborted starts before preflight', async () => {
    const ac = new AbortController()
    ac.abort()
    const result = await startInternalChatTurn({
      conversationId: 'conv-chat',
      prompt: 'round',
      selection: SELECTION,
      source: 'chatgpt-web-review-loop',
      loopId: 'rl_1',
      iteration: 1,
      maxIterations: 5,
      signal: ac.signal,
    })
    expect(result).toEqual({ ok: false, error: 'cancelled' })
    expect(h.getModelMeta).not.toHaveBeenCalled()
    expect(h.runChat).not.toHaveBeenCalled()
    expect(pendingInternalTurnsCount()).toBe(0)
  })

  it('forwards frozen Fast despite divergent preferences', async () => {
    h.getConvUiPrefs.mockReturnValue({
      chat: { providerId: 'provider-1', modelId: 'model-1', mode: 'agent', fastMode: false },
    })
    const handle = await startInternalChatTurn({
      conversationId: 'conv-chat',
      prompt: 'round',
      selection: { providerId: 'provider-1', modelId: 'model-1', fastMode: true },
      source: 'chatgpt-web-review-loop',
      loopId: 'rl_1',
      iteration: 1,
      maxIterations: 5,
      signal: new AbortController().signal,
    })
    if (!handle.ok) throw new Error('esperava ok: ' + handle.error)
    expect(h.runChat).toHaveBeenCalledWith(
      expect.objectContaining({
        fastModeOverride: true,
        ephemeralSession: true,
        behaviorOverride: 'agent',
      })
    )
    await handle.handle.done
  })

  it('isolates execution IDs and message metadata per round', async () => {
    const first = await startInternalChatTurn({
      conversationId: 'conv-chat',
      prompt: 'round 1',
      selection: SELECTION,
      source: 'chatgpt-web-review-loop',
      loopId: 'rl_1',
      iteration: 1,
      maxIterations: 5,
      signal: new AbortController().signal,
    })
    if (!first.ok) throw new Error('esperava ok')
    await first.handle.done
    await vi.waitFor(() => expect(pendingInternalTurnsCount()).toBe(0))

    const second = await startInternalChatTurn({
      conversationId: 'conv-chat',
      prompt: 'round 2',
      selection: SELECTION,
      source: 'chatgpt-web-review-loop',
      loopId: 'rl_1',
      iteration: 2,
      maxIterations: 5,
      signal: new AbortController().signal,
    })
    if (!second.ok) throw new Error('esperava ok')
    await second.handle.done

    expect(first.handle.executionId).not.toBe(second.handle.executionId)
    const meta1 = (
      h.runChat.mock.calls[0]?.[0] as { messageMeta?: { executionScope?: { executionId: string; iteration: number } } }
    ).messageMeta
    const meta2 = (
      h.runChat.mock.calls[1]?.[0] as { messageMeta?: { executionScope?: { executionId: string; iteration: number } } }
    ).messageMeta
    expect(meta1?.executionScope?.executionId).toBe(first.handle.executionId)
    expect(meta2?.executionScope?.executionId).toBe(second.handle.executionId)
    expect(meta1?.executionScope?.iteration).toBe(1)
    expect(meta2?.executionScope?.iteration).toBe(2)
  })

  it('does not compact main history during isolated preflight', async () => {
    h.getModelMeta.mockResolvedValue({ contextWindow: 200_000 } as never)
    const handle = await startInternalChatTurn({
      conversationId: 'conv-chat',
      prompt: 'round',
      selection: SELECTION,
      source: 'chatgpt-web-review-loop',
      loopId: 'rl_1',
      iteration: 1,
      maxIterations: 5,
      signal: new AbortController().signal,
    })
    if (!handle.ok) throw new Error('esperava ok: ' + handle.error)
    // Isolated preflight never reads main history or stats before admission.
    expect(h.chatHistoryStats).not.toHaveBeenCalled()
    expect(h.runChat).toHaveBeenCalled()
    await handle.handle.done
  })

  it('invalidates usage caches on terminal outcomes', async () => {
    let release!: () => void
    h.runChat.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return { planSubmitted: false }
    })
    const handle = await startInternalChatTurn({
      conversationId: 'conv-chat',
      prompt: 'round',
      selection: SELECTION,
      source: 'chatgpt-web-review-loop',
      loopId: 'rl_1',
      iteration: 1,
      maxIterations: 5,
      signal: new AbortController().signal,
    })
    if (!handle.ok) throw new Error('esperava ok')
    expect(h.invalidateUnifiedUsageCache).not.toHaveBeenCalled()
    release()
    await handle.handle.done
    await vi.waitFor(() => expect(h.invalidateUnifiedUsageCache).toHaveBeenCalled())
  })

  it('materializes explicit frozen off and default axes', async () => {
    // Default preferences without reasoning.
    h.getConvUiPrefs.mockReturnValue({
      chat: { providerId: 'provider-1', modelId: 'model-1', mode: 'agent' },
    })
    const def = await resolveReviewLoopSelection('conv-chat')
    if ('error' in def) throw new Error('esperava ok')
    expect(def.selection.reasoning).toBe('off')

    // Explicit off.
    h.getConvUiPrefs.mockReturnValue({
      chat: { providerId: 'provider-1', modelId: 'model-1', mode: 'agent', reasoning: 'off' },
    })
    const off = await resolveReviewLoopSelection('conv-chat')
    if ('error' in off) throw new Error('esperava ok')
    expect(off.selection.reasoning).toBe('off')

    // Real levels require catalog evidence or start fails closed.
    h.getProviderModelMeta.mockResolvedValue({ reasoning: true, reasoningEfforts: ['low', 'high'] } as never)
    h.getConvUiPrefs.mockReturnValue({
      chat: { providerId: 'provider-1', modelId: 'model-1', mode: 'agent', reasoning: 'high' },
    })
    const high = await resolveReviewLoopSelection('conv-chat')
    if ('error' in high) throw new Error('esperava ok')
    expect(high.selection.reasoning).toBe('high')
    // Frozen EFFECT: the value that WILL be sent (same as raw; no Ultra here).
    expect(high.selection.reasoningEffort).toBe('high')
  })

  it('fails BYOK freeze closed without support evidence', async () => {
    h.getConvUiPrefs.mockReturnValue({
      chat: { providerId: 'provider-1', modelId: 'model-1', mode: 'agent', reasoning: 'high' },
    })
    // Offline metadata (mock defaults to null).
    const offline = await resolveReviewLoopSelection('conv-chat')
    expect(offline).toEqual({ ok: false, error: 'no-model' })
    // Model without reasoning in metadata.
    h.getProviderModelMeta.mockResolvedValue({ reasoning: false, reasoningEfforts: [] } as never)
    expect(await resolveReviewLoopSelection('conv-chat')).toEqual({ ok: false, error: 'no-model' })
    // Empty effort lists provide no strict fallback evidence.
    h.getProviderModelMeta.mockResolvedValue({ reasoning: true, reasoningEfforts: [] } as never)
    expect(await resolveReviewLoopSelection('conv-chat')).toEqual({ ok: false, error: 'no-model' })
    // A level outside the supported list.
    h.getProviderModelMeta.mockResolvedValue({ reasoning: true, reasoningEfforts: ['low'] } as never)
    expect(await resolveReviewLoopSelection('conv-chat')).toEqual({ ok: false, error: 'no-model' })
    // Supported levels freeze their actual transport effect.
    h.getProviderModelMeta.mockResolvedValue({ reasoning: true, reasoningEfforts: ['low', 'high'] } as never)
    const ok = await resolveReviewLoopSelection('conv-chat')
    if ('error' in ok) throw new Error('esperava ok')
    expect(ok.selection.reasoningEffort).toBe('high')
  })

  it('a round with frozen reasoning off overrides conflicting BYOK runner preferences', async () => {
    const frozen = await resolveReviewLoopSelection('conv-chat')
    if ('error' in frozen) throw new Error('esperava ok')
    expect(frozen.selection.reasoning).toBe('off') // prefs default no freeze
    // Live effort changes do not override frozen off.
    h.getConvUiPrefs.mockReturnValue({
      chat: { providerId: 'provider-1', modelId: 'model-1', mode: 'agent', reasoning: 'high' },
    })
    const handle = await startInternalChatTurn({
      conversationId: 'conv-chat',
      prompt: 'round',
      selection: frozen.selection,
      source: 'chatgpt-web-review-loop',
      loopId: 'rl_1',
      iteration: 1,
      maxIterations: 5,
      signal: new AbortController().signal,
    })
    if (!handle.ok) throw new Error('esperava ok: ' + handle.error)
    expect(h.runChat).toHaveBeenCalledWith(
      expect.objectContaining({
        reasoningOverride: 'off',
        fastModeOverride: false,
      })
    )
    await handle.handle.done
  })

  it('a round with frozen reasoning high overrides conflicting BYOK runner preferences', async () => {
    h.getProviderModelMeta.mockResolvedValue({ reasoning: true, reasoningEfforts: ['low', 'high'] } as never)
    h.getConvUiPrefs.mockReturnValue({
      chat: { providerId: 'provider-1', modelId: 'model-1', mode: 'agent', reasoning: 'high' },
    })
    const frozen = await resolveReviewLoopSelection('conv-chat')
    if ('error' in frozen) throw new Error('esperava ok')
    expect(frozen.selection.reasoning).toBe('high')
    expect(frozen.selection.reasoningEffort).toBe('high')
    // Lower live efforts do not replace frozen levels.
    h.getConvUiPrefs.mockReturnValue({
      chat: { providerId: 'provider-1', modelId: 'model-1', mode: 'agent', reasoning: 'low' },
    })
    const handle = await startInternalChatTurn({
      conversationId: 'conv-chat',
      prompt: 'round',
      selection: frozen.selection,
      source: 'chatgpt-web-review-loop',
      loopId: 'rl_1',
      iteration: 1,
      maxIterations: 5,
      signal: new AbortController().signal,
    })
    if (!handle.ok) throw new Error('esperava ok: ' + handle.error)
    expect(h.runChat).toHaveBeenCalledWith(
      expect.objectContaining({
        reasoningOverride: 'high',
        frozenReasoningEffort: 'high',
        fastModeOverride: false,
      })
    )
    await handle.handle.done
  })

  it('keeps frozen reasoning authoritative and reads live preferences only without profiles', () => {
    // Frozen legacy profile WITHOUT a materialized axis: off, never live preferences.
    expect(turnReasoning('conv-chat', { providerId: 'p', modelId: 'm', fastMode: false })).toBe('off')
    // Explicit frozen off wins over preferences.
    expect(turnReasoning('conv-chat', { providerId: 'p', modelId: 'm', fastMode: false, reasoning: 'off' })).toBe('off')
    // Frozen levels win over preferences.
    expect(turnReasoning('conv-chat', { providerId: 'p', modelId: 'm', fastMode: false, reasoning: 'high' })).toBe(
      'high'
    )
    // Without a profile: live preferences (normal path).
    h.getConvUiPrefs.mockReturnValue({
      chat: { providerId: 'provider-1', modelId: 'model-1', mode: 'agent', reasoning: 'medium' },
    })
    expect(turnReasoning('conv-chat', undefined)).toBe('medium')
    h.getConvUiPrefs.mockReturnValue({ chat: { providerId: 'provider-1', modelId: 'model-1', mode: 'agent' } })
    expect(turnReasoning('conv-chat', undefined)).toBeUndefined()
  })

  it('freezes additional Codex account epochs independently', async () => {
    codexH.setStatus('acc_1', 'extra@example.com')
    codexH.setStatus('', 'padrao@example.com')
    h.getConvUiPrefs.mockReturnValue({
      chat: { providerId: 'builtin_codex_subscription@acc_1', modelId: 'gpt-5.6-sol', mode: 'agent' },
    })
    const frozen = await resolveReviewLoopSelection('conv-chat')
    if ('error' in frozen) throw new Error('esperava ok')
    // Slot fingerprints and epochs are independent of the default account epoch.
    expect(frozen.selection.identityFingerprint).toMatch(/^chatgpt:/)
    expect(frozen.selection.identityEpoch).toBeUndefined()
    expect(frozen.selection.providerId).toBe('builtin_codex_subscription@acc_1')
  })

  it('ignores default-account epochs for additional-account loops', async () => {
    codexH.setStatus('acc_1', 'extra@example.com')
    codexH.setStatus('', 'padrao@example.com')
    h.getConvUiPrefs.mockReturnValue({
      chat: { providerId: 'builtin_codex_subscription@acc_1', modelId: 'gpt-5.6-sol', mode: 'agent' },
    })
    const frozen = await resolveReviewLoopSelection('conv-chat')
    if ('error' in frozen) throw new Error('esperava ok')

    // Same slot fingerprint (same CODEX_HOME) revalidates even when the GLOBAL epoch has moved
    // (simulated by a legacy freeze carrying the old epoch; the guard ignores it for additional slots).
    const legacyWithGlobalEpoch = { ...frozen.selection, identityEpoch: 0 }
    expect(await revalidateReviewLoopSelection(legacyWithGlobalEpoch)).toEqual({ ok: true })

    // Selected SLOT identity changed (account switch in its CODEX_HOME): executor_unavailable.
    codexH.setStatus('acc_1', 'other@example.com')
    expect(await revalidateReviewLoopSelection(legacyWithGlobalEpoch)).toEqual({
      ok: false,
      error: 'executor-unavailable',
    })
  })

  it('DEFAULT Codex account keeps freezing and comparing the global epoch', async () => {
    codexH.setStatus('', 'padrao@example.com')
    h.getConvUiPrefs.mockReturnValue({
      chat: { providerId: 'builtin_codex_subscription', modelId: 'gpt-5.6-sol', mode: 'agent' },
    })
    const frozen = await resolveReviewLoopSelection('conv-chat')
    if ('error' in frozen) throw new Error('esperava ok')
    // Default accounts freeze the global epoch.
    expect(typeof frozen.selection.identityEpoch).toBe('number')
    expect(await revalidateReviewLoopSelection(frozen.selection)).toEqual({ ok: true })
    // Changed default epochs make executors unavailable.
    expect(await revalidateReviewLoopSelection({ ...frozen.selection, identityEpoch: 999 })).toEqual({
      ok: false,
      error: 'executor-unavailable',
    })
  })

  it('fails strict loop effort resolution closed while preserving manual defaults', () => {
    // Strict unsupported levels never use default effort fallback.
    expect(
      resolveNativeReasoningEffort({
        requestedEffort: 'high',
        supportedEfforts: ['low', 'medium'],
        defaultEffort: 'medium',
        strict: true,
      })
    ).toEqual({ ok: false })
    // Strict Ultra without known levels never uses defaults.
    expect(
      resolveNativeReasoningEffort({
        requestedEffort: 'ultra',
        supportedEfforts: [],
        defaultEffort: 'medium',
        strict: true,
      })
    ).toEqual({ ok: false })
    // Supported, off and absent efforts remain reproducible.
    expect(
      resolveNativeReasoningEffort({
        requestedEffort: 'high',
        supportedEfforts: ['low', 'high'],
        defaultEffort: 'low',
        strict: true,
      })
    ).toEqual({ ok: true, reasoningEffort: 'high', maestrlyUltra: false })
    expect(
      resolveNativeReasoningEffort({
        requestedEffort: 'off',
        supportedEfforts: [],
        defaultEffort: 'medium',
        strict: true,
      })
    ).toEqual({ ok: true, maestrlyUltra: false })
    expect(
      resolveNativeReasoningEffort({
        requestedEffort: undefined,
        supportedEfforts: [],
        defaultEffort: 'medium',
        strict: true,
      })
    ).toEqual({ ok: true, maestrlyUltra: false })
    // Empty strict support lists never pass non-off values through.
    expect(
      resolveNativeReasoningEffort({
        requestedEffort: 'high',
        supportedEfforts: [],
        defaultEffort: 'medium',
        strict: true,
      })
    ).toEqual({ ok: false })
    expect(
      resolveNativeReasoningEffort({
        requestedEffort: 'max',
        supportedEfforts: [],
        defaultEffort: 'medium',
        strict: true,
      })
    ).toEqual({ ok: false })
    // Strict Ultra resolves to the highest known level.
    expect(
      resolveNativeReasoningEffort({
        requestedEffort: 'ultra',
        supportedEfforts: ['low', 'medium', 'high'],
        defaultEffort: 'low',
        strict: true,
      })
    ).toEqual({ ok: true, reasoningEffort: 'high', maestrlyUltra: true })
    // Permissive manual turn preserves current behavior: fallback to default.
    expect(
      resolveNativeReasoningEffort({
        requestedEffort: 'high',
        supportedEfforts: ['low'],
        defaultEffort: 'medium',
        strict: false,
      })
    ).toEqual({ ok: true, reasoningEffort: 'medium', maestrlyUltra: false })
    expect(
      resolveNativeReasoningEffort({
        requestedEffort: 'ultra',
        supportedEfforts: [],
        defaultEffort: 'medium',
        strict: false,
      })
    ).toEqual({ ok: true, reasoningEffort: 'medium', maestrlyUltra: true })
  })

  it('rejects unreproducible frozen Claude runtime axes', () => {
    // Effort outside supported levels.
    const unsupported = claudeRuntimeAxes(
      'conv-chat',
      {
        value: 'claude-x',
        supportsEffort: true,
        supportedEffortLevels: ['low', 'medium'],
        supportsFastMode: false,
      } as never,
      'high',
      false,
      true
    )
    expect(unsupported.frozenReproducible).toBe(false)
    expect(unsupported.reasoningEffort).toBeUndefined()
    // Model without effort support.
    const noEffort = claudeRuntimeAxes(
      'conv-chat',
      { value: 'claude-x', supportsEffort: false, supportedEffortLevels: [], supportsFastMode: false } as never,
      'high',
      false,
      true
    )
    expect(noEffort.frozenReproducible).toBe(false)
    // Ultra without known levels.
    const ultra = claudeRuntimeAxes(
      'conv-chat',
      { value: 'claude-x', supportsEffort: true, supportedEffortLevels: [], supportsFastMode: false } as never,
      'ultra',
      false,
      true
    )
    expect(ultra.frozenReproducible).toBe(false)
    // Empty support lists cannot pass non-off values through.
    const emptyList = claudeRuntimeAxes(
      'conv-chat',
      { value: 'claude-x', supportsEffort: true, supportedEffortLevels: [], supportsFastMode: false } as never,
      'high',
      false,
      true
    )
    expect(emptyList.frozenReproducible).toBe(false)
    expect(emptyList.reasoningEffort).toBe('high') // Permissive would pass; strict rejects.
    // Frozen Fast=true without actual model support.
    const fast = claudeRuntimeAxes(
      'conv-chat',
      { value: 'claude-x', supportsEffort: true, supportedEffortLevels: ['high'], supportsFastMode: false } as never,
      'high',
      true,
      true
    )
    expect(fast.frozenReproducible).toBe(false)
    expect(fast.fastMode).toBe(false)
    // Fully reproducible profiles pass; permissive mode remains true.
    const ok = claudeRuntimeAxes(
      'conv-chat',
      {
        value: 'claude-x',
        supportsEffort: true,
        supportedEffortLevels: ['low', 'high'],
        supportsFastMode: true,
      } as never,
      'high',
      true,
      true
    )
    expect(ok.frozenReproducible).toBe(true)
    expect(ok.reasoningEffort).toBe('high')
    expect(ok.fastMode).toBe(true)
    const permissive = claudeRuntimeAxes(
      'conv-chat',
      { value: 'claude-x', supportsEffort: true, supportedEffortLevels: ['low'], supportsFastMode: false } as never,
      'high',
      false,
      false
    )
    expect(permissive.frozenReproducible).toBe(true)
  })

  it('frozen Codex Fast without a preferred tier returns executor_unavailable and never degrades to default', async () => {
    codexH.setStatus('', 'padrao@example.com')
    codexH.preferredFastTier = null // The Fast tier DISAPPEARED between freeze and round.
    codexH.codexModels = []
    h.getConvUiPrefs.mockReturnValue({
      chat: {
        providerId: 'builtin_codex_subscription',
        modelId: 'gpt-5.6-sol',
        mode: 'agent',
        reasoning: 'off',
        fastMode: true,
      },
    })
    const frozen = await resolveReviewLoopSelection('conv-chat')
    if ('error' in frozen) throw new Error('esperava ok')
    expect(frozen.selection.fastMode).toBe(true)
    const handle = await startInternalChatTurn({
      conversationId: 'conv-chat',
      prompt: 'round',
      selection: frozen.selection,
      source: 'chatgpt-web-review-loop',
      loopId: 'rl_1',
      iteration: 1,
      maxIterations: 5,
      signal: new AbortController().signal,
    })
    if (!handle.ok) throw new Error('esperava ok: ' + handle.error)
    // Fail closed: the round does NOT run with default serviceTier; it becomes executor_unavailable.
    expect(await handle.handle.done).toMatchObject({ status: 'error', error: 'executor-unavailable' })
  })

  it('rejects vanished frozen Codex efforts', async () => {
    codexH.setStatus('', 'padrao@example.com')
    codexH.preferredFastTier = null
    codexH.codexModels = [
      { id: 'gpt-5.6-sol', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] },
    ]
    h.getConvUiPrefs.mockReturnValue({
      chat: {
        providerId: 'builtin_codex_subscription',
        modelId: 'gpt-5.6-sol',
        mode: 'agent',
        reasoning: 'high',
        fastMode: false,
      },
    })
    const frozen = await resolveReviewLoopSelection('conv-chat')
    if ('error' in frozen) throw new Error('esperava ok')
    expect(frozen.selection.reasoningEffort).toBe('high')
    // If high disappears from the catalog, do not run with default or omitted effort.
    codexH.codexModels = [
      { id: 'gpt-5.6-sol', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }] },
    ]
    const handle = await startInternalChatTurn({
      conversationId: 'conv-chat',
      prompt: 'round',
      selection: frozen.selection,
      source: 'chatgpt-web-review-loop',
      loopId: 'rl_1',
      iteration: 1,
      maxIterations: 5,
      signal: new AbortController().signal,
    })
    if (!handle.ok) throw new Error('esperava ok: ' + handle.error)
    // Fail closed: never runs with defaultReasoningEffort or missing effort; becomes executor_unavailable.
    expect(await handle.handle.done).toMatchObject({ status: 'error', error: 'executor-unavailable' })
  })

  it('does not start loops with unsupported Codex efforts', async () => {
    codexH.setStatus('', 'padrao@example.com')
    codexH.codexModels = [
      { id: 'gpt-5.6-sol', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }] },
    ]
    h.getConvUiPrefs.mockReturnValue({
      chat: {
        providerId: 'builtin_codex_subscription',
        modelId: 'gpt-5.6-sol',
        mode: 'agent',
        reasoning: 'high',
        fastMode: false,
      },
    })
    expect(await resolveReviewLoopSelection('conv-chat')).toEqual({ ok: false, error: 'no-model' })
  })

  it('rejects changed Codex Ultra effort lists after freeze', async () => {
    codexH.setStatus('', 'padrao@example.com')
    codexH.preferredFastTier = null
    // Freeze with [low, medium, max]: Ultra resolves to the EFFECT max.
    codexH.codexModels = [
      {
        id: 'gpt-5.6-sol',
        supportedReasoningEfforts: [
          { reasoningEffort: 'low' },
          { reasoningEffort: 'medium' },
          { reasoningEffort: 'max' },
        ],
      },
    ]
    h.getConvUiPrefs.mockReturnValue({
      chat: {
        providerId: 'builtin_codex_subscription',
        modelId: 'gpt-5.6-sol',
        mode: 'agent',
        reasoning: 'ultra',
        fastMode: false,
      },
    })
    const frozen = await resolveReviewLoopSelection('conv-chat')
    if ('error' in frozen) throw new Error('esperava ok')
    // Raw sentinel and frozen max differ; live catalogs cannot change the frozen effect.
    expect(frozen.selection.reasoning).toBe('ultra')
    expect(frozen.selection.reasoningEffort).toBe('max')
    // The list changes during the loop: Ultra would now resolve high, so the round CANNOT run.
    codexH.codexModels = [
      {
        id: 'gpt-5.6-sol',
        supportedReasoningEfforts: [
          { reasoningEffort: 'low' },
          { reasoningEffort: 'medium' },
          { reasoningEffort: 'high' },
        ],
      },
    ]
    const handle = await startInternalChatTurn({
      conversationId: 'conv-chat',
      prompt: 'round',
      selection: frozen.selection,
      source: 'chatgpt-web-review-loop',
      loopId: 'rl_1',
      iteration: 1,
      maxIterations: 5,
      signal: new AbortController().signal,
    })
    if (!handle.ok) throw new Error('esperava ok: ' + handle.error)
    expect(await handle.handle.done).toMatchObject({ status: 'error', error: 'executor-unavailable' })
  })

  it('does not start Copilot loops without serializable catalog efforts', async () => {
    codexH.setStatus('', 'padrao@example.com')
    h.getConvUiPrefs.mockReturnValue({
      chat: {
        providerId: 'builtin_github_copilot_subscription',
        modelId: 'gpt-5.6-sol',
        mode: 'agent',
        reasoning: 'max',
        fastMode: false,
      },
    })
    // Empty effort lists fail start closed.
    copilotH.models = [{ id: 'gpt-5.6-sol' }]
    expect(await resolveReviewLoopSelection('conv-chat')).toEqual({ ok: false, error: 'no-model' })
    // The list declares max, but the official runner ONLY serializes low/medium/high/xhigh: start fails closed.
    copilotH.models = [{ id: 'gpt-5.6-sol', supportedReasoningEfforts: ['low', 'medium', 'max'] }]
    expect(await resolveReviewLoopSelection('conv-chat')).toEqual({ ok: false, error: 'no-model' })
    // Unsupported levels fail start closed.
    copilotH.models = [{ id: 'gpt-5.6-sol', supportedReasoningEfforts: ['low', 'medium'] }]
    expect(await resolveReviewLoopSelection('conv-chat')).toEqual({ ok: false, error: 'no-model' })
    // Freeze only supported serializable transport values.
    h.getConvUiPrefs.mockReturnValue({
      chat: {
        providerId: 'builtin_github_copilot_subscription',
        modelId: 'gpt-5.6-sol',
        mode: 'agent',
        reasoning: 'xhigh',
        fastMode: false,
      },
    })
    copilotH.models = [{ id: 'gpt-5.6-sol', supportedReasoningEfforts: ['low', 'medium', 'xhigh'] }]
    const ok = await resolveReviewLoopSelection('conv-chat')
    if ('error' in ok) throw new Error('esperava ok')
    expect(ok.selection.reasoningEffort).toBe('xhigh')
  })

  it('Copilot effective effort disappearing between freeze and round returns executor_unavailable', async () => {
    h.getConvUiPrefs.mockReturnValue({
      chat: {
        providerId: 'builtin_github_copilot_subscription',
        modelId: 'gpt-5.6-sol',
        mode: 'agent',
        reasoning: 'high',
        fastMode: false,
      },
    })
    copilotH.models = [{ id: 'gpt-5.6-sol', supportedReasoningEfforts: ['low', 'high'] }]
    const frozen = await resolveReviewLoopSelection('conv-chat')
    if ('error' in frozen) throw new Error('esperava ok')
    expect(frozen.selection.reasoningEffort).toBe('high')

    // Official runners cannot omit frozen efforts when capabilities disappear.
    copilotH.models = [{ id: 'gpt-5.6-sol', supportedReasoningEfforts: ['low', 'medium'] }]
    expect(await revalidateReviewLoopSelection(frozen.selection)).toEqual({
      ok: false,
      error: 'executor-unavailable',
    })
  })

  it('uses frozen effective Codex effort for isolated compaction', async () => {
    codexH.setStatus('', 'padrao@example.com')
    codexH.preferredFastTier = 'priority'
    // Isolated compaction revalidates frozen effects like new rounds.
    codexH.codexModels = [
      {
        id: 'gpt-5.6-sol',
        supportedReasoningEfforts: [
          { reasoningEffort: 'low' },
          { reasoningEffort: 'medium' },
          { reasoningEffort: 'max' },
        ],
      },
    ]
    h.listExecutionContextMessages.mockReturnValue([
      {
        id: 'u1',
        conversationId: 'conv-chat',
        role: 'user',
        parts: [{ type: 'text', id: 't1', text: 'round findings' }],
        createdAt: 1,
      },
      {
        id: 'a1',
        conversationId: 'conv-chat',
        role: 'assistant',
        parts: [{ type: 'text', id: 't2', text: 'work in progress' }],
        model: { providerId: 'builtin_codex_subscription', modelId: 'gpt-5.6-sol' },
        createdAt: 2,
      },
    ] as never)
    const frozen = {
      providerId: 'builtin_codex_subscription',
      modelId: 'gpt-5.6-sol',
      // Raw Ultra plus effective max (round 4): the helper receives the SAME effort as the main turn.
      reasoning: 'ultra',
      reasoningEffort: 'max',
      fastMode: true,
      serviceTier: 'priority',
    }
    const result = await compactReserved('conv-chat', {
      executionId: 'exec-1',
      selectionOverride: frozen,
      persist: false,
      skipRetireBinding: true,
    })
    expect(result.ok).toBe(true)
    // Intra-turn compaction uses effective max, never raw Ultra.
    expect(h.summarizeCodex).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: 'gpt-5.6-sol', effort: 'max', serviceTier: 'priority' })
    )
  })

  it('revalidates and serializes frozen BYOK efforts for isolated compaction', async () => {
    // Valid metadata verifies that the frozen value
    // is serialized without another mutable resolution.
    h.getProviderModelMeta.mockResolvedValue({
      reasoning: true,
      reasoningEfforts: ['low', 'medium', 'high', 'max'],
    } as never)
    h.listExecutionContextMessages.mockReturnValue([
      {
        id: 'u1',
        conversationId: 'conv-chat',
        role: 'user',
        parts: [{ type: 'text', id: 't1', text: 'round findings' }],
        createdAt: 1,
      },
      {
        id: 'a1',
        conversationId: 'conv-chat',
        role: 'assistant',
        parts: [{ type: 'text', id: 't2', text: 'work in progress' }],
        model: { providerId: 'provider-1', modelId: 'model-1' },
        createdAt: 2,
      },
    ] as never)
    h.generateText.mockResolvedValue({ text: 'summary byok', usage: { totalTokens: 15 } } as never)
    const frozen = {
      providerId: 'provider-1',
      modelId: 'model-1',
      reasoning: 'ultra',
      reasoningEffort: 'max',
      fastMode: false,
    }
    const result = await compactReserved('conv-chat', {
      executionId: 'exec-1',
      selectionOverride: frozen,
      persist: false,
      skipRetireBinding: true,
    })
    expect(result.ok).toBe(true)
    // Serialize already-validated sent efforts; mutable
    // or missing metadata cannot drop the active main-turn effort.
    expect(h.generateText).toHaveBeenCalledWith(
      expect.objectContaining({ providerOptions: { 'openai-compatible': { reasoningEffort: 'max' } } })
    )
  })

  it('rejects vanished frozen BYOK efforts', async () => {
    h.getConvUiPrefs.mockReturnValue({
      chat: { providerId: 'provider-1', modelId: 'model-1', mode: 'agent', reasoning: 'high', fastMode: false },
    })
    h.getProviderModelMeta.mockResolvedValue({ reasoning: true, reasoningEfforts: ['low', 'high'] } as never)
    const frozen = await resolveReviewLoopSelection('conv-chat')
    if ('error' in frozen) throw new Error('esperava ok')
    expect(frozen.selection.reasoningEffort).toBe('high')

    // Changed catalogs cannot silently omit or substitute frozen effort.
    h.getProviderModelMeta.mockResolvedValue({ reasoning: true, reasoningEfforts: ['low', 'medium'] } as never)
    expect(await revalidateReviewLoopSelection(frozen.selection)).toEqual({
      ok: false,
      error: 'executor-unavailable',
    })
  })
})
