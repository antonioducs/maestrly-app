import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MAX_RESPONSE_BYTES } from '../src/limits.js'
import { type Browser, type Harness, startHarness } from './http-harness.js'

let h: Harness
let id: string
let api: string
let owner: Browser
let maria: Browser
let mariaId: string

async function join(name: string): Promise<{ browser: Browser; principalId: string }> {
  const { token, principalId } = await h.admin.createInvite(id, { name })
  const browser = h.browser()
  expect((await browser.send('POST', `${api}/session/invite`, { token })).status).toBe(204)
  return { browser, principalId }
}

const put = (browser: Browser, body: unknown, headers?: Record<string, string>) =>
  browser.send('PUT', `${api}/responses/mine`, body, headers)
const mine = (browser: Browser, headers?: Record<string, string>) => browser.get(`${api}/responses/mine`, headers)
const submitted = async () =>
  (await h.admin.listEvents({ artifactId: id })).filter((event) => event.kind === 'response_submitted')

async function setUp(options: { maxResponses?: number } = {}): Promise<void> {
  h = await startHarness(options)
  id = h.id
  api = `/a/${id}/api`
  await h.admin.setSharing(id, { visibility: 'link' })
  owner = await h.owner()
  const joined = await join('Maria')
  maria = joined.browser
  mariaId = joined.principalId
}

afterEach(() => h.close())

describe('response routes', () => {
  beforeEach(() => setUp())

  it('saves one response per person, replaces it when sent again, and tells the owner once', async () => {
    expect((await mine(maria)).json).toEqual({ response: null })
    const first = await put(maria, { version: 1, data: { answer: 'a' } })
    expect(first.status).toBe(200)
    expect(first.headers['cache-control']).toBe('no-store')
    expect(first.json).toEqual({
      response: { data: { answer: 'a' }, version: 1, updatedAt: h.clock.now() },
      created: true,
    })
    expect(first.body).not.toContain('principal')
    expect(first.body).not.toContain(mariaId)
    h.clock.advance(1000)
    const second = await put(maria, { version: 1, data: { answer: 'b' } })
    expect(second.json).toEqual({
      response: { data: { answer: 'b' }, version: 1, updatedAt: h.clock.now() },
      created: false,
    })
    expect((await mine(maria)).json).toEqual({ response: second.json.response })

    const { responses } = await h.admin.listResponses(id)
    expect(responses).toHaveLength(1)
    expect(responses[0]).toMatchObject({
      author: { kind: 'invited', name: 'Maria', verified: true },
      data: { answer: 'b' },
      createdAt: h.clock.now() - 1000,
      updatedAt: h.clock.now(),
    })
    expect(await submitted()).toEqual([expect.objectContaining({ data: { name: 'Maria' } })])
    expect(h.onActivity).toHaveBeenCalledWith(id, 'response_submitted')
  })

  it('shows each person only their own response', async () => {
    await put(maria, { version: 1, data: { answer: 'a' } })
    const ana = (await join('Ana')).browser
    expect((await mine(ana)).json).toEqual({ response: null })
    expect((await mine(owner)).json).toEqual({ response: null })
  })

  it('asks a guest for a name before the first response, and marks it unverified', async () => {
    const guest = h.browser()
    expect((await guest.send('POST', `${api}/session/code`, {})).status).toBe(204)
    const refused = await put(guest, { version: 1, data: { answer: 'x' } })
    expect(refused.status).toBe(409)
    expect(refused.json).toEqual({ error: 'name_required' })
    expect((await guest.send('PUT', `${api}/session/name`, { name: 'Paula' })).status).toBe(204)
    expect((await put(guest, { version: 1, data: { answer: 'x' } })).status).toBe(200)
    expect((await h.admin.listResponses(id)).responses[0]?.author).toEqual({
      kind: 'guest',
      name: 'Paula',
      verified: false,
    })
  })

  it('records the owner’s response as the owner’s, without an event', async () => {
    const saved = await put(owner, { version: 1, data: { test: true } })
    expect(saved.status).toBe(200)
    expect((await mine(owner)).json.response.data).toEqual({ test: true })
    expect((await h.admin.listResponses(id)).responses[0]?.author).toEqual({
      kind: 'owner',
      name: 'Antonio',
      verified: true,
    })
    expect(await submitted()).toEqual([])
  })

  it('takes no responses while they are turned off, and says so in the state', async () => {
    await put(maria, { version: 1, data: { answer: 'a' } })
    await h.admin.setSharing(id, { responsesEnabled: false })
    expect((await maria.get(`${api}/state`)).json.can).toEqual({ comment: true, resolve: false, respond: false })
    const refused = await put(maria, { version: 1, data: { answer: 'b' } })
    expect(refused.status).toBe(403)
    expect(refused.json).toEqual({ error: 'responses_closed' })
    const kept = await mine(maria)
    expect(kept.status).toBe(200)
    expect(kept.json.response.data).toEqual({ answer: 'a' })
  })

  it('refuses what is not a response', async () => {
    for (const body of [
      { version: 1, data: [] },
      { version: 1, data: { t: 'x'.repeat(MAX_RESPONSE_BYTES) } },
      { data: {} },
      { version: 'one', data: {} },
    ]) {
      const refused = await put(maria, body)
      expect(refused.status, JSON.stringify(body).slice(0, 40)).toBe(400)
      expect(refused.json).toEqual({ error: 'invalid_response' })
    }
    expect((await put(maria, { version: 9, data: {} })).status).toBe(404)
    expect((await put(maria, { version: 1, data: { t: 'x'.repeat(70 * 1024) } })).status).toBe(413)
    expect((await h.admin.listResponses(id)).responses).toEqual([])
  })

  it('takes writes only from the viewer, and answers nothing to a browser without access', async () => {
    expect((await put(maria, { version: 1, data: {} }, { 'x-maestrly-artifact': '' })).status).toBe(403)
    expect((await put(maria, { version: 1, data: {} }, { origin: 'http://evil.test' })).status).toBe(403)
    expect((await mine(maria, { 'x-maestrly-artifact': '' })).status).toBe(403)
    const stranger = h.browser()
    expect((await put(stranger, { version: 1, data: {} })).status).toBe(404)
    expect((await mine(stranger)).status).toBe(404)
    expect((await h.admin.listResponses(id)).responses).toEqual([])
  })

  it('keeps the response of a person who was removed, with their name', async () => {
    await put(maria, { version: 1, data: { answer: 'a' } })
    await h.admin.revokePerson(id, mariaId)
    expect((await mine(maria)).status).toBe(404)
    expect((await h.admin.listResponses(id)).responses[0]).toMatchObject({
      author: { name: 'Maria' },
      data: { answer: 'a' },
    })
  })
})

describe('response limit', () => {
  beforeEach(() => setUp({ maxResponses: 1 }))

  it('stops taking new people at the limit, while those in can still change theirs', async () => {
    expect((await put(maria, { version: 1, data: { answer: 'a' } })).status).toBe(200)
    const ana = (await join('Ana')).browser
    const refused = await put(ana, { version: 1, data: { answer: 'b' } })
    expect(refused.status).toBe(409)
    expect(refused.json).toEqual({ error: 'too_many_responses' })
    expect((await put(maria, { version: 1, data: { answer: 'c' } })).status).toBe(200)
  })
})
