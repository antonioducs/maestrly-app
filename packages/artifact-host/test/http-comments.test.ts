import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MAX_COMMENT_CHARS } from '../src/limits.js'
import { type Browser, type Harness, startHarness } from './http-harness.js'

let h: Harness
let id: string
let api: string
let owner: Browser
let maria: Browser

const quote = { exact: 'quick brown fox', prefix: 'The ', suffix: ' jumps' }
const MISSING = 'A'.repeat(22)

async function join(name: string): Promise<Browser> {
  const { token } = await h.admin.createInvite(id, { name })
  const browser = h.browser()
  expect((await browser.send('POST', `${api}/session/invite`, { token })).status).toBe(204)
  return browser
}

const post = (browser: Browser, body: string, extra: Record<string, unknown> = {}) =>
  browser.send('POST', `${api}/comments`, { version: 1, body, ...extra })

const list = async (browser: Browser) => (await browser.get(`${api}/comments`)).json.comments as any[]

beforeEach(async () => {
  h = await startHarness()
  id = h.id
  api = `/a/${id}/api`
  await h.admin.setSharing(id, { visibility: 'link' })
  owner = await h.owner()
  maria = await join('Maria')
})
afterEach(() => h.close())

describe('comment routes', () => {
  it('lets a person comment on a passage, and shows each reader what is theirs', async () => {
    const created = await post(maria, '  Is this right?  ', { anchor: { quote } })
    expect(created.status).toBe(201)
    expect(created.json).toEqual({
      id: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
      version: 1,
      parentId: null,
      author: { kind: 'invited', name: 'Maria', verified: true, self: true },
      body: 'Is this right?',
      anchor: { quote },
      status: 'open',
      createdAt: h.clock.now(),
      canDelete: true,
    })
    expect(created.body).not.toContain('principalId')

    const seenByOwner = await owner.get(`${api}/comments`)
    expect(seenByOwner.status).toBe(200)
    expect(seenByOwner.headers['cache-control']).toBe('no-store')
    expect(seenByOwner.body).not.toContain('principalId')
    expect(seenByOwner.json).toEqual({
      comments: [{ ...created.json, author: { kind: 'invited', name: 'Maria', verified: true, self: false } }],
      nextCursor: null,
    })
    expect((await list(maria))[0]).toMatchObject({ author: { self: true }, canDelete: true })
    const ana = await join('Ana')
    expect((await list(ana))[0]).toMatchObject({ author: { self: false }, canDelete: false })

    expect((await h.admin.listEvents({ artifactId: id })).filter((event) => event.kind === 'comment_added')).toEqual([
      expect.objectContaining({ data: { name: 'Maria' } }),
    ])
    expect(h.onActivity).toHaveBeenCalledWith(id, 'comment_added')
    expect((await h.admin.get(id))?.openComments).toBe(1)
  })

  it('takes comments placed on a spot of the page', async () => {
    const point = { selector: 'body > p:nth-of-type(1)', rx: 0.4, ry: 0.5 }
    const created = await post(maria, 'Here?', { anchor: { point } })
    expect(created.status).toBe(201)
    expect(created.json.anchor).toEqual({ point })
    expect((await post(maria, 'Both', { anchor: { point, quote } })).status).toBe(400)
    expect((await post(maria, 'Off the box', { anchor: { point: { ...point, rx: 2 } } })).status).toBe(400)
  })

  it('records the owner’s comments and replies as the owner’s, without an event', async () => {
    const top = await post(owner, 'From the owner')
    expect(top.json).toMatchObject({ author: { kind: 'owner', name: 'Antonio', verified: true, self: true } })
    const reply = await maria.send('POST', `${api}/comments/${top.json.id}/replies`, { body: 'Thanks' })
    expect(reply.status).toBe(201)
    expect(reply.json).toMatchObject({ parentId: top.json.id, version: 1, anchor: null, author: { name: 'Maria' } })
    expect((await list(owner)).map((item) => item.body)).toEqual(['From the owner', 'Thanks'])
    expect(
      (await h.admin.listEvents({ artifactId: id })).filter((event) => event.kind === 'comment_added')
    ).toHaveLength(1)
    expect((await maria.send('POST', `${api}/comments/${MISSING}/replies`, { body: 'Nowhere' })).status).toBe(404)
    expect((await maria.send('POST', `${api}/comments/${reply.json.id}/replies`, { body: 'Nested' })).status).toBe(404)
  })

  it('asks a guest for a name before the first comment, and marks it unverified', async () => {
    const guest = h.browser()
    expect((await guest.send('POST', `${api}/session/code`, {})).status).toBe(204)
    const refused = await post(guest, 'Anonymous')
    expect(refused.status).toBe(409)
    expect(refused.json).toEqual({ error: 'name_required' })
    expect((await guest.send('PUT', `${api}/session/name`, { name: 'Ana' })).status).toBe(204)
    const created = await post(guest, 'From a guest')
    expect(created.status).toBe(201)
    expect(created.json.author).toEqual({ kind: 'guest', name: 'Ana', verified: false, self: true })
  })

  it('lets only the owner resolve and reopen', async () => {
    const { json: comment } = await post(maria, 'Question')
    const resolve = (browser: Browser, resolved: unknown) =>
      browser.send('POST', `${api}/comments/${comment.id}/resolve`, { resolved })
    expect((await resolve(maria, true)).status).toBe(403)
    expect((await resolve(owner, 'yes')).status).toBe(400)
    expect((await resolve(owner, true)).status).toBe(204)
    expect((await list(maria))[0].status).toBe('resolved')
    expect((await h.admin.get(id))?.openComments).toBe(0)
    expect((await resolve(owner, false)).status).toBe(204)
    expect((await list(maria))[0].status).toBe('open')
    expect((await owner.send('POST', `${api}/comments/${MISSING}/resolve`, { resolved: true })).status).toBe(404)
  })

  it('lets people delete their own comments, and the owner any', async () => {
    const mine = (await post(maria, 'Mine')).json
    const ana = await join('Ana')
    const hers = (await post(ana, 'Hers')).json
    expect((await maria.send('DELETE', `${api}/comments/${hers.id}`)).status).toBe(403)
    expect((await maria.send('DELETE', `${api}/comments/${mine.id}`)).status).toBe(204)
    expect((await maria.send('DELETE', `${api}/comments/${mine.id}`)).status).toBe(404)
    expect((await owner.send('DELETE', `${api}/comments/${hers.id}`)).status).toBe(204)
    expect(await list(owner)).toEqual([])
    expect((await owner.send('DELETE', `${api}/comments/not-an-id`)).status).toBe(404)
  })

  it('takes no comments while they are turned off, and says so in the state', async () => {
    await post(maria, 'Before')
    await h.admin.setSharing(id, { commentsEnabled: false })
    expect((await maria.get(`${api}/state`)).json.can).toEqual({ comment: false, resolve: false })
    const refused = await post(maria, 'After')
    expect(refused.status).toBe(403)
    expect(refused.json).toEqual({ error: 'comments_disabled' })
    const top = (await list(maria))[0]
    expect((await maria.send('POST', `${api}/comments/${top.id}/replies`, { body: 'Reply' })).status).toBe(403)
    // What was written stays readable.
    expect((await list(maria)).map((item) => item.body)).toEqual(['Before'])
  })

  it('answers whoever has no access like a page that does not exist', async () => {
    const stranger = h.browser()
    const missing = await stranger.get(`/a/${MISSING}/api/comments`)
    const hidden = await stranger.get(`${api}/comments`)
    expect(hidden.status).toBe(404)
    expect(hidden.body).toBe(missing.body)
    expect((await post(stranger, 'Hello')).status).toBe(404)
    const { json: comment } = await post(maria, 'Question')
    expect((await stranger.send('DELETE', `${api}/comments/${comment.id}`)).status).toBe(404)
    expect((await stranger.send('POST', `${api}/comments/${comment.id}/resolve`, { resolved: true })).status).toBe(404)

    await h.admin.setSharing(id, { visibility: 'private' })
    expect((await maria.get(`${api}/comments`)).status).toBe(404)
    expect((await list(owner)).map((item) => item.body)).toEqual(['Question'])
  })

  it('limits comment bodies, anchors and request size', async () => {
    expect((await post(maria, 'x'.repeat(MAX_COMMENT_CHARS + 1))).status).toBe(400)
    expect((await post(maria, '')).status).toBe(400)
    expect((await post(maria, 'ok', { anchor: { quote: { ...quote, exact: 'x'.repeat(501) } } })).status).toBe(400)
    expect((await post(maria, 'ok', { version: 9 })).status).toBe(404)
    expect((await post(maria, 'ok', { version: 'one' })).status).toBe(400)
    expect((await post(maria, 'x'.repeat(70_000))).status).toBe(413)
    expect((await post(maria, 'x'.repeat(MAX_COMMENT_CHARS))).status).toBe(201)
  })

  it('pages through comments with a cursor', async () => {
    for (let n = 0; n < 3; n++) await post(maria, `Comment ${n}`)
    const first = await maria.get(`${api}/comments?limit=2`)
    expect(first.json.comments.map((item: { body: string }) => item.body)).toEqual(['Comment 0', 'Comment 1'])
    const rest = await maria.get(`${api}/comments?cursor=${first.json.nextCursor}`)
    expect(rest.json).toMatchObject({ comments: [{ body: 'Comment 2' }], nextCursor: null })
    expect((await maria.get(`${api}/comments?cursor=abc`)).status).toBe(400)
  })

  it('refuses writes that do not come from the viewer', async () => {
    const body = JSON.stringify({ version: 1, body: 'Forged' })
    const cookie = [...maria.cookies].map(([name, value]) => `${name}=${value}`).join('; ')
    const base = { cookie, 'content-type': 'application/json', 'x-maestrly-artifact': '1', origin: h.origin }
    const { origin: _origin, ...withoutOrigin } = base
    const { 'x-maestrly-artifact': _header, ...withoutHeader } = base
    for (const headers of [withoutOrigin, withoutHeader, { ...base, origin: 'http://evil.test' }])
      expect((await maria.raw('POST', `${api}/comments`, { headers, body })).status).toBe(403)
    expect(await list(owner)).toEqual([])
  })
})
