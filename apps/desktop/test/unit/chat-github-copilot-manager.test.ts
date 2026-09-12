import path from 'node:path'
import { RuntimeConnection, type CopilotClientOptions, type CopilotSession, type ModelInfo } from '@github/copilot-sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  GitHubCopilotAccountChangedError,
  GitHubCopilotNotAuthenticatedError,
  GitHubCopilotSubscriptionManager,
  githubCopilotRuntimeEnvironment,
  resolveGitHubCopilotOAuthClientId,
  type GitHubCopilotRuntimeClient,
} from '../../src/main/chat/github-copilot/manager'
import type { GitHubCopilotOAuthClient } from '../../src/main/chat/github-copilot/oauth'
import type {
  GitHubCopilotTokenStorageMode,
  GitHubCopilotTokenStore,
} from '../../src/main/chat/github-copilot/token-store'

class MemoryTokenStore implements GitHubCopilotTokenStore {
  token: string | null
  storageMode: GitHubCopilotTokenStorageMode = 'secure'

  constructor(token: string | null = null) {
    this.token = token
  }

  get(): string | null {
    return this.token
  }

  set(token: string): GitHubCopilotTokenStorageMode {
    this.token = token
    return this.storageMode
  }

  clear(): void {
    this.token = null
  }

  mode(): GitHubCopilotTokenStorageMode {
    return this.storageMode
  }
}

function model(id = 'gpt-5.4'): ModelInfo {
  return {
    id,
    name: id === 'gpt-5.4' ? 'GPT-5.4' : id,
    capabilities: {
      supports: { vision: true, reasoningEffort: true },
      limits: { max_context_window_tokens: 272_000 },
    },
    policy: { state: 'enabled', terms: '' },
    billing: { multiplier: 1 },
    supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
    defaultReasoningEffort: 'high',
  }
}

function session(id: string): CopilotSession {
  return {
    sessionId: id,
    disconnect: vi.fn(async () => {}),
  } as unknown as CopilotSession
}

function runtimeClient(overrides: Partial<GitHubCopilotRuntimeClient> = {}): GitHubCopilotRuntimeClient {
  return {
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => []),
    forceStop: vi.fn(async () => {}),
    getAuthStatus: vi.fn(async () => ({
      isAuthenticated: true,
      authType: 'token' as const,
      host: 'https://github.com',
      login: 'octocat',
    })),
    listModels: vi.fn(async () => [model()]),
    createSession: vi.fn(async () => session('created-session')),
    resumeSession: vi.fn(async (id) => session(id)),
    deleteSession: vi.fn(async () => {}),
    ...overrides,
  }
}

describe('GitHubCopilotSubscriptionManager', () => {
  let tokenStore: MemoryTokenStore
  let client: GitHubCopilotRuntimeClient
  let clientOptions: CopilotClientOptions[]
  let releaseRuntimeLease: ReturnType<typeof vi.fn<() => void>>
  let manager: GitHubCopilotSubscriptionManager

  beforeEach(() => {
    tokenStore = new MemoryTokenStore('gho_private_token_value')
    client = runtimeClient()
    clientOptions = []
    releaseRuntimeLease = vi.fn()
    manager = new GitHubCopilotSubscriptionManager({
      getOAuthClientId: () => 'maestrly-public-client-id',
      tokenStore,
      getUserDataPath: () => '/tmp/maestrly-user-data',
      ensureDirectory: vi.fn(async () => {}),
      getProcessEnvironment: () => ({
        PATH: '/usr/bin:/bin',
        HOME: '/home/fixture',
        HTTPS_PROXY: 'https://proxy.example',
        OPENAI_API_KEY: 'sk-must-not-reach-child',
        AWS_SECRET_ACCESS_KEY: 'aws-must-not-reach-child',
        GITHUB_TOKEN: 'github-must-not-reach-child',
      }),
      resolveConnection: (environment) => RuntimeConnection.forStdio({ path: '/fixture/copilot', env: environment }),
      acquireRuntimeLease: async (runtimePath) => ({
        id: 'github-copilot-runtime',
        path: runtimePath,
        release: releaseRuntimeLease,
      }),
      createClient: (options) => {
        clientOptions.push(options)
        return client
      },
      createLoginId: () => 'login-fixture',
    })
  })

  it('requires a build or development OAuth client ID', () => {
    expect(resolveGitHubCopilotOAuthClientId({ packaged: true })).toBe('')
    expect(
      resolveGitHubCopilotOAuthClientId({
        packaged: true,
        developmentClientId: 'dev-only',
      })
    ).toBe('')
    expect(
      resolveGitHubCopilotOAuthClientId({
        packaged: true,
        buildClientId: ' build-override ',
        developmentClientId: 'dev-override',
      })
    ).toBe('build-override')
    expect(
      resolveGitHubCopilotOAuthClientId({
        packaged: false,
        developmentClientId: ' dev-override ',
      })
    ).toBe('dev-override')
  })

  afterEach(async () => {
    await manager.dispose()
  })

  it('starts isolated lazy runtimes with explicit tokens and sanitized status', async () => {
    expect(manager.getStatusSnapshot()).toBeNull()
    const first = await manager.getStatus()
    const second = await manager.getStatus()

    expect(client.start).toHaveBeenCalledTimes(1)
    expect(clientOptions).toHaveLength(1)
    expect(clientOptions[0]).toMatchObject({
      connection: {
        kind: 'stdio',
        path: '/fixture/copilot',
        env: { PATH: '/usr/bin:/bin', HOME: '/home/fixture', HTTPS_PROXY: 'https://proxy.example' },
      },
      mode: 'empty',
      baseDirectory: path.join('/tmp/maestrly-user-data', 'github-copilot-subscription'),
      gitHubToken: 'gho_private_token_value',
      useLoggedInUser: false,
      logLevel: 'error',
    })
    expect((clientOptions[0].connection as { env?: Record<string, string> }).env).toEqual({
      PATH: '/usr/bin:/bin',
      HOME: '/home/fixture',
      HTTPS_PROXY: 'https://proxy.example',
    })
    expect(first).toMatchObject({
      state: 'ready',
      available: true,
      connected: true,
      authenticated: true,
      account: { login: 'octocat', host: 'https://github.com', authType: 'token' },
      accountEpoch: 0,
    })
    expect(first.accountFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(first.accountFingerprint).not.toContain('gho_private')
    expect(JSON.stringify(first)).not.toContain('gho_private_token_value')
    expect(second).toBe(first)
  })

  it('allows only explicit operational subprocess environment', () => {
    expect(
      githubCopilotRuntimeEnvironment({
        PATH: '/safe/bin',
        no_proxy: 'localhost',
        SSL_CERT_FILE: '/safe/ca.pem',
        OPENAI_API_KEY: 'private-openai',
        ANTHROPIC_API_KEY: 'private-anthropic',
        COPILOT_SDK_AUTH_TOKEN: 'private-copilot',
      })
    ).toEqual({ PATH: '/safe/bin', no_proxy: 'localhost', SSL_CERT_FILE: '/safe/ca.pem' })
  })

  it('caches official models and returns defensive copies', async () => {
    const first = await manager.listModels()
    ;(first[0] as ModelInfo).name = 'mutated outside'
    const second = await manager.listModels()

    expect(client.listModels).toHaveBeenCalledTimes(1)
    expect(second[0]).toMatchObject({
      id: 'gpt-5.4',
      name: 'GPT-5.4',
      capabilities: { limits: { max_context_window_tokens: 272_000 } },
      supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
    })
  })

  it('creates and resumes empty sessions with explicit allowlists and locked identity', async () => {
    const created = await manager.createSession({
      model: 'gpt-5.4',
      reasoningEffort: 'xhigh',
      availableTools: ['custom:read', 'custom:bash'],
      systemMessage: { mode: 'replace', content: 'Maestrly harness' },
    })
    await manager.resumeSession(created.sessionId, {
      model: 'claude-sonnet-4.6',
      availableTools: ['custom:read'],
      systemMessage: { mode: 'replace', content: 'Maestrly legacy harness' },
    })

    expect(client.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gpt-5.4',
        reasoningEffort: 'xhigh',
        availableTools: ['custom:read', 'custom:bash'],
        systemMessage: { mode: 'replace', content: 'Maestrly harness' },
        clientName: 'maestrly',
        gitHubToken: 'gho_private_token_value',
        enableManagedSettings: true,
        remoteSession: 'off',
      })
    )
    expect(created.disconnect).toHaveBeenCalledTimes(1)
    expect(client.resumeSession).toHaveBeenCalledWith(
      'created-session',
      expect.objectContaining({
        model: 'claude-sonnet-4.6',
        availableTools: ['custom:read'],
        gitHubToken: 'gho_private_token_value',
        enableManagedSettings: true,
        remoteSession: 'off',
      })
    )
  })

  it('disconnects active sessions before official hard deletion', async () => {
    const created = await manager.createSession({ availableTools: [] })
    await manager.deleteSession(created.sessionId)

    expect(created.disconnect).toHaveBeenCalledTimes(1)
    expect(client.deleteSession).toHaveBeenCalledWith('created-session')
  })

  it('clears credentials and ends prior-identity runtimes on logout', async () => {
    const listener = vi.fn()
    manager.onAuthUpdated(listener)
    const before = manager.getAccountIdentity()
    await manager.getStatus()

    await manager.logout()

    expect(tokenStore.token).toBeNull()
    expect(client.stop).toHaveBeenCalledTimes(1)
    expect(manager.getAccountIdentity()).toEqual({ fingerprint: null, epoch: before.epoch + 1 })
    expect(listener).toHaveBeenCalledTimes(1)
    await expect(manager.listModels()).rejects.toBeInstanceOf(GitHubCopilotNotAuthenticatedError)
    await expect(manager.getStatus()).resolves.toMatchObject({ state: 'ready', authenticated: false })
  })

  it('holds runtime leases while clients are active', async () => {
    await manager.getStatus()

    expect(releaseRuntimeLease).not.toHaveBeenCalled()
    await manager.logout()
    expect(releaseRuntimeLease).toHaveBeenCalledTimes(1)
  })

  it('wipes COPILOT_HOME behind a reusable manager barrier', async () => {
    await manager.dispose()
    let removalStarted!: () => void
    const started = new Promise<void>((resolve) => {
      removalStarted = resolve
    })
    let releaseRemoval!: () => void
    const removalGate = new Promise<void>((resolve) => {
      releaseRemoval = resolve
    })
    const removeDirectory = vi.fn(async () => {
      removalStarted()
      await removalGate
    })
    const oauth = {
      startDeviceFlow: vi.fn(async () => ({
        deviceCode: 'private-device-code',
        userCode: 'RELOGIN',
        verificationUri: 'https://github.com/login/device',
        verificationUriComplete: null,
        expiresAt: Date.now() + 60_000,
        intervalSeconds: 5,
      })),
      pollForToken: vi.fn(async () => ({
        accessToken: 'gho_after_wipe',
        tokenType: 'bearer',
        scope: 'read:user',
      })),
    } as unknown as GitHubCopilotOAuthClient
    const clients = [runtimeClient(), runtimeClient()]
    const createClient = vi.fn(() => clients.shift()!)
    manager = new GitHubCopilotSubscriptionManager({
      getOAuthClientId: () => 'maestrly-public-client-id',
      createOAuthClient: () => oauth,
      tokenStore,
      getUserDataPath: () => '/tmp/maestrly-user-data',
      ensureDirectory: vi.fn(async () => {}),
      removeDirectory,
      resolveConnection: () => RuntimeConnection.forStdio({ path: '/fixture/copilot' }),
      createClient,
      createLoginId: () => 'login-after-wipe',
    })
    await manager.getStatus()

    const reset = manager.resetLocalData()
    await started
    const relogin = manager.startLogin()
    await Promise.resolve()
    expect(oauth.startDeviceFlow).not.toHaveBeenCalled()

    releaseRemoval()
    await reset
    expect(tokenStore.token).toBeNull()
    expect(removeDirectory).toHaveBeenCalledWith(path.join('/tmp/maestrly-user-data', 'github-copilot-subscription'))

    const attempt = await relogin
    await expect(manager.waitForLogin(attempt.loginId)).resolves.toMatchObject({ success: true })
    await expect(manager.getStatus()).resolves.toMatchObject({ authenticated: true })
    expect(tokenStore.token).toBe('gho_after_wipe')
    expect(createClient).toHaveBeenCalledTimes(2)
  })

  it('runs Device Flow in the background and publishes only user codes', async () => {
    await manager.logout()
    const oauth = {
      startDeviceFlow: vi.fn(async () => ({
        deviceCode: 'device-private-code',
        userCode: 'ABCD-EFGH',
        verificationUri: 'https://github.com/login/device',
        verificationUriComplete: null,
        expiresAt: Date.now() + 60_000,
        intervalSeconds: 5,
      })),
      pollForToken: vi.fn(async () => ({
        accessToken: 'gho_new_private_token',
        tokenType: 'bearer',
        scope: 'read:user',
      })),
    } as unknown as GitHubCopilotOAuthClient
    manager = new GitHubCopilotSubscriptionManager({
      getOAuthClientId: () => 'maestrly-public-client-id',
      createOAuthClient: () => oauth,
      tokenStore,
      getUserDataPath: () => '/tmp/user-data',
      ensureDirectory: vi.fn(async () => {}),
      resolveConnection: () => RuntimeConnection.forStdio({ path: '/fixture/copilot' }),
      createClient: () => client,
      createLoginId: () => 'login-fixture',
    })

    const attempt = await manager.startLogin()
    expect(attempt).toMatchObject({
      loginId: 'login-fixture',
      userCode: 'ABCD-EFGH',
      verificationUri: 'https://github.com/login/device',
      state: 'pending',
    })
    expect(JSON.stringify(attempt)).not.toContain('device-private-code')
    expect(JSON.stringify(attempt)).not.toContain('gho_')
    await expect(manager.waitForLogin(attempt.loginId)).resolves.toEqual({
      loginId: 'login-fixture',
      success: true,
      error: null,
    })
    expect(tokenStore.token).toBe('gho_new_private_token')
    expect(manager.getLoginStatus(attempt.loginId)?.state).toBe('succeeded')
    expect(manager.getAccountIdentity()).toMatchObject({ epoch: 1 })
  })

  it('discards sessions created during account changes', async () => {
    let resolveCreate!: (value: CopilotSession) => void
    const pendingCreate = new Promise<CopilotSession>((resolve) => {
      resolveCreate = resolve
    })
    client.createSession = vi.fn(() => pendingCreate)
    const create = manager.createSession({ availableTools: [] })
    await vi.waitFor(() => expect(client.createSession).toHaveBeenCalledTimes(1))
    const logout = manager.logout()
    const staleSession = session('stale-session')
    resolveCreate(staleSession)

    await expect(create).rejects.toBeInstanceOf(GitHubCopilotAccountChangedError)
    await logout
    expect(staleSession.disconnect).toHaveBeenCalledTimes(1)
  })

  it('does not publish stale previous-account status after logout', async () => {
    let resolveAuth!: (value: { isAuthenticated: boolean; authType: 'token'; login: string; host: string }) => void
    const pendingAuth = new Promise<{
      isAuthenticated: boolean
      authType: 'token'
      login: string
      host: string
    }>((resolve) => {
      resolveAuth = resolve
    })
    client.getAuthStatus = vi.fn(() => pendingAuth)

    const status = manager.getStatus()
    await vi.waitFor(() => expect(client.getAuthStatus).toHaveBeenCalledTimes(1))
    await manager.logout()
    resolveAuth({
      isAuthenticated: true,
      authType: 'token',
      login: 'stale-user',
      host: 'https://github.com',
    })

    await expect(status).resolves.toMatchObject({
      state: 'ready',
      authenticated: false,
      account: null,
      accountFingerprint: null,
      accountEpoch: 1,
    })
  })

  it('avoids network access when OAuth client IDs are missing', async () => {
    await manager.dispose()
    tokenStore = new MemoryTokenStore(null)
    manager = new GitHubCopilotSubscriptionManager({
      getOAuthClientId: () => '',
      tokenStore,
    })

    await expect(manager.getStatus()).resolves.toMatchObject({
      state: 'ready',
      available: false,
      authenticated: false,
      error: { code: 'configuration_missing' },
    })
    await expect(manager.startLogin()).rejects.toMatchObject({ code: 'configuration_missing' })
  })

  it('redacts runtime error tokens', async () => {
    client.start = vi.fn(async () => {
      throw new Error('Authorization: Bearer gho_should_never_escape')
    })

    const status = await manager.getStatus()

    expect(status).toMatchObject({ state: 'error', authenticated: false })
    expect(releaseRuntimeLease).toHaveBeenCalledTimes(1)
    expect(status.error?.message).toContain('[REDACTED]')
    expect(JSON.stringify(status)).not.toContain('gho_should_never_escape')
  })
})
