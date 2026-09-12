import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CodexAppServerAbortError,
  CodexAppServerClient,
  CodexAppServerProcessError,
  CodexAppServerRpcError,
  codexTextInput,
} from '../../src/main/chat/codex-subscription'

const fixtureSource = String.raw`
import readline from 'node:readline'

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
let initialized = false
let pendingServerRequest = null

const send = (message, ending = '\n') => process.stdout.write(JSON.stringify(message) + ending)
const success = (id, result) => send({ id, result })
const failure = (id, code, message, data) => send({ id, error: { code, message, ...(data ? { data } : {}) } })

lines.on('line', (line) => {
  const message = JSON.parse(line)
  if (message.method === 'initialize') {
    success(message.id, {
      userAgent: 'codex-fixture/1.0',
      codexHome: '/tmp/codex-home',
      platformFamily: 'unix',
      platformOs: 'linux',
    })
    return
  }
  if (message.method === 'initialized') {
    initialized = true
    return
  }
  if (!message.method && message.id === 'server-approval') {
    const requestId = pendingServerRequest
    pendingServerRequest = null
    success(requestId, message)
    return
  }
  if (!initialized) {
    failure(message.id, -32002, 'Not initialized')
    return
  }

  switch (message.method) {
    case 'test/handshake':
      success(message.id, { initialized })
      break
    case 'test/echo':
      setTimeout(() => success(message.id, message.params), message.params.delay)
      break
    case 'test/env':
      success(message.id, {
        kept: process.env.MAESTRLY_CODEX_ENV_TEST ?? null,
        removed: process.env.CODEX_REFRESH_TOKEN_URL_OVERRIDE ?? null,
        managedConfig: process.env.CODEX_APP_SERVER_MANAGED_CONFIG_PATH ?? null,
        openaiBase: process.env.OPENAI_BASE_URL ?? null,
        codexHome: process.env.CODEX_HOME ?? null,
      })
      break
    case 'test/error':
      failure(message.id, 4321, 'fixture rpc failure', { retryable: false })
      break
    case 'test/hang':
      break
    case 'test/protocol':
      process.stdout.write('not-json\n')
      success(message.id, { recovered: true })
      break
    case 'test/batch':
      process.stdout.write(
        JSON.stringify({ method: 'fixture/notification', params: { value: 7 } }) + '\r\n' +
          JSON.stringify({ id: message.id, result: { batched: true } }) + '\n',
      )
      break
    case 'test/serverRequest':
      pendingServerRequest = message.id
      send({
        id: 'server-approval',
        method: 'item/commandExecution/requestApproval',
        params: { command: 'npm test' },
      })
      break
    case 'test/exit':
      process.stderr.write('fatal from fixture')
      setTimeout(() => process.exit(17), 5)
      break
    case 'account/read':
      success(message.id, {
        account: { type: 'chatgpt', email: 'dev@example.com', planType: 'pro' },
        requiresOpenaiAuth: true,
      })
      break
    case 'account/login/start':
      success(message.id, { type: 'chatgpt', loginId: 'login-1', authUrl: 'https://auth.example.test' })
      break
    case 'account/logout':
      success(message.id, { omittedParams: !Object.hasOwn(message, 'params') })
      break
    case 'thread/start':
      success(message.id, {
        thread: { id: 'thread-1' },
        model: message.params.model ?? 'gpt-default',
        modelProvider: 'openai',
        serviceTier: null,
        cwd: message.params.cwd ?? '/repo',
      })
      break
    case 'thread/resume':
      success(message.id, {
        thread: { id: message.params.threadId },
        model: 'gpt-default',
        modelProvider: 'openai',
        serviceTier: null,
        cwd: '/repo',
      })
      break
    case 'thread/delete':
      success(message.id, {})
      send({ method: 'thread/deleted', params: { threadId: message.params.threadId } })
      break
    case 'turn/start':
      success(message.id, { turn: { id: 'turn-1', receivedInput: message.params.input } })
      send({ method: 'turn/started', params: { threadId: message.params.threadId, turn: { id: 'turn-1' } } })
      break
    case 'turn/interrupt':
      success(message.id, {})
      break
    case 'turn/steer':
      success(message.id, { accepted: true, turnId: message.params.expectedTurnId })
      break
    case 'turn/settings/update':
      success(message.id, { applied: true, effort: message.params.effort })
      break
    default:
      failure(message.id, -32601, 'Method not found')
  }
})
`

describe('CodexAppServerClient', () => {
  let directory: string
  let fixturePath: string
  const clients = new Set<CodexAppServerClient>()

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'maestrly-codex-client-'))
    fixturePath = path.join(directory, 'fixture.mjs')
    await writeFile(fixturePath, fixtureSource, 'utf8')
  })

  afterEach(async () => {
    await Promise.all([...clients].map((client) => client.close({ gracePeriodMs: 100 })))
    clients.clear()
    await rm(directory, { recursive: true, force: true })
    delete process.env.MAESTRLY_CODEX_ENV_TEST
    delete process.env.CODEX_REFRESH_TOKEN_URL_OVERRIDE
    delete process.env.CODEX_APP_SERVER_MANAGED_CONFIG_PATH
    delete process.env.OPENAI_BASE_URL
  })

  async function connect(
    overrides: Partial<Parameters<typeof CodexAppServerClient.connect>[0]> = {}
  ): Promise<CodexAppServerClient> {
    const client = await CodexAppServerClient.connect({
      binaryPath: process.execPath,
      binaryArgs: [fixturePath],
      clientInfo: { name: 'maestrly_test', title: 'Maestrly Test', version: '1.0.0' },
      defaultRequestTimeoutMs: 2_000,
      ...overrides,
    })
    clients.add(client)
    return client
  }

  it('completes initialization before correlating concurrent requests', async () => {
    const client = await connect({ capabilities: { experimentalApi: true } })

    expect(client.state).toBe('ready')
    expect(client.initializeResult).toMatchObject({
      userAgent: 'codex-fixture/1.0',
      platformFamily: 'unix',
      platformOs: 'linux',
    })
    await expect(client.request('test/handshake')).resolves.toEqual({ initialized: true })

    const slow = client.request<{ value: string }>('test/echo', { value: 'slow', delay: 20 })
    const fast = client.request<{ value: string }>('test/echo', { value: 'fast', delay: 1 })
    await expect(Promise.all([slow, fast])).resolves.toEqual([
      { value: 'slow', delay: 20 },
      { value: 'fast', delay: 1 },
    ])
  })

  it('keeps readers reentrant during nested server-request RPCs', async () => {
    const client = await connect()
    client.setServerRequestHandler(async () => {
      const nested = await client.request<{ value: string; delay: number }>('test/echo', {
        value: 'nested',
        delay: 1,
      })
      return { nested }
    })

    await expect(client.request('test/serverRequest')).resolves.toMatchObject({
      result: { nested: { value: 'nested', delay: 1 } },
    })
  })

  it('applies environment overrides and removes sensitive variables', async () => {
    process.env.MAESTRLY_CODEX_ENV_TEST = 'kept'
    process.env.CODEX_REFRESH_TOKEN_URL_OVERRIDE = 'https://attacker.invalid/token'
    process.env.CODEX_APP_SERVER_MANAGED_CONFIG_PATH = '/tmp/attacker-config.toml'
    process.env.OPENAI_BASE_URL = 'https://attacker.invalid/v1'
    const client = await connect({
      env: { CODEX_HOME: '/isolated/codex-home' },
      unsetEnv: ['codex_refresh_token_url_override'],
      unsetEnvPrefixes: ['CODEX_', 'OPENAI_'],
    })

    await expect(client.request('test/env')).resolves.toEqual({
      kept: 'kept',
      removed: null,
      managedConfig: null,
      openaiBase: null,
      codexHome: '/isolated/codex-home',
    })
  })

  it('exposes narrow account, thread and turn contracts', async () => {
    const client = await connect()
    const notifications: string[] = []
    client.onNotification(({ method }) => notifications.push(method))

    await expect(client.readAccount({ refreshToken: true })).resolves.toMatchObject({
      account: { type: 'chatgpt', email: 'dev@example.com', planType: 'pro' },
    })
    await expect(client.startAccountLogin({ type: 'chatgpt', appBrand: 'codex' })).resolves.toEqual({
      type: 'chatgpt',
      loginId: 'login-1',
      authUrl: 'https://auth.example.test',
    })
    await expect(client.startThread({ model: 'gpt-test', cwd: '/workspace' })).resolves.toMatchObject({
      thread: { id: 'thread-1' },
      model: 'gpt-test',
      cwd: '/workspace',
    })
    await expect(client.resumeThread({ threadId: 'thread-existing' })).resolves.toMatchObject({
      thread: { id: 'thread-existing' },
    })
    await expect(client.deleteThread({ threadId: 'thread-existing' })).resolves.toEqual({})
    await expect(client.startTurn({ threadId: 'thread-1', input: [codexTextInput('hi')] })).resolves.toEqual({
      turn: { id: 'turn-1', receivedInput: [{ type: 'text', text: 'hi', text_elements: [] }] },
    })
    await expect(client.interruptTurn({ threadId: 'thread-1', turnId: 'turn-1' })).resolves.toEqual({})
    await expect(
      client.steerTurn({
        threadId: 'thread-1',
        expectedTurnId: 'turn-1',
        input: [codexTextInput('also check tests')],
        clientUserMessageId: 'client-message-1',
      })
    ).resolves.toEqual({ accepted: true, turnId: 'turn-1' })
    await expect(
      client.updateTurnSettings({ threadId: 'thread-1', expectedTurnId: 'turn-1', effort: 'ultra' })
    ).resolves.toEqual({ applied: true, effort: 'ultra' })
    await expect(client.logoutAccount()).resolves.toEqual({ omittedParams: true })
    expect(notifications).toContain('turn/started')
    expect(notifications).toContain('thread/deleted')
  })

  it('handles batched JSONL, CRLF and invalid lines without disconnecting', async () => {
    const client = await connect()
    const notifications: string[] = []
    const protocolErrors: string[] = []
    client.onNotification(({ method }) => notifications.push(method))
    client.onProtocolError((error) => protocolErrors.push(error.message))

    await expect(client.request('test/batch')).resolves.toEqual({ batched: true })
    await expect(client.request('test/protocol')).resolves.toEqual({ recovered: true })

    expect(notifications).toEqual(['fixture/notification'])
    expect(protocolErrors).toEqual(['Codex app-server emitted invalid JSON'])
    expect(client.state).toBe('ready')
  })

  it('answers app-server initiated requests through the same channel', async () => {
    const client = await connect({
      serverRequestHandler: async (request, signal) => {
        expect(signal.aborted).toBe(false)
        expect(request).toEqual({
          id: 'server-approval',
          method: 'item/commandExecution/requestApproval',
          params: { command: 'npm test' },
        })
        return { decision: 'accept' }
      },
    })

    await expect(client.request('test/serverRequest')).resolves.toEqual({
      id: 'server-approval',
      result: { decision: 'accept' },
    })
  })

  it('keeps RPC errors and request aborts local', async () => {
    const client = await connect()

    const rpcError = await client.request('test/error').catch((error: unknown) => error)
    expect(rpcError).toBeInstanceOf(CodexAppServerRpcError)
    expect(rpcError).toMatchObject({ code: 4321, method: 'test/error', data: { retryable: false } })

    const abort = new AbortController()
    const hanging = client.request('test/hang', {}, { signal: abort.signal })
    abort.abort(new Error('cancelled by the test'))
    await expect(hanging).rejects.toBeInstanceOf(CodexAppServerAbortError)
    await expect(client.request('test/echo', { value: 'alive', delay: 0 })).resolves.toEqual({
      value: 'alive',
      delay: 0,
    })
  })

  it('preserves stderr and exit codes when rejecting pending requests', async () => {
    const client = await connect()

    const error = await client.request('test/exit').catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(CodexAppServerProcessError)
    expect(error).toMatchObject({ exit: { code: 17, signal: null } })
    expect((error as CodexAppServerProcessError).stderr).toContain('fatal from fixture')
    expect(client.state).toBe('failed')
  })

  it('closes processes and rejects pending operations during cleanup', async () => {
    const client = await connect()
    const hanging = client.request('test/hang')
    const rejected = expect(hanging).rejects.toMatchObject({ name: 'CodexAppServerClosedError' })

    await client.close({ gracePeriodMs: 100 })

    await rejected
    expect(client.state).toBe('closed')
    await expect(client.request('test/echo', { value: 'late', delay: 0 })).rejects.toMatchObject({
      name: 'CodexAppServerClosedError',
    })
  })

  it('returns typed failures for missing binaries', async () => {
    await expect(
      CodexAppServerClient.connect({
        binaryPath: path.join(directory, 'missing-codex'),
        clientInfo: { name: 'maestrly_test', title: null, version: '1.0.0' },
      })
    ).rejects.toBeInstanceOf(CodexAppServerProcessError)
  })
})
