import { describe, expect, it } from 'vitest'
import {
  DICTATION_LIMITS,
  DictationFailure,
  FLEET_DICTATION_FEATURE,
  FLEET_GATEWAY_ROUTES,
  checkDictationKey,
  dictationKeyHint,
  fleetDictationKeyRequestSchema,
  fleetDictationTranscribeRequestSchema,
  transcribeWithProvider,
} from '../src/index.js'

type Call = { url: string; init: RequestInit }

/** Records each request and answers with `respond`; rejects like fetch does when the request's signal aborts. */
function fakeFetch(respond: (call: Call) => Response | Promise<Response> = () => json({ text: 'ok' })) {
  const calls: Call[] = []
  const fetch = (url: string | URL | Request, init: RequestInit = {}) => {
    const call = { url: String(url), init }
    calls.push(call)
    const signal = init.signal
    if (signal?.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'))
    return new Promise<Response>((resolve, reject) => {
      signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
      Promise.resolve(respond(call)).then(resolve, reject)
    })
  }
  return { fetch: fetch as typeof globalThis.fetch, calls }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const audio = () => new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/mp4' })

const form = (call: Call) => call.init.body as FormData

async function failure(promise: Promise<unknown>): Promise<DictationFailure> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(DictationFailure)
    return error as DictationFailure
  }
  throw new Error('Expected a DictationFailure')
}

describe('transcribeWithProvider', () => {
  it('posts the audio to OpenAI as multipart with the key and the language', async () => {
    const { fetch, calls } = fakeFetch(() => json({ text: '  olá mundo ' }))
    const text = await transcribeWithProvider({
      provider: 'openai',
      key: 'sk-test',
      file: audio(),
      fileName: 'dictation.m4a',
      language: 'pt',
      fetch,
    })
    expect(text).toBe('olá mundo')
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://api.openai.com/v1/audio/transcriptions')
    expect(calls[0].init.method).toBe('POST')
    expect(new Headers(calls[0].init.headers).get('authorization')).toBe('Bearer sk-test')
    const body = form(calls[0])
    expect(body.get('model')).toBe('gpt-4o-transcribe')
    expect(body.get('response_format')).toBe('json')
    expect(body.get('language')).toBe('pt')
    const file = body.get('file') as File
    expect(file.name).toBe('dictation.m4a')
    expect(file.size).toBe(3)
  })

  it('uses Groq with its own model', async () => {
    const { fetch, calls } = fakeFetch()
    await transcribeWithProvider({
      provider: 'groq',
      key: 'gsk-test',
      file: audio(),
      fileName: 'dictation.m4a',
      language: 'en',
      fetch,
    })
    expect(calls[0].url).toBe('https://api.groq.com/openai/v1/audio/transcriptions')
    expect(form(calls[0]).get('model')).toBe('whisper-large-v3-turbo')
  })

  it('leaves the language to the provider when none is given, and sends no prompt unless asked', async () => {
    const { fetch, calls } = fakeFetch()
    await transcribeWithProvider({
      provider: 'openai',
      key: 'k',
      file: audio(),
      fileName: 'a.m4a',
      language: null,
      fetch,
    })
    expect(form(calls[0]).has('language')).toBe(false)
    expect(form(calls[0]).has('prompt')).toBe(false)
  })

  it('maps provider statuses to dictation errors', async () => {
    const cases: Array<[number, string]> = [
      [401, 'key-rejected'],
      [403, 'key-rejected'],
      [429, 'quota'],
      [413, 'too-long'],
      [500, 'unavailable'],
    ]
    for (const [status, code] of cases) {
      const { fetch } = fakeFetch(() => json({ error: { message: 'nope' } }, status))
      const error = await failure(
        transcribeWithProvider({
          provider: 'openai',
          key: 'k',
          file: audio(),
          fileName: 'a.m4a',
          language: null,
          fetch,
        })
      )
      expect(error.code).toBe(code)
    }
  })

  it('reports network failures and unexpected answers as unavailable', async () => {
    const offline = fakeFetch(() => Promise.reject(new TypeError('fetch failed')))
    expect(
      (
        await failure(
          transcribeWithProvider({
            provider: 'openai',
            key: 'k',
            file: audio(),
            fileName: 'a.m4a',
            language: null,
            fetch: offline.fetch,
          })
        )
      ).code
    ).toBe('unavailable')
    const odd = fakeFetch(() => json({ transcript: 'x' }))
    expect(
      (
        await failure(
          transcribeWithProvider({
            provider: 'openai',
            key: 'k',
            file: audio(),
            fileName: 'a.m4a',
            language: null,
            fetch: odd.fetch,
          })
        )
      ).code
    ).toBe('unavailable')
  })

  it('refuses a file over the providers limit without sending it', async () => {
    const { fetch, calls } = fakeFetch()
    const big = new Blob([new Uint8Array(DICTATION_LIMITS.fileBytesMax + 1)])
    const error = await failure(
      transcribeWithProvider({ provider: 'openai', key: 'k', file: big, fileName: 'a.wav', language: null, fetch })
    )
    expect(error.code).toBe('too-long')
    expect(calls).toHaveLength(0)
  })

  it('rejects with the abort itself when the caller cancels', async () => {
    const { fetch } = fakeFetch(() => new Promise<Response>(() => {}))
    const controller = new AbortController()
    const pending = transcribeWithProvider({
      provider: 'openai',
      key: 'k',
      file: audio(),
      fileName: 'a.m4a',
      language: null,
      signal: controller.signal,
      fetch,
    })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await expect(pending).rejects.not.toBeInstanceOf(DictationFailure)
  })
})

describe('checkDictationKey', () => {
  it('lists the models with the key', async () => {
    const { fetch, calls } = fakeFetch(() => json({ data: [] }))
    expect(await checkDictationKey({ provider: 'groq', key: 'gsk-1', fetch })).toBe('ok')
    expect(calls[0].url).toBe('https://api.groq.com/openai/v1/models')
    expect(calls[0].init.method ?? 'GET').toBe('GET')
    expect(new Headers(calls[0].init.headers).get('authorization')).toBe('Bearer gsk-1')
  })

  it('tells a refused key from a check that could not happen', async () => {
    for (const status of [401, 403])
      expect(
        await checkDictationKey({ provider: 'openai', key: 'k', fetch: fakeFetch(() => json({}, status)).fetch })
      ).toBe('key-rejected')
    expect(await checkDictationKey({ provider: 'openai', key: 'k', fetch: fakeFetch(() => json({}, 500)).fetch })).toBe(
      'unchecked'
    )
    const offline = fakeFetch(() => Promise.reject(new TypeError('fetch failed')))
    expect(await checkDictationKey({ provider: 'openai', key: 'k', fetch: offline.fetch })).toBe('unchecked')
  })
})

describe('dictation contracts', () => {
  it('validates the transcription request', () => {
    const request = { audio: 'YWJj', mediaType: 'audio/mp4', language: 'pt' }
    expect(fleetDictationTranscribeRequestSchema.parse(request)).toEqual(request)
    expect(fleetDictationTranscribeRequestSchema.parse({ ...request, language: null }).language).toBeNull()
    expect(() => fleetDictationTranscribeRequestSchema.parse({ ...request, language: 'pt-BR' })).toThrow()
    expect(() => fleetDictationTranscribeRequestSchema.parse({ ...request, audio: 'not base64!' })).toThrow()
    expect(() => fleetDictationTranscribeRequestSchema.parse({ ...request, mediaType: 'audio/ogg' })).toThrow()
    expect(() => fleetDictationTranscribeRequestSchema.parse({ ...request, extra: 1 })).toThrow()
  })

  it('trims the key and keeps only its last four characters as a hint', () => {
    expect(fleetDictationKeyRequestSchema.parse({ provider: 'openai', key: '  sk-abc  ' }).key).toBe('sk-abc')
    expect(() => fleetDictationKeyRequestSchema.parse({ provider: 'azure', key: 'k' })).toThrow()
    expect(() => fleetDictationKeyRequestSchema.parse({ provider: 'openai', key: '   ' })).toThrow()
    expect(dictationKeyHint(' sk-test-1234 ')).toBe('1234')
  })

  it('declares the gateway routes and feature', () => {
    expect(FLEET_DICTATION_FEATURE).toBe('dictation')
    expect(FLEET_GATEWAY_ROUTES.dictationGet).toMatchObject({ method: 'GET', path: '/v1/dictation' })
    expect(FLEET_GATEWAY_ROUTES.dictationKeySet).toMatchObject({ method: 'PUT', path: '/v1/dictation' })
    expect(FLEET_GATEWAY_ROUTES.dictationKeyDelete).toMatchObject({ method: 'DELETE', path: '/v1/dictation' })
    expect(FLEET_GATEWAY_ROUTES.dictationTranscribe).toMatchObject({
      method: 'POST',
      path: '/v1/dictation/transcriptions',
    })
  })
})
