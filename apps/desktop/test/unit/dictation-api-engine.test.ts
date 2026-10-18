import { describe, expect, it } from 'vitest'
import { transcribeWithApi } from '../../src/main/dictation/api-engine'
import { DICTATION_API_MAX_MS } from '../../src/shared/dictation'

type Seen = { url: string; form: FormData }

function provider(respond: () => Response | Promise<Response> = () => Response.json({ text: 'olá' })) {
  const seen: Seen[] = []
  const fetch = async (url: string | URL | Request, init: RequestInit = {}) => {
    seen.push({ url: String(url), form: init.body as FormData })
    return respond()
  }
  return { fetch: fetch as typeof globalThis.fetch, seen }
}

const speech = (samples = 16000) =>
  new Float32Array(samples).map((_, i) => 0.2 * Math.sin((2 * Math.PI * 220 * i) / 16000))
const withKey = () => 'sk-test'

describe('API dictation engine', () => {
  it('asks for a key before sending anything', async () => {
    const { fetch, seen } = provider()
    expect(await transcribeWithApi(speech(), 'openai', 'pt', { fetch, key: () => null })).toEqual({
      error: 'key-missing',
    })
    expect(seen).toHaveLength(0)
  })

  it('does not send silence or recordings past the limit', async () => {
    const { fetch, seen } = provider()
    expect(await transcribeWithApi(new Float32Array(16000), 'openai', 'pt', { fetch, key: withKey })).toEqual({
      error: 'silent',
    })
    expect(
      await transcribeWithApi(new Float32Array(16 * DICTATION_API_MAX_MS + 1), 'openai', 'pt', { fetch, key: withKey })
    ).toEqual({ error: 'too-long' })
    expect(seen).toHaveLength(0)
  })

  it('sends WAV in the chosen language and cleans the transcript', async () => {
    const { fetch, seen } = provider(() => Response.json({ text: '[BLANK_AUDIO] oi' }))
    expect(await transcribeWithApi(speech(), 'groq', 'pt', { fetch, key: withKey })).toEqual({ text: 'oi' })
    expect(seen[0].url).toBe('https://api.groq.com/openai/v1/audio/transcriptions')
    const file = seen[0].form.get('file') as File
    expect(file.type).toBe('audio/wav')
    expect(file.name).toBe('dictation.wav')
    expect(file.size).toBe(44 + 16000 * 2)
    expect(seen[0].form.get('language')).toBe('pt')
  })

  it('lets the provider detect the language in automatic mode', async () => {
    const { fetch, seen } = provider()
    await transcribeWithApi(speech(), 'openai', 'auto', { fetch, key: withKey })
    expect(seen[0].form.has('language')).toBe(false)
  })

  it('maps provider failures', async () => {
    const statuses: Array<[number, string]> = [
      [401, 'key-rejected'],
      [429, 'quota'],
      [503, 'unavailable'],
    ]
    for (const [status, error] of statuses) {
      const { fetch } = provider(() => new Response('{}', { status }))
      expect(await transcribeWithApi(speech(), 'openai', 'en', { fetch, key: withKey })).toEqual({ error })
    }
    const offline = provider(() => Promise.reject(new TypeError('fetch failed')))
    expect(await transcribeWithApi(speech(), 'openai', 'en', { fetch: offline.fetch, key: withKey })).toEqual({
      error: 'unavailable',
    })
  })

  it('treats an empty transcript as silence', async () => {
    const { fetch } = provider(() => Response.json({ text: '[BLANK_AUDIO]' }))
    expect(await transcribeWithApi(speech(), 'openai', 'en', { fetch, key: withKey })).toEqual({ error: 'silent' })
  })
})
