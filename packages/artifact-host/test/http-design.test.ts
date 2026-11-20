import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { text, utf8 } from './helpers.js'
import { type Browser, type Harness, startHarness } from './http-harness.js'

let h: Harness
let id: string
let api: string
let owner: Browser
let maria: Browser

const TOKENS_CSS = [
  '/* Design tokens */',
  ':root {',
  '  --color-brand: #2563eb;',
  '  --space-md: 16px;',
  '}',
  '[data-theme="dark"] {',
  '  --color-brand: #60a5fa;',
  '}',
  '',
].join('\n')

const MANIFEST_JSON = JSON.stringify({
  schema: 'maestrly-prototype/v1',
  title: 'Checkout Flow',
  tokens: ['tokens.css'],
  components: 'components.html',
  screens: [
    { id: 'home', name: 'Home', path: 'index.html#/home', viewport: 'desktop' },
    { id: 'mobile', name: 'Mobile', path: 'index.html#/mobile', viewport: 'mobile' },
  ],
  componentTokens: {
    PrimaryButton: ['--color-brand', '--space-md'],
  },
})

async function createDesignArtifact(): Promise<string> {
  const created = await h.admin.create({
    title: 'Checkout Prototype',
    owner: { kind: 'local', id: 'local' },
    origin: { workspaceId: null, conversationId: 'c1', conversationTitle: null },
    files: [
      {
        path: 'index.html',
        bytes: utf8(
          '<!doctype html><html><head><link rel="stylesheet" href="tokens.css" crossorigin></head><body><button data-ds="PrimaryButton">Pay</button></body></html>'
        ),
      },
      {
        path: 'components.html',
        bytes: utf8('<!doctype html><html><body><div data-ds="PrimaryButton" data-ds-main>Pay</div></body></html>'),
      },
      { path: 'tokens.css', bytes: utf8(TOKENS_CSS) },
      { path: 'maestrly-design.json', bytes: utf8(MANIFEST_JSON) },
    ],
  })
  return created.id
}

async function join(artifactId: string, name: string): Promise<Browser> {
  const { token } = await h.admin.createInvite(artifactId, { name })
  const browser = h.browser()
  expect((await browser.send('POST', `/a/${artifactId}/api/session/invite`, { token })).status).toBe(204)
  return browser
}

beforeEach(async () => {
  h = await startHarness()
  id = await createDesignArtifact()
  api = `/a/${id}/api`
  await h.admin.setSharing(id, { visibility: 'link' })
  owner = await h.owner(id)
  maria = await join(id, 'Maria')
})
afterEach(() => h.close())

describe('GET /a/:id/api/design', () => {
  it('returns parsed ViewerDesign for design artifacts, null for plain pages, and enforces viewer header & history access', async () => {
    const res = await owner.get(`${api}/design`)
    expect(res.status).toBe(200)
    expect(res.json).toEqual({
      design: {
        title: 'Checkout Flow',
        tokenFile: 'tokens.css',
        allTokenFiles: ['tokens.css'],
        componentsPath: 'components.html',
        screens: [
          { id: 'home', name: 'Home', path: 'index.html#/home', viewport: 'desktop' },
          { id: 'mobile', name: 'Mobile', path: 'index.html#/mobile', viewport: 'mobile' },
        ],
        componentTokens: { PrimaryButton: ['--color-brand', '--space-md'] },
        tokens: [
          {
            name: '--color-brand',
            group: 'color',
            kind: 'color',
            value: '#2563eb',
            themes: { '[data-theme="dark"]': '#60a5fa' },
          },
          {
            name: '--space-md',
            group: 'space',
            kind: 'length',
            value: '16px',
            themes: {},
          },
        ],
        themes: ['[data-theme="dark"]'],
      },
    })

    // Plain artifact without maestrly-design.json returns { design: null }
    const plainOwner = await h.owner(h.id)
    const plainRes = await plainOwner.get(`/a/${h.id}/api/design`)
    expect(plainRes.status).toBe(200)
    expect(plainRes.json).toEqual({ design: null })

    // Missing X-Maestrly-Artifact header -> 403
    const cookieStr = [...owner.cookies].map(([k, v]) => `${k}=${v}`).join('; ')
    const noHeader = await owner.raw('GET', `${api}/design`, { headers: { cookie: cookieStr } })
    expect(noHeader.status).toBe(403)

    // Unauthenticated stranger -> 404
    expect((await h.browser().get(`${api}/design`)).status).toBe(404)

    // Invalid version query -> 400; missing version -> 404
    expect((await owner.get(`${api}/design?version=abc`)).status).toBe(400)
    expect((await owner.get(`${api}/design?version=99`)).status).toBe(404)
  })
})

describe('POST /a/:id/api/tokens', () => {
  it('lets only the owner save token edits as a new version, preserving comments/formatting and enforcing CSRF + rate limits', async () => {
    // Non-owner invited person -> 403
    const mariaSave = await maria.send('POST', `${api}/tokens`, {
      baseVersion: 1,
      changes: [{ name: '--color-brand', value: '#ff5500' }],
    })
    expect(mariaSave.status).toBe(403)

    // Guest -> 403
    const guest = h.browser()
    await guest.send('POST', `${api}/session/code`, {})
    expect(
      (
        await guest.send('POST', `${api}/tokens`, {
          baseVersion: 1,
          changes: [{ name: '--color-brand', value: '#ff5500' }],
        })
      ).status
    ).toBe(403)

    // Wrong Origin -> 403; missing X-Maestrly-Artifact -> 403
    const cookieStr = [...owner.cookies].map(([k, v]) => `${k}=${v}`).join('; ')
    expect(
      (
        await owner.raw('POST', `${api}/tokens`, {
          headers: {
            cookie: cookieStr,
            origin: 'https://evil.example',
            'x-maestrly-artifact': '1',
            'content-type': 'application/json',
          },
          body: JSON.stringify({ baseVersion: 1, changes: [{ name: '--color-brand', value: '#ff5500' }] }),
        })
      ).status
    ).toBe(403)
    expect(
      (
        await owner.raw('POST', `${api}/tokens`, {
          headers: {
            cookie: cookieStr,
            origin: h.origin,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ baseVersion: 1, changes: [{ name: '--color-brand', value: '#ff5500' }] }),
        })
      ).status
    ).toBe(403)

    // Plain artifact without design contract -> 409 no_design_contract
    const plainOwner = await h.owner(h.id)
    const noContract = await plainOwner.send('POST', `/a/${h.id}/api/tokens`, {
      baseVersion: 1,
      changes: [{ name: '--color-brand', value: '#ff5500' }],
    })
    expect(noContract.status).toBe(409)
    expect(noContract.json).toEqual({ error: 'no_design_contract' })

    // Owner saves root + dark theme token changes -> 201 with ViewerVersion & updated ViewerDesign
    const saved = await owner.send('POST', `${api}/tokens`, {
      baseVersion: 1,
      changes: [
        { name: '--color-brand', value: '#1d4ed8' },
        { name: '--color-brand', theme: '[data-theme="dark"]', value: '#93c5fd' },
      ],
    })
    expect(saved.status).toBe(201)
    expect(saved.json.version).toEqual({
      number: 2,
      createdAt: h.clock.now(),
      summary: 'Tokens: --color-brand #2563eb → #1d4ed8, --color-brand ([data-theme="dark"]) #60a5fa → #93c5fd',
    })
    expect(saved.json.design.tokens[0]).toEqual({
      name: '--color-brand',
      group: 'color',
      kind: 'color',
      value: '#1d4ed8',
      themes: { '[data-theme="dark"]': '#93c5fd' },
    })

    // Verify stored version 2 createdBy='owner' and exact byte preservation outside edited spans
    const detail = await h.admin.get(id)
    expect(detail?.versions.find((v) => v.number === 2)?.createdBy).toBe('owner')
    const fileV2 = await h.admin.readFile(id, 2, 'tokens.css')
    expect(text(fileV2!.bytes)).toBe(
      [
        '/* Design tokens */',
        ':root {',
        '  --color-brand: #1d4ed8;',
        '  --space-md: 16px;',
        '}',
        '[data-theme="dark"] {',
        '  --color-brand: #93c5fd;',
        '}',
        '',
      ].join('\n')
    )

    // Stale baseVersion -> 409 version_conflict
    const stale = await owner.send('POST', `${api}/tokens`, {
      baseVersion: 1,
      changes: [{ name: '--space-md', value: '20px' }],
    })
    expect(stale.status).toBe(409)
    expect(stale.json).toEqual({ error: 'version_conflict', currentVersion: 2 })

    // Non-history viewer reading replaced v1 design -> 409 version_replaced
    const replaced = await maria.get(`${api}/design?version=1`)
    expect(replaced.status).toBe(409)
    expect(replaced.json).toEqual({ error: 'version_replaced' })

    // Rate limit: tokenSave allows 20 requests/min per artifact (2 already used above by saved + stale, 18 more allowed, 21st -> 429)
    for (let i = 0; i < 18; i++) {
      const r = await owner.send('POST', `${api}/tokens`, {
        baseVersion: 1,
        changes: [{ name: '--space-md', value: `${20 + i}px` }],
      })
      expect(r.status).toBe(409)
    }
    const limited = await owner.send('POST', `${api}/tokens`, {
      baseVersion: 2,
      changes: [{ name: '--space-md', value: '24px' }],
    })
    expect(limited.status).toBe(429)
    expect(limited.json).toEqual({ error: 'rate_limited' })
  })
})

describe('token suggestions on comments & POST /a/:id/api/comments/:id/apply', () => {
  it('validates suggestions, auto-fills empty bodies, enforces comment rules, and applies suggestions cleanly across versions', async () => {
    // Unnamed guest -> 409 name_required
    const guest = h.browser()
    await guest.send('POST', `${api}/session/code`, {})
    const unnamed = await guest.send('POST', `${api}/comments`, {
      version: 1,
      body: '',
      suggestion: { changes: [{ name: '--color-brand', value: '#e11d48' }] },
    })
    expect(unnamed.status).toBe(409)
    expect(unnamed.json).toEqual({ error: 'name_required' })

    // Named guest submits suggestion with empty body -> auto-summary & server-derived file/from!
    await guest.send('PUT', `${api}/session/name`, { name: 'Ana' })
    const created = await guest.send('POST', `${api}/comments`, {
      version: 1,
      body: '   ',
      suggestion: {
        changes: [
          { name: '--color-brand', value: '#e11d48' },
          { name: '--color-brand', theme: '[data-theme="dark"]', value: '#fb7185' },
        ],
      },
    })
    expect(created.status).toBe(201)
    expect(created.json).toMatchObject({
      body: 'Tokens: --color-brand #2563eb → #e11d48, --color-brand ([data-theme="dark"]) #60a5fa → #fb7185',
      status: 'open',
      suggestion: {
        file: 'tokens.css',
        changes: [
          { name: '--color-brand', from: '#2563eb', to: '#e11d48' },
          { name: '--color-brand', theme: '[data-theme="dark"]', from: '#60a5fa', to: '#fb7185' },
        ],
        appliedVersion: null,
      },
    })

    // Replies with suggestion -> 400; unknown token -> 400; unchanged value -> 400; unsafe value -> 400
    expect(
      (
        await maria.send('POST', `${api}/comments/${created.json.id}/replies`, {
          body: 'Reply',
          suggestion: { changes: [{ name: '--space-md', value: '20px' }] },
        })
      ).status
    ).toBe(400)
    expect(
      (
        await maria.send('POST', `${api}/comments`, {
          version: 1,
          body: 'Bad',
          suggestion: { changes: [{ name: '--nonexistent', value: '20px' }] },
        })
      ).status
    ).toBe(400)
    expect(
      (
        await maria.send('POST', `${api}/comments`, {
          version: 1,
          body: 'Same',
          suggestion: { changes: [{ name: '--space-md', value: '16px' }] },
        })
      ).status
    ).toBe(400)
    expect(
      (
        await maria.send('POST', `${api}/comments`, {
          version: 1,
          body: 'Url',
          suggestion: { changes: [{ name: '--space-md', value: 'url(https://evil.test)' }] },
        })
      ).status
    ).toBe(400)

    // Comments disabled -> 403 comments_disabled
    await h.admin.setSharing(id, { commentsEnabled: false })
    const disabledRes = await maria.send('POST', `${api}/comments`, {
      version: 1,
      body: 'While off',
      suggestion: { changes: [{ name: '--space-md', value: '20px' }] },
    })
    expect(disabledRes.status).toBe(403)
    expect(disabledRes.json).toEqual({ error: 'comments_disabled' })
    await h.admin.setSharing(id, { commentsEnabled: true })

    // Non-owner cannot apply suggestion -> 403
    expect((await maria.send('POST', `${api}/comments/${created.json.id}/apply`, { baseVersion: 1 })).status).toBe(403)

    // Intermediate version touching ANOTHER token (--space-md) does not block applying Ana's --color-brand suggestion!
    const v2 = await owner.send('POST', `${api}/tokens`, {
      baseVersion: 1,
      changes: [{ name: '--space-md', value: '24px' }],
    })
    expect(v2.status).toBe(201)

    // Stale baseVersion on apply -> 409 version_conflict
    expect((await owner.send('POST', `${api}/comments/${created.json.id}/apply`, { baseVersion: 1 })).json).toEqual({
      error: 'version_conflict',
      currentVersion: 2,
    })

    // Apply on currentVersion=2 -> 200 creates v3, marks suggestion appliedVersion=3 and status='resolved'
    // Version summary lists only validated token names — never third-party author names or proposed values!
    const applied = await owner.send('POST', `${api}/comments/${created.json.id}/apply`, { baseVersion: 2 })
    expect(applied.status).toBe(200)
    expect(applied.json.version.number).toBe(3)
    expect(applied.json.version.summary).toBe('Applied a token suggestion: --color-brand')
    expect(applied.json.version.summary).not.toContain('Ana')
    expect(applied.json.version.summary).not.toContain('#e11d48')
    expect(applied.json.comment).toMatchObject({
      id: created.json.id,
      status: 'resolved',
      suggestion: {
        file: 'tokens.css',
        appliedVersion: 3,
      },
    })

    // Second apply -> 409 already_applied
    const secondApply = await owner.send('POST', `${api}/comments/${created.json.id}/apply`, { baseVersion: 3 })
    expect(secondApply.status).toBe(409)
    expect(secondApply.json).toEqual({ error: 'already_applied' })

    // Conflict case: Maria suggests changing --space-md (24px -> 32px), then owner changes --space-md to 40px first -> 409 suggestion_conflict
    const mariaSuggest = await maria.send('POST', `${api}/comments`, {
      version: 3,
      body: 'Bigger spacing',
      suggestion: { changes: [{ name: '--space-md', value: '32px' }] },
    })
    expect(mariaSuggest.status).toBe(201)
    await owner.send('POST', `${api}/tokens`, {
      baseVersion: 3,
      changes: [{ name: '--space-md', value: '40px' }],
    })
    const conflictApply = await owner.send('POST', `${api}/comments/${mariaSuggest.json.id}/apply`, {
      baseVersion: 4,
    })
    expect(conflictApply.status).toBe(409)
    expect(conflictApply.json).toEqual({ error: 'suggestion_conflict' })

    // Already-matching value case: Maria suggests --space-md: 12px on v4, owner manually saves 12px as v5, then applies Maria's comment -> resolves with appliedVersion=5 without creating v6!
    const matchingSuggest = await maria.send('POST', `${api}/comments`, {
      version: 4,
      body: 'Compact spacing',
      suggestion: { changes: [{ name: '--space-md', value: '12px' }] },
    })
    expect(matchingSuggest.status).toBe(201)
    await owner.send('POST', `${api}/tokens`, {
      baseVersion: 4,
      changes: [{ name: '--space-md', value: '12px' }],
    })
    const noOpApply = await owner.send('POST', `${api}/comments/${matchingSuggest.json.id}/apply`, {
      baseVersion: 5,
    })
    expect(noOpApply.status).toBe(200)
    expect(noOpApply.json.version.number).toBe(5)
    expect(noOpApply.json.comment.suggestion.appliedVersion).toBe(5)
    expect(noOpApply.json.comment.status).toBe('resolved')
    expect((await h.admin.get(id))?.currentVersion).toBe(5)
  })
})
