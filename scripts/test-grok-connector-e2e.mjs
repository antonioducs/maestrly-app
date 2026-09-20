#!/usr/bin/env node
/**
 * End-to-end homologation of the external agent path, with no part of it stubbed on the Maestrly side.
 *
 * A real PostgreSQL, a real Maestrly server, a real OAuth device authorization and the real MCP endpoint.
 * The only actor played by this script is the pair a person would supply: the external agent (what a Grok
 * Bot routine does over MCP) and the executor computer (what Maestrly desktop does over the runner API).
 *
 * It proves the loop the product promises: the agent discovers projects and model selections, delegates
 * work with an exact account/model per stage, adjusts it while it runs, the executor performs the stages,
 * the task reaches its completion target, and the routine is notified with a signed callback it can verify.
 */
import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import http from 'node:http'
import { createServer } from 'node:net'

const container = `maestrly-grok-e2e-${process.pid}`
const ownerPassword = 'correct-horse-battery'
const callbackSecret = 'a-grok-callback-secret-that-is-long'
let postgres = false
let server

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: options.capture ? 'pipe' : 'inherit', env: options.env ?? process.env })
  if (result.status !== 0) throw new Error(result.stderr || `${command} exited with ${result.status}`)
  return result.stdout?.trim() ?? ''
}

async function freePort() {
  const probe = createServer()
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const { port } = probe.address()
  await new Promise((resolve, reject) => probe.close((error) => (error ? reject(error) : resolve())))
  return port
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(description, attempt, { timeoutMs = 60_000, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs
  let last
  for (;;) {
    try {
      const value = await attempt()
      if (value) return value
    } catch (error) {
      last = error
    }
    if (Date.now() >= deadline)
      throw new Error(`Timed out waiting for ${description}${last ? `: ${last.message}` : ''}`)
    await sleep(intervalMs)
  }
}

function check(condition, message) {
  if (!condition) throw new Error(message)
}

async function main() {
  run('npm', ['run', 'build:protocol'])

  // ---- Real PostgreSQL, migrated with the same migration path production uses -------------------------
  run('docker', ['run', '--rm', '-d', '--name', container, '-e', 'POSTGRES_PASSWORD=owner', '-e', 'POSTGRES_DB=maestrly', '-p', '127.0.0.1::5432', 'postgres:17-alpine'], { capture: true })
  postgres = true
  for (let attempt = 0; ; attempt += 1) {
    // Over TCP, not the unix socket: during initdb the socket already answers while the database does not.
    const ready = spawnSync('docker', ['exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres', '-d', 'maestrly'], { stdio: 'ignore' })
    if (ready.status === 0) break
    if (attempt === 120) throw new Error('PostgreSQL did not become ready.')
    await sleep(250)
  }
  const port = run('docker', ['port', container, '5432/tcp'], { capture: true }).split(':').at(-1)
  run('docker', ['exec', container, 'psql', '-U', 'postgres', '-d', 'maestrly', '-v', 'ON_ERROR_STOP=1', '-c', "create role maestrly_runtime login password 'runtime' nosuperuser nocreatedb nocreaterole noinherit nobypassrls; grant connect on database maestrly to maestrly_runtime;"])

  const apiPort = await freePort()
  const canonicalUrl = `http://127.0.0.1:${apiPort}`
  const owner = `owner-${randomUUID()}@example.test`
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    MIGRATION_DATABASE_URL: `postgres://postgres:owner@127.0.0.1:${port}/maestrly`,
    DATABASE_URL: `postgres://maestrly_runtime:runtime@127.0.0.1:${port}/maestrly`,
    BETTER_AUTH_SECRET: randomBytes(32).toString('hex'),
    MAESTRLY_CANONICAL_URL: canonicalUrl,
    MAESTRLY_WEB_ORIGIN: canonicalUrl,
    PORT: String(apiPort),
    LOG_LEVEL: 'warn',
    MAESTRLY_SECRET_KEYS: `e2e:${randomBytes(32).toString('base64')}`,
    // The callback receiver in this test runs on loopback, which the anti-SSRF guard refuses by default.
    MAESTRLY_CONNECTOR_ALLOW_PRIVATE_CALLBACKS: 'true',
    MAESTRLY_STORAGE_DIR: `.maestrly-data/grok-e2e-${process.pid}`,
  }
  run(process.execPath, ['--import', 'tsx', 'apps/server/src/db/migrate.ts'], { env })
  run(process.execPath, ['--import', 'tsx', 'apps/server/src/modules/auth/bootstrap.ts'], {
    env: { ...env, MAESTRLY_BOOTSTRAP_EMAIL: owner, MAESTRLY_BOOTSTRAP_PASSWORD: ownerPassword, MAESTRLY_BOOTSTRAP_ORGANIZATION: 'Grok homologation' },
  })

  server = spawn(process.execPath, ['--import', 'tsx', 'apps/server/src/main.ts'], { env, stdio: 'inherit' })
  server.once('exit', (code) => {
    if (code !== 0 && code !== null) throw new Error(`The Maestrly server exited with ${code}.`)
  })
  await waitFor('the server to become ready', async () => (await fetch(`${canonicalUrl}/api/v1/health/ready`)).ok)

  // ---- The person signs in and authorizes the agent ---------------------------------------------------
  const signIn = await fetch(`${canonicalUrl}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: owner, password: ownerPassword }),
  })
  check(signIn.ok, `Sign-in failed with ${signIn.status}.`)
  const cookie = signIn.headers.getSetCookie().map((value) => value.split(';', 1)[0]).join('; ')

  const api = async (method, path, body, extra = {}) => {
    const response = await fetch(`${canonicalUrl}${path}`, {
      method,
      headers: {
        cookie,
        'content-type': 'application/json',
        'x-maestrly-protocol-version': '1.0',
        'idempotency-key': randomUUID(),
        ...extra,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await response.text()
    if (!response.ok) throw new Error(`${method} ${path} → ${response.status} ${text.slice(0, 300)}`)
    return text ? JSON.parse(text) : null
  }

  const organizationId = (await api('GET', '/api/v1/organizations'))[0].id
  const project = await api('POST', `/api/v1/organizations/${organizationId}/projects`, { name: 'Delegated work' })
  const projectId = project.project.id

  const client = await api('POST', '/api/auth/oauth2/register', {
    client_name: 'Grok Bot',
    redirect_uris: ['https://grok.example/callback'],
    grant_types: ['urn:ietf:params:oauth:grant-type:device_code', 'refresh_token'],
    token_endpoint_auth_method: 'none',
    application_type: 'native',
    scope: 'openid profile email offline_access api:read api:write',
  })
  const connection = await api('POST', `/api/v1/organizations/${organizationId}/connectors`, {
    clientId: client.client_id,
    name: 'Grok Bot',
    cancelOnRevoke: true,
    grants: [
      {
        projectId,
        actions: ['tasks:read', 'tasks:write', 'execution:control', 'evidence:read', 'inspect:read', 'delivery:manage', 'interactions:answer'],
      },
    ],
  })

  // ---- The routine callback the agent listens on ------------------------------------------------------
  const received = []
  const callback = http.createServer((request, response) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      received.push({ headers: request.headers, raw: Buffer.concat(chunks) })
      response.statusCode = 204
      response.end()
    })
  })
  const callbackPort = await freePort()
  await new Promise((resolve) => callback.listen(callbackPort, '127.0.0.1', resolve))
  const endpoint = await api('PUT', `/api/v1/organizations/${organizationId}/connectors/${connection.id}/notification-endpoint`, {
    url: `http://127.0.0.1:${callbackPort}/routine`,
    secret: callbackSecret,
    enabled: true,
  })
  check(!JSON.stringify(endpoint).includes(callbackSecret), 'The callback secret must never be returned.')

  // ---- The agent authorizes with OAuth, for the MCP resource only -------------------------------------
  const mcpResource = `${canonicalUrl}/mcp`
  const deviceCode = await api('POST', '/api/auth/device/code', {
    client_id: client.client_id,
    scope: 'openid profile email offline_access api:read api:write',
    resource: mcpResource,
  })
  await api('GET', `/api/auth/device?user_code=${encodeURIComponent(deviceCode.user_code)}`)
  await api('POST', '/api/auth/device/approve', { userCode: deviceCode.user_code })
  await sleep((deviceCode.interval ?? 5) * 1000)
  const tokenResponse = await fetch(`${canonicalUrl}/api/auth/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: deviceCode.device_code,
      client_id: client.client_id,
      resource: mcpResource,
    }),
  })
  const tokens = await tokenResponse.json()
  check(tokenResponse.ok, `Token exchange failed: ${JSON.stringify(tokens)}`)

  // A token minted for MCP must not be accepted by the REST API with the person's full authority.
  const crossAudience = await fetch(`${canonicalUrl}/api/v1/me`, {
    headers: { authorization: `Bearer ${tokens.access_token}`, 'x-maestrly-protocol-version': '1.0' },
  })
  check(crossAudience.status === 401, `The MCP token must not be accepted by the REST API (got ${crossAudience.status}).`)

  let rpcId = 0
  const mcp = async (method, params) => {
    const response = await fetch(`${canonicalUrl}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${tokens.access_token}`,
        'x-maestrly-organization-id': organizationId,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
    })
    const body = await response.json()
    if (body.error) throw new Error(`${method} failed: ${body.error.message}`)
    return body.result
  }
  const tool = async (name, args) => {
    const result = await mcp('tools/call', { name, arguments: args })
    if (result.isError) throw new Error(`${name} failed: ${result.content?.[0]?.text ?? 'unknown error'}`)
    return result.structuredContent
  }

  const initialized = await mcp('initialize', { protocolVersion: '2025-06-18' })
  check(initialized.serverInfo?.name === 'maestrly', 'The MCP endpoint did not identify itself as Maestrly.')
  const catalog = await mcp('tools/list')
  const toolNames = catalog.tools.map((entry) => entry.name)
  for (const required of ['maestrly_list_projects', 'maestrly_list_executors', 'maestrly_create_task', 'maestrly_wait_task', 'maestrly_follow_up'])
    check(toolNames.includes(required), `The catalog is missing ${required}.`)

  const projects = await tool('maestrly_list_projects', {})
  check(projects.projects.length === 1 && projects.projects[0].projectId === projectId, 'The agent must see exactly the granted project.')

  // ---- The executor computer registers and publishes what it can actually run -------------------------
  const enrollment = await api('POST', '/api/v1/runner-enrollments', { organizationId, projectIds: [projectId] })
  const executor = await api('POST', '/api/v1/runners/enroll', {
    organizationId,
    token: enrollment.token,
    name: 'Studio MacBook',
    protocolVersion: '1.0',
    capabilities: [{ name: 'executor:maestrly' }],
    maxConcurrency: 2,
  })
  const runnerHeaders = {
    'content-type': 'application/json',
    'x-maestrly-protocol-version': '1.0',
    'x-maestrly-organization-id': organizationId,
    'x-maestrly-runner-id': executor.runnerId,
    authorization: `Runner ${executor.credential}`,
  }
  const runner = async (method, path, body) => {
    const response = await fetch(`${canonicalUrl}${path}`, {
      method,
      headers: { ...runnerHeaders, 'idempotency-key': randomUUID() },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await response.text()
    if (!response.ok) throw new Error(`${method} ${path} → ${response.status} ${text.slice(0, 300)}`)
    return text ? JSON.parse(text) : null
  }
  const selections = [
    { selectionId: 'sel-opus', modelLabel: 'claude-opus-5', accountLabel: 'Claude · personal', efforts: ['medium', 'high'], fastMode: false, executionModes: ['standard'], delegationProfiles: [], harnessProfileId: null, harnessHash: null },
    { selectionId: 'sel-astra', modelLabel: 'gpt-6-astra', accountLabel: 'OpenAI · work', efforts: ['low'], fastMode: true, executionModes: ['standard'], delegationProfiles: [], harnessProfileId: null, harnessHash: null },
  ]
  await runner('POST', '/api/v1/runners/delegations/inventory', {
    capability: 'delegation:stages:v1',
    enabled: true,
    revision: 'e2e'.padEnd(32, '0'),
    generatedAt: new Date().toISOString(),
    workspaces: [{ projectId, key: 'ws-main', label: 'maestrly', branches: ['main'], repositoryBindingId: null }],
    models: selections,
    features: {
      checks: [],
      github: { available: true, login: 'octocat', issue: null },
      preview: { available: false, issue: null },
      maestro: false,
      subagents: false,
      browserInspect: false,
      browserInteract: false,
    },
    issues: [],
  })

  // ---- The agent reads what is available and delegates the work ---------------------------------------
  const executors = await tool('maestrly_list_executors', { projectId })
  const advertised = executors.executors[0]
  check(advertised?.catalog.models.map((model) => model.selectionId).join(',') === 'sel-opus,sel-astra', 'The agent must see the exact selections the computer published.')

  const created = await tool('maestrly_create_task', {
    projectId,
    idempotencyKey: randomUUID(),
    task: {
      boardId: project.boardId,
      title: 'Add the delegation panel',
      objective: 'Ship the panel behind the existing capability.',
      acceptanceCriteria: ['The panel lists stages'],
      executorId: advertised.executorId,
      workspaceKey: 'ws-main',
      baseBranch: 'main',
      policy: { requireReview: false, completionTarget: 'patch_ready' },
      stages: [
        {
          type: 'implement',
          title: 'Implement the panel',
          instructions: 'Write it.',
          dependsOn: [],
          requiredForCompletion: true,
          settings: { selectionId: 'sel-opus', reasoning: 'high' },
        },
      ],
      dependsOnTaskIds: [],
      start: true,
    },
  })
  const taskId = created.task.id
  check(created.task.state === 'queued', `A task asked to start must be queued, not ${created.task.state}.`)
  check(created.stages[0].settings.selectionId === 'sel-opus' && created.stages[0].settings.reasoning === 'high', 'The stage must keep the exact configuration it was given.')

  // An effort the selection does not offer is refused instead of being approximated.
  let refused = null
  try {
    await tool('maestrly_configure_task', {
      projectId,
      taskId,
      expectedVersion: created.task.version,
      target: 'task_defaults',
      settingsPatch: { selectionId: 'sel-astra', reasoning: 'high' },
      idempotencyKey: randomUUID(),
    })
  } catch (error) {
    refused = error.message
  }
  check(refused && /reasoning effort/i.test(refused), 'Switching to a model without the current effort must be refused.')

  // The person changes their mind while it runs: one more stage, from the agent.
  const view = await tool('maestrly_get_task', { projectId, taskId })
  await tool('maestrly_follow_up', {
    projectId,
    taskId,
    expectedVersion: view.task.version,
    text: 'Also update the tests that cover the panel.',
    idempotencyKey: randomUUID(),
  })

  // ---- The executor performs the stages ---------------------------------------------------------------
  let performed = 0
  await waitFor(
    'the executor to finish every stage',
    async () => {
      const claim = await runner('POST', '/api/v1/runners/delegations/claim', {})
      if (claim?.delegation) {
        const admitted = claim.delegation.snapshot.settings
        check(!!admitted?.selectionId, 'A claimed stage must carry the configuration it was admitted with.')
        const selection = selections.find((entry) => entry.selectionId === admitted.selectionId)
        check(!!selection, `The executor was asked for an unknown selection ${admitted.selectionId}.`)
        await runner('POST', `/api/v1/runners/delegations/attempts/${claim.delegation.attemptId}/receipt`, {
          leaseId: claim.turn.leaseId,
          receipt: {
            requested: admitted,
            admitted,
            observed: {
              selectionId: selection.selectionId,
              modelId: selection.modelLabel,
              accountLabel: selection.accountLabel,
              reasoning: admitted.reasoning,
              fastMode: admitted.fastMode,
              harnessProfileId: null,
              harnessHash: null,
            },
            selectionHonored: true,
            conversationId: `conversation-${performed}`,
            result: 'succeeded',
            summary: 'Stage performed by the homologation executor.',
          },
          codeRevision: {
            id: randomUUID(),
            baseCommit: 'a'.repeat(40),
            headCommit: 'b'.repeat(40),
            contentDigest: `digest-${performed}`.padEnd(64, '0'),
            snapshotArtifactId: null,
            capturedAt: new Date().toISOString(),
          },
        })
        await runner('POST', `/api/v1/runners/chat/turns/${claim.turn.id}/complete`, {
          leaseId: claim.turn.leaseId,
          state: 'succeeded',
          error: null,
        })
        performed += 1
      }
      const current = await tool('maestrly_get_task', { projectId, taskId })
      if (['completed', 'needs_attention', 'failed'].includes(current.task.state)) return current
      return null
    },
    { timeoutMs: 120_000, intervalMs: 1_000 }
  )

  const finished = await tool('maestrly_get_task', { projectId, taskId })
  check(finished.task.state === 'completed', `The task should have completed; it is ${finished.task.state}: ${JSON.stringify(finished.task.blocker)}`)
  check(performed === 2, `Both the original stage and the follow-up should have run; ${performed} did.`)
  check(finished.attempts.every((attempt) => attempt.receipt?.selectionHonored), 'Every attempt must record that the selection was honored.')

  // The timeline the agent reads is the durable one, and waiting reports a timeout instead of blocking.
  const events = await tool('maestrly_read_events', { projectId, taskId, cursor: 0 })
  const types = events.events.map((event) => event.type)
  for (const required of ['task.created', 'task.started', 'task.follow_up', 'stage.finished', 'task.completed'])
    check(types.includes(required), `The timeline is missing ${required}: ${types.join(', ')}`)
  const waited = await tool('maestrly_wait_task', { projectId, taskId, cursor: events.cursor, timeoutSeconds: 2 })
  check(waited.timedOut && waited.state === 'completed', 'Waiting past the last event must report a timeout with the current state.')

  // ---- The routine is notified, and can verify the delivery itself ------------------------------------
  const notification = await waitFor(
    'the routine callback to receive the completion',
    async () => received.find((entry) => entry.headers['x-maestrly-event'] === 'task.completed'),
    { timeoutMs: 60_000, intervalMs: 500 }
  )
  const signature = String(notification.headers['x-maestrly-signature'])
  const [stamp, digest] = signature.split(',')
  const expected = createHmac('sha256', callbackSecret).update(`${stamp.slice(2)}.`).update(notification.raw).digest('hex')
  check(digest === `v1=${expected}`, 'The callback signature must cover the exact bytes delivered.')
  const payload = JSON.parse(notification.raw.toString('utf8'))
  check(payload.taskId === taskId && payload.state === 'completed', 'The notification must describe the task that completed.')
  check(payload.url.includes(`delegation=${taskId}`), 'The notification must carry a link a person can open.')

  // ---- Revoking the connection stops the agent immediately --------------------------------------------
  await api('PATCH', `/api/v1/organizations/${organizationId}/connectors/${connection.id}`, {
    expectedVersion: connection.version,
    revoked: true,
  })
  const afterRevoke = await fetch(`${canonicalUrl}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${tokens.access_token}`,
      'x-maestrly-organization-id': organizationId,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 999, method: 'tools/list' }),
  })
  check(afterRevoke.status === 403, `A revoked connection must be refused (got ${afterRevoke.status}).`)

  await new Promise((resolve) => callback.close(resolve))
  process.stdout.write(
    `[grok-connector-e2e] delegated over MCP, adjusted mid-flight, executed ${performed} stages, completed, notified and revoked.\n`
  )
}

try {
  await main()
} finally {
  if (server && !server.killed) server.kill('SIGTERM')
  if (postgres) spawnSync('docker', ['stop', container], { stdio: 'ignore' })
}
