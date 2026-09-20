import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parseOptions, runSmoke } from '../../scripts/smoke-cursor-sdk-authenticated.mjs'

const options = { enabled: true, model: 'test-model', apiKey: 'SECRET-KEY', timeoutMs: 100 }
const smokeRoot = path.resolve('isolated', 'smoke')
const never = () => new Promise(() => {})

function fixture(fault) {
  const calls = {
    policies: [],
    prompts: [],
    logs: [],
    opens: [],
    disposed: 0,
    closed: 0,
    cancelled: 0,
    removed: 0,
    login: 0,
    logout: 0,
  }
  let savedReceipt,
    sendCount = 0,
    currentStore
  class InMemoryCredentialStore {
    async load() {
      return this.value
    }
    async save(value) {
      this.value = value
    }
    async clear() {
      this.value = undefined
    }
  }
  const checkPolicy = (policy) => {
    calls.policies.push(policy)
    assert.equal(policy.apiKey, 'SECRET-KEY')
    assert.deepEqual(policy.model, { id: 'test-model' })
    assert.deepEqual(policy.tools, ['mcp'])
    assert.deepEqual(policy.mcpServers, {})
    assert.deepEqual(policy.local.settingSources, [])
    assert.equal(policy.local.cwd, smokeRoot)
    assert.equal(policy.local.store, currentStore)
    assert.deepEqual(Object.keys(policy.local.customTools), ['smoke_probe'])
    assert.deepEqual(policy.local.customTools.smoke_probe.annotations, {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    })
  }
  const agent = (policy) => ({
    agentId: 'isolated-agent',
    close() {
      calls.closed++
    },
    async send(prompt) {
      calls.prompts.push(prompt)
      const turn = ++sendCount
      if (fault === 'send') return never()
      let cancelled = false
      return {
        async cancel() {
          calls.cancelled++
          cancelled = true
          if (fault === 'cancel') throw new Error('SECRET-KEY')
        },
        async *stream() {
          if (fault === 'stream') await never()
          yield { secret: 'SECRET-KEY', identity: 'private@example.com' }
          if (turn < 3 && fault !== 'missing-tool') {
            const result = await policy.local.customTools.smoke_probe.execute(
              turn === 1 ? {} : { receipt: fault === 'receipt' ? 'wrong' : savedReceipt }
            )
            savedReceipt = result.receipt
          }
        },
        async wait() {
          if (fault === 'wait') return never()
          return { status: fault === 'status' ? 'error' : cancelled ? 'cancelled' : 'finished' }
        },
      }
    },
  })
  const sdk = {
    InMemoryCredentialStore,
    Cursor: {
      configure() {
        assert.fail('Global configuration is forbidden')
      },
      models: {
        async list(value) {
          assert.deepEqual(value, { apiKey: 'SECRET-KEY' })
          if (fault === 'models') throw new Error('SECRET-KEY private@example.com')
          return [{ id: fault === 'model-unavailable' ? 'another-model' : 'test-model' }]
        },
      },
      auth: {
        async login(value) {
          calls.login++
          assert.ok(value.store instanceof InMemoryCredentialStore)
          assert.equal(value.openBrowser, true)
          assert.ok(value.signal instanceof AbortSignal)
          value.onLoginUrl('https://secret-login-challenge')
          await value.store.save({ apiKey: 'SECRET-KEY' })
          if (fault === 'login') throw new Error('SECRET-KEY')
          return { apiKey: 'SECRET-KEY', email: 'private@example.com' }
        },
        async logout({ store }) {
          calls.logout++
          await store.clear()
          if (fault === 'logout') throw new Error('SECRET-KEY')
        },
        async status({ store }) {
          return { status: (await store.load()) ? 'logged-in' : 'logged-out' }
        },
      },
    },
    Agent: {
      async create(policy) {
        checkPolicy(policy)
        if (fault === 'create') return never()
        return agent(policy)
      },
      async resume(id, policy) {
        assert.equal(id, 'isolated-agent')
        assert.equal(calls.closed, 1)
        assert.equal(calls.disposed, 1)
        assert.equal(calls.opens.length, 2)
        checkPolicy(policy)
        if (fault === 'resume') throw new Error('SECRET-KEY')
        return agent(policy)
      },
    },
  }
  const dependencies = {
    loadSdk: async () => sdk,
    loadSqlite: async () => ({
      SqliteLocalAgentStore: {
        async open(value) {
          calls.opens.push(value)
          assert.deepEqual(value, { workspaceRef: smokeRoot, stateRoot: path.join(smokeRoot, 'sdk-state') })
          currentStore = {
            async dispose() {
              calls.disposed++
              if (fault === 'dispose') throw new Error('SECRET-KEY')
            },
          }
          return currentStore
        },
      },
    }),
    mkdtemp: async () => smokeRoot,
    rm: async (root, value) => {
      assert.equal(root, smokeRoot)
      assert.deepEqual(value, { recursive: true, force: true })
      calls.removed++
    },
    log: (line) => calls.logs.push(line),
  }
  return { calls, dependencies, sdk }
}

test('default refusal happens before loading SDK or touching state', async () => {
  const loadSdk = () => assert.fail('SDK must not load')
  for (const input of [{}, { ...options, enabled: false }, { ...options, model: '' }, { ...options, apiKey: '' }]) {
    await assert.rejects(runSmoke(input, { loadSdk }), /requires/)
  }
  assert.deepEqual(parseOptions(['--login', '--model', 'chosen'], {}), {
    enabled: false,
    model: 'chosen',
    login: true,
    apiKey: undefined,
  })
  assert.equal(parseOptions([], { MAESTRLY_CURSOR_SMOKE_MODEL: 'env-model' }).model, 'env-model')
  assert.throws(() => parseOptions(['--model'], {}), /Invalid arguments/)
})

for (const login of [false, true]) {
  test(`isolated authenticated lifecycle with browser login=${login}`, async () => {
    const { dependencies, calls } = fixture()
    const envBefore = { ...process.env }
    const result = await runSmoke({ ...options, login, apiKey: login ? undefined : options.apiKey }, dependencies)
    assert.deepEqual(result, { models: 1, toolCalls: 1, resumedToolCalls: 1, events: 3, cancelled: 1 })
    assert.equal(calls.login, Number(login))
    assert.equal(calls.logout, 1)
    assert.equal(calls.closed, 2)
    assert.equal(calls.disposed, 2)
    assert.equal(calls.cancelled, 1)
    assert.equal(calls.removed, 1)
    assert.equal(calls.policies.length, 2)
    assert.match(calls.logs.join('\n'), /PASS resume/)
    assert.match(calls.logs.join('\n'), /PASS cleanup/)
    assert.doesNotMatch(calls.logs.join('\n'), /SECRET|private|challenge|isolated-agent/)
    assert.ok(JSON.stringify({ ...process.env }) === JSON.stringify(envBefore), 'Environment must remain unchanged')
  })
}

for (const fault of [
  'models',
  'model-unavailable',
  'login',
  'create',
  'send',
  'stream',
  'wait',
  'missing-tool',
  'receipt',
  'status',
  'resume',
  'cancel',
  'dispose',
  'logout',
]) {
  test(`failure at ${fault} is sanitized and cleanup continues`, async () => {
    const { dependencies, calls } = fixture(fault)
    await assert.rejects(runSmoke({ ...options, login: fault === 'login', timeoutMs: 15 }, dependencies), (error) => {
      assert.match(error.message, /^Cursor live smoke failed at [a-z]+$/)
      return true
    })
    assert.equal(calls.logout, 1)
    if (calls.opens.length) {
      assert.equal(calls.removed, 1)
      assert.ok(calls.disposed >= 1)
    }
    assert.doesNotMatch(calls.logs.join('\n'), /SECRET|private|PASS cleanup/)
  })
}

test('late create handle is closed after timeout', async () => {
  const { dependencies, calls, sdk } = fixture()
  let resolveCreate
  sdk.Agent.create = () =>
    new Promise((resolve) => {
      resolveCreate = resolve
    })
  await assert.rejects(runSmoke({ ...options, timeoutMs: 10 }, dependencies), /failed at tool/)
  resolveCreate({
    close() {
      calls.closed++
    },
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls.closed, 1)
  assert.equal(calls.removed, 1)
})

test('abort interrupts pending send and cleans acquired resources', async () => {
  const { dependencies, calls, sdk } = fixture('send')
  const controller = new AbortController()
  const create = sdk.Agent.create
  sdk.Agent.create = async (policy) => {
    const handle = await create(policy)
    const send = handle.send
    handle.send = (...args) => {
      controller.abort()
      return send(...args)
    }
    return handle
  }
  await assert.rejects(runSmoke({ ...options, signal: controller.signal }, dependencies), /failed at tool/)
  assert.equal(calls.closed, 1)
  assert.equal(calls.disposed, 1)
  assert.equal(calls.removed, 1)
})

test('late send run is cancelled after timeout', async () => {
  const { dependencies, calls, sdk } = fixture()
  let resolveSend
  const create = sdk.Agent.create
  sdk.Agent.create = async (policy) => {
    const handle = await create(policy)
    handle.send = () =>
      new Promise((resolve) => {
        resolveSend = resolve
      })
    return handle
  }
  await assert.rejects(runSmoke({ ...options, timeoutMs: 10 }, dependencies), /failed at tool/)
  resolveSend({
    async cancel() {
      calls.cancelled++
    },
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls.cancelled, 1)
  assert.equal(calls.closed, 1)
  assert.equal(calls.removed, 1)
})

test('browser login deadline aborts polling and clears late credentials', async () => {
  const { dependencies, calls, sdk } = fixture()
  let loginOptions, resolveLogin
  sdk.Cursor.auth.login = (value) => {
    loginOptions = value
    return new Promise((resolve) => {
      resolveLogin = resolve
    })
  }
  await assert.rejects(runSmoke({ ...options, login: true, timeoutMs: 10 }, dependencies), /failed at auth/)
  assert.equal(loginOptions.signal.aborted, true)
  assert.equal(calls.logout, 1)
  await loginOptions.store.save({ apiKey: 'SECRET-KEY' })
  resolveLogin({ apiKey: 'SECRET-KEY' })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(await loginOptions.store.load(), undefined)
})

test('standalone CLI refuses without opt-in before loading the native SDK', () => {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('../../scripts/smoke-cursor-sdk-authenticated.mjs', import.meta.url))],
    {
      env: { ...process.env, MAESTRLY_CURSOR_LIVE_SMOKE: '', CURSOR_API_KEY: '', MAESTRLY_CURSOR_SMOKE_MODEL: '' },
      encoding: 'utf8',
      timeout: 5000,
    }
  )
  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /requires MAESTRLY_CURSOR_LIVE_SMOKE=1/)
  assert.doesNotMatch(result.stderr, /sqlite|node_modules|at file:/)
})

test('late SQLite store is disposed after opening exceeds its deadline', async () => {
  const { dependencies, calls } = fixture()
  let resolveOpen
  dependencies.loadSqlite = async () => ({
    SqliteLocalAgentStore: {
      open: () =>
        new Promise((resolve) => {
          resolveOpen = resolve
        }),
    },
  })
  await assert.rejects(runSmoke({ ...options, timeoutMs: 10 }, dependencies), /failed at store/)
  resolveOpen({
    async dispose() {
      calls.disposed++
    },
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls.disposed, 1)
  assert.equal(calls.removed, 1)
})
