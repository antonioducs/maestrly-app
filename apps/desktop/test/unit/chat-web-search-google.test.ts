import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebSearchRequest } from '../../src/main/chat/web-search/types'

type Account = { accountId: string | null } | null

const h = vi.hoisted(() => ({
  account: null as Account,
  manager: { getAccountIdentity: () => ({ fingerprint: 'project:test', epoch: 1 }) },
  search: vi.fn<(args: Record<string, unknown>) => Promise<{ text: string }>>(),
  managerFor: vi.fn<(accountId: string | null) => unknown>(),
  accountFor: vi.fn<(conversationId: string) => Promise<Account>>(),
}))
vi.mock('../../src/main/chat/image-gen', () => ({ antigravityHelperAccount: h.accountFor }))
vi.mock('../../src/main/chat/antigravity-subscription/manager', () => ({
  getAntigravitySubscriptionManager: h.managerFor,
}))
vi.mock('../../src/main/chat/antigravity-subscription/web-search', () => ({
  searchWebWithAntigravityRuntime: h.search,
}))

import { createGoogleBackend } from '../../src/main/chat/web-search/google'
import { resolveGroundingLinks } from '../../src/main/chat/web-search/grounding-links'

const REDIRECT = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/'

function request(signal = new AbortController().signal): WebSearchRequest {
  return { query: 'electron vibrancy', maxResults: 5, signal, conversationId: 'conv_google', cwd: '.' }
}

/** A fetch that answers each redirect link from `targets`: a Location, a status, or a thrown error. */
function redirects(targets: Record<string, string | number | Error>) {
  return vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
    const target = targets[String(input)]
    if (target instanceof Error) throw target
    if (typeof target === 'number') return new Response(null, { status: target })
    return new Response(null, { status: 302, headers: target === undefined ? {} : { location: target } })
  })
}

beforeEach(() => {
  h.account = { accountId: null }
  h.accountFor.mockReset().mockImplementation(async () => h.account)
  h.managerFor.mockReset().mockImplementation(() => h.manager)
  h.search.mockReset().mockImplementation(async () => ({ text: '' }))
})
afterEach(() => vi.restoreAllMocks())

describe('grounding link resolution', () => {
  it('replaces every redirect with its target, looking each distinct link up once', async () => {
    const fetch = redirects({
      [`${REDIRECT}AAA=`]: 'https://docs.example.test/guide',
      [`${REDIRECT}BBB`]: 'https://blog.example.test/post',
    })
    const text = [
      `See [docs](${REDIRECT}AAA=) and [blog](${REDIRECT}BBB).`,
      `Sources:\n[1] [docs.example.test](${REDIRECT}AAA=)`,
    ].join('\n')
    expect(await resolveGroundingLinks(text, new AbortController().signal, fetch)).toBe(
      [
        'See [docs](https://docs.example.test/guide) and [blog](https://blog.example.test/post).',
        'Sources:\n[1] [docs.example.test](https://docs.example.test/guide)',
      ].join('\n')
    )
    expect(fetch).toHaveBeenCalledTimes(2)
    // Only the redirect's headers are read: the cited page is never requested.
    expect(fetch.mock.calls[0][1]).toMatchObject({ method: 'HEAD', redirect: 'manual' })
  })

  it('keeps a link it cannot resolve to an http page', async () => {
    const fetch = redirects({
      [`${REDIRECT}OK`]: 200,
      [`${REDIRECT}GONE`]: 404,
      [`${REDIRECT}NOLOCATION`]: undefined as unknown as string,
      [`${REDIRECT}SCRIPT`]: 'javascript:alert(1)',
      [`${REDIRECT}DOWN`]: new Error('network down'),
    })
    const text = ['OK', 'GONE', 'NOLOCATION', 'SCRIPT', 'DOWN'].map((id) => `${REDIRECT}${id}`).join('\n')
    expect(await resolveGroundingLinks(text, new AbortController().signal, fetch)).toBe(text)
  })

  it('escapes parentheses that would end a Markdown link early', async () => {
    const fetch = redirects({ [`${REDIRECT}WIKI`]: 'https://wiki.example.test/Node_(software)' })
    expect(await resolveGroundingLinks(`[wiki](${REDIRECT}WIKI)`, new AbortController().signal, fetch)).toBe(
      '[wiki](https://wiki.example.test/Node_%28software%29)'
    )
  })

  it('leaves links on other hosts alone', async () => {
    const fetch = redirects({})
    const text = [
      'https://docs.example.test/grounding-api-redirect/AAA',
      'https://vertexaisearch.cloud.google.com.example.test/grounding-api-redirect/AAA',
    ].join('\n')
    expect(await resolveGroundingLinks(text, new AbortController().signal, fetch)).toBe(text)
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('Google AI backend', () => {
  it('is available only with a Google AI account the conversation may use', async () => {
    const backend = createGoogleBackend()
    expect(await backend.available(request())).toBe(true)
    expect(h.accountFor).toHaveBeenCalledWith('conv_google')
    h.account = null
    expect(await backend.available(request())).toBe(false)
  })

  it('searches on that account and resolves the cited links', async () => {
    h.account = { accountId: 'work' }
    h.search.mockImplementation(async () => ({
      text: `Answer[1].\n\nSources:\n[1] [docs.example.test](${REDIRECT}AAA)`,
    }))
    vi.spyOn(globalThis, 'fetch').mockImplementation(redirects({ [`${REDIRECT}AAA`]: 'https://docs.example.test/a' }))

    const outcome = await createGoogleBackend().search(request())

    expect(outcome).toEqual({
      kind: 'summary',
      text: 'Answer[1].\n\nSources:\n[1] [docs.example.test](https://docs.example.test/a)',
    })
    expect(h.managerFor).toHaveBeenCalledWith('work')
    expect(h.search).toHaveBeenCalledWith(
      expect.objectContaining({
        manager: h.manager,
        accountIdentity: { fingerprint: 'project:test', epoch: 1 },
        query: 'electron vibrancy',
      })
    )
  })

  it('asks for a Google AI account when none is signed in', async () => {
    h.account = null
    await expect(createGoogleBackend().search(request())).rejects.toThrow(/Connect a Google AI account/)
    expect(h.search).not.toHaveBeenCalled()
  })

  it('propagates an abort that happens while links are resolved', async () => {
    const controller = new AbortController()
    h.search.mockImplementation(async () => ({ text: `${REDIRECT}AAA` }))
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      controller.abort(new Error('stop'))
      throw new Error('aborted')
    })
    await expect(createGoogleBackend().search(request(controller.signal))).rejects.toThrow('stop')
  })
})
