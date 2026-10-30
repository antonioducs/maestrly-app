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
    accountId: null,
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
    slots: new Map<string, any>(),
    binding: vi.fn((): any => null),
    webContents,
    getMainWebContents: vi.fn(() => webContents),
    runGeneric: vi.fn(async (_args: any) => ({ planSubmitted: false })),
    runClaude: vi.fn(async () => ({ planSubmitted: false, sessionId: 'claude-session-1' })),
    compactSession: vi.fn(),
    summarizePortable: vi.fn(
      async (): Promise<import('../../src/main/chat/portable-summarizer').IsolatedSummaryResult> => ({
        text: 'portable Claude summary',
        usage: { input: 80, output: 16, cacheRead: 0, cacheCreate: 0, totalInput: 80 },
      })
    ),
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
  getClaudeSessionBinding: h.binding,
  getClaudeSubscriptionManager: (id?: string | null) => (id ? h.slots.get(id) : h.manager),
  inspectClaudeSessionCompatibility: vi.fn(async () => true),
  putClaudeSessionBinding: vi.fn(),
  retryManagedClaudeSessionCleanup: h.retryCleanup,
  runClaudeChat: h.runClaude,
}))
vi.mock('../../src/main/chat/claude-agent-sdk/manager', () => ({
  getClaudeSubscriptionManager: (id?: string | null) => (id ? h.slots.get(id) : h.manager),
  listClaudeSubscriptionManagers: () => [h.manager],
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
const environmentLocks = vi.hoisted(() => new Map<string, string>())
vi.mock('../../src/main/chat/chatgpt-web/manager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/chat/chatgpt-web/manager')>()),
  // An isolated internal turn is admitted only for the project-environment job that owns the conversation.
  projectEnvironmentLockFor: (conversationId: string) => environmentLocks.get(conversationId) ?? null,
}))
vi.mock('../../src/main/chat/runner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/chat/runner')>()
  return { ...actual, runChat: (args: unknown) => h.runGeneric(args) }
})
vi.mock('../../src/main/chat/portable-summarizer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/chat/portable-summarizer')>()),
  summarizeWithClaudeRuntime: h.summarizePortable,
  summarizeWithCodexRuntime: vi.fn(),
  summarizeWithGitHubCopilotRuntime: vi.fn(),
}))

import {
  addSubscriptionAccount,
  subscriptionProviderIdFor,
  CLAUDE_SUBSCRIPTION_PROVIDER_ID,
} from '../../src/main/chat/catalog'
import {
  compactReserved,
  registerChatIpc,
  resolveFrozenChatSelection,
  revalidateFrozenChatSelection,
  startInternalChatTurn,
  stopChat,
  stopChatAndWait,
  type ChatIpcDeps,
} from '../../src/main/chat/service'
import { chatHistoryStats, listChatMessages, upsertChatMessage } from '../../src/main/chat/chat-store'
import { setCompactionSummarizer, clearCompactionSummarizer } from '../../src/main/chat/compaction-summarizer'
import { getConvUiPrefs, patchConvUiPrefs } from '../../src/main/store'
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

import { addProvider } from '../../src/main/chat/catalog'
import { setApiKey, clearApiKey } from '../../src/main/chat/credentials'
import { setFailoverRoute, getSubscriptionFailoverRouter } from '../../src/main/chat/subscription-failover'
import { beginClaudeAttempt, listClaudeAttempts } from '../../src/main/chat/subscription-failover/claude-attempts'
import { resolveClaudeRuntimeTarget } from '../../src/main/chat/subscription-failover/claude-adapter'

function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function account() {
  const account = addSubscriptionAccount('claude-subscription', 'Fallback')
  const providerId = subscriptionProviderIdFor('claude-subscription', account.id)
  const status = { ...h.state.status, accountFingerprint: 'account-B', accountEpoch: 7 }
  const manager = {
    ...h.manager,
    accountId: account.id,
    status: vi.fn(async () => status),
    getStatusSnapshot: vi.fn(() => status),
    listModels: vi.fn(async () => h.state.models),
    assertAccountIdentity: vi.fn((identity: any) => {
      if (
        !status.authenticated ||
        identity.fingerprint !== status.accountFingerprint ||
        identity.epoch !== status.accountEpoch
      )
        throw new Error('account changed')
    }),
    getObservedModelContextWindow: vi.fn((): number | undefined => undefined),
    observeModelContextWindow: vi.fn(),
    abortAllQueries: vi.fn(),
    logout: vi.fn(async () => {
      status.authenticated = false
      status.accountEpoch++
      return { ok: true, status }
    }),
  }
  h.slots.set(account.id, manager)
  return { account, providerId, manager, status }
}
function exhaust(providerId: string, reset = Date.now() + 60_000) {
  getSubscriptionFailoverRouter().markExhausted(providerId, {
    reason: 'quota',
    source: 'structured-error',
    resetsAt: reset,
  })
}
function conversation(providerId: string) {
  const conv = makeConversation(makeWorkspace().id, { cwd: '/repo' })
  patchConvUiPrefs(conv.id, {
    chat: {
      providerId,
      modelId: 'sonnet',
      mode: 'agent',
      reasoning: 'high',
      fastMode: true,
    },
  })
  return conv
}
function history(conversationId: string, text = 'Earlier work') {
  upsertChatMessage({ id: 'u', conversationId, role: 'user', parts: [{ type: 'text', id: 'ut', text }], createdAt: 1 })
  upsertChatMessage({
    id: 'a',
    conversationId,
    role: 'assistant',
    parts: [{ type: 'text', id: 'at', text: 'Previous response' }],
    model: { providerId: CLAUDE_SUBSCRIPTION_PROVIDER_ID, modelId: 'sonnet' },
    createdAt: 2,
    usage: { usageVersion: 2, input: 100, output: 20, contextInput: 100, contextOutput: 20, modelContextWindow: 32000 },
  })
}
const send = (handlers: Map<string, Handler>, conversationId: string) =>
  handlers.get('chat:send')!({ sender: h.webContents }, { conversationId, text: 'Continue.' })

  beforeEach(async () => {
    freshDb()
    vi.clearAllMocks()
    h.slots.clear()
    h.binding.mockReturnValue(null)
    h.state.status = {
      ...h.state.status,
      state: 'ready',
      available: true,
      authenticated: true,
      accountFingerprint: 'sha256:claude-account',
      accountEpoch: 2,
    }
    h.manager.status.mockImplementation(async () => h.state.status)
    h.manager.getStatusSnapshot.mockImplementation(() => h.state.status)
    h.manager.listModels.mockImplementation(async () => h.state.models)
    h.manager.getObservedModelContextWindow.mockReturnValue(undefined)
    h.manager.assertAccountIdentity.mockImplementation(() => {})
    h.runClaude.mockResolvedValue({ planSubmitted: false, sessionId: 'session' })
    h.summarizePortable.mockResolvedValue({
      text: 'portable Claude summary',
      usage: { input: 80, output: 16, cacheRead: 0, cacheCreate: 0, totalInput: 80 },
    })
    modelMeta.getClaudeHarnessModelMeta.mockResolvedValue(null)
    await resolveClaudeRuntimeTarget({
      logicalProviderId: CLAUDE_SUBSCRIPTION_PROVIDER_ID,
      modelId: 'sonnet',
      chain: [CLAUDE_SUBSCRIPTION_PROVIDER_ID],
      attemptedProviderIds: new Set(),
      admit: false,
      signal: new AbortController().signal,
    })
    getSubscriptionFailoverRouter().resetProvider(CLAUDE_SUBSCRIPTION_PROVIDER_ID)
  })
  afterEach(async () => {
    vi.useRealTimers()
    for (const attempt of listClaudeAttempts()) attempt.abort(new Error('test cleanup'))
    closeDb()
  })


import { getAccountPool, setAccountPool } from '../../src/main/chat/subscription-failover/account-pool'
import { frozenFailoverChain, describeChatModelForDispatch } from '../../src/main/chat/service'
import type { ChatConfig } from '../../src/shared/chat'
const VIRTUAL = 'builtin_claude_subscription@~active'
const call = (handlers: Map<string, Handler>, channel: string, ...args: unknown[]) =>
  Promise.resolve(handlers.get(channel)!({ sender: h.webContents }, ...args))

describe('active account service', () => {
  it('lists the active account only for a provider with two or more accounts', async () => {
    const { handlers } = register()
    expect(((await call(handlers, 'chat:config')) as ChatConfig).subscriptionAccountPools ?? []).toEqual([])
    const work = account()
    const config = (await call(handlers, 'chat:config')) as ChatConfig
    expect(config.subscriptionAccountPools).toEqual([expect.objectContaining({
      kind: 'claude-subscription', providerId: VIRTUAL, activeProviderId: CLAUDE_SUBSCRIPTION_PROVIDER_ID,
      memberProviderIds: [CLAUDE_SUBSCRIPTION_PROVIDER_ID, work.providerId], connected: true,
    })])
    expect(config.providers.some((provider) => provider.id === VIRTUAL)).toBe(false)
  })
  it('saves the pool through IPC and rejects invalid patches', async () => {
    const work = account()
    const { handlers } = register()
    await expect(call(handlers, 'chat:subscription-account-pool:set', {
      kind: 'claude-subscription', activeProviderId: work.providerId, policy: 'prefer-active',
    })).resolves.toMatchObject({ ok: true, pool: { activeProviderId: work.providerId, policy: 'prefer-active' } })
    expect(h.webContents.send).toHaveBeenCalledWith('models:catalog-changed')
    await expect(call(handlers, 'chat:subscription-account-pool:set', { kind: 'claude-subscription', memberProviderIds: [] })).resolves.toEqual({ ok: false, error: 'invalid-members' })
  })
  it('drops a removed account from the pool', async () => {
    const work = account()
    setAccountPool({ kind: 'claude-subscription', memberProviderIds: [work.providerId, CLAUDE_SUBSCRIPTION_PROVIDER_ID], activeProviderId: work.providerId })
    const { handlers } = register()
    await call(handlers, 'chat:subscription-account:remove', work.account.id)
    expect(getAccountPool('claude-subscription')).toMatchObject({ memberProviderIds: [CLAUDE_SUBSCRIPTION_PROVIDER_ID], activeProviderId: CLAUDE_SUBSCRIPTION_PROVIDER_ID })
  })
  it('moves the pointer when the active account runs out and tells the pickers', () => {
    const work = account()
    register()
    h.webContents.send.mockClear()
    exhaust(CLAUDE_SUBSCRIPTION_PROVIDER_ID)
    expect(getAccountPool('claude-subscription').activeProviderId).toBe(work.providerId)
    expect(h.webContents.send).toHaveBeenCalledWith('models:catalog-changed')
  })
})

describe('active account selections', () => {
  it('validates an active-account selection on the active account and stores the virtual id', async () => {
    const work = account()
    setAccountPool({ kind: 'claude-subscription', activeProviderId: work.providerId })
    const conv = conversation(CLAUDE_SUBSCRIPTION_PROVIDER_ID)
    const { handlers } = register()
    await expect(call(handlers, 'chat:set-selection', conv.id, { providerId: VIRTUAL, modelId: 'sonnet' })).resolves.toEqual({ ok: true })
    expect(getConvUiPrefs(conv.id).chat?.providerId).toBe(VIRTUAL)
    expect(work.manager.listModels).toHaveBeenCalled()
    await expect(call(handlers, 'chat:get-selection', conv.id)).resolves.toEqual({ providerId: VIRTUAL, modelId: 'sonnet' })
    await expect(call(handlers, 'chat:models', VIRTUAL)).resolves.toEqual(['sonnet'])
  })
  it('keeps a virtual default for new conversations', async () => {
    account()
    const { handlers } = register()
    await expect(call(handlers, 'chat:set-default', { providerId: VIRTUAL, modelId: 'sonnet' })).resolves.toMatchObject({ ok: true })
    const fresh = makeConversation(makeWorkspace().id, { cwd: '/repo' })
    await expect(call(handlers, 'chat:get-selection', fresh.id)).resolves.toEqual({ providerId: VIRTUAL, modelId: 'sonnet' })
    await expect(describeChatModelForDispatch(VIRTUAL, 'sonnet')).resolves.toMatchObject({ available: true })
  })
})
