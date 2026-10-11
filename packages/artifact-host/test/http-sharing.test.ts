import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ACCESS_REQUEST_TTL_MS, MAX_DEVICES_PER_PRINCIPAL, MAX_PENDING_REQUESTS } from '../src/limits.js'
import { type Browser, type Harness, startHarness } from './http-harness.js'

let h: Harness
let id: string
let api: string

const MISSING = 'A'.repeat(22)

beforeEach(async () => {
  h = await startHarness()
  id = h.id
  api = `/a/${id}/api`
})
afterEach(() => h.close())

async function invite(name = 'Maria'): Promise<{ principalId: string; token: string }> {
  return h.admin.createInvite(id, { name })
}

async function join(token: string, browser: Browser = h.browser()): Promise<Browser> {
  const reply = await browser.send('POST', `${api}/session/invite`, { token })
  expect(reply.status).toBe(204)
  return browser
}

async function contentUrl(browser: Browser): Promise<string> {
  const reply = await browser.send('POST', `${api}/frame`, { version: 1 })
  expect(reply.status).toBe(200)
  return reply.json.url as string
}

const events = async () => (await h.admin.listEvents({ artifactId: id })).map((event) => [event.kind, event.data])

describe('personal links', () => {
  beforeEach(() => h.admin.setSharing(id, { visibility: 'people' }))

  it('previews the invitation without joining, then joins on request', async () => {
    const { token } = await invite()
    const maria = h.browser()
    const preview = await maria.send('POST', `${api}/invite/preview`, { token })
    expect(preview.status).toBe(200)
    expect(preview.json).toEqual({ name: 'Maria', ownerName: 'Antonio' })
    expect(maria.cookies.size).toBe(0)
    expect((await h.admin.getSharing(id)).people[0]?.devices).toEqual([])

    const joined = await maria.send(
      'POST',
      `${api}/session/invite`,
      { token },
      { 'user-agent': 'Version/17 Safari/604 iPhone' }
    )
    expect(joined.status).toBe(204)
    const cookie = joined.headers['set-cookie']?.[0] ?? ''
    expect(cookie).toContain('maestrly_artifact_session=')
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Strict')
    expect(cookie).toContain(`Path=/a/${id}/api`)

    const state = await maria.get(`${api}/state`)
    expect(state.status).toBe(200)
    expect(state.json).toMatchObject({
      artifact: { id, title: 'Probe', currentVersion: 1 },
      identity: { kind: 'invited', name: 'Maria' },
      ownerName: 'Antonio',
      can: { comment: true, resolve: false },
    })
    expect((await maria.raw('GET', await contentUrl(maria))).status).toBe(200)
    expect((await h.admin.getSharing(id)).people[0]?.devices).toEqual([
      expect.objectContaining({ label: 'Safari/iPhone' }),
    ])
    expect(await events()).toEqual([['device_added', { name: 'Maria', device: 'Safari/iPhone' }]])
    expect(h.onActivity).toHaveBeenCalledWith(id, 'device_added')
  })

  it('counts each browser as a device, up to the limit, and never the same browser twice', async () => {
    const { token } = await invite()
    const first = await join(token)
    await join(token, first)
    expect((await h.admin.getSharing(id)).people[0]?.devices).toHaveLength(1)
    for (let device = 1; device < MAX_DEVICES_PER_PRINCIPAL; device++) await join(token)
    expect((await h.admin.getSharing(id)).people[0]?.devices).toHaveLength(MAX_DEVICES_PER_PRINCIPAL)
    const refused = await h.browser().send('POST', `${api}/session/invite`, { token })
    expect(refused.status).toBe(409)
    expect(refused.json).toEqual({ error: 'too_many_devices' })
  })

  it('answers a wrong, foreign or revoked link like a page that does not exist', async () => {
    const missing = await h.browser().get(`/a/${MISSING}/api/state`)
    expect(missing.status).toBe(404)
    const { token, principalId } = await invite()
    const other = await h.createArtifact('Other')
    await h.admin.setSharing(other, { visibility: 'people' })
    const attempts = [
      await h.browser().send('POST', `${api}/session/invite`, { token: 'x'.repeat(43) }),
      await h.browser().send('POST', `/a/${other}/api/session/invite`, { token }),
      await h.browser().send('POST', `${api}/invite/preview`, { token: 'x'.repeat(43) }),
      await h.browser().send('POST', `${api}/session/invite`, { token: 42 }),
      await h.browser().send('POST', `${api}/session/invite`, {}),
    ]
    await h.admin.revokePerson(id, principalId)
    attempts.push(await h.browser().send('POST', `${api}/session/invite`, { token }))
    attempts.push(await h.browser().send('POST', `${api}/invite/preview`, { token }))
    for (const attempt of attempts) {
      expect(attempt.status).toBe(404)
      expect(attempt.body).toBe(missing.body)
      expect(attempt.headers['set-cookie']).toBeUndefined()
    }
  })

  it('refuses an invitation that expired', async () => {
    const { token } = await h.admin.createInvite(id, { name: 'Late', expiresAt: h.clock.now() + 1000 })
    const early = await join(token)
    h.clock.advance(1000)
    expect((await h.browser().send('POST', `${api}/session/invite`, { token })).status).toBe(404)
    expect((await early.get(`${api}/state`)).json).not.toHaveProperty('artifact')
  })

  it('tells the owner when someone says the link is not theirs', async () => {
    const { token } = await invite()
    const stranger = h.browser()
    expect((await stranger.send('POST', `${api}/invite/decline`, { token })).status).toBe(204)
    expect((await stranger.send('POST', `${api}/invite/decline`, { token: 'x'.repeat(43) })).status).toBe(404)
    expect(await events()).toEqual([['invite_declined', { name: 'Maria' }]])
    expect(stranger.cookies.size).toBe(0)
  })

  it('cuts access at once when the person is revoked', async () => {
    const { token, principalId } = await invite()
    const maria = await join(token)
    const url = await contentUrl(maria)
    await h.admin.revokePerson(id, principalId)
    expect((await h.admin.getSharing(id)).people).toEqual([])
    expect((await maria.get(`${api}/state`)).json).not.toHaveProperty('artifact')
    expect((await maria.send('POST', `${api}/frame`, { version: 1 })).status).toBe(404)
    expect((await maria.raw('GET', url)).status).toBe(404)
  })

  it('blocks everyone but the owner while private, and lets them back in when shared again', async () => {
    const { token } = await invite()
    const maria = await join(token)
    const owner = await h.owner()
    const url = await contentUrl(maria)
    await h.admin.setSharing(id, { visibility: 'private' })
    const blocked = await maria.get(`${api}/state`)
    expect(blocked.status).toBe(404)
    expect(blocked.body).toBe((await h.browser().get(`/a/${MISSING}/api/state`)).body)
    expect((await maria.raw('GET', url)).status).toBe(404)
    expect((await h.browser().send('POST', `${api}/session/invite`, { token })).status).toBe(404)
    expect((await owner.get(`${api}/state`)).json.identity).toEqual({ kind: 'owner' })

    await h.admin.setSharing(id, { visibility: 'people' })
    expect((await maria.get(`${api}/state`)).json.identity).toEqual({ kind: 'invited', name: 'Maria' })
    expect((await maria.raw('GET', url)).status).toBe(200)
  })

  it('refuses writes that do not come from the viewer', async () => {
    const { token } = await invite()
    const stranger = h.browser()
    for (const path of ['invite/preview', 'invite/decline', 'session/invite', 'session/code', 'access-requests']) {
      const body = JSON.stringify({ token, name: 'X' })
      const base = { 'content-type': 'application/json', 'x-maestrly-artifact': '1', origin: h.origin }
      const { origin: _origin, ...withoutOrigin } = base
      const { 'x-maestrly-artifact': _header, ...withoutHeader } = base
      for (const headers of [
        withoutOrigin,
        withoutHeader,
        { ...base, origin: 'http://evil.test' },
        { ...base, origin: 'null' },
        { ...base, 'content-type': 'text/plain' },
      ])
        expect((await stranger.raw('POST', `${api}/${path}`, { headers, body })).status, path).toBe(403)
    }
    expect((await stranger.raw('GET', `${api}/access-requests/current`)).status).toBe(403)
    expect((await h.admin.getSharing(id)).people[0]?.devices).toEqual([])
  })
})

describe('the owner’s view of sharing', () => {
  it('summarizes who can open the page, for the owner only, with the public link', async () => {
    const shared = await startHarness({ publicOrigins: ['https://mac.example/'] })
    try {
      const api = `/a/${shared.id}/api`
      await shared.admin.setSharing(shared.id, { visibility: 'people' })
      const { token } = await shared.admin.createInvite(shared.id, { name: 'Maria' })
      // People are listed in the order they were invited.
      shared.clock.advance(1000)
      await shared.admin.createInvite(shared.id, { name: 'Ana' })
      const maria = shared.browser()
      expect((await maria.send('POST', `${api}/session/invite`, { token })).status).toBe(204)
      await shared.browser().send('POST', `${api}/access-requests`, { name: 'João' })

      const owner = await shared.owner()
      expect((await owner.get(`${api}/state`)).json.sharing).toEqual({
        visibility: 'people',
        link: `https://mac.example/a/${shared.id}`,
        local: false,
        linkExpiresAt: null,
        people: [
          { name: 'Maria', kind: 'invited', devices: 1 },
          { name: 'Ana', kind: 'invited', devices: 0 },
        ],
        peopleCount: 2,
        requests: 1,
      })
      // Nobody else learns who the page is shared with.
      expect((await maria.get(`${api}/state`)).json).not.toHaveProperty('sharing')
    } finally {
      await shared.close()
    }
  })
})

describe('the gate', () => {
  it('shows what a visitor may do, and nothing about the artifact', async () => {
    const visitor = h.browser()
    const hidden = await visitor.get(`${api}/state`)
    expect(hidden.status).toBe(404)
    expect(hidden.body).toBe((await visitor.get(`/a/${MISSING}/api/state`)).body)

    await h.admin.setSharing(id, { visibility: 'people' })
    const people = await visitor.get(`${api}/state`)
    expect(people.status).toBe(200)
    expect(people.json).toEqual({
      gate: { request: true, guest: false, code: false, pending: null },
      ownerName: 'Antonio',
    })

    await h.admin.setSharing(id, { visibility: 'link', accessCode: 'letmein1' })
    expect((await visitor.get(`${api}/state`)).json.gate).toEqual({
      request: false,
      guest: true,
      code: true,
      pending: null,
    })
    expect((await visitor.send('POST', `${api}/frame`, { version: 1 })).status).toBe(404)
  })
})

describe('access requests', () => {
  beforeEach(() => h.admin.setSharing(id, { visibility: 'people' }))

  const ask = (browser: Browser, name = 'João', message?: string) =>
    browser.send('POST', `${api}/access-requests`, message === undefined ? { name } : { name, message })

  it('waits for the owner, then turns the waiting browser into the approved person’s device', async () => {
    const joao = h.browser()
    const asked = await ask(joao, ' João ', 'Can I see it?')
    expect(asked.status).toBe(202)
    const cookie = asked.headers['set-cookie']?.[0] ?? ''
    expect(cookie).toContain('maestrly_artifact_visitor=')
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Strict')
    expect(cookie).toContain(`Path=/a/${id}/api`)
    expect((await joao.get(`${api}/access-requests/current`)).json).toEqual({ status: 'pending' })
    expect((await joao.get(`${api}/state`)).json.gate.pending).toBe('pending')
    expect(await events()).toEqual([['access_requested', { name: 'João' }]])
    expect(h.onActivity).toHaveBeenCalledWith(id, 'access_requested')

    // Asking again from the same browser does not add a second request.
    expect((await ask(joao, 'João again')).status).toBe(202)
    const [request] = (await h.admin.getSharing(id)).requests
    expect((await h.admin.getSharing(id)).requests).toHaveLength(1)
    expect(request).toMatchObject({ name: 'João', message: 'Can I see it?' })

    await h.admin.decideAccessRequest(id, request!.id, { approve: true, name: 'João Silva' })
    expect((await joao.get(`${api}/state`)).json.gate.pending).toBe('pending')
    const approved = await joao.get(`${api}/access-requests/current`)
    expect(approved.json).toEqual({ status: 'approved' })
    expect(approved.headers['set-cookie']?.[0]).toContain('maestrly_artifact_session=')
    expect((await joao.get(`${api}/state`)).json).toMatchObject({
      identity: { kind: 'approved', name: 'João Silva' },
      can: { comment: true, resolve: false },
    })
    // Checking again does not add a device.
    expect((await joao.get(`${api}/access-requests/current`)).json).toEqual({ status: 'approved' })
    expect((await h.admin.getSharing(id)).people[0]?.devices).toHaveLength(1)
    expect((await events()).map(([kind]) => kind)).toEqual(['device_added', 'access_requested'])
  })

  it('tells a denied or expired request so, without a session', async () => {
    const denied = h.browser()
    await ask(denied)
    const [request] = (await h.admin.getSharing(id)).requests
    await h.admin.decideAccessRequest(id, request!.id, { approve: false })
    expect((await denied.get(`${api}/access-requests/current`)).json).toEqual({ status: 'denied' })
    expect((await denied.get(`${api}/state`)).json.gate.pending).toBe('denied')
    expect(denied.cookies.has('maestrly_artifact_session')).toBe(false)

    // Someone approved and later revoked is out for good from that browser, like a denied request.
    const approved = h.browser()
    await ask(approved, 'Approved')
    const [pending] = (await h.admin.getSharing(id)).requests
    await h.admin.decideAccessRequest(id, pending!.id, { approve: true })
    expect((await approved.get(`${api}/access-requests/current`)).json).toEqual({ status: 'approved' })
    const [person] = (await h.admin.getSharing(id)).people
    await h.admin.revokePerson(id, person!.id)
    expect((await approved.get(`${api}/state`)).json.gate).toMatchObject({ request: true, pending: null })
    expect((await approved.get(`${api}/access-requests/current`)).status).toBe(404)
    expect((await ask(approved, 'Approved')).status).toBe(403)

    const late = h.browser()
    await ask(late, 'Late')
    h.clock.advance(ACCESS_REQUEST_TTL_MS + 1)
    expect((await late.get(`${api}/access-requests/current`)).json).toEqual({ status: 'expired' })
    expect((await late.get(`${api}/state`)).json.gate.pending).toBeNull()
    expect((await h.browser().get(`${api}/access-requests/current`)).status).toBe(404)
  })

  it('limits names, messages and the number of pending requests', async () => {
    expect((await ask(h.browser(), 'x'.repeat(61))).status).toBe(400)
    expect((await ask(h.browser(), '')).status).toBe(400)
    expect((await ask(h.browser(), 'João', 'x'.repeat(281))).status).toBe(400)
    expect((await h.browser().send('POST', `${api}/access-requests`, { name: 42 })).status).toBe(400)
    for (let n = 0; n < MAX_PENDING_REQUESTS; n++) expect((await ask(h.browser(), `Person ${n}`)).status).toBe(202)
    const refused = await ask(h.browser(), 'One too many')
    expect(refused.status).toBe(429)
    expect(refused.json).toEqual({ error: 'too_many_requests' })
  })

  it('takes no requests for a private artifact or an open link', async () => {
    await h.admin.setSharing(id, { visibility: 'private' })
    expect((await ask(h.browser())).status).toBe(404)
    await h.admin.setSharing(id, { visibility: 'link' })
    expect((await ask(h.browser())).status).toBe(404)
  })
})

describe('anyone with the link', () => {
  const enter = (browser: Browser, code?: string) =>
    browser.send('POST', `${api}/session/code`, code === undefined ? {} : { code })

  it('lets a guest in without a code, as an unnamed person who can choose a name', async () => {
    await h.admin.setSharing(id, { visibility: 'link' })
    const guest = h.browser()
    expect((await enter(guest)).status).toBe(204)
    expect((await guest.get(`${api}/state`)).json.identity).toEqual({ kind: 'guest', name: null })
    // Entering again keeps the same device.
    expect((await enter(guest)).status).toBe(204)
    expect((await h.admin.getSharing(id)).people).toHaveLength(1)

    expect((await guest.send('PUT', `${api}/session/name`, { name: ' Ana ' })).status).toBe(204)
    expect((await guest.get(`${api}/state`)).json.identity).toEqual({ kind: 'guest', name: 'Ana' })
    expect((await guest.send('PUT', `${api}/session/name`, { name: 'x'.repeat(61) })).status).toBe(400)
    expect((await h.admin.getSharing(id)).people[0]).toMatchObject({ kind: 'guest', name: 'Ana' })
    expect(await events()).toEqual([])
  })

  it('lets only guests choose their name', async () => {
    await h.admin.setSharing(id, { visibility: 'link' })
    const maria = await join((await invite()).token)
    expect((await maria.send('PUT', `${api}/session/name`, { name: 'Not Maria' })).status).toBe(403)
    expect((await (await h.owner()).send('PUT', `${api}/session/name`, { name: 'Owner' })).status).toBe(403)
    expect((await h.browser().send('PUT', `${api}/session/name`, { name: 'Nobody' })).status).toBe(404)
    expect((await maria.get(`${api}/state`)).json.identity.name).toBe('Maria')
  })

  it('asks for the access code and makes a browser wait after five wrong ones', async () => {
    await h.admin.setSharing(id, { visibility: 'link', accessCode: 'letmein1' })
    const guest = h.browser()
    for (let attempt = 0; attempt < 5; attempt++) {
      const wrong = await enter(guest, attempt === 0 ? undefined : 'wrong-code')
      expect(wrong.status).toBe(403)
      expect(wrong.json).toEqual({ error: 'wrong_code' })
    }
    expect(guest.cookies.has('maestrly_artifact_visitor')).toBe(true)
    expect(guest.cookies.has('maestrly_artifact_session')).toBe(false)
    const waiting = await enter(guest, 'letmein1')
    expect(waiting.status).toBe(429)
    expect(waiting.json).toEqual({ error: 'too_many_attempts' })
    expect(waiting.headers['retry-after']).toBe('900')

    const other = h.browser()
    expect((await enter(other, 'letmein1')).status).toBe(204)
    expect((await other.get(`${api}/state`)).json.identity).toEqual({ kind: 'guest', name: null })
    h.clock.advance(15 * 60_000)
    expect((await enter(guest, 'letmein1')).status).toBe(204)
  })

  it('closes to guests when the link expires, and stays open to invited people', async () => {
    const { token } = await invite()
    await h.admin.setSharing(id, { visibility: 'link', linkExpiresAt: h.clock.now() + 1000 })
    const maria = await join(token)
    const guest = h.browser()
    await enter(guest)
    const url = await contentUrl(guest)
    h.clock.advance(1000)
    const gone = await guest.get(`${api}/state`)
    expect(gone.json).toEqual({
      gate: { request: true, guest: false, code: false, pending: null },
      ownerName: 'Antonio',
    })
    expect((await guest.raw('GET', url)).status).toBe(404)
    expect((await enter(h.browser())).status).toBe(404)
    expect((await maria.get(`${api}/state`)).json.identity).toEqual({ kind: 'invited', name: 'Maria' })
  })

  it('takes no guests unless the artifact is shared by link', async () => {
    expect((await enter(h.browser())).status).toBe(404)
    await h.admin.setSharing(id, { visibility: 'people' })
    expect((await enter(h.browser(), 'anything')).status).toBe(404)
  })
})

describe('request limits', () => {
  it('slows down a browser that asks too often', async () => {
    await h.admin.setSharing(id, { visibility: 'people' })
    const maria = await join((await invite()).token)
    let last = 200
    for (let n = 0; n < 125 && last === 200; n++) last = (await maria.get(`${api}/state`)).status
    expect(last).toBe(429)
    h.clock.advance(60_000)
    expect((await maria.get(`${api}/state`)).status).toBe(200)
  })
})
