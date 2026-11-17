import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { FLEET_BOT_AVATARS_FEATURE, FLEET_ORDER_FEATURE } from '@maestrly/bot-fleet-protocol'
import { harness } from './harness.js'

type Harness = Awaited<ReturnType<typeof harness>>
const json = async (response: Response): Promise<any> => response.json()
// A 1x1 PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64'
)

async function createBot(h: Harness, name: string) {
  const response = await h.request('POST', '/v1/bots', {
    name,
    instructions: '',
    ceiling: 'ask',
    talksTo: [],
    idempotencyKey: randomUUID(),
  })
  expect(response.status).toBe(201)
  return (await response.json()) as { id: string; environmentId: string }
}

describe('fleet order', () => {
  it('announces the features and lists bots and environments oldest first until the owner orders them', async () => {
    const h = await harness()
    const meta = await json(await h.request('GET', '/v1/meta'))
    expect(meta.moreFeatures).toEqual(expect.arrayContaining([FLEET_BOT_AVATARS_FEATURE, FLEET_ORDER_FEATURE]))
    const second = await createBot(h, 'Second')
    const third = await createBot(h, 'Third')
    const first = h.lifecycle.list()[0]
    const ids = (await json(await h.request('GET', '/v1/bots'))).bots.map((bot: { id: string }) => bot.id)
    expect(ids).toEqual([first.id, second.id, third.id])

    h.events.length = 0
    const reordered = await h.request('PUT', '/v1/bot-order', { botIds: [third.id, first.id] })
    expect(reordered.status).toBe(200)
    const bots = (await json(reordered)).bots as Array<{ id: string; position: number }>
    expect(bots.map((bot) => [bot.id, bot.position])).toEqual([
      [third.id, 0],
      [first.id, 1],
      [second.id, 2],
    ])
    // Every bot changed place, so devices hear of each.
    const heard = new Map(
      h.events.flatMap((event) => (event.type === 'bot.updated' ? [[event.bot.id, event.bot.position]] : []))
    )
    expect(heard).toEqual(
      new Map([
        [third.id, 0],
        [first.id, 1],
        [second.id, 2],
      ])
    )
    expect(h.lifecycle.list().map((bot) => bot.id)).toEqual([third.id, first.id, second.id])

    const environments = await h.request('PUT', '/v1/environment-order', {
      environmentIds: [second.environmentId],
    })
    expect(environments.status).toBe(200)
    const listed = (await json(environments)).environments as Array<{ id: string; position: number }>
    expect(listed[0]).toMatchObject({ id: second.environmentId, position: 0 })
    expect(listed.map((environment) => environment.position)).toEqual(listed.map((_, index) => index))
    expect(h.lifecycle.environments().map((environment) => environment.id)[0]).toBe(second.environmentId)
  })

  it('refuses unknown and repeated ids and changes nothing', async () => {
    const h = await harness()
    const bot = h.lifecycle.list()[0]
    const before = h.lifecycle.list().map((item) => item.position)
    expect((await h.request('PUT', '/v1/bot-order', { botIds: ['ghost'] })).status).toBe(404)
    expect((await h.request('PUT', '/v1/bot-order', { botIds: [bot.id, bot.id] })).status).toBe(400)
    expect((await h.request('PUT', '/v1/bot-order', { botIds: [] })).status).toBe(400)
    expect((await h.request('PUT', '/v1/environment-order', { environmentIds: ['ghost'] })).status).toBe(404)
    expect(h.lifecycle.list().map((item) => item.position)).toEqual(before)
  })

  it('puts a new bot last', async () => {
    const h = await harness()
    const second = await createBot(h, 'Second')
    await h.request('PUT', '/v1/bot-order', { botIds: [second.id] })
    const third = await createBot(h, 'Third')
    expect(h.lifecycle.list().map((bot) => bot.id)).toEqual([second.id, h.lifecycle.list()[1].id, third.id])
    expect(h.lifecycle.get(third.id)?.position).toBe(2)
  })
})

describe('bot avatars', () => {
  it('keeps, serves, replaces and removes a bot picture without reinstalling the bot', async () => {
    const h = await harness()
    const bot = h.lifecycle.list()[0]
    expect(bot.avatar).toBeNull()
    expect((await h.request('GET', `/v1/bots/${bot.id}/avatar`)).status).toBe(404)

    h.events.length = 0
    const put = await h.request('PUT', `/v1/bots/${bot.id}/avatar`, {
      mediaType: 'image/png',
      data: PNG.toString('base64'),
    })
    expect(put.status).toBe(200)
    const updated = await json(put)
    expect(updated.avatar).toMatch(/^[0-9a-f]{16}$/)
    expect(h.events.some((event) => event.type === 'bot.updated' && event.bot.avatar === updated.avatar)).toBe(true)

    const read = await h.request('GET', `/v1/bots/${bot.id}/avatar`)
    expect(read.status).toBe(200)
    expect(read.headers.get('content-type')).toBe('image/png')
    expect(read.headers.get('x-content-type-options')).toBe('nosniff')
    expect(Buffer.from(await read.arrayBuffer())).toEqual(PNG)

    const removed = await h.request('DELETE', `/v1/bots/${bot.id}/avatar`)
    expect((await json(removed)).avatar).toBeNull()
    expect((await h.request('GET', `/v1/bots/${bot.id}/avatar`)).status).toBe(404)
  })

  it('refuses a picture whose bytes are not the format it names, or that is not a picture', async () => {
    const h = await harness()
    const bot = h.lifecycle.list()[0]
    const send = (body: unknown) => h.request('PUT', `/v1/bots/${bot.id}/avatar`, body)
    expect((await send({ mediaType: 'image/jpeg', data: PNG.toString('base64') })).status).toBe(400)
    expect((await send({ mediaType: 'image/png', data: Buffer.from('<svg/>').toString('base64') })).status).toBe(400)
    expect((await send({ mediaType: 'image/svg+xml', data: PNG.toString('base64') })).status).toBe(400)
    expect((await send({ mediaType: 'image/png', data: 'A'.repeat(400_000) })).status).toBe(400)
    expect(await send({ mediaType: 'image/png', data: PNG.toString('base64') }).then((r) => r.status)).toBe(200)
    expect((await h.request('PUT', '/v1/bots/ghost/avatar', { mediaType: 'image/png', data: 'AA==' })).status).toBe(404)
  })

  it('removes the picture with the bot', async () => {
    const h = await harness()
    const bot = h.lifecycle.list()[0]
    h.store.setBotAvatar(bot.id, { mediaType: 'image/png', data: PNG, version: '0123456789abcdef' })
    h.store.purgeBot(bot.id)
    expect(h.store.db.prepare('SELECT * FROM bot_avatars').all()).toEqual([])
  })
})
