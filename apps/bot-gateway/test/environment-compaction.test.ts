import { randomUUID } from 'node:crypto'
import {
  FLEET_ENVIRONMENT_COMPACTION_FEATURE,
  type FleetBot,
  type FleetCompactionConfig,
  type FleetEnvironment,
  type FleetGatewayEvent,
} from '@maestrly/bot-fleet-protocol'
import { describe, expect, it } from 'vitest'
import { RESTART_TO_CHOOSE_COMPACTION } from '../src/lifecycle.js'
import { harness } from './harness.js'

type Harness = Awaited<ReturnType<typeof harness>>
const model = (modelId: string, intervalTokens = 100000): FleetCompactionConfig => ({
  providerId: 'prov_test',
  modelId,
  reasoning: null,
  fastMode: false,
  intervalTokens,
})
async function until(test: () => boolean, attempts = 400) {
  for (let i = 0; i < attempts; i++) {
    if (test()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Timed out')
}
async function json<T>(response: Response, status = 200): Promise<T> {
  const body = await response.json()
  expect(response.status, JSON.stringify(body)).toBe(status)
  return body as T
}
const bot = async (h: Harness, id: string) => json<FleetBot>(await h.request('GET', '/v1/bots/' + id))
const environment = async (h: Harness, id = 'test') =>
  json<FleetEnvironment>(await h.request('GET', '/v1/environments/' + id))
const patchBot = async (h: Harness, id: string, body: unknown) =>
  json<FleetBot>(await h.request('PATCH', '/v1/bots/' + id, body))
const patchEnvironment = async (h: Harness, body: unknown, id = 'test') =>
  json<FleetEnvironment>(await h.request('PATCH', '/v1/environments/' + id, body))
/** The bot's own model as the gateway stored it. */
const stored = (h: Harness, id: string) =>
  (h.store.db.prepare('SELECT compaction_json FROM bots WHERE id=?').get(id) as { compaction_json: string | null })
    .compaction_json
/** The model of the last installation of a bot that the instance received, or undefined without one. */
const installed = (h: Harness, id: string) => h.instance.installs.findLast((item) => item.profile.botId === id)
const installCount = (h: Harness, id: string) => h.instance.installs.filter((item) => item.profile.botId === id).length
async function sibling(h: Harness, name: string) {
  const created = await json<FleetBot>(
    await h.request('POST', '/v1/bots', {
      name,
      instructions: '',
      ceiling: 'ask',
      talksTo: [],
      environmentId: 'test',
      idempotencyKey: randomUUID(),
    }),
    201
  )
  await until(() => h.lifecycle.get(created.id)?.lifecycle === 'running')
  return created.id
}
const eventsSince = (h: Harness, index: number) => h.events.slice(index)
const botEvents = (events: FleetGatewayEvent[], id: string) =>
  events.filter((event) => event.type === 'bot.updated' && event.bot.id === id) as Extract<
    FleetGatewayEvent,
    { type: 'bot.updated' }
  >[]
const environmentEvents = (events: FleetGatewayEvent[]) =>
  events.filter((event) => event.type === 'environment.updated') as Extract<
    FleetGatewayEvent,
    { type: 'environment.updated' }
  >[]

describe('environment compaction defaults', () => {
  it('announces the feature and starts with neither a default nor a model', async () => {
    const h = await harness(Date.now, { environments: true })
    const meta = await json<{ features: string[] }>(await h.request('GET', '/v1/meta'))
    expect(meta.features).toContain(FLEET_ENVIRONMENT_COMPACTION_FEATURE)
    expect(await environment(h)).toMatchObject({ compaction: null })
    expect(await bot(h, 'test')).toMatchObject({ compaction: null, compactionSource: null })
    expect(installed(h, 'test')?.profile.compaction).toBeNull()
  })

  it("makes a first bot model its environment's default, which the bot and its siblings then inherit", async () => {
    const h = await harness(Date.now, { environments: true })
    const scout = await sibling(h, 'Scout')
    const before = h.events.length
    const x = model('model-x')

    const patched = await patchBot(h, 'test', { compaction: x })
    expect(patched).toMatchObject({ compaction: x, compactionSource: 'environment' })
    expect(await environment(h)).toMatchObject({ compaction: x })
    expect(stored(h, 'test')).toBeNull()
    expect(await bot(h, scout)).toMatchObject({ compaction: x, compactionSource: 'environment' })
    expect(installed(h, 'test')?.profile.compaction).toEqual(x)
    expect(installed(h, scout)?.profile.compaction).toEqual(x)
    const events = eventsSince(h, before)
    expect(environmentEvents(events).at(-1)?.environment.compaction).toEqual(x)
    expect(botEvents(events, 'test').at(-1)?.bot).toMatchObject({ compaction: x, compactionSource: 'environment' })
    expect(botEvents(events, scout).at(-1)?.bot).toMatchObject({ compaction: x, compactionSource: 'environment' })
  })

  it('gives a new bot the default, keeps a bot model its own, and inherits again with null', async () => {
    const h = await harness(Date.now, { environments: true })
    const x = model('model-x'),
      y = model('model-y')
    await patchEnvironment(h, { compaction: x })
    expect(await bot(h, 'test')).toMatchObject({ compaction: x, compactionSource: 'environment' })

    const scout = await sibling(h, 'Scout')
    expect(await bot(h, scout)).toMatchObject({ compaction: x, compactionSource: 'environment' })
    expect(installed(h, scout)?.profile.compaction).toEqual(x)

    expect(await patchBot(h, scout, { compaction: y })).toMatchObject({ compaction: y, compactionSource: 'bot' })
    expect(await environment(h)).toMatchObject({ compaction: x })
    expect(JSON.parse(stored(h, scout)!)).toEqual(y)
    expect(installed(h, scout)?.profile.compaction).toEqual(y)

    expect(await patchBot(h, scout, { compaction: null })).toMatchObject({
      compaction: x,
      compactionSource: 'environment',
    })
    expect(stored(h, scout)).toBeNull()
    expect(installed(h, scout)?.profile.compaction).toEqual(x)
  })

  it('reinstalls only the bots that inherit a changed default', async () => {
    const h = await harness(Date.now, { environments: true })
    const scout = await sibling(h, 'Scout')
    const x = model('model-x'),
      y = model('model-y'),
      z = model('model-z', 120000)
    await patchEnvironment(h, { compaction: x })
    await patchBot(h, scout, { compaction: y })
    const scoutInstalls = installCount(h, scout),
      testInstalls = installCount(h, 'test'),
      before = h.events.length

    expect(await patchEnvironment(h, { compaction: z })).toMatchObject({ compaction: z })
    expect(installCount(h, 'test')).toBe(testInstalls + 1)
    expect(installed(h, 'test')?.profile.compaction).toEqual(z)
    expect(installCount(h, scout)).toBe(scoutInstalls)
    expect(await bot(h, 'test')).toMatchObject({ compaction: z, compactionSource: 'environment' })
    expect(await bot(h, scout)).toMatchObject({ compaction: y, compactionSource: 'bot' })
    const events = eventsSince(h, before)
    expect(environmentEvents(events).map((event) => event.environment.compaction)).toEqual([z])
    expect(botEvents(events, 'test').at(-1)?.bot.compaction).toEqual(z)
    expect(botEvents(events, scout)).toEqual([])
  })

  it('stores a default while its environment is stopped and installs it when the environment starts', async () => {
    const h = await harness(Date.now, { environments: true })
    await json(await h.request('POST', '/v1/environments/test/stop'))
    await until(() => h.lifecycle.environment('test')?.lifecycle === 'stopped')
    const installs = h.instance.installs.length,
      w = model('model-w')
    expect(await patchEnvironment(h, { compaction: w })).toMatchObject({ compaction: w, lifecycle: 'stopped' })
    expect(h.instance.installs.length).toBe(installs)
    await json(await h.request('POST', '/v1/environments/test/start'))
    await until(() => h.lifecycle.get('test')?.lifecycle === 'running' && h.instance.installs.length > installs)
    expect(installed(h, 'test')?.profile.compaction).toEqual(w)
  })

  it('answers the owner when a bot cannot take the new default at once, and gives it later', async () => {
    const h = await harness(Date.now, { environments: true })
    const z = model('model-z')
    h.instance.control.installFailures = 1
    expect(await patchEnvironment(h, { compaction: z })).toMatchObject({ compaction: z })
    expect(h.instance.control.installFailures).toBe(0)
    expect(installed(h, 'test')?.profile.compaction).not.toEqual(z)
    await until(() => installed(h, 'test')?.profile.compaction?.modelId === 'model-z', 500)
    expect(await bot(h, 'test')).toMatchObject({ compaction: z, compactionSource: 'environment', lifecycle: 'running' })
  })

  it("sends a bot its own model when a sibling's model became the default while both waited", async () => {
    const h = await harness(Date.now, { environments: true })
    const scout = await sibling(h, 'Scout')
    await json(await h.request('POST', '/v1/environments/test/stop'))
    await until(() => h.lifecycle.environment('test')?.lifecycle === 'stopped')
    const x = model('model-x'),
      y = model('model-y')
    // Both changes wait for the start; the first one makes its model the default and gives it to Scout meanwhile.
    const started = h.lifecycle.startEnvironment('test')
    const [first, second] = await Promise.all([
      h.lifecycle.patch('test', { compaction: x }),
      h.lifecycle.patch(scout, { compaction: y }),
    ])
    await started
    expect(first).toMatchObject({ compaction: x, compactionSource: 'environment' })
    expect(second).toMatchObject({ compaction: y, compactionSource: 'bot' })
    expect(await environment(h)).toMatchObject({ compaction: x })
    expect(installed(h, 'test')?.profile.compaction).toEqual(x)
    expect(installed(h, scout)?.profile.compaction).toEqual(y)
  })

  it('applies default changes in the order the owner made them while the environment is busy', async () => {
    const h = await harness(Date.now, { environments: true })
    const x = model('model-x'),
      z = model('model-z')
    await patchEnvironment(h, { compaction: x })
    await json(await h.request('POST', '/v1/environments/test/stop'))
    await until(() => h.lifecycle.environment('test')?.lifecycle === 'stopped')
    const started = h.lifecycle.startEnvironment('test')
    // The second change goes back to the stored default: it still comes after the first one.
    const changes = Promise.all([
      h.lifecycle.patchEnvironment('test', { compaction: z }),
      h.lifecycle.patchEnvironment('test', { compaction: x }),
    ])
    await started
    const [, last] = await changes
    expect(last.compaction).toEqual(x)
    expect(h.store.getEnvironment('test')?.compaction).toEqual(x)
    expect(installed(h, 'test')?.profile.compaction).toEqual(x)
  })

  it('leaves the other bots to a later reconcile once the instance cannot be reached', async () => {
    const h = await harness(Date.now, { environments: true })
    const scout = await sibling(h, 'Scout'),
      helper = await sibling(h, 'Helper')
    await patchEnvironment(h, { compaction: model('model-x') })
    const z = model('model-z')
    const attempts = h.instance.control.installAttempts
    h.instance.control.installDrops = 1
    expect(await patchEnvironment(h, { compaction: z })).toMatchObject({ compaction: z })
    expect(h.instance.control.installAttempts).toBe(attempts + 1)
    await until(
      () => ['test', scout, helper].every((id) => installed(h, id)?.profile.compaction?.modelId === 'model-z'),
      500
    )
    for (const id of ['test', scout, helper])
      expect(await bot(h, id)).toMatchObject({ compaction: z, compactionSource: 'environment', lifecycle: 'running' })
  })

  it('lists the models of a running environment whose instance can', async () => {
    const h = await harness(Date.now, { environments: true, compaction: true })
    expect(await json(await h.request('GET', '/v1/environments/test/selections'))).toEqual({
      options: h.instance.selectionOptions,
      current: null,
    })
    expect(await json(await h.request('GET', '/v1/environments/missing/selections'), 404)).toMatchObject({
      code: 'NOT_FOUND',
    })
    await json(await h.request('POST', '/v1/environments/test/stop'))
    await until(() => h.lifecycle.environment('test')?.lifecycle === 'stopped')
    expect(await json(await h.request('GET', '/v1/environments/test/selections'), 409)).toMatchObject({
      code: 'BOT_NOT_RUNNING',
    })
  })

  it('asks to restart an environment whose instance cannot list its models', async () => {
    const h = await harness(Date.now, { environments: true })
    expect(await json(await h.request('GET', '/v1/environments/test/selections'), 409)).toEqual({
      code: 'CONFLICT',
      message: RESTART_TO_CHOOSE_COMPACTION,
    })
  })

  it('keeps an archived and restored bot inheriting, and never stores the inherited model', async () => {
    const h = await harness(Date.now, { environments: true })
    const scout = await sibling(h, 'Scout')
    const x = model('model-x')
    await patchEnvironment(h, { compaction: x })

    await json(await h.request('POST', '/v1/bots/' + scout + '/pause'))
    await json(await h.request('POST', '/v1/bots/' + scout + '/resume'))
    await patchBot(h, scout, { name: 'Scout 2' })
    expect(stored(h, scout)).toBeNull()

    await json(await h.request('POST', '/v1/bots/' + scout + '/archive'))
    await json(await h.request('POST', '/v1/archived-bots/' + scout + '/restore'))
    await until(() => h.lifecycle.get(scout)?.lifecycle === 'running')
    expect(stored(h, scout)).toBeNull()
    expect(await bot(h, scout)).toMatchObject({ compaction: x, compactionSource: 'environment' })
    expect(installed(h, scout)?.profile.compaction).toEqual(x)
  })
})
