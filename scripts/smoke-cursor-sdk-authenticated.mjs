#!/usr/bin/env node
// Explicit live opt-in; all local state belongs to this invocation.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

export function parseOptions(argv = process.argv.slice(2), env = process.env) {
  let model = env.MAESTRLY_CURSOR_SMOKE_MODEL
  let login = false
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--login') login = true
    else if (argv[i] === '--model' && argv[i + 1] && !argv[i + 1].startsWith('--')) model = argv[++i]
    else throw new Error('Invalid arguments: use --model MODEL [--login]')
  }
  return { enabled: env.MAESTRLY_CURSOR_LIVE_SMOKE === '1', model, login, apiKey: env.CURSOR_API_KEY }
}

export async function runSmoke(options = {}, dependencies = {}) {
  const { enabled, model, login = false, apiKey: suppliedKey, timeoutMs = 120000, signal } = options
  if (enabled !== true || typeof model !== 'string' || !model.trim()) {
    throw new Error('Live smoke requires MAESTRLY_CURSOR_LIVE_SMOKE=1 and --model MODEL or MAESTRLY_CURSOR_SMOKE_MODEL')
  }
  if (!login && !(typeof suppliedKey === 'string' && suppliedKey.trim())) {
    throw new Error('Live smoke requires an explicit CURSOR_API_KEY or --login')
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid timeout')
  const log = dependencies.log ?? console.log
  const makeTemporary = dependencies.mkdtemp ?? mkdtemp
  const remove = dependencies.rm ?? rm
  const loadSdk = dependencies.loadSdk ?? (() => import('@cursor/sdk'))
  const loadSqlite = dependencies.loadSqlite ?? (() => import('@cursor/sdk/sqlite'))
  let stage = 'initialize'
  let root, store, credentialStore, sdk, activeRun
  const agents = new Set()
  const counters = { models: 0, toolCalls: 0, resumedToolCalls: 0, events: 0, cancelled: 0 }
  const loginAbort = new AbortController()
  let failure

  // SDK create/send/store APIs lack AbortSignal. Dispose handles that arrive
  // after a deadline as well as handles already acquired by the runner.
  async function bounded(action, lateCleanup, cleanup = false) {
    let expired = false
    let timer, abort
    const work = Promise.resolve().then(action)
    const deadline = new Promise((_, reject) => {
      const stop = () => {
        expired = true
        reject(new Error('Operation stopped'))
      }
      timer = setTimeout(stop, Math.min(timeoutMs, cleanup ? 10000 : timeoutMs))
      if (!cleanup && signal) {
        abort = stop
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) stop()
      }
    })
    work.then(
      (value) => {
        if (expired && lateCleanup)
          Promise.resolve()
            .then(() => lateCleanup(value))
            .catch(() => {})
      },
      () => {}
    )
    try {
      return await Promise.race([work, deadline])
    } finally {
      clearTimeout(timer)
      if (abort) signal.removeEventListener('abort', abort)
    }
  }
  const pass = (name) => log(`[cursor-sdk-smoke] PASS ${name}`)
  async function acquireAgent(action) {
    const agent = await bounded(action, (value) => value.close())
    agents.add(agent)
    return agent
  }
  async function send(agent, prompt) {
    activeRun = await bounded(
      () => agent.send(prompt),
      (value) => value.cancel()
    )
    return activeRun
  }
  async function finish(run, status) {
    const iterator = run.stream()
    try {
      await bounded(async () => {
        for await (const _event of iterator) counters.events++
      })
      const result = await bounded(() => run.wait())
      if (result.status !== status) throw new Error('Unexpected run status')
      activeRun = undefined
    } finally {
      // A stuck next() must not make iterator.return() an unbounded wait.
      await bounded(() => iterator.return?.(), undefined, true)
    }
  }
  try {
    sdk = await bounded(loadSdk)
    credentialStore = new sdk.InMemoryCredentialStore()
    let apiKey = suppliedKey
    stage = 'auth'
    if (login) {
      const result = await bounded(
        () =>
          sdk.Cursor.auth.login({
            store: credentialStore,
            openBrowser: true,
            onLoginUrl: () => {}, // Never print the login challenge or identity.
            signal: loginAbort.signal,
            apiKeyName: 'Maestrly isolated live smoke',
            apiKeyTtlMs: 3600000,
          }),
        () => credentialStore.clear()
      )
      apiKey = result.apiKey
      if ((await bounded(() => sdk.Cursor.auth.status({ store: credentialStore }))).status !== 'logged-in') {
        throw new Error('Login was not stored')
      }
    }
    if (typeof apiKey !== 'string' || !apiKey.trim()) throw new Error('Missing credential')
    stage = 'models'
    const models = await bounded(() => sdk.Cursor.models.list({ apiKey }))
    counters.models = models.length
    if (!models.some((item) => item.id === model)) throw new Error('Explicit model unavailable')
    pass('auth')
    pass('models')
    stage = 'store'
    root = await bounded(
      () => makeTemporary(path.join(tmpdir(), 'maestrly-cursor-live-')),
      (value) => remove(value, { recursive: true, force: true })
    )
    const { SqliteLocalAgentStore } = await bounded(loadSqlite)
    const storeOptions = { workspaceRef: root, stateRoot: path.join(root, 'sdk-state') }
    store = await bounded(
      () => SqliteLocalAgentStore.open(storeOptions),
      (value) => value.dispose()
    )
    const receipt = randomUUID()
    let phase = 'initial'
    const customTools = {
      smoke_probe: {
        description: 'Read an in-memory smoke receipt. For resume, supply the receipt from the earlier tool result.',
        inputSchema: { type: 'object', properties: { receipt: { type: 'string' } }, additionalProperties: false },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        execute(args) {
          if (phase === 'initial') counters.toolCalls++
          else if (phase === 'resume' && args.receipt === receipt) counters.resumedToolCalls++
          else throw new Error('Invalid probe receipt or phase')
          return { receipt }
        },
      },
    }
    const agentOptions = () => ({
      apiKey,
      model: { id: model },
      tools: ['mcp'],
      mcpServers: {},
      local: { cwd: root, store, settingSources: [], customTools, enableAgentRetries: false },
    })
    stage = 'tool'
    let agent = await acquireAgent(() => sdk.Agent.create(agentOptions()))
    const agentId = agent.agentId
    await finish(
      await send(
        agent,
        'Call smoke_probe on custom-user-tools with empty arguments exactly once. Remember its receipt for the next turn, then reply OK.'
      ),
      'finished'
    )
    if (counters.toolCalls < 1) throw new Error('Host tool was not invoked')
    pass('tool')
    stage = 'resume'
    agent.close()
    agents.delete(agent)
    await bounded(() => store.dispose())
    store = undefined
    store = await bounded(
      () => SqliteLocalAgentStore.open(storeOptions),
      (value) => value.dispose()
    )
    phase = 'resume'
    agent = await acquireAgent(() => sdk.Agent.resume(agentId, agentOptions()))
    if (agent.agentId !== agentId) throw new Error('Resume changed agent identity')
    await finish(
      await send(
        agent,
        'Call smoke_probe on custom-user-tools once with the receipt returned in the previous turn. Recover it from conversation history; do not invent it. Then reply OK.'
      ),
      'finished'
    )
    if (counters.resumedToolCalls < 1) throw new Error('Resume did not recover the receipt')
    pass('resume')
    stage = 'cancel'
    phase = 'cancel'
    const run = await send(agent, 'Count from one to one thousand in words. Do not call tools.')
    await bounded(() => run.cancel())
    await finish(run, 'cancelled')
    counters.cancelled++
    pass('cancel')
  } catch {
    failure = new Error(`Cursor live smoke failed at ${stage}`)
  } finally {
    loginAbort.abort()
    const clean = async (action) => {
      try {
        await bounded(action, undefined, true)
      } catch {
        failure ??= new Error('Cursor live smoke failed at cleanup')
      }
    }
    if (activeRun) await clean(() => activeRun.cancel())
    for (const agent of agents) await clean(() => agent.close())
    if (store) await clean(() => store.dispose())
    if (credentialStore) {
      await clean(() => sdk.Cursor.auth.logout({ store: credentialStore }))
      await clean(() => credentialStore.clear())
      await clean(async () => {
        if ((await sdk.Cursor.auth.status({ store: credentialStore })).status !== 'logged-out')
          throw new Error('Logout failed')
      })
    }
    if (root) await clean(() => remove(root, { recursive: true, force: true }))
  }
  if (failure) throw failure
  pass('logout')
  pass('cleanup')
  log(`[cursor-sdk-smoke] PASS counters ${JSON.stringify(counters)}`)
  return counters
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController()
  const interrupt = () => controller.abort()
  process.once('SIGINT', interrupt)
  try {
    await runSmoke({ ...parseOptions(), signal: controller.signal })
  } catch (error) {
    console.error(`[cursor-sdk-smoke] ${error.message}`)
    process.exitCode = 1
  } finally {
    process.removeListener('SIGINT', interrupt)
  }
  // Non-abortable SDK work must not keep the standalone smoke alive indefinitely.
  process.exit(process.exitCode ?? 0)
}
