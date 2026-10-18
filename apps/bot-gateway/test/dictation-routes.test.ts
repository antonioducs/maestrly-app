import { describe, expect, it } from 'vitest'
import { FLEET_PROTOCOL_HEADER } from '@maestrly/bot-fleet-protocol'
import { harness } from './harness.js'

const json = (response: Response) => response.json() as Promise<Record<string, any>>
const KEY = 'sk-test-1234'
const recording = { audio: Buffer.from('abc').toString('base64'), mediaType: 'audio/mp4', language: 'pt' }

type Seen = { url: string; authorization: string | null; form: FormData | null }

/** A provider: `/models` answers `modelsStatus`, transcriptions answer `respond`. */
function provider(options: { modelsStatus?: number; offline?: boolean; respond?: () => Promise<Response> } = {}) {
  const seen: Seen[] = []
  const fetch = async (url: string | URL | Request, init: RequestInit = {}) => {
    const href = String(url)
    seen.push({
      url: href,
      authorization: new Headers(init.headers).get('authorization'),
      form: init.body instanceof FormData ? init.body : null,
    })
    if (options.offline) throw new TypeError('fetch failed')
    if (href.endsWith('/models')) return new Response('{"data":[]}', { status: options.modelsStatus ?? 200 })
    return options.respond ? options.respond() : Response.json({ text: 'olá mundo' })
  }
  return { fetch: fetch as typeof globalThis.fetch, seen }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => (resolve = done))
  return { promise, resolve }
}

describe('dictation routes', () => {
  it('announces the feature past the 20 legacy ones', async () => {
    const h = await harness()
    const meta = await json(await fetch(h.origin + '/v1/meta'))
    expect(meta.moreFeatures).toContain('dictation')
    expect(meta.features).not.toContain('dictation')
    expect(meta.features).toHaveLength(20)
  })

  it('stores a checked key and never answers with it', async () => {
    const { fetch, seen } = provider()
    const h = await harness(Date.now, { dictationFetch: fetch })
    expect(await json(await h.request('GET', '/v1/dictation'))).toEqual({
      configured: false,
      provider: null,
      keyHint: null,
    })
    const saved = await h.request('PUT', '/v1/dictation', { provider: 'openai', key: KEY })
    expect(saved.status).toBe(200)
    const body = await json(saved)
    expect(body).toEqual({ provider: 'openai', keyHint: '1234' })
    expect(JSON.stringify(body)).not.toContain(KEY)
    expect(seen[0]).toMatchObject({ url: 'https://api.openai.com/v1/models', authorization: `Bearer ${KEY}` })
    const status = await json(await h.request('GET', '/v1/dictation'))
    expect(status).toEqual({ configured: true, provider: 'openai', keyHint: '1234' })
    expect(JSON.stringify(status)).not.toContain(KEY)
  })

  it('refuses a key the provider rejects, and one it could not check', async () => {
    const rejected = await harness(Date.now, { dictationFetch: provider({ modelsStatus: 401 }).fetch })
    expect(await json(await rejected.request('PUT', '/v1/dictation', { provider: 'groq', key: KEY }))).toEqual({
      error: 'key-rejected',
    })
    expect((await json(await rejected.request('GET', '/v1/dictation'))).configured).toBe(false)
    const offline = await harness(Date.now, { dictationFetch: provider({ offline: true }).fetch })
    expect(await json(await offline.request('PUT', '/v1/dictation', { provider: 'groq', key: KEY }))).toEqual({
      error: 'unchecked',
    })
    expect((await json(await offline.request('GET', '/v1/dictation'))).configured).toBe(false)
  })

  it('transcribes with the stored key once one is set', async () => {
    const { fetch, seen } = provider()
    const h = await harness(Date.now, { dictationFetch: fetch })
    expect(await json(await h.request('POST', '/v1/dictation/transcriptions', recording))).toEqual({
      error: 'not-configured',
    })
    await h.request('PUT', '/v1/dictation', { provider: 'openai', key: KEY })
    const result = await h.request('POST', '/v1/dictation/transcriptions', recording)
    expect(result.status).toBe(200)
    expect(await json(result)).toEqual({ text: 'olá mundo' })
    const call = seen.find((each) => each.url.endsWith('/audio/transcriptions'))!
    expect(call.authorization).toBe(`Bearer ${KEY}`)
    expect(call.form?.get('model')).toBe('gpt-4o-transcribe')
    expect(call.form?.get('language')).toBe('pt')
    const file = call.form?.get('file') as File
    expect(file.name).toBe('dictation.m4a')
    expect(file.size).toBe(3)
  })

  it('answers provider failures in the body', async () => {
    let status = 429
    const h = await harness(Date.now, {
      dictationFetch: provider({ respond: async () => new Response('{}', { status }) }).fetch,
    })
    await h.request('PUT', '/v1/dictation', { provider: 'openai', key: KEY })
    const quota = await h.request('POST', '/v1/dictation/transcriptions', recording)
    expect(quota.status).toBe(200)
    expect(await json(quota)).toEqual({ error: 'quota' })
    status = 500
    expect(await json(await h.request('POST', '/v1/dictation/transcriptions', recording))).toEqual({
      error: 'unavailable',
    })
  })

  it('refuses a body over its limit', async () => {
    const h = await harness(Date.now, { dictationFetch: provider().fetch })
    const big = { ...recording, audio: 'A'.repeat(8 * 1024 * 1024 + 4) }
    const response = await h.request('POST', '/v1/dictation/transcriptions', big)
    expect(response.status).toBe(400)
    expect(JSON.stringify(await json(response))).toContain('Request body too large')
  })

  it('removes the key', async () => {
    const h = await harness(Date.now, { dictationFetch: provider().fetch })
    await h.request('PUT', '/v1/dictation', { provider: 'openai', key: KEY })
    expect((await h.request('DELETE', '/v1/dictation')).status).toBe(204)
    expect((await json(await h.request('GET', '/v1/dictation'))).configured).toBe(false)
  })

  it('runs at most four transcriptions at once', async () => {
    const gate = deferred()
    let started = 0
    const h = await harness(Date.now, {
      dictationFetch: provider({
        respond: async () => {
          started++
          await gate.promise
          return Response.json({ text: 'pronto' })
        },
      }).fetch,
    })
    await h.request('PUT', '/v1/dictation', { provider: 'groq', key: KEY })
    const first = Array.from({ length: 4 }, () => h.request('POST', '/v1/dictation/transcriptions', recording))
    await expect.poll(() => started).toBe(4)
    expect(await json(await h.request('POST', '/v1/dictation/transcriptions', recording))).toEqual({ error: 'busy' })
    gate.resolve()
    for (const response of await Promise.all(first)) expect(await json(response)).toEqual({ text: 'pronto' })
  })

  it('serves only paired devices on the public port', async () => {
    const h = await harness(Date.now, { dictationFetch: provider().fetch })
    const anonymous = await fetch(h.origin + '/v1/dictation', { headers: { [FLEET_PROTOCOL_HEADER]: '1' } })
    expect(anonymous.status).toBe(401)
    expect((await h.request('GET', '/v1/dictation', undefined, true)).status).toBe(404)
  })
})
