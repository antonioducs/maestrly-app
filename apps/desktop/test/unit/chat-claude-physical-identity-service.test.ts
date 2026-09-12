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
import { compactReserved, registerChatIpc, stopChatAndWait, type ChatIpcDeps } from '../../src/main/chat/service'
import { listChatMessages, upsertChatMessage } from '../../src/main/chat/chat-store'
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

function slot() {
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
  setFailoverRoute({
    primaryProviderId: CLAUDE_SUBSCRIPTION_PROVIDER_ID,
    enabled: true,
    fallbackProviderIds: [providerId],
  })
  return { account, providerId, manager, status }
}
function exhaust(providerId: string, reset = Date.now() + 60_000) {
  getSubscriptionFailoverRouter().markExhausted(providerId, {
    reason: 'quota',
    source: 'structured-error',
    resetsAt: reset,
  })
}
function conversation() {
  const conv = makeConversation(makeWorkspace().id, { cwd: '/repo' })
  patchConvUiPrefs(conv.id, {
    chat: {
      providerId: CLAUDE_SUBSCRIPTION_PROVIDER_ID,
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

describe('Claude physical account service ownership', () => {
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

  it.each([
    'quota',
    'signed-out',
  ])('admits physical B when logical A is %s without changing selection', async (reason) => {
    const fallback = slot()
    const conv = conversation()
    const { handlers } = register()
    if (reason === 'quota') exhaust(CLAUDE_SUBSCRIPTION_PROVIDER_ID)
    else {
      h.state.status.authenticated = false
      h.state.status.accountFingerprint = null
    }
    fallback.manager.getObservedModelContextWindow.mockReturnValue(32000)
    await expect(send(handlers, conv.id)).resolves.toEqual({ ok: true })
    await vi.waitFor(() => expect(h.runClaude).toHaveBeenCalledOnce())
    const args = (h.runClaude.mock.calls as any)[0][0]
    expect(args.initialTarget).toMatchObject({
      providerId: fallback.providerId,
      accountId: fallback.account.id,
      contextWindow: 32000,
    })
    expect(args.manager).toBe(fallback.manager)
    expect(args.contextWindow).toBe(32000)
    expect(args).toMatchObject({ reasoningEffort: 'high', fastMode: true })
    expect(getConvUiPrefs(conv.id).chat?.providerId).toBe(CLAUDE_SUBSCRIPTION_PROVIDER_ID)
    expect(listChatMessages(conv.id).filter((message) => message.role === 'user')).toHaveLength(1)
    await stopChatAndWait(conv.id)
  })

  it('distinguishes proven all-account exhaustion from mixed unavailability before persistence', async () => {
    const fallback = slot()
    const conv = conversation()
    const { handlers } = register()
    exhaust(CLAUDE_SUBSCRIPTION_PROVIDER_ID)
    exhaust(fallback.providerId)
    await expect(send(handlers, conv.id)).resolves.toEqual({ ok: false, error: 'claude-accounts-exhausted' })
    fallback.status.authenticated = false
    await expect(send(handlers, conv.id)).resolves.toEqual({ ok: false, error: 'unavailable' })
    expect(h.runClaude).not.toHaveBeenCalled()
    expect(listChatMessages(conv.id)).toEqual([])
  })

  it('keeps B running on default logout and revokes B callbacks on B logout', async () => {
    const fallback = slot()
    const conv = conversation()
    const { handlers } = register()
    exhaust(CLAUDE_SUBSCRIPTION_PROVIDER_ID)
    const finished = deferred<any>()
    h.runClaude.mockImplementationOnce(() => finished.promise)
    await send(handlers, conv.id)
    await vi.waitFor(() => expect(h.runClaude).toHaveBeenCalledOnce())
    const args = (h.runClaude.mock.calls as any)[0][0]
    const target = args.initialTarget
    expect(args.onSessionReady('B-session', target)).toBe(true)
    await handlers.get('chat:claude-subscription:logout')!({}, {})
    expect(args.signal.aborted).toBe(false)
    expect(args.canPersistSession(target)).toBe(true)
    args.onModelContextWindow(16000, target)
    expect(fallback.manager.observeModelContextWindow).toHaveBeenCalledWith('sonnet', 16000)
    const logout = handlers.get('chat:claude-subscription:logout')!(
      {},
      { accountId: fallback.account.id }
    ) as Promise<any>
    expect(args.signal.aborted).toBe(true)
    expect(args.onSessionReady('late-B', target)).toBe(false)
    expect(fallback.manager.logout).not.toHaveBeenCalled()
    finished.resolve({ planSubmitted: false })
    await expect(logout).resolves.toMatchObject({ ok: true })
    expect(fallback.manager.logout).toHaveBeenCalledOnce()
    expect(h.deleteAll).toHaveBeenCalledWith(undefined, { accountId: fallback.account.id })
    expect(getSubscriptionFailoverRouter().getHealth(fallback.providerId).state).toBe('unknown')
  })

  it('keeps reserved manual compaction on B alive during default A logout', async () => {
    const fallback = slot()
    const conv = conversation()
    history(conv.id)
    exhaust(CLAUDE_SUBSCRIPTION_PROVIDER_ID)
    const { handlers } = register()
    const finished = deferred<any>()
    h.summarizePortable.mockImplementationOnce(() => finished.promise)
    const compaction = handlers.get('chat:compact')!({}, conv.id) as Promise<any>
    await vi.waitFor(() => expect(h.summarizePortable).toHaveBeenCalledOnce())
    const summaryArgs = (h.summarizePortable.mock.calls as any)[0][0]
    expect(summaryArgs.manager).toBe(fallback.manager)
    await handlers.get('chat:claude-subscription:logout')!({}, {})
    expect(summaryArgs.signal.aborted).toBe(false)
    finished.resolve({
      text: 'Summary from B.',
      usage: { input: 1, output: 1, cacheRead: 0, cacheCreate: 0, totalInput: 1 },
    })
    await expect(compaction).resolves.toMatchObject({ ok: true, summary: 'Summary from B.' })
  })

  it('freezes active-turn effort and Fast mode for portable compaction', async () => {
    slot()
    const conv = conversation()
    history(conv.id)
    const { handlers } = register()
    const finished = deferred<any>()
    h.runClaude.mockImplementationOnce(() => finished.promise)
    await send(handlers, conv.id)
    const args = (h.runClaude.mock.calls as any)[0][0]
    expect(args).toMatchObject({ reasoningEffort: 'high', fastMode: true })
    patchConvUiPrefs(conv.id, { chat: { ...getConvUiPrefs(conv.id).chat, reasoning: 'off', fastMode: false } })
    await expect(args.compactHistory()).resolves.toMatchObject({ summary: 'portable Claude summary' })
    expect(h.summarizePortable).toHaveBeenCalledWith(expect.objectContaining({ effort: 'high', fastMode: true }))
    finished.resolve({ planSubmitted: false })
    await stopChatAndWait(conv.id)
  })

  it('uses a smaller next-account window for compaction before that account owns the root', async () => {
    const fallback = slot()
    fallback.manager.getObservedModelContextWindow.mockReturnValue(32000)
    h.manager.getObservedModelContextWindow.mockReturnValue(200000)
    const conv = conversation()
    history(conv.id, 'history '.repeat(10000))
    const { handlers } = register()
    const finished = deferred<any>()
    h.runClaude.mockImplementationOnce(() => finished.promise)
    await send(handlers, conv.id)
    const args = (h.runClaude.mock.calls as any)[0][0]
    exhaust(CLAUDE_SUBSCRIPTION_PROVIDER_ID)
    const resolved = await resolveClaudeRuntimeTarget({
      logicalProviderId: CLAUDE_SUBSCRIPTION_PROVIDER_ID,
      modelId: 'sonnet',
      chain: [fallback.providerId],
      attemptedProviderIds: new Set(),
      admit: false,
      signal: new AbortController().signal,
    })
    if (!resolved.ok) throw new Error('Expected fallback target')
    await args.compactHistory(resolved.target)
    expect(h.summarizePortable.mock.calls.length).toBeGreaterThan(1)
    for (const [input] of h.summarizePortable.mock.calls as any) expect(input.manager).toBe(fallback.manager)
    finished.resolve({ planSubmitted: false })
    await stopChatAndWait(conv.id)
  })

  it('retains all completed chunks and failed helper attempts when compaction cannot finish', async () => {
    const fallback = slot()
    fallback.manager.getObservedModelContextWindow.mockReturnValue(32000)
    h.manager.getObservedModelContextWindow.mockReturnValue(32000)
    const conv = conversation()
    history(conv.id, 'x'.repeat(40000))
    h.summarizePortable
      .mockResolvedValueOnce({
        text: 'first summary',
        usage: { input: 80, output: 16, cacheRead: 0, cacheCreate: 0, totalInput: 80 },
        runtimeEstimatedCostUsd: 0.2,
      })
      .mockRejectedValueOnce(
        Object.assign(new Error("You've hit your limit"), {
          partialUsage: { input: 20, output: 5, cacheRead: 0, cacheCreate: 0, totalInput: 20 },
          runtimeEstimatedCostUsd: 0.1,
        })
      )
      .mockRejectedValueOnce(
        Object.assign(new Error('network failed'), {
          partialUsage: { input: 3, output: 1, cacheRead: 0, cacheCreate: 0, totalInput: 3 },
          runtimeEstimatedCostUsd: 0.05,
        })
      )
    const result = await compactReserved(conv.id)
    expect(result).toMatchObject({ ok: false, error: 'network failed', usage: { input: 103, output: 22 } })
    expect(result.runtimeEstimatedCostUsd).toBeCloseTo(0.35)
  })

  it('does not retain A as root owner after its attempt is retired during a switch', async () => {
    slot()
    const conv = conversation()
    const { handlers } = register()
    const finished = deferred<any>()
    h.runClaude.mockImplementationOnce(() => finished.promise)
    await send(handlers, conv.id)
    const args = (h.runClaude.mock.calls as any)[0][0]
    const target = args.initialTarget
    args.onEffectiveTargetChanged(target)
    const attempt = beginClaudeAttempt({
      providerId: target.providerId,
      accountIdentity: target.accountIdentity,
      scope: 'root',
      conversationId: conv.id,
      abort: vi.fn(),
    })
    expect(args.onSessionReady('A-session', target)).toBe(true)
    attempt.release()
    expect(args.canPersistSession(target)).toBe(false)
    await handlers.get('chat:claude-subscription:logout')!({}, {})
    expect(args.signal.aborted).toBe(false)
    expect(h.manager.logout).toHaveBeenCalledOnce()
    finished.resolve({ planSubmitted: false })
    await stopChatAndWait(conv.id)
  })

  it('waits for an A child of a B root before mutating default identity', async () => {
    const fallback = slot()
    const conv = conversation()
    const { handlers } = register()
    exhaust(CLAUDE_SUBSCRIPTION_PROVIDER_ID)
    const finished = deferred<any>()
    h.runClaude.mockImplementationOnce(() => finished.promise)
    await send(handlers, conv.id)
    const args = (h.runClaude.mock.calls as any)[0][0]
    const abort = vi.fn()
    const child = beginClaudeAttempt({
      providerId: CLAUDE_SUBSCRIPTION_PROVIDER_ID,
      accountIdentity: { fingerprint: 'sha256:claude-account', epoch: 2 },
      scope: 'subagent',
      conversationId: conv.id,
      abort,
    })
    const logout = handlers.get('chat:claude-subscription:logout')!({}, {}) as Promise<any>
    expect(abort).toHaveBeenCalledOnce()
    expect(args.signal.aborted).toBe(true)
    finished.resolve({ planSubmitted: false })
    vi.useFakeTimers()
    await vi.advanceTimersByTimeAsync(6000)
    expect(h.manager.logout).not.toHaveBeenCalled()
    vi.useRealTimers()
    child.release()
    await expect(logout).resolves.toMatchObject({ ok: true })
    expect(h.manager.logout).toHaveBeenCalledOnce()
    expect(h.deleteAll).not.toHaveBeenCalledWith(undefined, { accountId: fallback.account.id })
  })

  it('waits for preadmission helpers with no active root', async () => {
    const fallback = slot()
    const { handlers } = register()
    const abort = vi.fn()
    const child = beginClaudeAttempt({
      providerId: fallback.providerId,
      accountIdentity: { fingerprint: 'account-B', epoch: 7 },
      scope: 'helper',
      abort,
    })
    const logout = handlers.get('chat:claude-subscription:logout')!(
      {},
      { accountId: fallback.account.id }
    ) as Promise<any>
    expect(abort).toHaveBeenCalledOnce()
    expect(fallback.manager.logout).not.toHaveBeenCalled()
    child.release()
    await expect(logout).resolves.toMatchObject({ ok: true })
  })

  it('compacts through physical B without authenticated A and freezes the multi-chunk route', async () => {
    const fallback = slot()
    const conv = conversation()
    register()
    history(conv.id, 'x'.repeat(30000))
    h.state.status.authenticated = false
    h.state.status.accountFingerprint = null
    fallback.manager.getObservedModelContextWindow.mockReturnValue(16000)
    h.summarizePortable.mockImplementation(async () => {
      setFailoverRoute({ primaryProviderId: CLAUDE_SUBSCRIPTION_PROVIDER_ID, enabled: false, fallbackProviderIds: [] })
      return { text: 'summary', usage: { input: 80, output: 16, cacheRead: 0, cacheCreate: 0, totalInput: 80 } }
    })
    await expect(compactReserved(conv.id)).resolves.toMatchObject({ ok: true })
    expect(h.summarizePortable.mock.calls.length).toBeGreaterThan(1)
    for (const [args] of h.summarizePortable.mock.calls as any) expect(args.manager).toBe(fallback.manager)
  })

  it('releases a half-open lease before automatic compaction admits the same account', async () => {
    const fallback = slot()
    const conv = conversation()
    const { handlers } = register()
    history(conv.id, 'x'.repeat(30000))
    exhaust(CLAUDE_SUBSCRIPTION_PROVIDER_ID)
    exhaust(fallback.providerId, Date.now() + 100)
    await new Promise((resolve) => setTimeout(resolve, 110))
    fallback.manager.getObservedModelContextWindow.mockReturnValue(24000)
    h.summarizePortable.mockImplementation(async () => {
      if (h.summarizePortable.mock.calls.length === 1)
        expect(getSubscriptionFailoverRouter().getHealth(fallback.providerId).state).toBe('half-open')
      return { text: 'summary', usage: { input: 80, output: 16, cacheRead: 0, cacheCreate: 0, totalInput: 80 } }
    })
    await expect(send(handlers, conv.id)).resolves.toEqual({ ok: true })
    expect(h.summarizePortable).toHaveBeenCalled()
    await stopChatAndWait(conv.id)
  })
  it('keeps native occupancy and compatibility on the eligible binding owner B', async () => {
    const fallback = slot()
    const conv = conversation()
    const { handlers } = register()
    history(conv.id)
    exhaust(CLAUDE_SUBSCRIPTION_PROVIDER_ID)
    h.binding.mockReturnValue({
      accountId: fallback.account.id,
      accountFingerprint: 'account-B',
      accountEpoch: 7,
      lastMessageId: 'a',
      modelId: 'claude-sonnet-5',
      sessionId: 'B-session',
    })
    await expect(handlers.get('chat:history:stats')!({}, conv.id)).resolves.toMatchObject({
      contextProjection: { source: 'runtime-usage', usedTokens: 120, modelContextWindow: 32000 },
    })
    await expect(send(handlers, conv.id)).resolves.toEqual({ ok: true })
    expect(fallback.manager.listModels).toHaveBeenCalled()
    expect(h.deleteOne).not.toHaveBeenCalled()
    await stopChatAndWait(conv.id)
  })

  it('rejects callbacks from retired physical A after switching to B', async () => {
    const fallback = slot()
    const conv = conversation()
    const { handlers } = register()
    const finished = deferred<any>()
    h.runClaude.mockImplementationOnce(() => finished.promise)
    await send(handlers, conv.id)
    const args = (h.runClaude.mock.calls as any)[0][0]
    const initial = args.initialTarget
    const result = await resolveClaudeRuntimeTarget({
      logicalProviderId: CLAUDE_SUBSCRIPTION_PROVIDER_ID,
      modelId: 'sonnet',
      reasoningEffort: 'high',
      fastMode: true,
      chain: [fallback.providerId],
      attemptedProviderIds: new Set(),
      admit: false,
      signal: new AbortController().signal,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.message)
    args.onEffectiveTargetChanged(result.target)
    expect(args.canPersistSession(initial)).toBe(false)
    expect(args.onSessionReady('late-A', initial)).toBe(false)
    expect(args.onSessionReady('current-B', result.target)).toBe(true)
    args.onModelContextWindow(9000, initial)
    expect(h.manager.observeModelContextWindow).not.toHaveBeenCalled()
    args.onModelContextWindow(16000, result.target)
    expect(fallback.manager.observeModelContextWindow).toHaveBeenCalledWith('sonnet', 16000)
    finished.resolve({ planSubmitted: false })
    await stopChatAndWait(conv.id)
  })
  it('aborts a BYOK root that owns a physical Claude child on default logout', async () => {
    const conv = conversation()
    const { handlers } = register()
    const provider = addProvider({ name: 'BYOK', baseURL: 'https://byok.test/v1', kind: 'openai' })
    setApiKey(provider.id, 'test-key')
    patchConvUiPrefs(conv.id, { chat: { providerId: provider.id, modelId: 'byok-model' } })
    let rootSignal: AbortSignal | undefined
    h.runGeneric.mockImplementationOnce(async (args: any) => {
      rootSignal = args.signal
      const attempt = beginClaudeAttempt({
        providerId: CLAUDE_SUBSCRIPTION_PROVIDER_ID,
        accountIdentity: { fingerprint: 'sha256:claude-account', epoch: 2 },
        scope: 'subagent',
        conversationId: conv.id,
        abort: () => {},
      })
      try {
        await new Promise<void>((resolve) => args.signal.addEventListener('abort', () => resolve(), { once: true }))
      } finally {
        attempt.release()
      }
      return { planSubmitted: false }
    })
    await expect(send(handlers, conv.id)).resolves.toEqual({ ok: true })
    await vi.waitFor(() => expect(listClaudeAttempts()).toHaveLength(1))
    h.deleteOne.mockClear()
    await expect(handlers.get('chat:claude-subscription:logout')!({}, {})).resolves.toMatchObject({ ok: true })
    expect(rootSignal?.aborted).toBe(true)
    expect(h.deleteOne).not.toHaveBeenCalled()
    clearApiKey(provider.id)
  })

  it('merges failed summary usage and cost exactly once when compaction rotates', async () => {
    const fallback = slot()
    const conv = conversation()
    register()
    history(conv.id)
    const quota = Object.assign(new Error("You've hit your usage limit"), {
      partialUsage: { input: 30, output: 5, cacheRead: 2, cacheCreate: 1, totalInput: 33 },
      partialRuntimeEstimatedCostUsd: 0.3,
    })
    h.summarizePortable.mockRejectedValueOnce(quota).mockResolvedValueOnce({
      text: 'portable Claude summary',
      usage: { input: 80, output: 16, cacheRead: 0, cacheCreate: 0, totalInput: 80 },
      runtimeEstimatedCostUsd: 0.4,
    } as any)
    await expect(compactReserved(conv.id)).resolves.toMatchObject({
      ok: true,
      usage: { input: 110, output: 21, cacheRead: 2, cacheCreate: 1, totalInput: 113 },
      runtimeEstimatedCostUsd: 0.7,
    })
    expect((h.summarizePortable.mock.calls as any)[1][0].manager).toBe(fallback.manager)
  })

  it('returns an admitted half-open lease if the runner rejects before attempt registration', async () => {
    const fallback = slot()
    const conv = conversation()
    const { handlers } = register()
    exhaust(CLAUDE_SUBSCRIPTION_PROVIDER_ID)
    exhaust(fallback.providerId, Date.now() + 30)
    await new Promise((resolve) => setTimeout(resolve, 40))
    h.runClaude.mockRejectedValueOnce(new Error('runner setup failed'))
    await expect(send(handlers, conv.id)).resolves.toEqual({ ok: true })
    await stopChatAndWait(conv.id)
    expect(getSubscriptionFailoverRouter().getHealth(fallback.providerId).state).toBe('exhausted')
    expect(getSubscriptionFailoverRouter().getHealth(fallback.providerId).halfOpenLeaseId).toBeUndefined()
  })
})
