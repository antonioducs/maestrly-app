import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { harness } from './harness.js'

describe('archived bot aliases for older Macs', () => {
  it('lists an archived environment of one through the old collection, and keeps the new collections separate', async () => {
    const h = await harness(Date.now, { environments: true })
    await h.lifecycle.archiveEnvironment(h.bot.environmentId!)
    const legacy = await h.request('GET', '/v1/archived-bots')
    expect(legacy.status).toBe(200)
    expect((await legacy.json()).bots).toEqual([
      expect.objectContaining({ id: h.bot.id, environmentId: h.bot.environmentId, files: 'kept' }),
    ])
    const modern = await h.request('GET', '/v1/archived-bots?separateEnvironments=1')
    expect((await modern.json()).bots).toEqual([])
    expect((await (await h.request('GET', '/v1/archived-environments')).json()).environments).toHaveLength(1)
  })

  it('restores the archived environment of one through the old bot alias', async () => {
    const h = await harness(Date.now, { environments: true })
    await h.lifecycle.archiveEnvironment(h.bot.environmentId!)
    const response = await h.request('POST', `/v1/archived-bots/${h.bot.id}/restore`)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ id: h.bot.id, environmentId: h.bot.environmentId })
    expect(h.store.getBot(h.bot.id)?.lifecycle).not.toBe('archived')
    expect(h.store.getEnvironment(h.bot.environmentId!)?.archivedAt).toBeNull()
  })

  it('purges the archived environment of one through the old bot alias', async () => {
    const h = await harness(Date.now, { environments: true })
    await h.lifecycle.archiveEnvironment(h.bot.environmentId!)
    const response = await h.request('DELETE', `/v1/archived-bots/${h.bot.id}`)
    expect(response.status).toBe(204)
    expect(h.store.getBot(h.bot.id)).toBeNull()
    expect(h.store.getEnvironment(h.bot.environmentId!)).toBeNull()
    expect(await h.lifecycle.archivedEnvironments()).toEqual([])
  })

  it('restores a bot archived before its sole environment and refuses an active bot', async () => {
    const h = await harness(Date.now, { environments: true })
    expect((await h.request('POST', `/v1/archived-bots/${h.bot.id}/restore`)).status).toBe(404)
    await h.lifecycle.archive(h.bot.id)
    await h.lifecycle.archiveEnvironment(h.bot.environmentId!)
    const response = await h.request('POST', `/v1/archived-bots/${h.bot.id}/restore`)
    expect(response.status).toBe(200)
    expect(h.store.getBot(h.bot.id)?.lifecycle).not.toBe('archived')
    expect((await h.request('POST', `/v1/archived-bots/${h.bot.id}/restore`)).status).toBe(404)
  })

  it('never restores or purges siblings through a bot alias', async () => {
    const h = await harness(Date.now, { environments: true })
    const response = await h.request('POST', '/v1/bots', {
      name: 'Partner',
      instructions: '',
      ceiling: 'ask',
      talksTo: [],
      environmentId: h.bot.environmentId,
      idempotencyKey: randomUUID(),
    })
    expect(response.status).toBe(201)
    const partner = await response.json()
    await h.lifecycle.archiveEnvironment(h.bot.environmentId!)
    expect((await (await h.request('GET', '/v1/archived-bots')).json()).bots).toEqual([])
    expect((await h.request('POST', `/v1/archived-bots/${h.bot.id}/restore`)).status).toBe(409)
    expect((await h.request('DELETE', `/v1/archived-bots/${h.bot.id}`)).status).toBe(409)
    expect(h.store.getBot(partner.id)?.lifecycle).toBe('archived')
    expect(h.store.getEnvironment(h.bot.environmentId!)?.archivedAt).not.toBeNull()
  })
})
