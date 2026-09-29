import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { harness } from './harness.js'
import { InstanceClient } from '../src/instance.js'
import { Logger } from '../src/logger.js'

beforeEach(() => {
  vi.spyOn(Logger.prototype, 'log')
})
afterEach(() => {
  vi.restoreAllMocks()
})

const secret = 'synthetic-provisioning-secret'
const accounts = { items: [{ type: 'api-key', name: 'Test', kind: 'openai', baseURL: null, key: secret }] }
const skill = { name: 'x', files: [{ path: 'SKILL.md', data: 'eA==', executable: false }] }
const mcp = { servers: [{ name: 'Test', transport: 'stdio', enabled: true, command: 'node', env: { TOKEN: secret } }] }
const start = { kind: 'claude', method: 'browser', slot: 'auto' }
const routes: Array<[string, string, unknown?]> = [
  ['GET', '/accounts'],
  ['POST', '/accounts/import', accounts],
  ['DELETE', '/subscriptions/codex/default'],
  ['POST', '/logins', start],
  ['GET', '/logins/login-test'],
  ['POST', '/logins/login-test/callback', { path: '/callback', query: 'code=' + secret }],
  ['POST', '/logins/login-test/code', { code: secret }],
  ['DELETE', '/logins/login-test'],
  ['GET', '/skills'],
  ['POST', '/skills', skill],
  ['DELETE', '/skills/x'],
  ['GET', '/mcp-servers'],
  ['POST', '/mcp-servers/import', mcp],
  ['DELETE', '/mcp-servers/m1'],
]
type Harness = Awaited<ReturnType<typeof harness>>
const configured = (h: Harness) => h.store.activity().filter((entry) => entry.kind === 'bot_configured')
function noSecrets(h: Harness) {
  expect(JSON.stringify(h.store.activity())).not.toContain(secret)
  expect(JSON.stringify(vi.mocked(Logger.prototype.log).mock.calls)).not.toContain(secret)
  expect(h.store.db.prepare('SELECT * FROM idempotency').all()).toEqual([])
}

it('discovers provisioning on the gateway and the live bot', async () => {
  const h = await harness()
  expect((await (await h.request('GET', '/v1/meta')).json()).features).toEqual([
    'provisioning',
    'environments',
    'environment-compaction',
    'environment-updates',
  ])
  expect((await (await h.request('GET', '/v1/bots/' + h.bot.id)).json()).capabilities).toEqual(['provisioning'])
})

it('proxies all inventories without recording activity', async () => {
  const h = await harness()
  for (const [path, result] of [
    ['/accounts', { apiKeys: [], subscriptions: [] }],
    ['/skills', { skills: [] }],
    ['/mcp-servers', { servers: [] }],
  ] as const) {
    const response = await h.request('GET', '/v1/bots/' + h.bot.id + path)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(result)
    expect(h.instance.provisioningRequests.at(-1)).toEqual({ method: 'GET', path: '/v1' + path, body: undefined })
  }
  expect(configured(h)).toEqual([])
})

it('forwards account credentials verbatim and records only successful counts and the device name', async () => {
  const h = await harness()
  const response = await h.request('POST', '/v1/bots/' + h.bot.id + '/accounts/import', accounts)
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual(h.instance.provisioning.results)
  expect(h.instance.provisioningRequests.at(-1)?.body).toEqual(accounts)
  expect(configured(h)).toEqual([
    expect.objectContaining({
      summary: 'Mac',
      data: { accounts: 1, skills: 0, mcpServers: 0, removed: 0 },
    }),
  ])
  noSecrets(h)
})

it('records no activity for unchanged or failed imports and skill installs', async () => {
  const h = await harness()
  for (const outcome of ['unchanged', 'failed'] as const) {
    h.instance.provisioning.results.results[0].outcome = outcome
    for (const [path, body] of [
      ['/accounts/import', accounts],
      ['/mcp-servers/import', mcp],
    ] as const) {
      expect((await h.request('POST', '/v1/bots/' + h.bot.id + path, body)).status).toBe(200)
    }
  }
  h.instance.provisioning.skill.outcome = 'unchanged'
  expect((await h.request('POST', '/v1/bots/' + h.bot.id + '/skills', skill)).status).toBe(200)
  expect(configured(h)).toEqual([])
  noSecrets(h)
})

it('counts changed MCP imports and skill installs without exposing secrets', async () => {
  const h = await harness()
  h.instance.provisioning.results.results = [
    { index: 0, target: 'm1', outcome: 'updated', error: null },
    { index: 1, target: null, outcome: 'failed', error: secret },
    { index: 2, target: 'm2', outcome: 'unchanged', error: null },
  ]
  const response = await h.request('POST', '/v1/bots/' + h.bot.id + '/mcp-servers/import', mcp)
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual(h.instance.provisioning.results)
  expect(h.instance.provisioningRequests.at(-1)?.body).toEqual(mcp)
  for (const outcome of ['added', 'updated']) {
    h.instance.provisioning.skill.outcome = outcome
    expect((await h.request('POST', '/v1/bots/' + h.bot.id + '/skills', skill)).status).toBe(200)
  }
  expect(configured(h).map((entry) => entry.data)).toEqual([
    { accounts: 0, skills: 0, mcpServers: 1, removed: 0 },
    { accounts: 0, skills: 1, mcpServers: 0, removed: 0 },
    { accounts: 0, skills: 1, mcpServers: 0, removed: 0 },
  ])
  noSecrets(h)
})

it('allows a 9 MiB skill body, rejects 13 MiB, and retains 1 MiB on every other new body route', async () => {
  const h = await harness()
  const largeSkill = (size: number) => ({
    name: 'x',
    files: Array.from({ length: 3 }, (_, i) => ({
      path: 'file-' + i,
      data: 'A'.repeat(size / 3),
      executable: false,
    })),
  })
  const accepted = largeSkill(9 * 1024 * 1024)
  expect((await h.request('POST', '/v1/bots/' + h.bot.id + '/skills', accepted)).status).toBe(200)
  expect(h.instance.provisioningRequests.at(-1)?.body).toEqual(accepted)
  const oversized = await h.request('POST', '/v1/bots/' + h.bot.id + '/skills', largeSkill(13 * 1024 * 1024 + 2))
  expect(oversized.status).toBe(400)
  expect(await oversized.json()).toMatchObject({ code: 'INVALID_REQUEST', message: 'Request body too large' })
  for (const [method, path, body] of routes.filter(([method, path]) => method === 'POST' && path !== '/skills')) {
    const response = await h.request(method, '/v1/bots/' + h.bot.id + path, {
      ...(body as object),
      padding: 'x'.repeat(1024 * 1024),
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ message: 'Request body too large' })
  }
  expect(h.instance.provisioningRequests).toHaveLength(1)
})

it('proxies login start, polling, callback, code and cancellation without activity or persistence', async () => {
  const h = await harness()
  for (const [method, path, body] of routes.filter(([, path]) => path.startsWith('/logins'))) {
    const response = await h.request(method, '/v1/bots/' + h.bot.id + path, body)
    expect(response.status).toBe(method === 'DELETE' ? 204 : 200)
    if (method !== 'DELETE')
      expect(await response.json()).toEqual(
        path.endsWith('/callback') ? h.instance.provisioning.callback : h.instance.provisioning.login
      )
    expect(h.instance.provisioningRequests.at(-1)).toEqual({ method, path: '/v1' + path, body })
  }
  expect(configured(h)).toEqual([])
  noSecrets(h)
})

it('proxies removals and records a count only after success', async () => {
  const h = await harness()
  for (const [method, path] of routes.filter(([method, path]) => method === 'DELETE' && !path.startsWith('/logins'))) {
    expect((await h.request(method, '/v1/bots/' + h.bot.id + path)).status).toBe(204)
    expect(h.instance.provisioningRequests.at(-1)).toEqual({ method, path: '/v1' + path, body: undefined })
  }
  expect(configured(h).map((entry) => entry.data)).toEqual(
    Array(3).fill({ accounts: 0, skills: 0, mcpServers: 0, removed: 1 })
  )
  h.instance.provisioning.failure = { code: 'CONFLICT', message: 'Synthetic failure' }
  for (const [method, path, body] of routes.filter(([method]) => method !== 'GET')) {
    expect((await h.request(method, '/v1/bots/' + h.bot.id + path, body)).status).toBe(409)
  }
  expect(configured(h)).toHaveLength(3)
  noSecrets(h)
})

it('rejects every new route for bots lacking provisioning, stopped or archived bots, and bot tokens', async () => {
  const h = await harness()
  h.instance.provisioning.capabilities.length = 0
  h.lifecycle.statuses.get(h.bot.id)!.capabilities = []
  for (const [method, path, body] of routes) {
    const response = await h.request(method, '/v1/bots/' + h.bot.id + path, body)
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({
      code: 'CONFLICT',
      message: 'Restart this bot to update it before configuring it from the Mac.',
    })
    expect((await h.request(method, '/v1/bots/' + h.bot.id + path, body, false, h.botHeaders())).status).toBe(401)
  }
  await h.lifecycle.stop(h.bot.id)
  for (const [method, path, body] of routes) {
    const response = await h.request(method, '/v1/bots/' + h.bot.id + path, body)
    expect(response.status).toBe(409)
    expect((await response.json()).code).toBe('BOT_NOT_RUNNING')
  }
  await h.lifecycle.archive(h.bot.id)
  for (const [method, path, body] of routes)
    expect((await h.request(method, '/v1/bots/' + h.bot.id + path, body)).status).toBe(404)
  expect(h.instance.provisioningRequests).toEqual([])
})

it('keeps the existing instance path when a running bot has no cached status', async () => {
  const h = await harness()
  h.lifecycle.statuses.delete(h.bot.id)
  const response = await h.request('GET', '/v1/bots/' + h.bot.id + '/accounts')
  expect(response.status).toBe(200)
  expect(h.instance.provisioningRequests).toHaveLength(1)
})

it('uses per-call timeouts without changing the default for subsequent calls', async () => {
  const timer = vi.spyOn(globalThis, 'setTimeout')
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(null, { status: 204 }))
  try {
    const client = new InstanceClient('test', 'control')
    // An empty answer is no login, skill or account list: each call fails, after waiting its own time.
    const empty = { code: 'INSTANCE_UNAVAILABLE', message: 'Invalid bot instance response' }
    await expect(client.loginStart({ kind: 'claude', method: 'browser', slot: 'auto' })).rejects.toMatchObject(empty)
    expect(timer.mock.calls.at(-1)?.[1]).toBe(30000)
    await expect(client.skillInstall(skill)).rejects.toMatchObject(empty)
    expect(timer.mock.calls.at(-1)?.[1]).toBe(60000)
    await expect(client.accountsList()).rejects.toMatchObject(empty)
    expect(timer.mock.calls.at(-1)?.[1]).toBe(15000)
  } finally {
    timer.mockRestore()
    fetchMock.mockRestore()
  }
})
