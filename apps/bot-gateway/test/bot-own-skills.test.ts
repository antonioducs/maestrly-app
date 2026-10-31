import type http from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { harness } from './harness.js'

afterEach(() => vi.restoreAllMocks())

const skill = {
  name: 'make-animation',
  description: 'Use when animating.',
  status: 'active',
  createdBy: 'bot',
  lastEditedBy: 'bot',
  createdAt: 1,
  updatedAt: 1,
  revision: 2,
  locked: false,
  files: 1,
  hasScripts: false,
  uses: 3,
  lastUsedAt: 4,
  shadowed: false,
  proposal: null,
}
const detail = {
  ...skill,
  currentFiles: [
    { path: 'SKILL.md', content: '---\nname: make-animation\ndescription: Use when animating.\n---\nDo.' },
  ],
  proposalFiles: null,
  versions: [{ id: 'v-1', at: 1, actor: 'bot', action: 'create', reason: 'Learned', paths: ['SKILL.md'] }],
}

/** An environment whose instance serves `bot-own-skills`, recording what the gateway asked it. */
async function environment(
  options: { capabilities?: string[]; answer?: (req: http.IncomingMessage, body: string) => [number, unknown] } = {}
) {
  const asked: Array<{ method: string; url: string; body: string }> = []
  const h = await harness(Date.now, {
    environments: true,
    instanceCapabilities: options.capabilities ?? ['bot-own-skills'],
    instanceRoutes: (req, res) => {
      if (!/^\/v1\/bots\/[^/]+\/own-skills(\/|$)/.test(req.url ?? '')) return false
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8')
        asked.push({ method: req.method!, url: req.url!, body })
        const [status, answer] = options.answer?.(req, body) ?? [200, answerFor(req)]
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(answer))
      })
      return true
    },
  })
  return { h, asked }
}
function answerFor(req: http.IncomingMessage): unknown {
  const url = req.url ?? ''
  if (/\/versions\//.test(url)) return { files: detail.currentFiles }
  if (/\/own-skills$/.test(url)) return { review: req.method === 'PATCH' ? 'approve' : 'auto', skills: [skill] }
  if (req.method === 'POST') return { skill: { ...detail, locked: true, revision: 3 } }
  return detail
}

describe("a bot's own skills through the gateway", () => {
  it('advertises the feature', async () => {
    const { h } = await environment()
    expect((await (await h.request('GET', '/v1/meta')).json()).moreFeatures).toContain('bot-own-skills')
  })

  it("forwards the owner's reads and changes to the bot's environment, under its own id", async () => {
    const { h, asked } = await environment()
    const base = `/v1/bots/${h.bot.id}/own-skills`
    const listed = await h.request('GET', base)
    expect(listed.status).toBe(200)
    expect(listed.headers.get('cache-control')).toBe('private, no-store')
    expect(await listed.json()).toEqual({ review: 'auto', skills: [skill] })
    expect(await (await h.request('PATCH', base, { review: 'approve' })).json()).toMatchObject({ review: 'approve' })
    expect(await (await h.request('GET', `${base}/make-animation`)).json()).toEqual(detail)
    expect(await (await h.request('GET', `${base}/make-animation/versions/v-1`)).json()).toEqual({
      files: detail.currentFiles,
    })
    const locked = await h.request('POST', `${base}/make-animation`, { action: 'lock', revision: 2 })
    expect(locked.status).toBe(200)
    expect((await locked.json()).skill).toMatchObject({ locked: true, revision: 3 })
    expect(asked.map(({ method, url }) => `${method} ${url}`)).toEqual([
      `GET ${base}`,
      `PATCH ${base}`,
      `GET ${base}/make-animation`,
      `GET ${base}/make-animation/versions/v-1`,
      `POST ${base}/make-animation`,
    ])
    expect(JSON.parse(asked.at(-1)!.body)).toEqual({ action: 'lock', revision: 2 })
  })

  it('refuses bad names and requests before reaching the environment', async () => {
    const { h, asked } = await environment()
    const base = `/v1/bots/${h.bot.id}/own-skills`
    expect((await h.request('GET', `${base}/Not_A_Skill`)).status).toBe(404)
    expect((await h.request('GET', `${base}/make-animation/versions/v.1`)).status).toBe(404)
    expect((await h.request('POST', `${base}/make-animation`, { action: 'lock' })).status).toBe(400)
    expect(
      (await h.request('POST', `${base}/make-animation`, { action: 'remove-file', revision: 1, path: '../x' })).status
    ).toBe(400)
    expect((await h.request('PATCH', base, { review: 'later' })).status).toBe(400)
    expect((await h.request('GET', '/v1/bots/missing/own-skills')).status).toBe(404)
    expect(asked).toEqual([])
  })

  it("passes on the environment's refusals, and a reply that is not a skill is not passed on", async () => {
    let reply: [number, unknown] = [409, { code: 'CONFLICT', message: 'The skill changed since you opened it.' }]
    const { h } = await environment({ answer: () => reply })
    const path = `/v1/bots/${h.bot.id}/own-skills/make-animation`
    const conflict = await h.request('POST', path, { action: 'archive', revision: 1 })
    expect(conflict.status).toBe(409)
    expect(await conflict.json()).toMatchObject({ code: 'CONFLICT', message: expect.stringContaining('changed since') })
    reply = [404, { code: 'NOT_FOUND', message: 'The bot has no such skill or version.' }]
    expect((await h.request('GET', path)).status).toBe(404)
    reply = [200, { ...detail, secret: 'x' }]
    expect((await h.request('GET', path)).status).toBe(503)
  })

  it('asks to update a bot whose environment predates it', async () => {
    const { h, asked } = await environment({ capabilities: [] })
    const response = await h.request('GET', `/v1/bots/${h.bot.id}/own-skills`)
    expect(response.status).toBe(426)
    expect(await response.json()).toMatchObject({ code: 'PROTOCOL_INCOMPATIBLE' })
    expect(asked).toEqual([])
  })
})
