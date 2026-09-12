import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatConfig } from '../../src/shared/chat'
import type { GrokSubscriptionModel, GrokSubscriptionStatus } from '../../src/main/chat/grok-subscription'

/** Mock manager state avoids overly narrow null inference. */
interface MockGrokManagerState {
  status: GrokSubscriptionStatus
  models: GrokSubscriptionModel[]
}

const h = vi.hoisted(() => {
  const signedOutStatus = (): GrokSubscriptionStatus => ({
    state: 'ready',
    available: true,
    connected: false,
    authenticated: false,
    account: null,
    storageMode: 'secure',
    accountFingerprint: null,
    accountEpoch: 0,
    error: null,
  })
  const signedInStatus = (overrides: Partial<GrokSubscriptionStatus> = {}): GrokSubscriptionStatus => ({
    state: 'ready',
    available: true,
    connected: true,
    authenticated: true,
    account: { email: 'grok@x.ai', name: 'Grok User', planType: 'SuperGrok' },
    storageMode: 'secure',
    accountFingerprint: 'sha256:sub:grok-user',
    accountEpoch: 3,
    error: null,
    ...overrides,
  })
  const defaultModels: GrokSubscriptionModel[] = [{ id: 'grok-4' }, { id: 'grok-4-fast' }]

  const authUpdatedListeners = new Map<string, (() => void) | null>()
  const loginCompletions = new Map<string, Promise<{ loginId: string; success: boolean; error: unknown }>>()

  const makeManager = (accountId: string | null) => {
    const state: MockGrokManagerState = {
      status: signedOutStatus(),
      models: [...defaultModels],
    }
    return {
      accountId,
      isDisposed: false,
      getStatus: vi.fn(async () => state.status),
      getStatusSnapshot: vi.fn(() => state.status),
      listModels: vi.fn(async () => state.models),
      getAccountIdentity: vi.fn(() => ({
        fingerprint: state.status.accountFingerprint,
        epoch: state.status.accountEpoch,
      })),
      assertAccountIdentity: vi.fn(),
      resetLocalData: vi.fn(async () => {
        state.status = signedOutStatus()
      }),
      startLogin: vi.fn(async (method: string) => {
        const loginId = `login-${accountId ?? 'default'}-${method}`
        return {
          loginId,
          method,
          authUrl: method === 'browser' ? `https://auth.x.ai/oauth2/authorize?login=${loginId}` : null,
          userCode: method === 'device' ? 'ABCD-EFGH' : null,
          verificationUri: method === 'device' ? 'https://auth.x.ai/device' : null,
          verificationUriComplete: method === 'device' ? 'https://auth.x.ai/device?user_code=ABCD-EFGH' : null,
          expiresAt: Date.now() + 180_000,
          state: 'pending',
          completion: null,
        }
      }),
      waitForLogin: vi.fn(
        (loginId: string) => loginCompletions.get(loginId) ?? Promise.resolve({ loginId, success: true, error: null })
      ),
      onAuthUpdated: vi.fn((listener: () => void) => {
        authUpdatedListeners.set(accountId ?? '', listener)
        return () => {
          authUpdatedListeners.set(accountId ?? '', null)
        }
      }),
      dispose: vi.fn(async () => {}),
      __state: state,
    }
  }

  const managers = new Map<string, ReturnType<typeof makeManager>>()
  const managerFor = (accountId: string | null) => {
    const key = accountId ?? ''
    let manager = managers.get(key)
    if (!manager) {
      manager = makeManager(accountId)
      managers.set(key, manager)
    }
    return manager
  }

  const webContents = { isDestroyed: vi.fn(() => false), send: vi.fn() }
  return {
    managerFor,
    managers,
    authUpdatedListeners,
    loginCompletions,
    webContents,
    getMainWebContents: vi.fn(() => webContents),
    runChat: vi.fn(),
    invalidateProvider: vi.fn(),
    signedInStatus,
    signedOutStatus,
  }
})

vi.mock('../../src/main/window-ipc', () => ({ getMainWebContents: h.getMainWebContents }))

vi.mock('../../src/main/chat/grok-subscription', () => ({
  grokSubscriptionErrorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
  getGrokSubscriptionManager: (accountId: string | null = null) => h.managerFor(accountId),
  listGrokSubscriptionManagers: () => [...h.managers.values()],
  disposeGrokSubscriptionManager: vi.fn(async () => {}),
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

vi.mock('../../src/main/chat/claude-agent-sdk', () => ({
  claudeSubscriptionErrorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
  compactClaudeSession: vi.fn(),
  deleteAllManagedClaudeSessions: vi.fn(async () => {}),
  deleteClaudeSessionForConversation: vi.fn(async () => {}),
  getClaudeSessionBinding: vi.fn(() => null),
  getClaudeSubscriptionManager: () => ({
    isDisposed: false,
    status: vi.fn(async () => ({
      state: 'ready',
      available: true,
      authenticated: false,
      account: null,
      error: null,
    })),
    getStatusSnapshot: vi.fn(() => null),
    listModels: vi.fn(async () => []),
    accountIdentity: vi.fn(async () => ({ fingerprint: null, epoch: 0 })),
    assertAccountIdentity: vi.fn(),
    observeModelContextWindow: vi.fn(),
    getObservedModelContextWindow: vi.fn(() => undefined),
    onAuthenticationRequired: vi.fn(() => () => {}),
    login: vi.fn(),
    cancelLogin: vi.fn(),
    logout: vi.fn(),
    wipe: vi.fn(),
    dispose: vi.fn(),
  }),
  inspectClaudeSessionCompatibility: vi.fn(async () => true),
  putClaudeSessionBinding: vi.fn(),
  retryManagedClaudeSessionCleanup: vi.fn(async () => {}),
  runClaudeChat: vi.fn(),
}))

vi.mock('../../src/main/chat/portable-summarizer', () => ({
  summarizeWithClaudeRuntime: vi.fn(),
  summarizeWithCodexRuntime: vi.fn(),
  summarizeWithGitHubCopilotRuntime: vi.fn(),
}))

vi.mock('../../src/main/chat/runner', () => ({
  normalizeAiUsage: vi.fn(() => ({ input: 0, output: 0, totalInput: 0, cacheRead: 0, cacheCreate: 0 })),
  runChat: h.runChat,
}))

vi.mock('../../src/main/chat/model-meta', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/chat/model-meta')>()
  return { ...actual, getClaudeHarnessModelMeta: vi.fn(async () => null) }
})

vi.mock('../../src/main/chat/provider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/chat/provider')>()
  return { ...actual, invalidateProvider: h.invalidateProvider }
})

import {
  GROK_SUBSCRIPTION_PROVIDER_ID,
  addSubscriptionAccount,
  subscriptionProviderIdFor,
} from '../../src/main/chat/catalog'
import { registerChatIpc, type ChatIpcDeps } from '../../src/main/chat/service'
import { closeDb, freshDb } from '../helpers/db'
import { makeConversation, makeWorkspace } from '../helpers/factories'
import { patchConvUiPrefs } from '../../src/main/store'

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

function signedInDefaultManager(): void {
  h.managerFor(null).__state.status = h.signedInStatus()
}

function signedOutDefaultManager(): void {
  h.managerFor(null).__state.status = h.signedOutStatus()
}

/**
 * Controlled login completion: the service reads manager status at
 * completion after state flips, matching real token persistence before
 * notification.
 */
function deferredLogin(loginId: string, flip?: () => void): (success?: boolean, error?: unknown) => void {
  let resolveFn!: (completion: { loginId: string; success: boolean; error: unknown }) => void
  h.loginCompletions.set(
    loginId,
    new Promise((resolve) => {
      resolveFn = resolve
    })
  )
  return (success = true, error: unknown = null) => {
    flip?.()
    resolveFn({ loginId, success, error })
  }
}

describe('Grok subscription service integration', () => {
  beforeEach(() => {
    freshDb()
    vi.clearAllMocks()
    h.loginCompletions.clear()
    h.managerFor(null).__state.status = h.signedOutStatus()
    h.managerFor(null).__state.models = [{ id: 'grok-4' }, { id: 'grok-4-fast' }]
  })

  afterEach(() => {
    closeDb()
  })

  describe('chat:grok-subscription:status', () => {
    it('returns signed-out when unauthenticated', async () => {
      const { handlers } = register()
      await expect(handlers.get('chat:grok-subscription:status')?.({})).resolves.toEqual({
        state: 'signed-out',
        authenticated: false,
      })
    })

    it('returns authenticated account data', async () => {
      signedInDefaultManager()
      const { handlers } = register()
      await expect(handlers.get('chat:grok-subscription:status')?.({}, { refresh: true })).resolves.toMatchObject({
        state: 'signed-in',
        authenticated: true,
        email: 'grok@x.ai',
        planType: 'SuperGrok',
      })
    })

    it('returns additional account status with account IDs', async () => {
      const account = addSubscriptionAccount('grok-subscription', 'Conta extra')
      h.managerFor(account.id).__state.status = h.signedInStatus({
        account: { email: 'extra@x.ai', name: 'Extra', planType: 'SuperGrok' },
        accountFingerprint: 'sha256:sub:extra',
        accountEpoch: 1,
      })
      const { handlers } = register()
      await expect(
        handlers.get('chat:grok-subscription:status')?.({}, { accountId: account.id })
      ).resolves.toMatchObject({
        state: 'signed-in',
        authenticated: true,
        accountId: account.id,
        email: 'extra@x.ai',
      })
    })

    it('returns unavailable for missing accounts', async () => {
      const { handlers } = register()
      await expect(handlers.get('chat:grok-subscription:status')?.({}, { accountId: 'acc_ghost' })).resolves.toEqual({
        state: 'unavailable',
        authenticated: false,
        accountId: 'acc_ghost',
      })
    })
  })

  describe('chat:grok-subscription:login', () => {
    it('returns browser auth URLs and publishes login completion', async () => {
      signedOutDefaultManager()
      const complete = deferredLogin('login-default-browser', () => signedInDefaultManager())
      const { handlers } = register()

      await expect(handlers.get('chat:grok-subscription:login')?.({})).resolves.toMatchObject({
        ok: true,
        authUrl: expect.stringContaining('https://auth.x.ai/oauth2/authorize'),
        status: { state: 'signing-in', authenticated: false },
      })
      expect(h.webContents.send).toHaveBeenCalledWith(
        'chat:grok-subscription:auth-changed',
        expect.objectContaining({ state: 'signing-in', authenticated: false })
      )
      expect(h.managerFor(null).resetLocalData).toHaveBeenCalled()
      expect(h.invalidateProvider).toHaveBeenCalledWith(GROK_SUBSCRIPTION_PROVIDER_ID)

      // Login completion publishes signed-in authentication changes.
      complete()
      await vi.waitFor(() =>
        expect(h.webContents.send).toHaveBeenCalledWith(
          'chat:grok-subscription:auth-changed',
          expect.objectContaining({ state: 'signed-in', authenticated: true })
        )
      )
    })

    it('returns device verification URLs and codes', async () => {
      signedOutDefaultManager()
      const complete = deferredLogin('login-default-device', () => signedInDefaultManager())
      const { handlers } = register()

      await expect(handlers.get('chat:grok-subscription:login')?.({}, { method: 'device' })).resolves.toMatchObject({
        ok: true,
        verificationUrl: 'https://auth.x.ai/device?user_code=ABCD-EFGH',
        userCode: 'ABCD-EFGH',
      })
      complete()
    })

    it('rejects concurrent pending logins', async () => {
      const complete = deferredLogin('login-default-browser', () => signedInDefaultManager())
      const { handlers } = register()

      await expect(handlers.get('chat:grok-subscription:login')?.({})).resolves.toMatchObject({ ok: true })
      await expect(handlers.get('chat:grok-subscription:login')?.({})).resolves.toMatchObject({
        ok: false,
        error: expect.stringContaining('transition'),
      })
      // Resolve pending login to avoid leaking state between tests.
      complete()
      await vi.waitFor(() =>
        expect(h.webContents.send).toHaveBeenCalledWith(
          'chat:grok-subscription:auth-changed',
          expect.objectContaining({ state: 'signed-in' })
        )
      )
    })

    it('publishes login completion errors', async () => {
      const complete = deferredLogin('login-default-browser')
      const { handlers } = register()
      await expect(handlers.get('chat:grok-subscription:login')?.({})).resolves.toMatchObject({ ok: true })
      complete(false, { message: 'denied' })
      await vi.waitFor(() =>
        expect(h.webContents.send).toHaveBeenCalledWith(
          'chat:grok-subscription:auth-changed',
          expect.objectContaining({ state: 'error', authenticated: false, error: 'denied' })
        )
      )
    })
  })

  describe('chat:grok-subscription:logout', () => {
    it('cleans managers and publishes signed-out state', async () => {
      signedInDefaultManager()
      const { handlers } = register()

      await expect(handlers.get('chat:grok-subscription:logout')?.({})).resolves.toMatchObject({
        ok: true,
        status: { state: 'signed-out', authenticated: false },
      })
      expect(h.managerFor(null).resetLocalData).toHaveBeenCalled()
      expect(h.invalidateProvider).toHaveBeenCalledWith(GROK_SUBSCRIPTION_PROVIDER_ID)
      expect(h.webContents.send).toHaveBeenCalledWith(
        'chat:grok-subscription:auth-changed',
        expect.objectContaining({ state: 'signed-out', authenticated: false })
      )
      await expect(handlers.get('chat:grok-subscription:status')?.({})).resolves.toMatchObject({
        state: 'signed-out',
      })
    })

    it('aborts only the active account Grok turn', async () => {
      signedInDefaultManager()
      const runRejected = vi.fn()
      h.runChat.mockImplementation(
        (opts: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            if (opts.signal.aborted) reject(opts.signal.reason ?? new Error('aborted'))
            else opts.signal.addEventListener('abort', () => reject(opts.signal.reason ?? new Error('aborted')))
          })
      )
      const { handlers } = register()
      const workspace = makeWorkspace()
      const conversation = makeConversation(workspace.id, { cwd: '/repo' })
      patchConvUiPrefs(conversation.id, {
        chat: { providerId: GROK_SUBSCRIPTION_PROVIDER_ID, modelId: 'grok-4', mode: 'agent', permMode: 'ask' },
      })

      await expect(
        handlers.get('chat:send')?.({ sender: h.webContents }, { conversationId: conversation.id, text: 'Run this.' })
      ).resolves.toEqual({ ok: true })
      await vi.waitFor(() => expect(h.runChat).toHaveBeenCalledOnce())
      expect(h.managerFor(null).assertAccountIdentity).toHaveBeenCalled()

      const rejected = h.runChat.mock.results[0].value.then(runRejected, runRejected)
      await expect(handlers.get('chat:grok-subscription:logout')?.({})).resolves.toMatchObject({ ok: true })
      await rejected
      expect(runRejected).toHaveBeenCalled()
    })
  })

  describe('catalog and selection', () => {
    it('Grok provider appears connected without an API key in chat:config', async () => {
      signedInDefaultManager()
      const { handlers } = register()
      const config = await handlers.get('chat:config')?.({})
      expect(config).toMatchObject({
        providers: expect.arrayContaining([
          expect.objectContaining({
            id: GROK_SUBSCRIPTION_PROVIDER_ID,
            kind: 'grok-subscription',
            builtIn: true,
            connected: true,
            apiKeyPresent: false,
          }),
        ]),
      })
    })

    it('reads models from the correct account manager', async () => {
      signedInDefaultManager()
      const account = addSubscriptionAccount('grok-subscription', 'Conta extra')
      h.managerFor(account.id).__state.status = h.signedInStatus({
        account: { email: 'extra@x.ai', name: 'Extra', planType: 'SuperGrok' },
        accountFingerprint: 'sha256:sub:extra',
        accountEpoch: 1,
      })
      h.managerFor(account.id).__state.models = [{ id: 'grok-extra-1' }]
      const { handlers } = register()

      await expect(handlers.get('chat:models')?.({}, GROK_SUBSCRIPTION_PROVIDER_ID, true)).resolves.toEqual([
        'grok-4',
        'grok-4-fast',
      ])
      await expect(
        handlers.get('chat:models')?.({}, subscriptionProviderIdFor('grok-subscription', account.id), true)
      ).resolves.toEqual(['grok-extra-1'])
      expect(h.managerFor(account.id).listModels).toHaveBeenCalledWith(true)
    })

    it('rejects nonexistent model selections', async () => {
      signedInDefaultManager()
      const { handlers } = register()
      await expect(
        handlers.get('chat:set-default')?.({}, { providerId: GROK_SUBSCRIPTION_PROVIDER_ID, modelId: 'nope-9' })
      ).resolves.toEqual({ ok: false, error: 'no-model' })
      await expect(
        handlers.get('chat:set-default')?.({}, { providerId: GROK_SUBSCRIPTION_PROVIDER_ID, modelId: 'grok-4' })
      ).resolves.toEqual({ ok: true })
    })

    it('defaults to authenticated Grok when other providers are unavailable', async () => {
      signedInDefaultManager()
      const { handlers } = register()
      const config = (await handlers.get('chat:config')?.({})) as ChatConfig
      expect(config.defaultSelection).toEqual({ providerId: GROK_SUBSCRIPTION_PROVIDER_ID, modelId: '' })
    })
  })

  describe('multi-account', () => {
    it('isolates additional-slot login and logout from the default account', async () => {
      signedInDefaultManager()
      const account = addSubscriptionAccount('grok-subscription', 'Conta extra')
      const complete = deferredLogin(`login-${account.id}-browser`, () => {
        h.managerFor(account.id).__state.status = h.signedInStatus({
          account: { email: 'extra@x.ai', name: 'Extra', planType: 'SuperGrok' },
          accountFingerprint: 'sha256:sub:extra',
          accountEpoch: 1,
        })
      })
      const { handlers } = register()

      await expect(
        handlers.get('chat:grok-subscription:login')?.({}, { accountId: account.id })
      ).resolves.toMatchObject({
        ok: true,
        authUrl: expect.stringContaining('https://auth.x.ai/oauth2/authorize'),
      })
      expect(h.managerFor(null).resetLocalData).not.toHaveBeenCalled()
      complete()
      // Slot broadcasts include accountId.
      await vi.waitFor(() =>
        expect(h.webContents.send).toHaveBeenCalledWith(
          'chat:grok-subscription:auth-changed',
          expect.objectContaining({ state: 'signed-in', accountId: account.id })
        )
      )
      // The default account stays signed in.
      await expect(handlers.get('chat:grok-subscription:status')?.({})).resolves.toMatchObject({
        state: 'signed-in',
      })

      await expect(
        handlers.get('chat:grok-subscription:logout')?.({}, { accountId: account.id })
      ).resolves.toMatchObject({ ok: true })
      expect(h.managerFor(null).resetLocalData).not.toHaveBeenCalled()
      expect(h.managerFor(account.id).resetLocalData).toHaveBeenCalled()
      // Slot logout includes accountId in events.
      expect(h.webContents.send).toHaveBeenCalledWith(
        'chat:grok-subscription:auth-changed',
        expect.objectContaining({ state: 'signed-out', accountId: account.id })
      )
      // The default account remains signed in after slot logout.
      await expect(handlers.get('chat:grok-subscription:status')?.({})).resolves.toMatchObject({
        state: 'signed-in',
      })
    })

    it('removes only the selected account slot and manager', async () => {
      signedInDefaultManager()
      const account = addSubscriptionAccount('grok-subscription', 'Conta extra')
      const { handlers } = register()

      await expect(handlers.get('chat:subscription-account:remove')?.({}, account.id)).resolves.toEqual({
        ok: true,
      })
      expect(h.managerFor(account.id).resetLocalData).toHaveBeenCalled()
      expect(h.managerFor(null).resetLocalData).not.toHaveBeenCalled()
      expect(h.invalidateProvider).toHaveBeenCalledWith(subscriptionProviderIdFor('grok-subscription', account.id))
      // Removed catalog slots become unavailable.
      await expect(
        handlers.get('chat:grok-subscription:status')?.({}, { accountId: account.id })
      ).resolves.toMatchObject({ state: 'unavailable' })
    })
  })

  describe('identity boundary', () => {
    it('aborts active turns on logout', async () => {
      signedInDefaultManager()
      h.runChat.mockImplementation(
        (opts: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            opts.signal.addEventListener('abort', () => reject(opts.signal.reason ?? new Error('aborted')))
          })
      )
      const { handlers } = register()
      const workspace = makeWorkspace()
      const conversation = makeConversation(workspace.id, { cwd: '/repo' })
      patchConvUiPrefs(conversation.id, {
        chat: { providerId: GROK_SUBSCRIPTION_PROVIDER_ID, modelId: 'grok-4' },
      })
      await expect(
        handlers.get('chat:send')?.({ sender: h.webContents }, { conversationId: conversation.id, text: 'Do it.' })
      ).resolves.toEqual({ ok: true })
      await vi.waitFor(() => expect(h.runChat).toHaveBeenCalledOnce())

      const rejected = h.runChat.mock.results[0].value.then(
        () => undefined,
        (error: unknown) => error
      )
      await expect(handlers.get('chat:grok-subscription:logout')?.({})).resolves.toMatchObject({ ok: true })
      await expect(rejected).resolves.toBeDefined()
    })

    it('aborts turns behind identity barriers when subjects change', async () => {
      signedInDefaultManager()
      h.runChat.mockImplementation(
        (opts: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            opts.signal.addEventListener('abort', () => reject(opts.signal.reason ?? new Error('aborted')))
          })
      )
      const { handlers } = register()
      const workspace = makeWorkspace()
      const conversation = makeConversation(workspace.id, { cwd: '/repo' })
      patchConvUiPrefs(conversation.id, {
        chat: { providerId: GROK_SUBSCRIPTION_PROVIDER_ID, modelId: 'grok-4' },
      })
      await expect(
        handlers.get('chat:send')?.({ sender: h.webContents }, { conversationId: conversation.id, text: 'Do it.' })
      ).resolves.toEqual({ ok: true })
      await vi.waitFor(() => expect(h.runChat).toHaveBeenCalledOnce())

      const rejected = h.runChat.mock.results[0].value.then(
        () => undefined,
        (error: unknown) => error
      )
      // The manager announces a real account change (different subject); the service aborts the turn.
      // Real identity changes end sessions and report signed-out.
      signedOutDefaultManager()
      h.authUpdatedListeners.get('')?.()
      await expect(rejected).resolves.toMatchObject({ message: 'Grok account changed' })
      expect(h.invalidateProvider).toHaveBeenCalledWith(GROK_SUBSCRIPTION_PROVIDER_ID)
      await vi.waitFor(() =>
        expect(h.webContents.send).toHaveBeenCalledWith(
          'chat:grok-subscription:auth-changed',
          expect.objectContaining({ state: 'signed-out', authenticated: false })
        )
      )
    })

    it('does not persist stale login results after logout', async () => {
      const { handlers } = register()
      const late = Promise.resolve({ loginId: 'login-default-browser', success: true, error: null })
      h.loginCompletions.set('login-default-browser', late)

      await expect(handlers.get('chat:grok-subscription:login')?.({})).resolves.toMatchObject({ ok: true })
      await expect(handlers.get('chat:grok-subscription:logout')?.({})).resolves.toMatchObject({ ok: true })
      const sendsAfterLogout = h.webContents.send.mock.calls.length

      // Late login generations never publish signed-in state.
      await late
      await new Promise((resolve) => setTimeout(resolve, 10))
      const lateSends = h.webContents.send.mock.calls.slice(sendsAfterLogout)
      expect(lateSends.filter(([, payload]) => payload?.state === 'signed-in')).toEqual([])
      expect(h.managerFor(null).resetLocalData).toHaveBeenCalledTimes(2)
    })
  })
})
