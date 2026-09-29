import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { fleetActivityEntrySchema, fleetActivityKindSchema } from '@maestrly/bot-fleet-protocol'
import { z } from 'zod'
import type { FakeDockerDriver } from '../src/docker.js'
import { Logger } from '../src/logger.js'
import { harness } from './harness.js'

type Harness = Awaited<ReturnType<typeof harness>>
const GiB = 1024 ** 3
const secret = 'synthetic-environment-secret'
beforeEach(() => {
  vi.spyOn(Logger.prototype, 'log')
})
afterEach(() => {
  vi.restoreAllMocks()
})
async function until(test: () => boolean) {
  for (let i = 0; i < 300; i++) {
    if (test()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Timed out')
}
const json = async (response: Response): Promise<any> => response.json()
const running = (h: Harness, ...ids: string[]) =>
  until(() => ids.every((id) => h.lifecycle.get(id)?.lifecycle === 'running'))
const botRequest = (name: string, placement: object = {}) => ({
  name,
  instructions: '',
  ceiling: 'ask',
  talksTo: [],
  idempotencyKey: randomUUID(),
  ...placement,
})
async function createBot(h: Harness, name: string, placement: object = {}) {
  const response = await h.request('POST', '/v1/bots', botRequest(name, placement))
  expect(response.status).toBe(201)
  const bot = (await response.json()) as { id: string; environmentId: string }
  await running(h, bot.id)
  return bot
}
const configured = (h: Harness) => h.store.activity().filter((entry) => entry.kind === 'bot_configured')
function noSecrets(h: Harness) {
  expect(JSON.stringify(h.store.activity())).not.toContain(secret)
  expect(JSON.stringify(vi.mocked(Logger.prototype.log).mock.calls)).not.toContain(secret)
  expect(h.store.db.prepare('SELECT * FROM idempotency').all()).toEqual([])
}
const accounts = { items: [{ type: 'api-key', name: 'Test', kind: 'openai', baseURL: null, key: secret }] }
const skill = { name: 'x', files: [{ path: 'SKILL.md', data: 'eA==', executable: false }] }
const mcp = { servers: [{ name: 'Test', transport: 'stdio', enabled: true, command: 'node', env: { TOKEN: secret } }] }
const routes: Array<[string, string, unknown?]> = [
  ['GET', '/accounts'],
  ['POST', '/accounts/import', accounts],
  ['DELETE', '/subscriptions/codex/default'],
  ['POST', '/logins', { kind: 'claude', method: 'browser', slot: 'auto' }],
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

describe('environment routes', () => {
  it('advertises environments and creates, lists, renames and limits environments', async () => {
    const h = await harness(Date.now, { environments: true })
    const docker = h.lifecycle.docker as FakeDockerDriver
    expect((await json(await h.request('GET', '/v1/meta'))).features).toEqual([
      'provisioning',
      'environments',
      'environment-compaction',
      'environment-updates',
      'context-limit',
    ])
    const request = { name: 'Archived', idempotencyKey: randomUUID() }
    const created = await h.request('POST', '/v1/environments', request)
    expect(created.status).toBe(201)
    expect(await created.json()).toMatchObject({
      id: 'archived',
      name: 'Archived',
      lifecycle: 'creating',
      memoryLimitBytes: null,
      botIds: [],
    })
    // Replaying the request gives the same environment.
    const replay = await h.request('POST', '/v1/environments', request)
    expect(replay.status).toBe(201)
    expect((await replay.json()).id).toBe('archived')
    await until(() => h.lifecycle.environment('archived')?.lifecycle === 'running')
    // An environment named "archived" does not collide with the archived collection.
    expect((await json(await h.request('GET', '/v1/environments/archived'))).name).toBe('Archived')
    expect((await json(await h.request('GET', '/v1/archived-environments'))).environments).toEqual([])
    const list = await json(await h.request('GET', '/v1/environments'))
    expect(list.environments.map((item: { id: string }) => item.id)).toEqual(['test', 'archived'])
    expect(list.environments[0]).toMatchObject({
      botIds: [h.bot.id],
      lifecycle: 'running',
      capabilities: ['provisioning', 'environments'],
    })
    const patched = await h.request('PATCH', '/v1/environments/archived', {
      name: 'Company',
      memoryLimitBytes: 8 * GiB,
    })
    expect(patched.status).toBe(200)
    expect(await patched.json()).toMatchObject({ id: 'archived', name: 'Company', memoryLimitBytes: 8 * GiB })
    expect(docker.memoryUpdates).toEqual([{ id: 'fake-maestrly-env-archived', memory: 8 * GiB }])
    expect((await h.request('PATCH', '/v1/environments/archived', { memoryLimitBytes: 1024 })).status).toBe(400)
    expect((await h.request('PATCH', '/v1/environments/archived', {})).status).toBe(400)
    expect((await h.request('GET', '/v1/environments/missing')).status).toBe(404)
    expect((await h.request('PATCH', '/v1/environments/missing', { name: 'X' })).status).toBe(404)
    expect(
      (await h.request('POST', '/v1/environments', { name: 'X', memoryLimitBytes: 1, idempotencyKey: randomUUID() }))
        .status
    ).toBe(400)
    expect((await h.request('GET', '/v1/environments', undefined, false, h.botHeaders())).status).toBe(401)
    expect(h.store.activity().filter((entry) => entry.kind === 'environment_created')).toEqual([
      expect.objectContaining({ botId: null, environmentId: 'archived', summary: 'Archived' }),
    ])
  })

  it('schedules, cancels and forces an environment update', async () => {
    const h = await harness(Date.now, { environments: true })
    const path = '/v1/environments/test/update'
    const image = 'sha256:' + 'c'.repeat(64)
    const current = await json(await h.request('POST', path, { when: 'idle' }))
    expect(current.update).toEqual({ available: false, pendingSince: null })
    h.docker.setImage(h.lifecycle.config.botImage, image)
    const status = h.lifecycle.statuses.get(h.bot.id)!
    status.turn = { ...status.turn, state: 'running' }

    const scheduled = await h.request('POST', path, { when: 'idle' })
    expect(scheduled.status).toBe(200)
    const pending = await json(scheduled)
    expect(pending.update).toEqual({ available: true, pendingSince: expect.any(String) })
    expect((await json(await h.request('GET', '/v1/environments/test'))).update).toEqual(pending.update)
    const cancelled = await h.request('DELETE', path)
    expect(cancelled.status).toBe(200)
    expect((await json(cancelled)).update).toEqual({ available: true, pendingSince: null })

    const invalid = await h.request('POST', path, { when: 'later' })
    expect(invalid.status).toBe(400)
    expect((await json(invalid)).code).toBe('INVALID_REQUEST')
    expect((await json(await h.request('POST', '/v1/environments/missing/update', { when: 'idle' }))).code).toBe(
      'NOT_FOUND'
    )
    expect((await json(await h.request('DELETE', '/v1/environments/missing/update'))).code).toBe('NOT_FOUND')

    await h.request('POST', path, { when: 'idle' })
    const now = await h.request('POST', path, { when: 'now' })
    expect(now.status).toBe(200)
    expect(await json(now)).toMatchObject({ lifecycle: 'running', update: { available: false, pendingSince: null } })
    const name = h.store.getEnvironment('test')!.containerName
    expect([...h.docker.containers.values()].find((item) => item.name === name)?.imageId).toBe(image)

    await h.request('POST', '/v1/environments/test/stop')
    const stopped = await h.request('POST', path, { when: 'idle' })
    expect((await json(stopped)).code).toBe('BOT_NOT_RUNNING')
  })

  it('creates bots in a new, a named or an existing environment, up to eight in one', async () => {
    const h = await harness(Date.now, { environments: true })
    const docker = h.lifecycle.docker as FakeDockerDriver
    const ads = await createBot(h, 'Ads', { environment: { name: 'Work' } })
    expect(ads.environmentId).toBe('work')
    expect(h.lifecycle.environment('work')?.name).toBe('Work')
    const scout = await createBot(h, 'Scout', { environmentId: 'work' })
    expect(scout.environmentId).toBe('work')
    // Older Macs name no environment: the bot gets one of its own, named after it.
    const cleo = await createBot(h, 'Cleo')
    expect(cleo.environmentId).toBe('cleo')
    expect(h.lifecycle.environment('cleo')?.name).toBe('Cleo')
    expect(
      (await h.request('POST', '/v1/bots', botRequest('Both', { environmentId: 'work', environment: { name: 'X' } })))
        .status
    ).toBe(400)
    expect((await h.request('POST', '/v1/bots', botRequest('Lost', { environmentId: 'missing' }))).status).toBe(404)
    for (let slot = 3; slot <= 8; slot++) await createBot(h, 'Bot ' + slot, { environmentId: 'work' })
    const full = await h.request('POST', '/v1/bots', botRequest('Ninth', { environmentId: 'work' }))
    expect(full.status).toBe(409)
    expect(await full.json()).toMatchObject({ code: 'CONFLICT', message: 'This environment already has 8 bots.' })
    expect(h.lifecycle.environment('work')?.botIds).toHaveLength(8)
    expect([...docker.containers.values()].map((item) => item.name).sort()).toEqual([
      'maestrly-env-cleo',
      'maestrly-env-test',
      'maestrly-env-work',
    ])
    const bots = (await json(await h.request('GET', '/v1/bots'))).bots as Array<{
      id: string
      environmentId: string
      resources: { memoryBytes: number | null }
    }>
    expect(bots.find((bot) => bot.id === ads.id)?.environmentId).toBe('work')
  })

  it("answers a shared bot's own start, stop and restart with CONFLICT and acts on a bot alone", async () => {
    const h = await harness(Date.now, { environments: true })
    const scout = await createBot(h, 'Scout', { environmentId: 'test' })
    for (const command of ['start', 'stop', 'restart']) {
      const response = await h.request('POST', `/v1/bots/${scout.id}/${command}`)
      expect(response.status).toBe(409)
      expect(await response.json()).toMatchObject({
        code: 'CONFLICT',
        message: 'This bot shares its environment. Restart the environment instead.',
      })
    }
    const stopped = await h.request('POST', '/v1/environments/test/stop')
    expect(stopped.status).toBe(200)
    expect((await stopped.json()).lifecycle).toBe('stopped')
    expect(h.lifecycle.get(scout.id)?.lifecycle).toBe('stopped')
    expect((await json(await h.request('POST', '/v1/environments/test/start'))).lifecycle).toBe('running')
    await running(h, h.bot.id, scout.id)
    expect((await json(await h.request('POST', '/v1/environments/test/restart'))).lifecycle).toBe('running')
    await running(h, h.bot.id, scout.id)
    const other = await createBot(h, 'Other', { environment: { name: 'Home' } })
    expect((await json(await h.request('POST', `/v1/bots/${other.id}/stop`))).lifecycle).toBe('stopped')
    expect(h.lifecycle.environment('home')?.lifecycle).toBe('stopped')
    expect((await json(await h.request('POST', `/v1/bots/${other.id}/start`))).lifecycle).toBe('running')
    expect((await h.request('POST', '/v1/environments/missing/restart')).status).toBe(404)
    expect(
      h.store
        .activity()
        .filter((entry) => entry.kind.startsWith('environment_'))
        .map((entry) => [entry.kind, entry.botId, entry.environmentId])
    ).toEqual([
      ['environment_stopped', null, 'test'],
      ['environment_started', null, 'test'],
      ['environment_restarted', null, 'test'],
    ])
  })

  it('archives, lists, restores and deletes environments in their own collection', async () => {
    let now = Date.parse('2026-09-26T10:00:00.000Z')
    const h = await harness(() => now, { environments: true })
    const scout = await createBot(h, 'Scout', { environmentId: 'test' })
    const routine = await json(
      await h.request('POST', `/v1/bots/${scout.id}/routines`, {
        title: 'Check',
        prompt: 'Check',
        schedule: { kind: 'interval', everyMinutes: 30 },
        enabled: true,
        idempotencyKey: randomUUID(),
      })
    )
    expect(routine.nextRunAt).toBe('2026-09-26T10:30:00.000Z')
    const archived = await h.request('POST', '/v1/environments/test/archive')
    expect(archived.status).toBe(200)
    expect((await archived.json()).lifecycle).toBe('archived')
    expect((await json(await h.request('GET', '/v1/bots'))).bots).toEqual([])
    expect((await json(await h.request('GET', '/v1/environments'))).environments).toEqual([])
    expect((await json(await h.request('GET', '/v1/archived-bots'))).bots).toEqual([])
    expect((await json(await h.request('GET', '/v1/archived-environments'))).environments).toEqual([
      expect.objectContaining({
        id: 'test',
        name: 'Test',
        files: 'kept',
        bots: [expect.objectContaining({ id: h.bot.id }), expect.objectContaining({ id: scout.id })],
      }),
    ])
    expect((await h.request('GET', '/v1/environments/test')).status).toBe(404)
    for (const [method, route] of [
      ['POST', `/v1/archived-bots/${scout.id}/restore`],
      ['DELETE', `/v1/archived-bots/${scout.id}`],
    ] as const) {
      const response = await h.request(method, route)
      expect(response.status).toBe(409)
      expect((await response.json()).message).toBe('Restore its environment first')
    }
    now = Date.parse('2026-09-28T09:00:00.000Z')
    const restored = await h.request('POST', '/v1/archived-environments/test/restore')
    expect(restored.status).toBe(200)
    expect(await restored.json()).toMatchObject({ id: 'test', lifecycle: 'creating' })
    expect((await h.request('POST', '/v1/archived-environments/test/restore')).status).toBe(404)
    await running(h, h.bot.id, scout.id)
    // Its bots' routines resume from the restore instead of replaying what they missed.
    expect(h.store.routineById(routine.id)?.nextRunAt).toBe('2026-09-28T09:30:00.000Z')
    expect((await h.request('DELETE', '/v1/archived-environments/test')).status).toBe(404)
    expect((await h.request('POST', '/v1/environments/test/archive')).status).toBe(200)
    expect((await h.request('DELETE', '/v1/archived-environments/test')).status).toBe(204)
    expect((await h.request('DELETE', '/v1/archived-environments/test')).status).toBe(404)
    expect((await json(await h.request('GET', '/v1/archived-environments'))).environments).toEqual([])
    expect(h.store.getBot(scout.id)).toBeNull()
    expect(h.store.activity().map((entry) => [entry.kind, entry.environmentId])).toEqual(
      expect.arrayContaining([['environment_deleted', 'test']])
    )
  })

  it('configures an environment through its own routes and through its bots, counting on the environment', async () => {
    const h = await harness(Date.now, { environments: true })
    for (const [method, path, body] of routes) {
      const response = await h.request(method, '/v1/environments/test' + path, body)
      expect(response.status, method + ' ' + path).toBe(method === 'DELETE' ? 204 : 200)
      expect(h.instance.provisioningRequests.at(-1)).toEqual({ method, path: '/v1' + path, body })
    }
    const added = await h.request('POST', '/v1/environments/test/accounts/api-key', {
      kind: 'openai',
      name: 'Fake model',
      key: secret,
      baseURL: null,
    })
    expect(added.status).toBe(201)
    expect(await added.text()).toBe(JSON.stringify({ providerId: 'prov_test' }))
    expect((await h.request('DELETE', '/v1/environments/test/accounts/prov_test')).status).toBe(204)
    expect((await h.request('POST', '/v1/environments/test/ui/open', { target: 'skills' })).status).toBe(204)
    expect(h.instance.uiOpens).toEqual([{ target: 'skills' }])
    expect(configured(h).map((entry) => [entry.botId, entry.environmentId, entry.summary, entry.data])).toEqual([
      [null, 'test', 'Mac', { accounts: 1, skills: 0, mcpServers: 0, removed: 0 }],
      [null, 'test', 'Mac', { accounts: 0, skills: 0, mcpServers: 0, removed: 1 }],
      [null, 'test', 'Mac', { accounts: 0, skills: 1, mcpServers: 0, removed: 0 }],
      [null, 'test', 'Mac', { accounts: 0, skills: 0, mcpServers: 0, removed: 1 }],
      [null, 'test', 'Mac', { accounts: 0, skills: 0, mcpServers: 1, removed: 0 }],
      [null, 'test', 'Mac', { accounts: 0, skills: 0, mcpServers: 0, removed: 1 }],
    ])
    // A bot's routes configure its environment, and record it there too.
    expect((await h.request('POST', `/v1/bots/${h.bot.id}/accounts/import`, accounts)).status).toBe(200)
    expect(configured(h).at(-1)).toMatchObject({ botId: null, environmentId: 'test', data: { accounts: 1 } })
    expect(h.instance.provisioningRequests.at(-1)).toEqual({
      method: 'POST',
      path: '/v1/accounts/import',
      body: accounts,
    })
    noSecrets(h)
    expect(h.instance.botRequests).toEqual([])
  })

  it('keeps the skill body limit and 1 MiB for other bodies, and refuses unknown or stopped environments', async () => {
    const h = await harness(Date.now, { environments: true })
    const largeSkill = (size: number) => ({
      name: 'x',
      files: Array.from({ length: 3 }, (_, i) => ({
        path: 'file-' + i,
        data: 'A'.repeat(size / 3),
        executable: false,
      })),
    })
    expect((await h.request('POST', '/v1/environments/test/skills', largeSkill(9 * 1024 * 1024))).status).toBe(200)
    const oversized = await h.request('POST', '/v1/environments/test/skills', largeSkill(13 * 1024 * 1024 + 2))
    expect(oversized.status).toBe(400)
    expect(await oversized.json()).toMatchObject({ message: 'Request body too large' })
    for (const [method, path, body] of routes.filter(([method, path]) => method === 'POST' && path !== '/skills')) {
      const response = await h.request(method, '/v1/environments/test' + path, {
        ...(body as object),
        padding: 'x'.repeat(1024 * 1024),
      })
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ message: 'Request body too large' })
    }
    expect(h.instance.provisioningRequests).toHaveLength(1)
    for (const [method, path, body] of routes) {
      expect((await h.request(method, '/v1/environments/missing' + path, body)).status).toBe(404)
      expect((await h.request(method, '/v1/environments/test' + path, body, false, h.botHeaders())).status).toBe(401)
    }
    await h.lifecycle.stopEnvironment('test')
    for (const [method, path, body] of routes) {
      const response = await h.request(method, '/v1/environments/test' + path, body)
      expect(response.status).toBe(409)
      expect((await response.json()).code).toBe('BOT_NOT_RUNNING')
    }
    expect(h.instance.provisioningRequests).toHaveLength(1)
  })

  it('issues screen tickets for bot surfaces and for the environment screen without a takeover', async () => {
    const h = await harness(Date.now, { environments: true })
    for (const body of [{ mode: 'view' }, { mode: 'view', surface: 'browser' }, { mode: 'view', surface: 'apps' }]) {
      const response = await h.request('POST', `/v1/bots/${h.bot.id}/screen-tickets`, body)
      expect(response.status).toBe(201)
      expect((await response.json()).path).toMatch(/^\/v1\/screen\?ticket=/)
    }
    expect(
      (await h.request('POST', `/v1/bots/${h.bot.id}/screen-tickets`, { mode: 'view', surface: 'desk' })).status
    ).toBe(400)
    expect(
      (await h.request('POST', `/v1/bots/${h.bot.id}/screen-tickets`, { mode: 'control', surface: 'apps' })).status
    ).toBe(403)
    const control = await h.request('POST', '/v1/environments/test/screen-tickets', { mode: 'control' })
    expect(control.status).toBe(201)
    expect((await control.json()).path).toMatch(/^\/v1\/screen\?ticket=/)
    expect((await h.request('POST', '/v1/environments/missing/screen-tickets', { mode: 'view' })).status).toBe(404)
    expect(
      (await h.request('POST', '/v1/environments/test/screen-tickets', { mode: 'view' }, false, h.botHeaders())).status
    ).toBe(401)
  })

  it('keeps an environment that predates environments to its one bot and its original configuration', async () => {
    const h = await harness()
    expect((await h.request('GET', '/v1/environments/test/accounts')).status).toBe(200)
    expect(h.instance.provisioningRequests.at(-1)).toMatchObject({ method: 'GET', path: '/v1/accounts' })
    const joined = await h.request('POST', '/v1/bots', botRequest('Pal', { environmentId: 'test' }))
    expect(joined.status).toBe(409)
    expect(await joined.json()).toMatchObject({
      code: 'CONFLICT',
      message: 'Restart this environment to update it before adding bots.',
    })
    for (const [route, body] of [
      ['/v1/environments/test/screen-tickets', { mode: 'view' }],
      [`/v1/bots/${h.bot.id}/screen-tickets`, { mode: 'view', surface: 'apps' }],
    ] as const) {
      const response = await h.request('POST', route, body)
      expect(response.status).toBe(409)
      expect((await response.json()).message).toBe('Restart this environment to update it before opening this screen.')
    }
    h.instance.provisioning.capabilities.length = 0
    h.lifecycle.statuses.get(h.bot.id)!.capabilities = []
    const refused = await h.request('GET', '/v1/environments/test/skills')
    expect(refused.status).toBe(409)
    expect(await refused.json()).toMatchObject({
      code: 'CONFLICT',
      message: 'Restart this environment to update it before configuring it from the Mac.',
    })
  })
})

describe('activity of environments', () => {
  it('leaves environment entries out of the activity history unless asked, for Macs that predate them', async () => {
    const h = await harness(Date.now, { environments: true })
    // The activity a Mac from before environments reads: every kind but the environments' own.
    const legacyHistory = z.object({
      entries: z.array(
        fleetActivityEntrySchema.extend({
          kind: fleetActivityKindSchema.exclude([
            'environment_created',
            'environment_started',
            'environment_stopped',
            'environment_restarted',
            'environment_archived',
            'environment_restored',
            'environment_deleted',
          ]),
        })
      ),
      lastSeq: z.number(),
    })
    const before = h.store.lastActivitySeq()
    for (let i = 0; i < 3; i++) expect((await h.request('POST', '/v1/environments/test/restart')).status).toBe(200)
    await running(h, h.bot.id)
    expect((await h.request('POST', `/v1/bots/${h.bot.id}/pause`)).status).toBe(200)
    const history = await json(await h.request('GET', `/v1/activity?after=${before}&limit=1`))
    expect(legacyHistory.safeParse(history).success).toBe(true)
    expect(history.entries).toEqual([expect.objectContaining({ kind: 'paused', botId: h.bot.id })])
    expect(history.lastSeq).toBe(h.store.lastActivitySeq())
    expect(legacyHistory.safeParse(await json(await h.request('GET', '/v1/activity'))).success).toBe(true)
    const everything = await json(await h.request('GET', `/v1/activity?after=${before}&includeEnvironmentActivity=1`))
    expect(everything.entries.map((entry: { kind: string }) => entry.kind)).toEqual([
      'environment_restarted',
      'environment_restarted',
      'environment_restarted',
      'paused',
    ])
    expect(legacyHistory.safeParse(everything).success).toBe(false)
  })
})

describe('owner memory in environments', () => {
  const save = (h: Harness, botId: string, body: object) =>
    h.request(
      'POST',
      '/internal/v1/owner-memory',
      { origin: 'owner', idempotencyKey: randomUUID(), ...body },
      true,
      h.botHeaders(botId)
    )
  const forget = (h: Harness, botId: string, id: string) =>
    h.request('POST', `/internal/v1/owner-memory/${id}/forget`, { reason: 'Outdated' }, true, h.botHeaders(botId))
  const visible = async (h: Harness, botId: string) =>
    (await json(await h.request('GET', '/internal/v1/owner-memory', undefined, true, h.botHeaders(botId)))) as {
      activeChars: number
      entries: Array<{ id: string; content: string; environmentId: string | null; replacesId: string | null }>
    }
  const ownerSave = async (h: Harness, content: string, environmentId?: string | null, replacesId?: string) => {
    const response = await h.request('POST', '/v1/owner-memory', {
      content,
      idempotencyKey: randomUUID(),
      ...(environmentId === undefined ? {} : { environmentId }),
      ...(replacesId ? { replacesId } : {}),
    })
    expect(response.status).toBe(201)
    return json(response)
  }

  it('keeps owner entries global unless scoped, and lets the owner move them', async () => {
    const h = await harness(Date.now, { environments: true })
    const other = await createBot(h, 'Other', { environment: { name: 'Home' } })
    const global = await ownerSave(h, 'Prefers short answers.')
    expect(global.environmentId).toBeNull()
    const scoped = await ownerSave(h, 'Works on the Test project.', 'test')
    expect(scoped.environmentId).toBe('test')
    expect(
      (
        await h.request('POST', '/v1/owner-memory', {
          content: 'Lost',
          environmentId: 'missing',
          idempotencyKey: randomUUID(),
        })
      ).status
    ).toBe(404)
    expect(
      (await json(await h.request('GET', '/v1/owner-memory'))).entries.map((entry: { id: string }) => entry.id)
    ).toEqual([global.id, scoped.id])
    expect((await visible(h, h.bot.id)).entries.map((entry) => entry.id)).toEqual([global.id, scoped.id])
    expect((await visible(h, other.id)).entries.map((entry) => entry.id)).toEqual([global.id])
    const revision = h.store.ownerMemoryRevision()
    const promoted = await h.request('PATCH', `/v1/owner-memory/${scoped.id}`, { environmentId: null })
    expect(promoted.status).toBe(200)
    expect((await promoted.json()).environmentId).toBeNull()
    expect(h.store.ownerMemoryRevision()).toBe(revision + 1)
    expect(h.events.filter((event) => event.type === 'owner_memory.updated').at(-1)).toMatchObject({
      revision: revision + 1,
    })
    expect((await visible(h, other.id)).entries.map((entry) => entry.id)).toEqual([global.id, scoped.id])
    expect(
      (await json(await h.request('PATCH', `/v1/owner-memory/${scoped.id}`, { environmentId: 'home' }))).environmentId
    ).toBe('home')
    expect((await visible(h, h.bot.id)).entries.map((entry) => entry.id)).toEqual([global.id])
    expect((await h.request('PATCH', `/v1/owner-memory/${scoped.id}`, { environmentId: 'missing' })).status).toBe(404)
    expect(h.store.ownerMemoryById(scoped.id)?.environmentId).toBe('home')
  })

  it("keeps a bot's writes inside its environment and shows it nothing of another", async () => {
    const h = await harness(Date.now, { environments: true })
    const other = await createBot(h, 'Other', { environment: { name: 'Home' } })
    const global = await ownerSave(h, 'Prefers short answers.')
    const home = await ownerSave(h, 'Home has a garden.', 'home')
    const saved = await save(h, h.bot.id, { content: 'Test ships on Fridays.', environmentId: 'home' })
    expect(saved.status).toBe(201)
    const own = await saved.json()
    // A bot's entry belongs to its own environment, whatever the request says.
    expect(own).toMatchObject({ environmentId: 'test', author: { kind: 'bot', botId: h.bot.id } })
    const snapshot = () => JSON.stringify([h.store.ownerMemoryById(global.id), h.store.ownerMemoryById(home.id)])
    const before = snapshot()
    // Entries of another environment and global entries are neither replaced nor forgotten, and the answer is the
    // same as for an id that does not exist.
    for (const target of [home.id, global.id, global.id.slice(0, 8), 'unknown-entry-id']) {
      for (const response of [
        await save(h, h.bot.id, { content: 'Replacement', replacesId: target }),
        await forget(h, h.bot.id, target),
      ]) {
        expect(response.status).toBe(404)
        expect(await response.json()).toMatchObject({
          code: 'NOT_FOUND',
          message: expect.stringContaining('id shown in your memory'),
        })
      }
    }
    expect(snapshot()).toBe(before)
    // Saving what another environment knows creates the bot's own entry; saving a global fact returns it unchanged.
    const echo = await json(await save(h, h.bot.id, { content: 'Home has a garden.' }))
    expect(echo).toMatchObject({ environmentId: 'test', content: 'Home has a garden.' })
    expect(echo.id).not.toBe(home.id)
    expect(await json(await save(h, h.bot.id, { content: 'Prefers short answers.' }))).toEqual(global)
    expect(snapshot()).toBe(before)
    expect((await visible(h, other.id)).entries.map((entry) => entry.id)).toEqual([global.id, home.id])
    // Its own entries it replaces and forgets.
    const replacement = await json(await save(h, h.bot.id, { content: 'Test ships on Mondays.', replacesId: own.id }))
    expect(replacement).toMatchObject({ environmentId: 'test', replacesId: own.id })
    expect((await forget(h, h.bot.id, replacement.id)).status).toBe(200)
    // Links to entries it cannot see are not shown to it.
    const moved = await ownerSave(h, 'Everyone has a garden.', null, home.id)
    expect((await visible(h, h.bot.id)).entries.find((entry) => entry.id === moved.id)?.replacesId).toBeNull()
    expect((await visible(h, other.id)).entries.find((entry) => entry.id === moved.id)?.replacesId).toBe(home.id)
    expect(
      h.store
        .activity()
        .filter((entry) => entry.kind === 'owner_memory_saved')
        .map((entry) => [entry.botId, entry.environmentId])
    ).toEqual([
      [h.bot.id, 'test'],
      [h.bot.id, 'test'],
      [h.bot.id, 'test'],
    ])
  })

  it('counts the owner memory budget per environment prompt', async () => {
    const h = await harness(Date.now, { environments: true })
    const other = await createBot(h, 'Other', { environment: { name: 'Home' } })
    for (let i = 0; i < 7; i++) await ownerSave(h, String(i) + 'h'.repeat(499), 'home')
    await ownerSave(h, 'g'.repeat(500))
    // Home's prompt is full; Test's is not.
    const full = await h.request('POST', '/v1/owner-memory', { content: 'One more', idempotencyKey: randomUUID() })
    expect(full.status).toBe(409)
    expect((await full.json()).message).toBe(
      'Owner memory is full (4000/4000 characters). Replace or forget outdated entries first.'
    )
    expect((await save(h, other.id, { content: 'Home fact' })).status).toBe(409)
    expect((await save(h, h.bot.id, { content: 't'.repeat(500) })).status).toBe(201)
    expect((await json(await h.request('GET', '/v1/owner-memory?status=active'))).activeChars).toBe(4000)
    expect((await visible(h, h.bot.id)).activeChars).toBe(1000)
    expect((await visible(h, other.id)).activeChars).toBe(4000)
  })
})
