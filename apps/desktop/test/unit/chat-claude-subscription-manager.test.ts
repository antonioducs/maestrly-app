import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ClaudeSubscriptionManager,
  isCompatibleClaudeCodeVersion,
  parseClaudeAuthStatus,
  type ClaudeSubscriptionManagerDependencies,
} from '../../src/main/chat/claude-agent-sdk/manager'
import { claudeSubscriptionRuntimeEnvironment } from '../../src/main/chat/claude-agent-sdk/runtime-env'

vi.mock('../../src/main/chat/model-meta', () => ({
  listCatalogProviderModelIds: vi.fn(async () => []),
}))
vi.mock('../../src/main/store', () => ({
  getAppSetting: vi.fn(() => null),
  setAppSetting: vi.fn(),
}))
import { listCatalogProviderModelIds } from '../../src/main/chat/model-meta'
import { resetClaudeRemoteCatalogForTests } from '../../src/main/chat/claude-agent-sdk/model-catalog'

const bundledIds = ['claude-fable-5', 'claude-haiku-4-5-20251001', 'claude-opus-4-6', 'claude-sonnet-4-6']
beforeEach(() => {
  resetClaudeRemoteCatalogForTests()
  vi.mocked(listCatalogProviderModelIds).mockReset().mockResolvedValue([])
})

function fixture(overrides: Partial<ClaudeSubscriptionManagerDependencies> = {}) {
  const files = new Map<string, string>([
    [
      path.join('/home/test', '.claude', '.claude.json'),
      JSON.stringify({
        userID: 'keychain-selector-only',
        oauthAccount: { accessToken: 'must-not-copy' },
        apiKey: 'must-not-copy',
        theme: 'dark',
      }),
    ],
  ])
  const processCalls: string[][] = []
  let authenticated = true
  const dependencies: ClaudeSubscriptionManagerDependencies = {
    getUserDataPath: () => '/tmp/maestrly',
    getHomeDirectory: () => '/home/test',
    getProcessEnvironment: () => ({
      PATH: '/safe/bin',
      HOME: '/home/test',
      HTTPS_PROXY: 'https://proxy.example',
      SSL_CERT_FILE: '/safe/ca.pem',
      ANTHROPIC_API_KEY: 'must-not-reach-claude',
      ANTHROPIC_BASE_URL: 'https://billing.example',
      CLAUDE_CODE_OAUTH_TOKEN: 'must-not-reach-claude',
      AWS_SECRET_ACCESS_KEY: 'must-not-reach-claude',
    }),
    resolveExecutable: () => '/safe/bin/claude',
    ensureDirectory: vi.fn(async () => {}),
    removeDirectory: vi.fn(async (directory) => {
      for (const file of [...files.keys()]) {
        if (file === directory || file.startsWith(`${directory}${path.sep}`)) files.delete(file)
      }
    }),
    readTextFile: vi.fn(async (file) => {
      const value = files.get(file)
      if (value === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      return value
    }),
    writePrivateFile: vi.fn(async (file, contents) => {
      if (files.has(file)) throw Object.assign(new Error('exists'), { code: 'EEXIST' })
      files.set(file, contents)
    }),
    runProcess: vi.fn(async (_executable, args, options) => {
      processCalls.push(args)
      expect(options.env).not.toHaveProperty('ANTHROPIC_API_KEY')
      expect(options.env).not.toHaveProperty('ANTHROPIC_BASE_URL')
      expect(options.env).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN')
      if (args[0] === '--version') return { exitCode: 0, stdout: '2.1.263 (Claude Code)', stderr: '' }
      if (args.join(' ') === 'auth status --json') {
        return {
          exitCode: 0,
          stdout: authenticated
            ? JSON.stringify({
                loggedIn: true,
                email: 'dev@example.com',
                orgId: 'org-1',
                orgName: 'Engineering',
                subscriptionType: 'max',
                authMethod: 'claude.ai',
                apiProvider: 'firstParty',
              })
            : JSON.stringify({ loggedIn: false }),
          stderr: '',
        }
      }
      if (args.join(' ') === 'auth login --claudeai') {
        authenticated = true
        return { exitCode: 0, stdout: '', stderr: '' }
      }
      throw new Error(`Unexpected subprocess: ${args.join(' ')}`)
    }),
    queryFactory: vi.fn(() => {
      throw new Error('query not expected')
    }),
    deleteSession: vi.fn(async () => {}),
    ...overrides,
  }
  return {
    manager: new ClaudeSubscriptionManager(dependencies),
    dependencies,
    files,
    processCalls,
    setAuthenticated(value: boolean) {
      authenticated = value
    },
  }
}

describe('Claude subscription manager', () => {
  it('allows only operational environment and pins the isolated runtime flags', () => {
    expect(
      claudeSubscriptionRuntimeEnvironment('/private/claude-profile', {
        PATH: '/safe/bin',
        HOME: '/home/test',
        HTTPS_PROXY: 'https://proxy.example',
        NODE_EXTRA_CA_CERTS: '/safe/ca.pem',
        ANTHROPIC_API_KEY: 'private-api-key',
        ANTHROPIC_BASE_URL: 'https://billing.example',
        CLAUDE_CODE_OAUTH_TOKEN: 'private-oauth',
        AWS_ACCESS_KEY_ID: 'private-aws',
      })
    ).toEqual({
      PATH: '/safe/bin',
      HOME: '/home/test',
      HTTPS_PROXY: 'https://proxy.example',
      NODE_EXTRA_CA_CERTS: '/safe/ca.pem',
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
      ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
      DISABLE_AUTOUPDATER: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: 'false',
      CLAUDE_AGENT_SDK_CLIENT_APP: 'maestrly/0.0.1',
      CLAUDE_CONFIG_DIR: '/private/claude-profile',
    })
  })

  it('copies only the non-secret Keychain selector and normalizes account identity', async () => {
    const { manager, files } = fixture()

    const status = await manager.status({ refresh: true })

    const isolated = files.get(path.join('/tmp/maestrly', 'claude-agent-sdk', '.claude.json')) ?? ''
    expect(JSON.parse(isolated)).toEqual({ userID: 'keychain-selector-only' })
    expect(isolated).not.toContain('must-not-copy')
    expect(status).toMatchObject({
      state: 'ready',
      available: true,
      authenticated: true,
      account: {
        email: 'dev@example.com',
        organizationId: 'org-1',
        organizationName: 'Engineering',
        subscriptionType: 'max',
      },
      accountEpoch: 1,
      cliVersion: '2.1.263',
      sdkVersion: '0.3.263',
    })
    expect(status.accountFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(JSON.stringify(status)).not.toContain('keychain-selector-only')
  })

  it('logs out locally without invoking the shared Claude CLI logout', async () => {
    const { manager, processCalls, files, setAuthenticated } = fixture()
    await manager.status({ refresh: true })
    setAuthenticated(false)

    const result = await manager.logout()

    expect(result.ok).toBe(true)
    expect(result.status.authenticated).toBe(false)
    expect(processCalls).not.toContainEqual(['auth', 'logout'])
    expect(files.has(path.join('/tmp/maestrly', 'claude-agent-sdk', '.maestrly-signed-out'))).toBe(true)
    expect(files.has(path.join('/tmp/maestrly', 'claude-agent-sdk', '.claude.json'))).toBe(false)
  })

  it('rejects incompatible CLI releases and parses signed-out status', async () => {
    expect(isCompatibleClaudeCodeVersion('2.1.258')).toBe(false)
    expect(isCompatibleClaudeCodeVersion('2.1.263')).toBe(true)
    expect(isCompatibleClaudeCodeVersion('2.2.0')).toBe(true)
    expect(isCompatibleClaudeCodeVersion('2.1.257')).toBe(false)
    expect(isCompatibleClaudeCodeVersion('3.0.0')).toBe(false)
    expect(parseClaudeAuthStatus('{"loggedIn":false}')).toEqual({
      authenticated: false,
      account: null,
    })

    const { manager } = fixture({
      runProcess: vi.fn(async (_executable, args) =>
        args[0] === '--version'
          ? { exitCode: 0, stdout: '2.1.100', stderr: '' }
          : { exitCode: 0, stdout: '{"loggedIn":true}', stderr: '' }
      ),
    })
    await expect(manager.status({ refresh: true })).resolves.toMatchObject({
      state: 'unavailable',
      authenticated: false,
      cliVersion: '2.1.100',
      error: expect.stringContaining('2.1.263'),
    })
  })

  it('fails closed for API/cloud backends and runtime API-key sources', () => {
    expect(() =>
      parseClaudeAuthStatus(
        JSON.stringify({
          loggedIn: true,
          email: 'dev@example.com',
          subscriptionType: 'api',
          authMethod: 'api_key',
          apiProvider: 'firstParty',
        })
      )
    ).toThrow('not a verifiable Claude.ai subscription')
    expect(() =>
      parseClaudeAuthStatus(
        JSON.stringify({
          loggedIn: true,
          orgId: 'cloud-org',
          subscriptionType: 'enterprise',
          authMethod: 'external',
          apiProvider: 'bedrock',
        })
      )
    ).toThrow('not a verifiable Claude.ai subscription')

    const { manager } = fixture()
    expect(() =>
      manager.assertSubscriptionRuntimeAccount({
        apiProvider: 'firstParty',
        apiKeySource: 'ANTHROPIC_API_KEY',
      })
    ).toThrow('non-subscription backend')
    expect(() => manager.assertSubscriptionRuntimeAccount({ apiProvider: 'gateway' })).toThrow(
      'non-subscription backend'
    )
  })

  it('proves the initialized runtime account matches the admitted subscription identity', async () => {
    const { manager } = fixture()
    const status = await manager.status({ refresh: true })
    const identity = {
      fingerprint: status.accountFingerprint,
      epoch: status.accountEpoch,
    }

    expect(() =>
      manager.assertSubscriptionRuntimeAccount(
        {
          apiProvider: 'firstParty',
          email: 'dev@example.com',
          organization: 'org-1',
          subscriptionType: 'Claude Max',
        },
        identity
      )
    ).not.toThrow()
    expect(() =>
      manager.assertSubscriptionRuntimeAccount(
        {
          apiProvider: 'firstParty',
          email: 'other@example.com',
          organization: 'org-1',
          subscriptionType: 'Claude Max',
        },
        identity
      )
    ).toThrow('does not match')
    expect(() =>
      manager.assertSubscriptionRuntimeAccount(
        {
          apiProvider: 'firstParty',
          email: 'dev@example.com',
          organization: 'org-1',
          subscriptionType: 'Claude Pro',
        },
        identity
      )
    ).toThrow('does not match')
  })

  it('invalidates the previous identity when a refresh can no longer prove subscription auth', async () => {
    const { manager, dependencies } = fixture()
    const ready = await manager.status({ refresh: true })
    const admitted = {
      fingerprint: ready.accountFingerprint,
      epoch: ready.accountEpoch,
    }
    vi.mocked(dependencies.runProcess).mockImplementation(async (_executable, args) =>
      args[0] === '--version'
        ? { exitCode: 0, stdout: '2.1.263 (Claude Code)', stderr: '' }
        : {
            exitCode: 0,
            stdout: JSON.stringify({
              loggedIn: true,
              orgId: 'cloud-org',
              subscriptionType: 'enterprise',
              authMethod: 'external',
              apiProvider: 'bedrock',
            }),
            stderr: '',
          }
    )

    const invalid = await manager.status({ refresh: true })

    expect(invalid).toMatchObject({
      state: 'error',
      authenticated: false,
      accountFingerprint: null,
      accountEpoch: ready.accountEpoch + 1,
    })
    expect(() => manager.assertAccountIdentity(admitted)).toThrow('account changed')
  })

  it('cancels a queued login before it can remove the isolated profile or start auth login', async () => {
    let releaseVersion!: () => void
    let versionStarted!: () => void
    const versionGate = new Promise<void>((resolve) => {
      releaseVersion = resolve
    })
    const started = new Promise<void>((resolve) => {
      versionStarted = resolve
    })
    const { manager, dependencies, processCalls } = fixture()
    let firstVersion = true
    vi.mocked(dependencies.runProcess).mockImplementation(async (_executable, args) => {
      processCalls.push(args)
      if (args[0] === '--version') {
        if (firstVersion) {
          firstVersion = false
          versionStarted()
          await versionGate
        }
        return { exitCode: 0, stdout: '2.1.263 (Claude Code)', stderr: '' }
      }
      if (args.join(' ') === 'auth status --json') {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            loggedIn: true,
            email: 'dev@example.com',
            subscriptionType: 'max',
            authMethod: 'claude.ai',
            apiProvider: 'firstParty',
          }),
          stderr: '',
        }
      }
      if (args.join(' ') === 'auth login --claudeai') {
        return { exitCode: 0, stdout: '', stderr: '' }
      }
      throw new Error(`Unexpected subprocess: ${args.join(' ')}`)
    })

    const statusPending = manager.status({ refresh: true })
    await started
    const loginPending = manager.login()
    expect(() =>
      manager.createQuery({
        prompt: '',
      })
    ).toThrow('authentication is changing')
    manager.cancelLogin()
    releaseVersion()
    await statusPending
    const result = await loginPending

    expect(result).toMatchObject({ ok: false, error: 'Claude login was cancelled.' })
    expect(processCalls).not.toContainEqual(['auth', 'login', '--claudeai'])
  })

  it('deletes sessions with an explicit isolated environment without mutating process.env', async () => {
    const ambient = process.env.CLAUDE_CONFIG_DIR
    const deleteSession = vi.fn(async (_sessionId, options) => {
      expect(process.env.CLAUDE_CONFIG_DIR).toBe(ambient)
      expect(options).toMatchObject({
        dir: '/repo',
        configDirectory: path.join('/tmp/maestrly', 'claude-agent-sdk'),
        environment: {
          CLAUDE_CONFIG_DIR: path.join('/tmp/maestrly', 'claude-agent-sdk'),
        },
      })
    })
    const { manager } = fixture({ deleteSession })

    await manager.deleteManagedSession('session-1', '/repo')

    expect(deleteSession).toHaveBeenCalledOnce()
    expect(process.env.CLAUDE_CONFIG_DIR).toBe(ambient)
  })

  it('wipes into an explicit signed-out profile so status cannot bootstrap Keychain again', async () => {
    const { manager, files } = fixture()
    await manager.status({ refresh: true })

    await manager.wipe()

    expect(files.has(path.join('/tmp/maestrly', 'claude-agent-sdk', '.maestrly-signed-out'))).toBe(true)
    expect(files.has(path.join('/tmp/maestrly', 'claude-agent-sdk', '.claude.json'))).toBe(false)
  })
  it('unions SDK seeds with public discovery while preserving account-aware rows on collisions', async () => {
    vi.mocked(listCatalogProviderModelIds).mockResolvedValue(['claude-opus-4-8', 'claude-sonnet-4-8'])
    const accountModel = {
      value: 'claude-opus-4-8',
      displayName: 'Account-specific Opus',
      supportsEffort: true,
      supportedEffortLevels: ['low', 'high'],
    }
    // Measured against the live runtime: the harness answers with its default list plus the session's own
    // model. A single seedless probe therefore hides Fable and the non-1M Opus entirely.
    const BASE = [
      { value: 'default', displayName: 'Default (recommended)' },
      { value: 'opus[1m]', displayName: 'Opus (1M context)' },
      { value: 'sonnet', displayName: 'Sonnet' },
      { value: 'haiku', displayName: 'Haiku' },
      accountModel,
    ]
    const seeds: (string | undefined)[] = []
    let activeProbes = 0
    let maxActiveProbes = 0
    const queryFactory = vi.fn((params: { options?: { model?: string } }) => {
      const seed = params.options?.model
      seeds.push(seed)
      activeProbes += 1
      maxActiveProbes = Math.max(maxActiveProbes, activeProbes)
      return {
        initializationResult: async () => ({
          account: {
            apiProvider: 'firstParty',
            email: 'dev@example.com',
            organization: 'org-1',
            subscriptionType: 'max',
          },
        }),
        supportedModels: async () => (seed ? [...BASE, { value: seed, displayName: seed }] : [...BASE]),
        close: vi.fn(() => {
          activeProbes -= 1
        }),
      }
    })
    const { manager } = fixture({ queryFactory: queryFactory as never })

    const [models, concurrentModels] = await Promise.all([manager.listModels(), manager.listModels()])

    expect(seeds).toEqual([undefined, 'fable', 'opus'])
    expect(maxActiveProbes).toBe(1)
    expect(models.map((model) => model.value)).toEqual([
      'default',
      'opus[1m]',
      'sonnet',
      'haiku',
      'claude-opus-4-8',
      'fable',
      'opus',
      'claude-sonnet-4-8',
    ])
    expect(models.find((model) => model.value === 'claude-opus-4-8')).toEqual(accountModel)
    expect(models.filter((model) => model.value === 'claude-opus-4-8')).toHaveLength(1)
    expect(models.find((model) => model.value === 'claude-sonnet-4-8')).toMatchObject({
      resolvedModel: 'claude-sonnet-4-8',
      displayName: 'Sonnet 4 8',
    })
    expect(concurrentModels).toEqual(models)
    // Second call is served from cache: three subprocesses per model list would be paid on every render.
    await manager.listModels()
    expect(queryFactory).toHaveBeenCalledTimes(3)

    // A status refresh validates auth, but does not throw away the capability catalog.
    await manager.status({ refresh: true })
    await manager.listModels()
    expect(queryFactory).toHaveBeenCalledTimes(3)

    // Forced refresh bypasses completed caches and reruns three probes without identity changes.
    await manager.listModels(undefined, true)
    expect(queryFactory).toHaveBeenCalledTimes(6)
  })

  it('reads official usage with cache and single-flight, then invalidates it on identity teardown', async () => {
    const response = {
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 34, resets_at: '2026-08-29T18:00:00Z' },
        seven_day: { utilization: 12, resets_at: '2026-09-03T08:00:00Z' },
      },
    }
    const usage = vi.fn(async () => response)
    const close = vi.fn()
    const promptStates: Array<{ completed: boolean; done: Promise<void> }> = []
    const queryFactory = vi.fn(
      (params: { prompt: AsyncIterable<unknown>; options?: { env?: Record<string, string> } }) => {
        expect(params.options?.env).not.toHaveProperty('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC')
        const state = { completed: false, done: Promise.resolve() }
        state.done = (async () => {
          for await (const _message of params.prompt) {
            // The control probe intentionally yields no model messages.
          }
          state.completed = true
        })()
        promptStates.push(state)
        return {
          initializationResult: async () => ({
            account: {
              apiProvider: 'firstParty',
              email: 'dev@example.com',
              organization: 'org-1',
              subscriptionType: 'max',
            },
          }),
          usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => {
            expect(state.completed).toBe(false)
            return usage()
          },
          close,
        }
      }
    )
    const { manager, setAuthenticated } = fixture({ queryFactory: queryFactory as never })

    const [first, concurrent] = await Promise.all([manager.getUsage(), manager.getUsage()])

    expect(first).toBe(response)
    expect(concurrent).toBe(response)
    expect(manager.getUsageSnapshot()).toBe(response)
    expect(queryFactory).toHaveBeenCalledOnce()
    expect(usage).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
    await Promise.all(promptStates.map((state) => state.done))
    expect(promptStates.every((state) => state.completed)).toBe(true)

    await manager.getUsage()
    expect(queryFactory).toHaveBeenCalledOnce()

    await manager.getUsage(true)
    expect(queryFactory).toHaveBeenCalledTimes(2)
    expect(usage).toHaveBeenCalledTimes(2)
    expect(close).toHaveBeenCalledTimes(2)
    await Promise.all(promptStates.map((state) => state.done))
    expect(promptStates.every((state) => state.completed)).toBe(true)

    setAuthenticated(false)
    await manager.logout()
    expect(manager.getUsageSnapshot()).toBeNull()
  })

  it('closes a failed usage probe and rejects a runtime account that does not match the admitted identity', async () => {
    const close = vi.fn()
    const usage = vi.fn(async () => ({ rate_limits_available: true, rate_limits: {} }))
    const queryFactory = vi.fn(() => ({
      initializationResult: async () => ({
        account: {
          apiProvider: 'firstParty',
          email: 'other@example.com',
          organization: 'org-1',
          subscriptionType: 'max',
        },
      }),
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: usage,
      close,
    }))
    const { manager } = fixture({ queryFactory: queryFactory as never })

    await expect(manager.getUsage()).rejects.toThrow('does not match')
    expect(usage).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledOnce()
    expect(manager.getUsageSnapshot()).toBeNull()
  })

  it('keeps listing models when a seed the account cannot reach fails', async () => {
    const queryFactory = vi.fn((params: { options?: { model?: string } }) => ({
      initializationResult: async () => {
        if (params.options?.model === 'fable') throw new Error('model not available for this account')
        return {
          account: {
            apiProvider: 'firstParty',
            email: 'dev@example.com',
            organization: 'org-1',
            subscriptionType: 'max',
          },
        }
      },
      supportedModels: async () => [{ value: params.options?.model ?? 'default', displayName: 'x' }],
      close: vi.fn(),
    }))
    const { manager } = fixture({ queryFactory: queryFactory as never })

    const models = await manager.listModels()

    // One unreachable seed costs that entry, not the whole selector.
    expect(models.map((model) => model.value)).toEqual(['default', 'opus', ...bundledIds])
  })

  it('retains bundled model discovery when every SDK probe fails', async () => {
    const queryFactory = vi.fn(() => ({
      initializationResult: async () => {
        throw new Error('claude runtime unavailable')
      },
      supportedModels: async () => [],
      close: vi.fn(),
    }))
    const { manager } = fixture({ queryFactory: queryFactory as never })

    expect((await manager.listModels()).map((model) => model.value)).toEqual(bundledIds)
    expect(queryFactory).toHaveBeenCalledTimes(3)
  })

  it('latches terminal OAuth failure until a successful explicit login', async () => {
    const { manager, dependencies } = fixture()
    const listener = vi.fn()
    manager.onAuthenticationRequired(listener)
    const ready = await manager.status({ refresh: true })
    expect(ready.authenticated).toBe(true)

    expect(manager.requireAuthentication(new Error('OAuth token expired. Please authenticate again.'))).toBe(true)
    expect(listener).toHaveBeenCalledOnce()
    expect(manager.getStatusSnapshot()).toMatchObject({
      state: 'error',
      authenticated: false,
      accountFingerprint: null,
      accountEpoch: ready.accountEpoch + 1,
    })

    const authCallsBeforeRefresh = vi
      .mocked(dependencies.runProcess)
      .mock.calls.filter(([, args]) => args.join(' ') === 'auth status --json').length
    await expect(manager.status({ refresh: true })).resolves.toMatchObject({
      state: 'error',
      authenticated: false,
      accountFingerprint: null,
    })
    const authCallsAfterRefresh = vi
      .mocked(dependencies.runProcess)
      .mock.calls.filter(([, args]) => args.join(' ') === 'auth status --json').length
    expect(authCallsAfterRefresh).toBe(authCallsBeforeRefresh)
    expect(() => manager.createQuery({ prompt: '' })).toThrow('Sign in again')

    await expect(manager.login()).resolves.toMatchObject({
      ok: true,
      status: { state: 'ready', authenticated: true },
    })
    await expect(manager.status({ refresh: true })).resolves.toMatchObject({
      state: 'ready',
      authenticated: true,
    })
  })
})
