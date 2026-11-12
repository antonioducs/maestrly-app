import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openWhiteboardViewer } from '../src/whiteboard-viewer.js'
import { type Browser, type Harness, startHarness } from './http-harness.js'
import { tempDir } from './helpers.js'

let h: Harness
let id: string
let revision: number
let cleanup: () => void
let viewerDir: string

const VIEWER_HTML = '<!doctype html><html><head><title>Board</title></head><body><div id="root"></div></body></html>'

beforeEach(async () => {
  const temp = tempDir()
  cleanup = temp.cleanup
  viewerDir = path.join(temp.dir, 'viewer')
  mkdirSync(path.join(viewerDir, 'assets'), { recursive: true })
  writeFileSync(path.join(viewerDir, 'index.html'), VIEWER_HTML)
  writeFileSync(path.join(viewerDir, 'assets', 'a.js'), 'console.log(1)')
  writeFileSync(path.join(temp.dir, 'secret.js'), 'secret')
  symlinkSync(path.join(temp.dir, 'secret.js'), path.join(viewerDir, 'assets', 'linked.js'))
  h = await startHarness({ whiteboardViewer: await openWhiteboardViewer(viewerDir), boardPollMs: 200 })
  const created = await h.admin.createBoard({
    title: 'Board',
    owner: { kind: 'local', id: 'local' },
    origin: { workspaceId: null, conversationId: 'c1', conversationTitle: null },
    ops: [
      { op: 'card', id: 'a', text: 'A' },
      { op: 'card', id: 'b', text: 'B', at: { near: 'a', side: 'right' } },
    ],
  })
  id = created.detail.id
  revision = created.revision
})
afterEach(async () => {
  await h.close()
  cleanup()
})

const api = () => `/a/${id}/api`
const elementsOf = async (browser: Browser) => (await browser.get(`${api()}/board`)).json.elements as any[]
const moved = (element: any, dx: number) => ({
  ...element,
  x: element.x + dx,
  version: element.version + 1,
  versionNonce: element.versionNonce + 1,
})

async function guest(): Promise<Browser> {
  await h.admin.setSharing(id, { visibility: 'link' })
  const browser = h.browser()
  expect((await browser.send('POST', `${api()}/session/code`, {})).status).toBe(204)
  return browser
}

describe('whiteboard API', () => {
  it('gives the owner the live board and lets them edit it', async () => {
    const owner = await h.owner(id)
    const reply = await owner.get(`${api()}/board`)
    expect(reply.status).toBe(200)
    expect(reply.json.revision).toBe(revision)
    expect(reply.json.canEdit).toBe(true)
    const live = (await h.admin.exportArtifact(id)).board!.elements.filter((stored) => !stored.element.isDeleted)
    expect(reply.json.elements).toHaveLength(live.length)
    expect(live.length).toBeGreaterThanOrEqual(4)
  })

  it('takes a person’s edit only from the viewer, and reports it to the next poll at once', async () => {
    const owner = await h.owner(id)
    const card = (await elementsOf(owner)).find((element) => element.id === 'a')
    const body = { elements: [moved(card, 300)] }
    expect((await owner.send('POST', `${api()}/board/elements`, body, { 'x-maestrly-artifact': '' })).status).toBe(403)
    const pushed = await owner.send('POST', `${api()}/board/elements`, body)
    expect(pushed.status).toBe(200)
    expect(pushed.json).toEqual({ revision: revision + 1, kept: [] })
    const changes = await owner.get(`${api()}/board/changes?since=${revision}`)
    expect(changes.status).toBe(200)
    expect(changes.json.revision).toBe(revision + 1)
    expect(changes.json.elements.map((element: any) => [element.id, element.x])).toEqual([['a', card.x + 300]])
    const read = await h.admin.readBoard(id, { since: revision })
    expect(read.outline.changes?.byPerson).toEqual(['a'])
  })

  it('sends back the board copy of what a canvas sent out of date', async () => {
    const owner = await h.owner(id)
    const card = (await elementsOf(owner)).find((element) => element.id === 'a')
    await owner.send('POST', `${api()}/board/elements`, { elements: [moved(card, 300)] })
    const stale = await owner.send('POST', `${api()}/board/elements`, { elements: [card] })
    expect(stale.json.revision).toBe(revision + 1)
    expect(stale.json.kept.map((element: any) => [element.id, element.x])).toEqual([['a', card.x + 300]])
  })

  it('holds a poll until the agent changes the board', async () => {
    const owner = await h.owner(id)
    const started = Date.now()
    const poll = owner.get(`${api()}/board/changes?since=${revision}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
    await h.admin.applyBoard({ id, baseRevision: revision, ops: [{ op: 'update', id: 'b', text: 'Changed' }] })
    const reply = await poll
    expect(Date.now() - started).toBeLessThan(1000)
    expect(reply.json.revision).toBe(revision + 1)
    expect(reply.json.elements.some((element: any) => element.text === 'Changed')).toBe(true)
  })

  it('answers a poll with nothing when the board does not change', async () => {
    const owner = await h.owner(id)
    const started = Date.now()
    const reply = await owner.get(`${api()}/board/changes?since=${revision}`)
    expect(Date.now() - started).toBeGreaterThanOrEqual(150)
    expect(reply.json).toEqual({ revision, elements: [] })
  })

  it('refuses a revision the board does not have', async () => {
    const owner = await h.owner(id)
    for (const since of [String(revision + 1), '-1', 'x', ''])
      expect((await owner.get(`${api()}/board/changes?since=${since}`)).status).toBe(400)
  })

  it('shows a guest the board and keeps it read-only while only the owner may edit', async () => {
    const visitor = await guest()
    const reply = await visitor.get(`${api()}/board`)
    expect(reply.status).toBe(200)
    expect(reply.json.canEdit).toBe(false)
    const card = reply.json.elements[0]
    const pushed = await visitor.send('POST', `${api()}/board/elements`, { elements: [moved(card, 10)] })
    expect(pushed.status).toBe(403)
    expect(pushed.json.error).toBe('read_only')
  })

  it('refuses invalid elements and bodies above the push limit', async () => {
    const owner = await h.owner(id)
    const invalid = await owner.send('POST', `${api()}/board/elements`, { elements: [{ id: 'a', type: 'rocket' }] })
    expect(invalid.status).toBe(400)
    expect(invalid.json.error).toBe('invalid_elements')
    const big = await owner.send('POST', `${api()}/board/elements`, { elements: [], padding: 'x'.repeat(950 * 1024) })
    expect(big.status).toBe(413)
  })

  it('has no board for a page or for someone without access', async () => {
    const owner = await h.owner()
    expect((await owner.get(`/a/${h.id}/api/board`)).status).toBe(404)
    expect((await h.browser().get(`${api()}/board`)).status).toBe(404)
  })

  it('serves the host’s viewer as the whiteboard’s content, and nothing outside it', async () => {
    const owner = await h.owner(id)
    const frame = await owner.send('POST', `${api()}/frame`, { version: 1 })
    expect(frame.status).toBe(200)
    const base = String(frame.json.url).replace(/index\.html$/, '')
    const page = await owner.raw('GET', frame.json.url)
    expect(page.status).toBe(200)
    expect(page.body).toContain('<div id="root"></div>')
    expect(page.body).toContain('_maestrly/bridge.js')
    expect(page.headers['content-security-policy']).toContain('sandbox')
    expect((await owner.raw('GET', `${base}assets/a.js`)).body).toBe('console.log(1)')
    for (const target of ['..%2f..%2fsecret.js', '../secret.js', 'assets/linked.js', 'missing.js'])
      expect((await owner.raw('GET', `${base}${target}`)).status).toBe(404)
  })

  it('answers waiting polls when the server closes, instead of cutting them', async () => {
    const owner = await h.owner(id)
    const poll = owner.get(`${api()}/board/changes?since=${revision}`).catch(() => null)
    await new Promise((resolve) => setTimeout(resolve, 50))
    const started = Date.now()
    await h.server.close()
    const reply = await poll
    expect(Date.now() - started).toBeLessThan(500)
    expect(reply?.status).toBe(200)
    expect(reply?.json).toEqual({ revision, elements: [] })
  })
})
