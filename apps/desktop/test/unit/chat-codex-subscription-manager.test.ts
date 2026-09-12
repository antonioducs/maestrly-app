import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setImmediate as waitImmediate } from 'node:timers/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CodexAppServerClient,
  CodexAppServerProcessError,
  CodexAppServerRpcError,
  CodexRuntimeNotFoundError,
  CodexSubscriptionManager,
  type CodexAppServerConnectOptions,
  type CodexNotification,
  type CodexRuntimeResolution,
} from '../../src/main/chat/codex-subscription'

const fixtureSource = String.raw`
import readline from 'node:readline'

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
let initialized = false
let accountReadCount = 0
let rateLimitsReadCount = 0
let loggedIn = true
let modelRound = 0
const deletedThreadIds = []

const send = (message) => process.stdout.write(JSON.stringify(message) + '\n')
const success = (id, result) => send({ id, result })

lines.on('line', (line) => {
  const message = JSON.parse(line)
  if (message.method === 'initialize') {
    success(message.id, {
      userAgent: 'codex-manager-fixture/1.0',
      codexHome: process.env.CODEX_HOME,
      platformFamily: 'unix',
      platformOs: 'linux',
    })
    return
  }
  if (message.method === 'initialized') {
    initialized = true
    return
  }
  if (!initialized) {
    send({ id: message.id, error: { code: -32002, message: 'Not initialized' } })
    return
  }

  switch (message.method) {
    case 'account/read': {
      accountReadCount += 1
      success(message.id, {
        account: loggedIn
          ? {
              type: 'chatgpt',
              email:
                (message.params.refreshToken ? 'refresh-' : 'cached-') + accountReadCount + '@example.com',
              planType: 'pro',
              accessToken: 'fixture-secret-must-not-leak',
            }
          : null,
        requiresOpenaiAuth: true,
        receivedRefreshToken: message.params.refreshToken,
      })
      break
    }
    case 'account/login/start':
      success(message.id, {
        type: 'chatgpt',
        loginId: 'login-' + process.pid,
        authUrl: 'https://chatgpt.com/login?code=oauth-private-value',
      })
      setTimeout(() => {
        loggedIn = true
        send({
          method: 'account/login/completed',
          params: { loginId: 'login-' + process.pid, success: true, error: null },
        })
        send({ method: 'account/updated', params: { authMode: 'chatgpt', planType: 'pro' } })
      }, 15)
      break
    case 'account/logout':
      loggedIn = false
      success(message.id, {})
      send({ method: 'account/updated', params: { authMode: null, planType: null } })
      break
    case 'account/rateLimits/read': {
      rateLimitsReadCount += 1
      success(message.id, {
        rateLimits: {
          primary: {
            usedPercent: 42,
            windowDurationMins: 60,
            resetsAt: 1_700_000_000,
          },
          secondary: {
            usedPercent: 10,
            resetsAt: 1_700_003_600,
          },
          rateLimitReachedType: null,
          readCount: rateLimitsReadCount,
        },
        rateLimitsByLimitId: {
          codex: {
            primary: { usedPercent: 100, resetsAt: 1_700_000_100 },
          },
        },
      })
      break
    }
    case 'test/emitRateLimitsUpdated':
      send({
        method: 'account/rateLimits/updated',
        params: message.params ?? { rateLimits: { primary: { usedPercent: 99 } } },
      })
      success(message.id, {})
      break
    case 'test/emitAccountUpdated':
      send({
        method: 'account/updated',
        params: message.params ?? { authMode: null, planType: null },
      })
      success(message.id, {})
      break
    case 'thread/delete':
      deletedThreadIds.push(message.params.threadId)
      success(message.id, {})
      break
    case 'model/list':
      if (!message.params.cursor) {
        modelRound += 1
        success(message.id, {
          data: [
            {
              id: 'model-priority',
              model: 'model-priority',
              displayName: 'Priority round ' + modelRound,
              description: 'pid=' + process.pid,
              hidden: false,
              supportedReasoningEfforts: [
                { reasoningEffort: 'medium', description: 'Balanced' },
                { reasoningEffort: 'high', description: 'Deep' },
              ],
              defaultReasoningEffort: 'medium',
              inputModalities: ['text', 'image'],
              supportsPersonality: true,
              serviceTiers: [{ id: 'priority', name: 'Fast', description: '1.5x speed' }],
              defaultServiceTier: null,
              additionalSpeedTiers: ['fast'],
              context_window: 272_000,
              max_context_window: 1_000_000,
              effective_context_window_percent: 95,
              supports_experimental_context: true,
              prefer_websockets: true,
              supports_parallel_tool_calls: true,
              tool_mode: 'code_mode_only',
              multi_agent_version: 2,
              use_responses_lite: true,
              supported_verbosity: ['low', 'medium'],
              default_verbosity: 'medium',
              minimum_client_version: '0.153.4',
              isDefault: true,
            },
          ],
          nextCursor: 'page-2',
        })
      } else {
        success(message.id, {
          data: [
            {
              id: 'model-legacy-fast',
              displayName: 'Legacy Fast',
              supportedReasoningEfforts: [],
              defaultReasoningEffort: 'low',
              additionalSpeedTiers: ['fast'],
              serviceTiers: [],
              defaultServiceTier: null,
            },
            {
              id: 'model-standard',
              displayName: 'Standard',
              supportedReasoningEfforts: [],
              defaultReasoningEffort: 'medium',
              inputModalities: ['text'],
              serviceTiers: [],
              defaultServiceTier: null,
            },
          ],
          nextCursor: null,
        })
      }
      break
    case 'test/pid':
      success(message.id, { pid: process.pid })
      break
    case 'test/deletedThreads':
      success(message.id, { threadIds: deletedThreadIds })
      break
    case 'test/crash':
      process.stderr.write('fixture crash')
      setTimeout(() => process.exit(19), 5)
      break
    default:
      send({ id: message.id, error: { code: -32601, message: 'Method not found' } })
  }
})
`

function runtime(executablePath: string, version: string | null = '0.153.4-fixture'): CodexRuntimeResolution {
  const executableName = process.platform === 'win32' ? 'codex.exe' : 'codex'
  return {
    executablePath,
    source: 'path',
    version,
    target: {
      platform: process.platform,
      arch: process.arch,
      targetTriple: 'fixture-target',
      optionalPackage: '@openai/codex-fixture',
      executableName,
    },
  }
}

describe('CodexSubscriptionManager', () => {
  let directory: string
  let fixturePath: string
  let userDataPath: string
  let manager: CodexSubscriptionManager | null
  let connectOptions: CodexAppServerConnectOptions[]
  let connectClient: ReturnType<typeof vi.fn<(options: CodexAppServerConnectOptions) => Promise<CodexAppServerClient>>>

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'maestrly-codex-manager-'))
    fixturePath = path.join(directory, 'fixture.mjs')
    userDataPath = path.join(directory, 'user-data')
    await writeFile(fixturePath, fixtureSource, 'utf8')
    connectOptions = []
    connectClient = vi.fn(async (options: CodexAppServerConnectOptions) => {
      connectOptions.push(options)
      return CodexAppServerClient.connect({ ...options, binaryArgs: [fixturePath] })
    })
    manager = new CodexSubscriptionManager({
      resolveRuntime: () => runtime(process.execPath),
      connectClient,
      getUserDataPath: () => userDataPath,
      getAppVersion: () => '9.8.7-test',
    })
  })

  afterEach(async () => {
    await manager?.dispose()
    manager = null
    await rm(directory, { recursive: true, force: true })
  })

  it('starts a lazy isolated Codex singleton with sanitized cached status', async () => {
    const codexHome = path.join(userDataPath, 'codex-subscription')
    await mkdir(codexHome, { recursive: true })
    await writeFile(path.join(codexHome, 'auth.json'), '{"kept":true}', 'utf8')
    await writeFile(path.join(codexHome, 'config.toml'), '[projects."/tmp/old"]\ntrust_level="trusted"\n', 'utf8')
    await writeFile(
      path.join(codexHome, 'models_cache.json'),
      JSON.stringify({ models: [{ slug: 'gpt-5.6-sol', multi_agent_version: 'v2' }] }),
      'utf8'
    )
    expect(manager!.getStatusSnapshot()).toBeNull()
    expect(connectClient).not.toHaveBeenCalled()

    const [first, concurrent] = await Promise.all([manager!.getStatus(), manager!.getStatus()])
    const second = await manager!.getStatus()

    expect(connectClient).toHaveBeenCalledTimes(1)
    expect(connectOptions[0]).toMatchObject({
      binaryPath: process.execPath,
      binaryArgs: [
        'app-server',
        '--disable',
        'multi_agent',
        '--disable',
        'multi_agent_v2',
        '-c',
        `model_catalog_json=${path.join(codexHome, 'maestrly-model-catalog.json')}`,
      ],
      clientInfo: { name: 'maestrly', title: 'Maestrly', version: '9.8.7-test' },
      capabilities: { experimentalApi: true },
      env: { CODEX_HOME: codexHome },
    })
    expect(connectOptions[0].unsetEnv).toContain('CODEX_SQLITE_HOME')
    expect(connectOptions[0].unsetEnvPrefixes).toEqual(['CODEX_', 'OPENAI_', 'AZURE_OPENAI_'])
    expect(first).toMatchObject({
      state: 'ready',
      available: true,
      connected: true,
      authenticated: true,
      account: { type: 'chatgpt', email: 'cached-1@example.com', planType: 'pro' },
      runtime: { source: 'path', platform: process.platform, arch: process.arch },
    })
    expect(concurrent).toBe(first)
    expect(second).toBe(first)
    expect(manager!.getStatusSnapshot()).toBe(first)
    expect(JSON.stringify(first)).not.toContain('fixture-secret-must-not-leak')
    expect(JSON.stringify(first)).not.toContain('accessToken')

    const refreshed = await manager!.getStatus(true)
    expect(refreshed.account).toMatchObject({ email: 'refresh-2@example.com' })
    expect(await manager!.getClient()).toBe(await manager!.getClient())
    const homeStat = await stat(path.join(userDataPath, 'codex-subscription'))
    expect(homeStat.isDirectory()).toBe(true)
    await expect(stat(path.join(codexHome, 'auth.json'))).resolves.toBeDefined()
    await expect(stat(path.join(codexHome, 'config.toml'))).rejects.toMatchObject({ code: 'ENOENT' })
    if (process.platform !== 'win32') expect(homeStat.mode & 0o777).toBe(0o700)
  })

  it('repeats invalidated account reads', async () => {
    let notify!: (notification: CodexNotification) => void
    let resolveStaleRead!: (value: {
      account: { type: 'chatgpt'; email: string; planType: string }
      requiresOpenaiAuth: boolean
    }) => void
    const staleRead = new Promise<{
      account: { type: 'chatgpt'; email: string; planType: string }
      requiresOpenaiAuth: boolean
    }>((resolve) => {
      resolveStaleRead = resolve
    })
    const readAccount = vi
      .fn()
      .mockImplementationOnce(() => staleRead)
      .mockResolvedValueOnce({ account: null, requiresOpenaiAuth: true })
    const fakeClient = {
      state: 'ready',
      failure: null,
      readAccount,
      onNotification: vi.fn((listener: (notification: CodexNotification) => void) => {
        notify = listener
        return () => {}
      }),
      waitForExit: vi.fn(() => new Promise<never>(() => {})),
      close: vi.fn(async () => {}),
    }
    manager = new CodexSubscriptionManager({
      resolveRuntime: () => runtime(process.execPath),
      connectClient: async () => fakeClient as unknown as CodexAppServerClient,
      getUserDataPath: () => userDataPath,
      getAppVersion: () => '9.8.7-test',
    })

    const pendingStatus = manager.getStatus()
    await vi.waitFor(() => expect(readAccount).toHaveBeenCalledTimes(1))
    notify({ method: 'account/updated', params: { authMode: null, planType: null } })
    resolveStaleRead({
      account: { type: 'chatgpt', email: 'stale@example.com', planType: 'pro' },
      requiresOpenaiAuth: true,
    })

    const status = await pendingStatus
    expect(readAccount).toHaveBeenCalledTimes(2)
    expect(status).toMatchObject({ authenticated: false, account: null })
    expect(manager.getStatusSnapshot()).toBe(status)
  })

  it('supports ChatGPT login polling and logout', async () => {
    const accountUpdated = vi.fn()
    const unsubscribe = manager!.onAccountUpdated(accountUpdated)
    const started = await manager!.startLogin()

    expect(started).toMatchObject({
      authUrl: 'https://chatgpt.com/login?code=oauth-private-value',
      state: 'pending',
    })
    expect(manager!.getLoginStatus(started.loginId)?.loginId).toBe(started.loginId)

    await expect(manager!.waitForLogin(started.loginId, { timeoutMs: 2_000 })).resolves.toEqual({
      loginId: started.loginId,
      success: true,
      error: null,
    })
    expect(manager!.getLoginStatus(started.loginId)?.state).toBe('succeeded')
    await vi.waitFor(() => expect(accountUpdated).toHaveBeenCalledTimes(1))

    await manager!.logout()
    await vi.waitFor(() => expect(accountUpdated).toHaveBeenCalledTimes(2))
    unsubscribe()
    expect(manager!.getLoginStatus(started.loginId)).toBeNull()
    await expect(manager!.getStatus(true)).resolves.toMatchObject({ authenticated: false, account: null })
  })

  it('resets local homes while allowing future login', async () => {
    const client = await manager!.getClient()
    const home = path.join(userDataPath, 'codex-subscription')
    await writeFile(path.join(home, 'auth-fixture.json'), 'secret', 'utf8')

    await manager!.resetLocalData()

    expect(client.state).toBe('closed')
    await expect(stat(home)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(manager!.getStatusSnapshot()).toBeNull()

    await expect(manager!.getStatus()).resolves.toMatchObject({ authenticated: true })
    expect(connectClient).toHaveBeenCalledTimes(2)
    expect((await stat(home)).isDirectory()).toBe(true)
  })

  it('blocks status and client access until reset removal finishes', async () => {
    let markRemovalStarted!: () => void
    const removalStarted = new Promise<void>((resolve) => {
      markRemovalStarted = resolve
    })
    let releaseRemoval!: () => void
    const removalGate = new Promise<void>((resolve) => {
      releaseRemoval = resolve
    })
    const removeDirectory = vi.fn(async (target: string) => {
      markRemovalStarted()
      await removalGate
      await rm(target, { recursive: true, force: true })
    })
    manager = new CodexSubscriptionManager({
      resolveRuntime: () => runtime(process.execPath),
      connectClient,
      getUserDataPath: () => userDataPath,
      getAppVersion: () => '9.8.7-test',
      removeDirectory,
    })

    await expect(manager.getStatus()).resolves.toMatchObject({ state: 'ready', authenticated: true })
    const oldClient = await manager.getClient()
    const reset = manager.resetLocalData()
    let statusSettled = false
    let clientSettled = false
    const waitingStatus = manager.getStatus().then((status) => {
      statusSettled = true
      return status
    })
    const waitingClient = manager.getClient().then((client) => {
      clientSettled = true
      return client
    })
    await removalStarted
    await waitImmediate()

    expect(oldClient.state).toBe('closed')
    expect(statusSettled).toBe(false)
    expect(clientSettled).toBe(false)
    expect(connectClient).toHaveBeenCalledTimes(1)

    releaseRemoval()
    await reset
    const [status, newClient] = await Promise.all([waitingStatus, waitingClient])

    expect(removeDirectory).toHaveBeenCalledWith(path.join(userDataPath, 'codex-subscription'))
    expect(status).toMatchObject({ state: 'ready', connected: true, authenticated: true })
    expect(newClient).not.toBe(oldClient)
    expect(newClient.state).toBe('ready')
    expect(connectClient).toHaveBeenCalledTimes(2)
    await expect(manager.getClient()).resolves.toBe(newClient)
  })

  it('normalizes thread IDs before official deletion RPC', async () => {
    await manager!.deleteThread('  thread-to-delete  ')

    await expect(manager!.request('test/deletedThreads')).resolves.toEqual({
      threadIds: ['thread-to-delete'],
    })
    await expect(manager!.deleteThread('   ')).rejects.toThrow('Codex thread id is required')
  })

  it('does not treat API keys or other auth modes as ChatGPT subscriptions', async () => {
    const fakeClient = {
      state: 'ready',
      failure: null,
      readAccount: vi.fn(async () => ({
        account: { type: 'apiKey' as const },
        requiresOpenaiAuth: true,
      })),
      onNotification: vi.fn(() => () => {}),
      waitForExit: vi.fn(() => new Promise<never>(() => {})),
      close: vi.fn(async () => {}),
    }
    manager = new CodexSubscriptionManager({
      resolveRuntime: () => runtime(process.execPath),
      connectClient: async () => fakeClient as unknown as CodexAppServerClient,
      getUserDataPath: () => userDataPath,
      getAppVersion: () => '9.8.7-test',
    })

    await expect(manager.getStatus()).resolves.toMatchObject({
      state: 'ready',
      connected: true,
      authenticated: false,
      account: { type: 'apiKey' },
    })
  })

  it('accepts runtime model limits independently of disk caches', async () => {
    const [model] = await manager!.listModels()

    expect(model).toMatchObject({
      id: 'model-priority',
      nominalContextWindow: 272_000,
      maxContextWindow: 1_000_000,
      effectiveContextWindowPercent: 95,
      contextWindow: 258_400,
      supportsExperimentalContext: true,
      preferWebsockets: true,
      supportsParallelToolCalls: true,
      toolMode: 'code_mode_only',
      multiAgentVersion: 2,
      useResponsesLite: true,
      supportedVerbosity: ['low', 'medium'],
      defaultVerbosity: 'medium',
      minimumClientVersion: '0.153.4',
    })
  })

  it('paginates and caches normalized models with supported Fast tiers', async () => {
    const codexHome = path.join(userDataPath, 'codex-subscription')
    await mkdir(codexHome, { recursive: true })
    await writeFile(
      path.join(codexHome, 'models_cache.json'),
      JSON.stringify({
        models: [
          {
            slug: 'model-priority',
            context_window: 320_000,
            max_context_window: 1_100_000,
            effective_context_window_percent: 80,
          },
        ],
      }),
      'utf8'
    )
    const first = await manager!.listModels()
    const cached = await manager!.listModels()

    expect(first).toHaveLength(3)
    expect(cached).toBe(first)
    expect(first[0]).toMatchObject({
      id: 'model-priority',
      model: 'model-priority',
      displayName: 'Priority round 1',
      defaultReasoningEffort: 'medium',
      inputModalities: ['text', 'image'],
      serviceTiers: [{ id: 'priority', name: 'Fast', description: '1.5x speed' }],
      nominalContextWindow: 320_000,
      maxContextWindow: 1_100_000,
      effectiveContextWindowPercent: 80,
      contextWindow: 256_000,
      isDefault: true,
    })
    expect(first[0].supportedReasoningEfforts).toEqual([
      { reasoningEffort: 'medium', description: 'Balanced' },
      { reasoningEffort: 'high', description: 'Deep' },
    ])
    expect(first[1].inputModalities).toEqual(['text', 'image'])
    await expect(manager!.preferredServiceTier('model-priority')).resolves.toBe('priority')
    await expect(manager!.preferredServiceTier('model-legacy-fast')).resolves.toBe('fast')
    await expect(manager!.preferredServiceTier('model-standard')).resolves.toBeNull()
    await expect(manager!.preferredServiceTier('missing')).resolves.toBeNull()

    manager!.observeModelContextWindow('model-priority', 250_000)
    expect((await manager!.listModels())[0].contextWindow).toBe(250_000)
    expect(manager!.getObservedModelContextWindow('model-priority')).toBe(250_000)
    expect(manager!.getObservedModelContextWindow('model-priority', 320_000)).toBe(250_000)

    // A nominal 1M observation cannot replace active
    // 320k settings or contaminate other requests.
    manager!.observeModelContextWindow('model-priority', 950_000, 1_000_000)
    expect(manager!.getObservedModelContextWindow('model-priority', 1_000_000)).toBe(950_000)
    expect(manager!.getObservedModelContextWindow('model-priority', 320_000)).toBe(250_000)
    expect(manager!.getObservedModelContextWindowObservation('model-priority', 1_000_000)).toEqual({
      contextWindow: 950_000,
      requestedNominal: 1_000_000,
      maxContextWindow: 1_100_000,
      effectiveContextWindowPercent: 80,
    })
    expect((await manager!.listModels())[0].contextWindow).toBe(250_000)

    const forced = await manager!.listModels(true)
    expect(forced).not.toBe(first)
    expect(forced[0].displayName).toBe('Priority round 2')
    expect(forced[0].contextWindow).toBe(250_000)
  })

  it('discards crashed clients and reconnects on next access', async () => {
    const oldClient = await manager!.getClient()
    const oldModels = await manager!.listModels()
    const oldPid = await manager!.request<{ pid: number }>('test/pid')

    const crash = await manager!.request('test/crash').catch((error: unknown) => error)
    expect(crash).toBeInstanceOf(CodexAppServerProcessError)
    await oldClient.waitForExit()
    await waitImmediate()

    const newClient = await manager!.getClient()
    const newPid = await manager!.request<{ pid: number }>('test/pid')
    const newModels = await manager!.listModels()

    expect(newClient).not.toBe(oldClient)
    expect(connectClient).toHaveBeenCalledTimes(2)
    expect(newPid.pid).not.toBe(oldPid.pid)
    expect(newModels).not.toBe(oldModels)
    expect(newModels[0].description).toBe(`pid=${newPid.pid}`)
  })

  it('returns redacted public errors for unavailable runtimes', async () => {
    const missing = new CodexRuntimeNotFoundError(
      'missing sk-secretvalue Bearer private-token https://x.test/?access_token=topsecret',
      runtime(process.execPath).target,
      []
    )
    manager = new CodexSubscriptionManager({
      resolveRuntime: () => {
        throw missing
      },
      connectClient,
      getUserDataPath: () => userDataPath,
      getAppVersion: () => '9.8.7-test',
    })

    const status = await manager.getStatus()

    expect(status).toMatchObject({
      state: 'error',
      available: false,
      connected: false,
      authenticated: false,
      error: { code: 'CODEX_RUNTIME_NOT_FOUND' },
    })
    expect(status.error?.message).toContain('[REDACTED]')
    expect(status.error?.message).not.toMatch(/secretvalue|private-token|topsecret/)
    expect(connectClient).not.toHaveBeenCalled()
  })

  it('disposes local singletons and blocks new clients', async () => {
    const client = await manager!.getClient()

    await manager!.dispose()

    expect(client.state).toBe('closed')
    expect(manager!.getStatusSnapshot()).toMatchObject({ state: 'disposed', connected: false })
    await expect(manager!.getStatus()).resolves.toMatchObject({ state: 'disposed', connected: false })
    await expect(manager!.getClient()).rejects.toMatchObject({ name: 'CodexAppServerClosedError' })
  })

  it('holds runtime leases until app-server closure', async () => {
    const release = vi.fn()
    const acquireRuntimeLease = vi.fn(async (runtimePath: string) => ({
      id: 'codex-runtime' as const,
      path: runtimePath,
      release,
    }))
    manager = new CodexSubscriptionManager({
      resolveRuntime: () => runtime(process.execPath),
      acquireRuntimeLease,
      connectClient,
      getUserDataPath: () => userDataPath,
      getAppVersion: () => '9.8.7-test',
    })

    await manager.getClient()

    expect(acquireRuntimeLease).toHaveBeenCalledWith(process.execPath)
    expect(release).not.toHaveBeenCalled()
    await manager.dispose()
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('releases leases on app-server initialization failure', async () => {
    const release = vi.fn()
    connectClient.mockRejectedValueOnce(new Error('fixture start failed'))
    manager = new CodexSubscriptionManager({
      resolveRuntime: () => runtime(process.execPath),
      acquireRuntimeLease: async (runtimePath) => ({ id: 'codex-runtime', path: runtimePath, release }),
      connectClient,
      getUserDataPath: () => userDataPath,
      getAppVersion: () => '9.8.7-test',
    })

    await expect(manager.getClient()).rejects.toThrow('fixture start failed')
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('fetches missing snapshots before enabling overrides', async () => {
    const codexHome = path.join(userDataPath, 'codex-subscription')
    await mkdir(codexHome, { recursive: true })
    await writeFile(path.join(codexHome, 'auth.json'), '{"authenticated":true}', 'utf8')
    const cachePath = path.join(codexHome, 'models_cache.json')
    connectClient.mockImplementationOnce(async (options: CodexAppServerConnectOptions) => {
      connectOptions.push(options)
      setTimeout(() => {
        void writeFile(
          cachePath,
          JSON.stringify({ models: [{ slug: 'gpt-5.6-sol', multi_agent_version: 'v2' }] }),
          'utf8'
        )
      }, 25)
      return CodexAppServerClient.connect({ ...options, binaryArgs: [fixturePath] })
    })

    await manager!.getStatus()

    expect(connectOptions).toHaveLength(2)
    expect(connectOptions[0].binaryArgs).toEqual([
      'app-server',
      '--disable',
      'multi_agent',
      '--disable',
      'multi_agent_v2',
    ])
    const overridePath = path.join(codexHome, 'maestrly-model-catalog.json')
    expect(connectOptions[1].binaryArgs).toEqual([
      'app-server',
      '--disable',
      'multi_agent',
      '--disable',
      'multi_agent_v2',
      '-c',
      `model_catalog_json=${overridePath}`,
    ])
    const written = JSON.parse(await readFile(overridePath, 'utf8')) as {
      models: Array<{ slug: string; multi_agent_version: unknown }>
    }
    expect(written.models).toEqual([{ slug: 'gpt-5.6-sol', multi_agent_version: null, max_context_window: 1_050_000 }])
  })

  it('refreshes expired snapshots before enabling catalog overrides', async () => {
    const codexHome = path.join(userDataPath, 'codex-subscription')
    await mkdir(codexHome, { recursive: true })
    const cachePath = path.join(codexHome, 'models_cache.json')
    await writeFile(cachePath, JSON.stringify({ models: [{ slug: 'gpt-5.6-sol', multi_agent_version: 'v2' }] }), 'utf8')
    const stats = await stat(cachePath)
    // Expired 25-hour snapshots require refresh without overrides.
    await utimes(cachePath, stats.atime, new Date(stats.mtimeMs - 25 * 60 * 60_000))
    connectClient.mockImplementationOnce(async (options: CodexAppServerConnectOptions) => {
      connectOptions.push(options)
      setTimeout(() => {
        void writeFile(
          cachePath,
          JSON.stringify({
            models: [
              { slug: 'gpt-5.6-sol', multi_agent_version: 'v2' },
              { slug: 'gpt-5.6-terra', multi_agent_version: 'v2' },
            ],
          }),
          'utf8'
        )
      }, 25)
      return CodexAppServerClient.connect({ ...options, binaryArgs: [fixturePath] })
    })

    await manager!.getStatus()

    expect(connectOptions).toHaveLength(2)
    expect(connectOptions[0].binaryArgs).toEqual([
      'app-server',
      '--disable',
      'multi_agent',
      '--disable',
      'multi_agent_v2',
    ])
    expect(connectOptions[1].binaryArgs).toContain('-c')
    expect(connectOptions[1].binaryArgs?.at(-1)).toBe(
      `model_catalog_json=${path.join(codexHome, 'maestrly-model-catalog.json')}`
    )
    const refreshedOverride = JSON.parse(
      await readFile(path.join(codexHome, 'maestrly-model-catalog.json'), 'utf8')
    ) as { models: Array<{ slug: string; multi_agent_version: unknown }> }
    expect(refreshedOverride.models).toEqual([
      { slug: 'gpt-5.6-sol', multi_agent_version: null, max_context_window: 1_050_000 },
      { slug: 'gpt-5.6-terra', multi_agent_version: null, max_context_window: 1_050_000 },
    ])
  })

  it('refreshes snapshots written by older runtime versions', async () => {
    const codexHome = path.join(userDataPath, 'codex-subscription')
    await mkdir(codexHome, { recursive: true })
    const cachePath = path.join(codexHome, 'models_cache.json')
    await writeFile(
      cachePath,
      JSON.stringify({
        client_version: '0.149.1',
        models: [{ slug: 'gpt-5.6-sol', multi_agent_version: 'v2' }],
      }),
      'utf8'
    )
    connectClient.mockImplementationOnce(async (options: CodexAppServerConnectOptions) => {
      connectOptions.push(options)
      setTimeout(() => {
        void writeFile(
          cachePath,
          JSON.stringify({
            client_version: '0.153.4-fixture',
            models: [
              { slug: 'gpt-6-astra', multi_agent_version: 'v2' },
              { slug: 'gpt-5.6-sol', multi_agent_version: 'v2' },
            ],
          }),
          'utf8'
        )
      }, 25)
      return CodexAppServerClient.connect({ ...options, binaryArgs: [fixturePath] })
    })

    await manager!.getStatus()

    expect(connectOptions).toHaveLength(2)
    expect(connectOptions[0].binaryArgs).not.toContain('-c')
    expect(connectOptions[1].binaryArgs).toContain('-c')
    const refreshedOverride = JSON.parse(
      await readFile(path.join(codexHome, 'maestrly-model-catalog.json'), 'utf8')
    ) as { client_version: string; models: Array<{ slug: string; multi_agent_version: unknown }> }
    expect(refreshedOverride.client_version).toBe('0.153.4-fixture')
    expect(refreshedOverride.models).toEqual([
      { slug: 'gpt-6-astra', multi_agent_version: null },
      { slug: 'gpt-5.6-sol', multi_agent_version: null, max_context_window: 1_050_000 },
    ])
  })

  it('reconnects without rejected catalogs until cache changes', async () => {
    const codexHome = path.join(userDataPath, 'codex-subscription')
    await mkdir(codexHome, { recursive: true })
    const overridePath = path.join(codexHome, 'maestrly-model-catalog.json')
    await writeFile(
      path.join(codexHome, 'models_cache.json'),
      JSON.stringify({
        client_version: '0.153.4-fixture',
        models: [{ slug: 'gpt-5.6-sol', multi_agent_version: 'v2' }],
      }),
      'utf8'
    )
    // Reproduce catalog-only runtime rejection; startup without flags still works.
    connectClient.mockImplementation(async (options: CodexAppServerConnectOptions) => {
      connectOptions.push(options)
      if (options.binaryArgs?.includes('-c')) {
        throw new CodexAppServerProcessError(
          'Codex app-server exited unexpectedly (code=1, signal=null)',
          { code: 1, signal: null },
          'Error: failed to parse model_catalog_json: missing field `supports_reasoning_summaries`\n'
        )
      }
      return CodexAppServerClient.connect({ ...options, binaryArgs: [fixturePath] })
    })

    const status = await manager!.getStatus()

    // Keep the provider usable even when multi-agent suppression is unavailable.
    expect(status).toMatchObject({ state: 'ready', connected: true, authenticated: true, error: null })
    expect(connectOptions).toHaveLength(2)
    expect(connectOptions[0].binaryArgs).toContain('-c')
    expect(connectOptions[1].binaryArgs).toEqual([
      'app-server',
      '--disable',
      'multi_agent',
      '--disable',
      'multi_agent_v2',
    ])
    await expect(stat(overridePath)).rejects.toMatchObject({ code: 'ENOENT' })

    const client = await manager!.getClient()
    await manager!.request('test/crash').catch(() => undefined)
    await client.waitForExit()
    await waitImmediate()
    await manager!.getClient()

    // Unchanged caches must not repeat failed process startup.
    expect(connectOptions).toHaveLength(3)
    expect(connectOptions[2].binaryArgs).not.toContain('-c')
    await expect(stat(overridePath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('includes the stderr line explaining app-server death in the error', async () => {
    manager = new CodexSubscriptionManager({
      resolveRuntime: () => runtime(process.execPath),
      connectClient: async () => {
        throw new CodexAppServerProcessError(
          'Codex app-server exited unexpectedly (code=1, signal=null)',
          { code: 1, signal: null },
          'WARNING: proceeding anyway\nError: failed to load configuration: missing field `supports_reasoning_summaries`\n'
        )
      },
      getUserDataPath: () => userDataPath,
      getAppVersion: () => '9.8.7-test',
    })

    const status = await manager.getStatus()

    expect(status.state).toBe('error')
    expect(status.error?.message).toContain('exited unexpectedly (code=1')
    expect(status.error?.message).toContain('missing field `supports_reasoning_summaries`')
  })

  it('caches and deduplicates account rate-limit reads', async () => {
    expect(manager!.getRateLimitsSnapshot()).toBeNull()

    const [first, concurrent] = await Promise.all([manager!.getRateLimits(), manager!.getRateLimits()])
    const second = await manager!.getRateLimits()

    expect(first).toMatchObject({
      primary: { usedPercent: 42, windowDurationMins: 60, resetsAt: 1_700_000_000_000 },
      secondary: { usedPercent: 10, resetsAt: 1_700_003_600_000 },
      rateLimitReachedType: null,
      readCount: 1,
    })
    expect(concurrent).toBe(first)
    expect(second).toBe(first)
    expect(manager!.getRateLimitsSnapshot()).toBe(first)

    const refreshed = await manager!.getRateLimits(true)
    expect(refreshed).toMatchObject({ readCount: 2 })
    expect(manager!.getRateLimitsSnapshot()).toBe(refreshed)
  })

  it('merges sparse rate-limit updates and notifies listeners', async () => {
    const updates: unknown[] = []
    const off = manager!.onRateLimitsUpdated((limits) => updates.push(limits))

    const initial = await manager!.getRateLimits()
    expect(initial?.primary?.usedPercent).toBe(42)

    await manager!.request('test/emitRateLimitsUpdated', {
      rateLimits: {
        primary: { usedPercent: 99 },
        rateLimitReachedType: 'primary',
      },
    })
    await vi.waitFor(() => expect(updates.length).toBe(1))

    const merged = manager!.getRateLimitsSnapshot()
    expect(merged).toMatchObject({
      primary: { usedPercent: 99, windowDurationMins: 60, resetsAt: 1_700_000_000_000 },
      secondary: { usedPercent: 10, resetsAt: 1_700_003_600_000 },
      rateLimitReachedType: 'primary',
      readCount: 1,
    })
    expect(updates[0]).toBe(merged)
    off()
  })

  it('invalidates rate caches after account updates', async () => {
    const first = await manager!.getRateLimits()
    expect(first).toMatchObject({ readCount: 1 })
    expect(manager!.getRateLimitsSnapshot()).toBe(first)

    await manager!.request('test/emitAccountUpdated', { authMode: null, planType: null })
    await vi.waitFor(() => expect(manager!.getRateLimitsSnapshot()).toBeNull())

    const second = await manager!.getRateLimits()
    expect(second).toMatchObject({ readCount: 2 })
  })

  it('fails open when runtime rate-limit RPC is missing', async () => {
    let resolveExit!: (exit: { code: number | null; signal: NodeJS.Signals | null }) => void
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      resolveExit = resolve
    })
    const notificationListeners = new Set<(notification: CodexNotification) => void>()
    const fakeClient = {
      state: 'ready' as const,
      failure: null,
      onNotification: (listener: (notification: CodexNotification) => void) => {
        notificationListeners.add(listener)
        return () => notificationListeners.delete(listener)
      },
      waitForExit: () => exited,
      request: async (method: string) => {
        if (method === 'account/rateLimits/read') {
          throw new CodexAppServerRpcError('Method not found', -32601, method, 1)
        }
        throw new CodexAppServerRpcError(`Unexpected method ${method}`, -32601, method, 1)
      },
      close: async () => {
        resolveExit({ code: 0, signal: null })
      },
      abort: () => {
        resolveExit({ code: null, signal: 'SIGTERM' })
      },
    }

    await manager?.dispose()
    manager = new CodexSubscriptionManager({
      resolveRuntime: () => runtime(process.execPath),
      connectClient: async () => fakeClient as unknown as CodexAppServerClient,
      getUserDataPath: () => userDataPath,
      getAppVersion: () => '9.8.7-test',
    })

    await expect(manager.getRateLimits()).resolves.toBeNull()
    await expect(manager.getRateLimits(true)).resolves.toBeNull()
    expect(manager.getRateLimitsSnapshot()).toBeNull()
  })

  it('isolates rate caches by account', async () => {
    const connectA = vi.fn(async (options: CodexAppServerConnectOptions) => {
      return CodexAppServerClient.connect({ ...options, binaryArgs: [fixturePath] })
    })
    const connectB = vi.fn(async (options: CodexAppServerConnectOptions) => {
      return CodexAppServerClient.connect({ ...options, binaryArgs: [fixturePath] })
    })

    const managerA = new CodexSubscriptionManager({
      accountId: 'acct-a',
      resolveRuntime: () => runtime(process.execPath),
      connectClient: connectA,
      getUserDataPath: () => userDataPath,
      getAppVersion: () => '9.8.7-test',
    })
    const managerB = new CodexSubscriptionManager({
      accountId: 'acct-b',
      resolveRuntime: () => runtime(process.execPath),
      connectClient: connectB,
      getUserDataPath: () => userDataPath,
      getAppVersion: () => '9.8.7-test',
    })

    try {
      const [limitsA, limitsB] = await Promise.all([managerA.getRateLimits(), managerB.getRateLimits()])
      expect(limitsA).toMatchObject({ readCount: 1 })
      expect(limitsB).toMatchObject({ readCount: 1 })
      expect(limitsA).not.toBe(limitsB)
      expect(managerA.getRateLimitsSnapshot()).toBe(limitsA)
      expect(managerB.getRateLimitsSnapshot()).toBe(limitsB)
      expect(managerA.codexHome).not.toBe(managerB.codexHome)

      await managerA.request('test/emitRateLimitsUpdated', { rateLimits: { primary: { usedPercent: 88 } } })
      await vi.waitFor(() => expect(managerA.getRateLimitsSnapshot()?.primary?.usedPercent).toBe(88))
      expect(managerB.getRateLimitsSnapshot()?.primary?.usedPercent).toBe(42)
    } finally {
      await managerA.dispose()
      await managerB.dispose()
    }
  })
})
