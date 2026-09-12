import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
  const order: string[] = []
  const state: {
    status: any
    snapshot: any
    models: any[]
    identity: { fingerprint: string | null; epoch: number }
    binding: any
  } = {
    status: null,
    snapshot: null,
    models: [],
    identity: { fingerprint: null, epoch: 0 },
    binding: null,
  }
  let authUpdated: (() => void) | null = null
  const manager = {
    isDisposed: false,
    getStatus: vi.fn(async () => state.status),
    getStatusSnapshot: vi.fn(() => state.snapshot),
    startLogin: vi.fn<() => Promise<any>>(async () => ({
      loginId: 'login-1',
      userCode: 'ABCD-EFGH',
      verificationUri: 'https://github.com/login/device',
      verificationUriComplete: null,
      expiresAt: Date.now() + 60_000,
      state: 'pending',
      completion: null,
    })),
    waitForLogin: vi.fn<(loginId: string) => Promise<any>>(async () => ({
      loginId: 'login-1',
      success: true,
      error: null,
    })),
    logout: vi.fn(async () => {
      order.push('logout')
    }),
    resetLocalData: vi.fn(async () => {
      order.push('reset-local')
    }),
    dispose: vi.fn(async () => {}),
    listModels: vi.fn(async () => state.models),
    getAccountIdentity: vi.fn(() => ({ ...state.identity })),
    assertAccountIdentity: vi.fn(),
    onAuthUpdated: vi.fn((listener: () => void) => {
      authUpdated = listener
      return () => {
        if (authUpdated === listener) authUpdated = null
      }
    }),
  }
  const webContents = {
    isDestroyed: vi.fn(() => false),
    send: vi.fn(),
  }
  return {
    order,
    state,
    manager,
    webContents,
    getMainWebContents: vi.fn(() => webContents),
    emitAuthUpdated: () => authUpdated?.(),
    deleteAll: vi.fn(async () => {
      order.push('delete-all')
      return []
    }),
    deleteOne: vi.fn(async () => {
      state.binding = null
      return { conversationId: '', sessionId: null, remoteDeleted: false }
    }),
    retryCleanup: vi.fn(async () => []),
    compactSession: vi.fn(async () => ({
      sessionId: 'session-test',
      success: true,
      tokensRemoved: 100,
      messagesRemoved: 2,
      summary: 'summary',
      contextWindow: { tokenLimit: 272_000, currentTokens: 42_000, messagesLength: 3 },
    })),
    summarizePortable: vi.fn(async () => ({
      text: 'portable summary',
      usage: { input: 100, output: 20, cacheRead: 0, cacheCreate: 0, totalInput: 100 },
    })),
    getBinding: vi.fn(() => state.binding),
    putBinding: vi.fn((binding: any) => {
      state.binding = { ...binding, updatedAt: Date.now() }
    }),
    runCopilot: vi.fn<(args: any) => Promise<{ planSubmitted: boolean; sessionId: string }>>(async () => ({
      planSubmitted: false,
      sessionId: 'session-test',
    })),
    redactError: (error: unknown) =>
      (error instanceof Error ? error.message : String(error))
        .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
        .replace(/\b(?:gh[opsur]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/g, '[REDACTED]'),
  }
})

vi.mock('../../src/main/window-ipc', () => ({
  getMainWebContents: h.getMainWebContents,
}))

vi.mock('../../src/main/chat/github-copilot', () => ({
  compactGitHubCopilotSession: h.compactSession,
  deleteAllManagedGitHubCopilotSessions: h.deleteAll,
  deleteGitHubCopilotSessionForConversation: h.deleteOne,
  getGitHubCopilotSubscriptionManager: () => h.manager,
  githubCopilotErrorMessage: h.redactError,
  getGitHubCopilotSessionBinding: h.getBinding,
  putGitHubCopilotSessionBinding: h.putBinding,
  retryManagedGitHubCopilotSessionCleanup: h.retryCleanup,
  runGitHubCopilotChat: h.runCopilot,
}))

vi.mock('../../src/main/chat/portable-summarizer', () => ({
  summarizeWithCodexRuntime: vi.fn(),
  summarizeWithGitHubCopilotRuntime: h.summarizePortable,
}))

vi.mock('../../src/main/chat/codex-subscription', () => ({
  compactCodexSubscriptionThread: vi.fn(),
  deleteAllManagedCodexThreads: vi.fn(async () => []),
  deleteCodexThreadForConversation: vi.fn(async () => ({
    conversationId: '',
    threadId: null,
    remoteDeleted: false,
  })),
  deleteManagedCodexThread: vi.fn(async () => ({ conversationId: '', threadId: null, remoteDeleted: false })),
  getCodexSubscriptionManager: () => ({
    isDisposed: false,
    getStatus: vi.fn(async () => ({
      state: 'ready',
      available: true,
      connected: false,
      authenticated: false,
      account: null,
      requiresOpenaiAuth: true,
      runtime: null,
      error: null,
    })),
    getStatusSnapshot: vi.fn(() => null),
    listModels: vi.fn(async () => []),
    onAccountUpdated: vi.fn(() => () => {}),
    dispose: vi.fn(async () => {}),
  }),
  getCodexThreadBinding: vi.fn(() => null),
  putCodexThreadBinding: vi.fn(),
  retryManagedCodexThreadCleanup: vi.fn(async () => []),
  runCodexSubscriptionChat: vi.fn(),
}))

import { addProvider, GITHUB_COPILOT_SUBSCRIPTION_PROVIDER_ID } from '../../src/main/chat/catalog'
import type { ChatIpcDeps } from '../../src/main/chat/service'
import { registerChatIpc } from '../../src/main/chat/service'
import { getConvUiPrefs, patchConvUiPrefs } from '../../src/main/store'
import { listChatMessages, upsertChatMessage } from '../../src/main/chat/chat-store'
import { MAESTRLY_ULTRA_EFFORT } from '../../src/shared/chat'
import { openAINativeCompactionMarkerPart } from '../../src/main/chat/message'
import { closeDb, freshDb } from '../helpers/db'
import { makeConversation, makeWorkspace } from '../helpers/factories'

type Handler = (event: any, ...args: any[]) => unknown

const signedOutStatus = () => ({
  state: 'ready' as const,
  available: true,
  connected: false,
  authenticated: false,
  account: null,
  storageMode: 'secure' as const,
  accountFingerprint: null,
  accountEpoch: 0,
  error: null,
})

const signedInStatus = (login = 'octocat') => ({
  state: 'ready' as const,
  available: true,
  connected: true,
  authenticated: true,
  account: { login, host: 'https://github.com', authType: 'token' as const },
  storageMode: 'secure' as const,
  accountFingerprint: 'sha256:account-a',
  accountEpoch: 1,
  error: null,
})

const copilotModel = (id: string, policy: 'enabled' | 'disabled' | 'unconfigured' = 'enabled') => ({
  id,
  name: id,
  capabilities: {
    supports: { vision: true, reasoningEffort: true },
    limits: { max_context_window_tokens: 272_000 },
  },
  policy: { state: policy, terms: '' },
  supportedReasoningEfforts: ['low', 'high', 'xhigh'],
  defaultReasoningEffort: 'high',
})

function register(): { handlers: Map<string, Handler>; emitStatus: ReturnType<typeof vi.fn> } {
  const handlers = new Map<string, Handler>()
  const emitStatus = vi.fn()
  registerChatIpc({
    mhandle: (channel, fn) => void handlers.set(channel, fn as Handler),
    mon: vi.fn(),
    emitStatus,
  } satisfies ChatIpcDeps)
  return { handlers, emitStatus }
}

describe('GitHub Copilot chat service integration', () => {
  beforeEach(() => {
    freshDb()
    h.order.length = 0
    h.state.status = signedOutStatus()
    h.state.snapshot = null
    h.state.models = []
    h.state.identity = { fingerprint: null, epoch: 0 }
    h.state.binding = null
    h.webContents.send.mockClear()
    h.getMainWebContents.mockClear()
    h.deleteAll.mockClear()
    h.deleteOne.mockClear()
    h.retryCleanup.mockClear()
    h.runCopilot.mockReset()
    h.runCopilot.mockResolvedValue({ planSubmitted: false, sessionId: 'session-test' })
    h.manager.getStatus.mockClear()
    h.manager.getStatus.mockImplementation(async () => h.state.status)
    h.manager.getStatusSnapshot.mockClear()
    h.manager.getStatusSnapshot.mockImplementation(() => h.state.snapshot)
    h.manager.startLogin.mockClear()
    h.manager.startLogin.mockResolvedValue({
      loginId: 'login-1',
      userCode: 'ABCD-EFGH',
      verificationUri: 'https://github.com/login/device',
      verificationUriComplete: null,
      expiresAt: Date.now() + 60_000,
      state: 'pending',
      completion: null,
    })
    h.manager.waitForLogin.mockClear()
    h.manager.waitForLogin.mockResolvedValue({ loginId: 'login-1', success: true, error: null })
    h.manager.logout.mockClear()
    h.manager.logout.mockImplementation(async () => {
      h.order.push('logout')
    })
    h.manager.resetLocalData.mockClear()
    h.manager.resetLocalData.mockImplementation(async () => {
      h.order.push('reset-local')
    })
    h.manager.listModels.mockClear()
    h.manager.listModels.mockImplementation(async () => h.state.models)
    h.manager.getAccountIdentity.mockClear()
    h.manager.getAccountIdentity.mockImplementation(() => ({ ...h.state.identity }))
    h.manager.assertAccountIdentity.mockReset()
    h.compactSession.mockClear()
    h.summarizePortable.mockClear()
    h.getBinding.mockClear()
    h.putBinding.mockClear()
  })

  afterEach(closeDb)

  it('registers status/login/logout and publishes auth-changed through the manager listener', async () => {
    const { handlers } = register()

    expect(handlers.has('chat:github-copilot-subscription:status')).toBe(true)
    expect(handlers.has('chat:github-copilot-subscription:login')).toBe(true)
    expect(handlers.has('chat:github-copilot-subscription:logout')).toBe(true)
    expect(h.manager.onAuthUpdated).toHaveBeenCalled()

    h.state.status = signedInStatus('listener-user')
    h.emitAuthUpdated()

    await vi.waitFor(() =>
      expect(h.webContents.send).toHaveBeenCalledWith('chat:github-copilot-subscription:auth-changed', {
        state: 'signed-in',
        authenticated: true,
        username: 'listener-user',
        enterpriseUrl: 'https://github.com',
      })
    )
  })

  it('returns Device Flow URL and code without waiting for login', async () => {
    const { handlers } = register()
    let finishLogin!: (value: { loginId: string; success: boolean; error: null }) => void
    const completion = new Promise<{ loginId: string; success: boolean; error: null }>((resolve) => {
      finishLogin = resolve
    })
    h.manager.waitForLogin.mockReturnValue(completion)
    h.manager.startLogin.mockResolvedValueOnce({
      loginId: 'device-login',
      userCode: 'WXYZ-1234',
      verificationUri: 'https://github.com/login/device',
      verificationUriComplete: 'https://github.com/login/device?user_code=WXYZ-1234',
      expiresAt: Date.now() + 60_000,
      state: 'pending',
      completion: null,
    })

    const result = await handlers.get('chat:github-copilot-subscription:login')?.({})

    expect(result).toEqual({
      ok: true,
      verificationUrl: 'https://github.com/login/device?user_code=WXYZ-1234',
      userCode: 'WXYZ-1234',
      status: { state: 'signing-in', authenticated: false },
    })
    expect(h.order).toEqual(['delete-all', 'reset-local'])
    expect(h.webContents.send).toHaveBeenCalledWith('chat:github-copilot-subscription:auth-changed', {
      state: 'signing-in',
      authenticated: false,
    })

    h.state.status = signedInStatus()
    finishLogin({ loginId: 'device-login', success: true, error: null })
    await vi.waitFor(() =>
      expect(h.webContents.send).toHaveBeenCalledWith(
        'chat:github-copilot-subscription:auth-changed',
        expect.objectContaining({ state: 'signed-in', authenticated: true })
      )
    )
  })

  it('preserves sessions and skips OAuth when the persisted token authenticates', async () => {
    const { handlers } = register()
    h.state.status = signedInStatus('persisted-user')

    await expect(handlers.get('chat:github-copilot-subscription:login')?.({})).resolves.toEqual({
      ok: true,
      status: {
        state: 'signed-in',
        authenticated: true,
        username: 'persisted-user',
        enterpriseUrl: 'https://github.com',
      },
    })
    expect(h.manager.startLogin).not.toHaveBeenCalled()
    expect(h.manager.resetLocalData).not.toHaveBeenCalled()
    expect(h.deleteAll).not.toHaveBeenCalled()
  })

  it('maps authenticated status and drains tombstones', async () => {
    const { handlers } = register()
    h.state.status = signedInStatus('status-user')

    await expect(handlers.get('chat:github-copilot-subscription:status')?.({}, { refresh: true })).resolves.toEqual({
      state: 'signed-in',
      authenticated: true,
      username: 'status-user',
      enterpriseUrl: 'https://github.com',
    })
    expect(h.manager.getStatus).toHaveBeenCalledWith(true)
    expect(h.retryCleanup).toHaveBeenCalledTimes(1)
  })

  it('turns synchronous and denied OAuth failures into recoverable states', async () => {
    const { handlers } = register()
    h.manager.startLogin.mockRejectedValueOnce(new Error('Device Flow unavailable'))

    await expect(handlers.get('chat:github-copilot-subscription:login')?.({})).resolves.toEqual({
      ok: false,
      error: 'Device Flow unavailable',
      status: { state: 'error', authenticated: false, error: 'Device Flow unavailable' },
    })

    h.webContents.send.mockClear()
    h.manager.waitForLogin.mockResolvedValueOnce({
      loginId: 'login-1',
      success: false,
      error: { code: 'access_denied', message: 'Login denied' },
    })
    await expect(handlers.get('chat:github-copilot-subscription:login')?.({})).resolves.toMatchObject({ ok: true })
    await vi.waitFor(() =>
      expect(h.webContents.send).toHaveBeenCalledWith('chat:github-copilot-subscription:auth-changed', {
        state: 'error',
        authenticated: false,
        error: 'Login denied',
      })
    )
  })

  it('deletes old-account sessions before clearing the token', async () => {
    const { handlers } = register()
    h.state.status = signedOutStatus()

    await expect(handlers.get('chat:github-copilot-subscription:logout')?.({})).resolves.toEqual({
      ok: true,
      status: { state: 'signed-out', authenticated: false },
    })
    expect(h.order).toEqual(['delete-all', 'reset-local'])
    expect(h.manager.logout).not.toHaveBeenCalled()
    expect(h.manager.getStatus).toHaveBeenCalledWith(true)
  })

  it('lists enabled models while excluding policy-blocked models', async () => {
    const { handlers } = register()
    h.state.status = signedInStatus()
    h.state.models = [
      copilotModel('gpt-enabled', 'enabled'),
      copilotModel('claude-blocked', 'disabled'),
      copilotModel('gemini-unconfigured', 'unconfigured'),
      { ...copilotModel('model-without-policy'), policy: undefined },
    ]

    await expect(handlers.get('chat:models')?.({}, GITHUB_COPILOT_SUBSCRIPTION_PROVIDER_ID, true)).resolves.toEqual([
      'gpt-enabled',
      'gemini-unconfigured',
      'model-without-policy',
    ])
    expect(h.manager.listModels).toHaveBeenCalledWith(true)
  })

  it('redacts runtime credentials before model IPC', async () => {
    const { handlers } = register()
    h.state.status = signedInStatus()
    h.manager.listModels.mockRejectedValueOnce(
      new Error('request failed: Authorization: Bearer gho_runtime_secret?token=github_pat_private')
    )

    let exposed = ''
    try {
      await handlers.get('chat:models')?.({}, GITHUB_COPILOT_SUBSCRIPTION_PROVIDER_ID, true)
    } catch (error) {
      exposed = error instanceof Error ? error.message : String(error)
    }

    expect(exposed).toContain('Bearer [REDACTED]')
    expect(exposed).not.toContain('gho_runtime_secret')
    expect(exposed).not.toContain('github_pat_private')
  })

  it('rejects unavailable or disabled models before persistence or dispatch', async () => {
    const { handlers } = register()
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    const sender = { isDestroyed: () => false, send: vi.fn() }
    h.state.status = signedInStatus()
    h.state.identity = { fingerprint: 'sha256:account-a', epoch: 2 }
    h.state.models = [copilotModel('blocked-model', 'disabled'), copilotModel('allowed-model')]

    for (const modelId of ['missing-model', 'blocked-model']) {
      patchConvUiPrefs(conversation.id, {
        chat: { providerId: GITHUB_COPILOT_SUBSCRIPTION_PROVIDER_ID, modelId },
      })
      await expect(
        handlers.get('chat:send')?.({ sender }, { conversationId: conversation.id, text: `use ${modelId}` })
      ).resolves.toEqual({ ok: false, error: 'no-model' })
    }

    expect(h.manager.listModels).toHaveBeenCalledWith(true)
    expect(h.runCopilot).not.toHaveBeenCalled()
    expect(listChatMessages(conversation.id)).toEqual([])
  })

  it('rejects unknown manual selections before clearing the previous session', async () => {
    const { handlers } = register()
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    patchConvUiPrefs(conversation.id, {
      chat: { providerId: GITHUB_COPILOT_SUBSCRIPTION_PROVIDER_ID, modelId: 'allowed-model' },
    })
    h.state.status = signedInStatus()
    h.state.identity = { fingerprint: 'sha256:account-a', epoch: 2 }
    h.state.models = [copilotModel('allowed-model')]

    await expect(
      handlers.get('chat:set-selection')?.({}, conversation.id, {
        providerId: GITHUB_COPILOT_SUBSCRIPTION_PROVIDER_ID,
        modelId: 'typed-but-unknown',
      })
    ).resolves.toEqual({ ok: false, error: 'no-model' })

    expect(h.deleteOne).not.toHaveBeenCalled()
    expect(getConvUiPrefs(conversation.id).chat?.modelId).toBe('allowed-model')
  })

  it('does not leak Copilot native measurements when switching to BYOK', async () => {
    const { handlers } = register()
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    const byok = addProvider({
      name: 'Anthropic compatible',
      baseURL: 'https://copilot-switch.example.test/v1',
      kind: 'anthropic',
    })
    patchConvUiPrefs(conversation.id, {
      chat: { providerId: GITHUB_COPILOT_SUBSCRIPTION_PROVIDER_ID, modelId: 'gpt-copilot' },
    })
    upsertChatMessage({
      id: 'user-before-native-compact',
      conversationId: conversation.id,
      role: 'user',
      parts: [{ type: 'text', id: 'large-text', text: 'x'.repeat(1_200_000) }],
      createdAt: 1,
    })
    upsertChatMessage({
      id: 'native-copilot-marker',
      conversationId: conversation.id,
      role: 'assistant',
      parts: [openAINativeCompactionMarkerPart('native-marker-part')],
      model: { providerId: GITHUB_COPILOT_SUBSCRIPTION_PROVIDER_ID, modelId: 'gpt-copilot' },
      usage: {
        usageVersion: 2,
        input: 0,
        output: 0,
        contextInput: 58_000,
        contextOutput: 2_000,
        modelContextWindow: 272_000,
        billingOnly: true,
      },
      createdAt: 2,
    })
    h.state.status = signedInStatus()
    h.state.identity = { fingerprint: 'sha256:account-a', epoch: 1 }
    h.state.models = [copilotModel('gpt-copilot')]
    h.state.binding = {
      conversationId: conversation.id,
      sessionId: 'session-native',
      modelId: 'gpt-copilot',
      harnessProfile: 'copilot-openai-v1',
      toolSignature: 'tools-v1',
      lastMessageId: 'native-copilot-marker',
      accountFingerprint: 'sha256:account-a',
      updatedAt: 1,
    }

    expect(await handlers.get('chat:history:stats')?.({}, conversation.id)).toMatchObject({
      contextProjection: { usedTokens: 58_000, source: 'runtime-usage', quality: 'measured' },
    })
    await expect(
      handlers.get('chat:set-selection')?.({}, conversation.id, {
        providerId: byok.id,
        modelId: 'fable',
      })
    ).resolves.toEqual({ ok: true })
    const switched = (await handlers.get('chat:history:stats')?.({}, conversation.id)) as any
    expect(switched.contextProjection).toMatchObject({ source: 'portable-transcript', quality: 'estimated' })
    expect(switched.contextProjection.usedTokens).toBeGreaterThan(390_000)
    expect(h.deleteOne).not.toHaveBeenCalled()
  })

  it('deduplicates login and blocks admission from the start of logout', async () => {
    const { handlers } = register()
    let finishReset!: () => void
    const reset = new Promise<void>((resolve) => {
      finishReset = resolve
    })
    h.manager.resetLocalData.mockReturnValueOnce(reset)

    const firstLogin = handlers.get('chat:github-copilot-subscription:login')?.({}) as Promise<unknown>
    await vi.waitFor(() => expect(h.manager.resetLocalData).toHaveBeenCalledTimes(1))
    await expect(handlers.get('chat:github-copilot-subscription:login')?.({})).resolves.toMatchObject({ ok: false })
    finishReset()
    await expect(firstLogin).resolves.toMatchObject({ ok: true })

    // Complete the first Device Flow so the next portion starts from a stable signed-in state.
    await vi.waitFor(() => expect(h.manager.waitForLogin).toHaveBeenCalled())
    await vi.waitFor(() => expect(h.manager.getStatus).toHaveBeenCalledWith(true))

    h.state.status = signedInStatus()
    h.state.identity = { fingerprint: 'sha256:account-a', epoch: 3 }
    h.state.models = [copilotModel('gpt-5.6-sol')]
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    patchConvUiPrefs(conversation.id, {
      chat: { providerId: GITHUB_COPILOT_SUBSCRIPTION_PROVIDER_ID, modelId: 'gpt-5.6-sol' },
    })
    let finishLogoutReset!: () => void
    h.manager.resetLocalData.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishLogoutReset = resolve
      })
    )
    const logout = handlers.get('chat:github-copilot-subscription:logout')?.({}) as Promise<unknown>
    await vi.waitFor(() => expect(h.manager.resetLocalData).toHaveBeenCalledTimes(2))
    await expect(
      handlers.get('chat:send')?.(
        { sender: { isDestroyed: () => false, send: vi.fn() } },
        { conversationId: conversation.id, text: 'must not cross logout' }
      )
    ).resolves.toEqual({ ok: false, error: 'no-key' })
    h.state.status = signedOutStatus()
    h.state.identity = { fingerprint: null, epoch: 4 }
    finishLogoutReset()
    await expect(logout).resolves.toMatchObject({ ok: true })
    expect(h.runCopilot).not.toHaveBeenCalled()
  })

  it('admits model-aware turns and resolves synthetic Ultra', async () => {
    const { handlers, emitStatus } = register()
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    patchConvUiPrefs(conversation.id, {
      chat: {
        providerId: GITHUB_COPILOT_SUBSCRIPTION_PROVIDER_ID,
        modelId: 'claude-sonnet-4.6',
        reasoning: MAESTRLY_ULTRA_EFFORT,
      },
    })
    h.state.status = signedInStatus()
    h.state.identity = { fingerprint: 'sha256:account-a', epoch: 7 }
    h.state.models = [copilotModel('claude-sonnet-4.6')]
    h.runCopilot.mockImplementationOnce(async (args: any) => {
      expect(args.onSessionReady('session-model-aware')).toBe(true)
      expect(args.canPersistSession()).toBe(true)
      return { planSubmitted: false, sessionId: 'session-model-aware' }
    })
    const sender = { isDestroyed: () => false, send: vi.fn() }

    await expect(
      handlers.get('chat:send')?.({ sender }, { conversationId: conversation.id, text: 'analise o projeto' })
    ).resolves.toEqual({ ok: true })
    await vi.waitFor(() => expect(h.runCopilot).toHaveBeenCalledTimes(1))

    expect(h.runCopilot.mock.calls[0][0]).toMatchObject({
      conversationId: conversation.id,
      selection: {
        providerId: GITHUB_COPILOT_SUBSCRIPTION_PROVIDER_ID,
        modelId: 'claude-sonnet-4.6',
      },
      reasoningEffort: 'xhigh',
      maestrlyUltra: true,
      accountIdentity: { fingerprint: 'sha256:account-a', epoch: 7 },
    })
    expect(h.manager.assertAccountIdentity).toHaveBeenCalledWith({ fingerprint: 'sha256:account-a', epoch: 7 })
    await vi.waitFor(() => expect(emitStatus).toHaveBeenCalledWith(conversation.id, 'ready', undefined))
    expect(getConvUiPrefs(conversation.id).chat?.reasoning).toBe(MAESTRLY_ULTRA_EFFORT)
  })

  it('compacts large BYOK history before starting a smaller Copilot session', async () => {
    const { handlers } = register()
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    patchConvUiPrefs(conversation.id, {
      chat: {
        providerId: GITHUB_COPILOT_SUBSCRIPTION_PROVIDER_ID,
        modelId: 'gpt-copilot-small',
      },
    })
    upsertChatMessage({
      id: 'user-large-byok',
      conversationId: conversation.id,
      role: 'user',
      parts: [{ type: 'text', id: 'large-byok-text', text: 'x'.repeat(1_000_000) }],
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
    h.state.status = signedInStatus()
    h.state.identity = { fingerprint: 'sha256:account-a', epoch: 8 }
    h.state.models = [copilotModel('gpt-copilot-small')]

    await expect(
      handlers.get('chat:send')?.(
        { sender: { isDestroyed: () => false, send: vi.fn() } },
        { conversationId: conversation.id, text: 'continue no Copilot' }
      )
    ).resolves.toEqual({ ok: true })
    await vi.waitFor(() => expect(h.runCopilot).toHaveBeenCalledTimes(1))

    const messages = listChatMessages(conversation.id)
    const markerIndex = messages.findIndex((message) => message.parts.some((part) => part.type === 'compaction'))
    const pendingIndex = messages.findIndex((message) =>
      message.parts.some((part) => part.type === 'text' && part.text === 'continue no Copilot')
    )
    expect(markerIndex).toBeGreaterThan(0)
    expect(pendingIndex).toBeGreaterThan(markerIndex)
    expect(h.summarizePortable).toHaveBeenCalled()
  })

  it('revokes persistence and aborts the active turn when GitHub identity changes', async () => {
    const { handlers, emitStatus } = register()
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    patchConvUiPrefs(conversation.id, {
      chat: {
        providerId: GITHUB_COPILOT_SUBSCRIPTION_PROVIDER_ID,
        modelId: 'gpt-5.6-sol',
      },
    })
    h.state.status = signedInStatus()
    h.state.identity = { fingerprint: 'sha256:old-account', epoch: 3 }
    h.state.models = [copilotModel('gpt-5.6-sol')]
    let finishRun!: (value: { planSubmitted: boolean; sessionId: string }) => void
    const pendingRun = new Promise<{ planSubmitted: boolean; sessionId: string }>((resolve) => {
      finishRun = resolve
    })
    h.runCopilot.mockReturnValueOnce(pendingRun)
    const sender = { isDestroyed: () => false, send: vi.fn() }

    await expect(
      handlers.get('chat:send')?.({ sender }, { conversationId: conversation.id, text: 'continue' })
    ).resolves.toEqual({ ok: true })
    await vi.waitFor(() => expect(h.runCopilot).toHaveBeenCalledTimes(1))
    const args = h.runCopilot.mock.calls[0][0]
    expect(args.canPersistSession()).toBe(true)
    expect(args.signal.aborted).toBe(false)

    h.emitAuthUpdated()

    await vi.waitFor(() => expect(args.signal.aborted).toBe(true))
    expect(args.canPersistSession()).toBe(false)
    expect(args.onSessionReady('late-session')).toBe(false)
    await vi.waitFor(() => expect(h.deleteAll).toHaveBeenCalled())

    finishRun({ planSubmitted: false, sessionId: 'late-session' })
    await vi.waitFor(() => expect(emitStatus).toHaveBeenCalledWith(conversation.id, 'idle', undefined))
  })

  it('persists portable compaction and immediately invalidates the native session', async () => {
    const { handlers } = register()
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    patchConvUiPrefs(conversation.id, {
      chat: {
        providerId: GITHUB_COPILOT_SUBSCRIPTION_PROVIDER_ID,
        modelId: 'gpt-5.6-sol',
      },
    })
    const userId = 'user-before-compact'
    const assistantId = 'assistant-before-compact'
    upsertChatMessage({
      id: userId,
      conversationId: conversation.id,
      role: 'user',
      parts: [{ type: 'text', id: 'user-text', text: 'continue' }],
      createdAt: 1,
    })
    upsertChatMessage({
      id: assistantId,
      conversationId: conversation.id,
      role: 'assistant',
      parts: [{ type: 'text', id: 'assistant-text', text: 'done' }],
      model: { providerId: GITHUB_COPILOT_SUBSCRIPTION_PROVIDER_ID, modelId: 'gpt-5.6-sol' },
      createdAt: 2,
    })
    h.state.status = signedInStatus()
    h.state.identity = { fingerprint: 'sha256:account-a', epoch: 1 }
    h.state.models = [copilotModel('gpt-5.6-sol')]
    h.state.binding = {
      conversationId: conversation.id,
      sessionId: 'session-test',
      modelId: 'gpt-5.6-sol',
      harnessProfile: 'copilot-openai-v1',
      toolSignature: 'tools-v1',
      lastMessageId: assistantId,
      accountFingerprint: 'sha256:account-a',
      updatedAt: 1,
    }

    await expect(handlers.get('chat:compact')?.({}, conversation.id)).resolves.toEqual({
      ok: true,
      summary: 'portable summary',
      usage: { input: 100, output: 20, cacheRead: 0, cacheCreate: 0, totalInput: 100 },
    })

    expect(h.summarizePortable).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: conversation.id,
        accountIdentity: { fingerprint: 'sha256:account-a', epoch: 1 },
        modelId: 'gpt-5.6-sol',
      })
    )
    const marker = listChatMessages(conversation.id).at(-1)
    expect(marker?.parts).toEqual([
      expect.objectContaining({ type: 'compaction', text: 'portable summary', strategy: 'summary' }),
    ])
    expect(h.deleteOne).toHaveBeenCalledWith(conversation.id)
    expect(h.state.binding).toBeNull()
    expect(await handlers.get('chat:history:stats')?.({}, conversation.id)).toMatchObject({
      contextProjection: { source: 'portable-transcript', quality: 'estimated' },
    })
  })
})
