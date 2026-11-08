import { afterEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  dictationKey: null as string | null,
  providers: [] as Array<{ id: string; baseURL: string }>,
  keys: new Map<string, string>(),
  settings: null as unknown,
}))
vi.mock('../../src/main/dictation/settings', () => ({ getDictationKey: () => h.dictationKey }))
vi.mock('../../src/main/chat/catalog', () => ({ listProviders: () => h.providers }))
vi.mock('../../src/main/chat/credentials', () => ({ getApiKey: (id: string) => h.keys.get(id) ?? null }))
vi.mock('../../src/main/assistant/assistant-settings', async () => {
  const { parseAssistantSettings } = await import('../../src/shared/assistant')
  return { getAssistantSettings: () => parseAssistantSettings(h.settings), setAssistantSettings: vi.fn() }
})
vi.mock('../../src/main/assistant/assistant-conversation', () => ({
  ensureAssistantConversation: vi.fn(),
  startNewAssistantSession: vi.fn(),
}))

import { registerAssistantIpc } from '../../src/main/assistant/assistant-ipc'
import {
  createSpeechRequests,
  OPENAI_SPEECH_URL,
  openAiSpeechKey,
  synthesizeOpenAiSpeech,
} from '../../src/main/assistant/tts'
import { mergeAssistantSettings, parseAssistantSettings } from '../../src/shared/assistant'

const audio = new Uint8Array([0x49, 0x44, 0x33]).buffer
const ok = () => new Response(audio, { status: 200, headers: { 'content-type': 'audio/mpeg' } })
const opts = (signal = new AbortController().signal) => ({ voice: 'marin', speed: 1.25, locale: 'pt-BR', signal })

afterEach(() => {
  h.dictationKey = null
  h.providers = []
  h.keys.clear()
  h.settings = null
})

describe('OpenAI speech', () => {
  it('posts the sentence with the voice, speed and locale instructions, and returns the audio', async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => ok())
    const result = await synthesizeOpenAiSpeech(' Tudo pronto. ', opts(), {
      fetch: fetch as never,
      apiKey: () => 'sk-test',
    })
    expect(result).toEqual({ ok: true, audio, mime: 'audio/mpeg' })
    const [url, init] = fetch.mock.calls[0]
    expect(url).toBe(OPENAI_SPEECH_URL)
    expect(init?.method).toBe('POST')
    expect(init?.headers).toEqual({ authorization: 'Bearer sk-test', 'content-type': 'application/json' })
    expect(JSON.parse(init?.body as string)).toEqual({
      model: 'gpt-4o-mini-tts',
      voice: 'marin',
      input: 'Tudo pronto.',
      speed: 1.25,
      response_format: 'mp3',
      instructions: 'Fale em português do Brasil, de forma natural e direta.',
    })
  })

  it('says what went wrong: no key, a rejected key, a sentence too long, the network', async () => {
    const fetch = vi.fn(async () => ok())
    expect(await synthesizeOpenAiSpeech('Oi.', opts(), { fetch: fetch as never, apiKey: () => null })).toEqual({
      ok: false,
      error: 'key-missing',
    })
    expect(fetch).not.toHaveBeenCalled()
    for (const status of [401, 403])
      expect(
        await synthesizeOpenAiSpeech('Oi.', opts(), {
          fetch: (async () => new Response('', { status })) as never,
          apiKey: () => 'sk',
        })
      ).toEqual({ ok: false, error: 'key-rejected' })
    expect(
      await synthesizeOpenAiSpeech('x'.repeat(4001), opts(), { fetch: fetch as never, apiKey: () => 'sk' })
    ).toEqual({
      ok: false,
      error: 'too-long',
    })
    expect(
      await synthesizeOpenAiSpeech('Oi.', opts(), {
        fetch: (async () => {
          throw new TypeError('offline')
        }) as never,
        apiKey: () => 'sk',
      })
    ).toEqual({ ok: false, error: 'network' })
  })

  it('cancels every request of the window in flight', async () => {
    const speech = createSpeechRequests()
    const fetch = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        })
    )
    const deps = { fetch: fetch as never, apiKey: () => 'sk' }
    const first = speech.speak('Um.', { voice: 'marin', speed: 1, locale: 'en' }, deps)
    const second = speech.speak('Dois.', { voice: 'marin', speed: 1, locale: 'en' }, deps)
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
    speech.cancel()
    expect(await first).toEqual({ ok: false, error: 'cancelled' })
    expect(await second).toEqual({ ok: false, error: 'cancelled' })
    expect(speech.pending).toBe(0)
  })

  it('takes the dictation key, else a BYOK provider on api.openai.com', async () => {
    h.providers = [
      { id: 'groq', baseURL: 'https://api.groq.com/openai/v1' },
      { id: 'openai', baseURL: 'https://api.openai.com/v1' },
    ]
    h.keys.set('groq', 'gsk').set('openai', 'sk-byok')
    expect(await openAiSpeechKey()).toBe('sk-byok')
    h.dictationKey = 'sk-dictation'
    expect(await openAiSpeechKey()).toBe('sk-dictation')
    h.dictationKey = null
    h.keys.delete('openai')
    expect(await openAiSpeechKey()).toBeNull()
  })
})

describe('voice settings', () => {
  it('defaults to the agent voice read by the system', () => {
    expect(parseAssistantSettings({}).voice).toEqual({
      mode: 'agent',
      engine: 'system',
      systemVoice: null,
      openaiVoice: 'marin',
      speed: 1,
      autoSpeak: true,
      shortcutListens: true,
      realtimeModel: 'gpt-realtime-mini',
      realtimeVoice: 'marin',
    })
  })

  it('changes only the voice fields a patch names, and keeps valid stored fields', () => {
    const current = mergeAssistantSettings(parseAssistantSettings({}), { voice: { engine: 'openai', speed: 1.5 } })
    const next = mergeAssistantSettings(current, { voice: { openaiVoice: 'cedar' } })
    expect(next.voice).toMatchObject({ engine: 'openai', speed: 1.5, openaiVoice: 'cedar' })
    expect(() => mergeAssistantSettings(next, { voice: { speed: 3 } })).toThrow()
    expect(parseAssistantSettings({ voice: { engine: 'openai', speed: 9, mode: 'nope' } }).voice).toMatchObject({
      engine: 'openai',
      speed: 1,
      mode: 'agent',
    })
  })
})

describe('the speech channel', () => {
  function register() {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
    const reg = {
      handle: (channel: string, fn: never) => handlers.set(channel, fn),
      mhandle: (channel: string, fn: never) => handlers.set(channel, fn),
      on: (channel: string, fn: never) => handlers.set(channel, fn),
      mon: (channel: string, fn: never) => handlers.set(channel, fn),
    }
    const assistant = { id: 7 }
    registerAssistantIpc(reg as never, {
      window: () => ({ webContents: () => assistant }) as never,
      locale: () => 'en',
      openConversationInApp: vi.fn(),
      openSettingsInApp: vi.fn(),
      applySettings: () => null,
      shortcutError: () => null,
      wayland: false,
    })
    return { handlers, assistant }
  }

  it('reads aloud only for the assistant window', async () => {
    const { handlers } = register()
    await expect(
      Promise.resolve().then(() => handlers.get('assistant:tts')?.({ sender: { id: 1 } }, { text: 'Oi.' }))
    ).rejects.toThrow('Only the assistant window reads answers aloud')
  })

  it('lists the OpenAI voices and says whether a key is set', async () => {
    const { handlers } = register()
    expect(await handlers.get('assistant:voices')?.({})).toEqual({
      openai: ['alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse', 'marin', 'cedar'],
      openaiKey: false,
    })
    h.dictationKey = 'sk'
    expect(await handlers.get('assistant:voices')?.({})).toMatchObject({ openaiKey: true })
  })

  it('tries a voice for Settings with the voice and speed chosen, and refuses anything else', async () => {
    const { handlers } = register()
    expect(
      await handlers.get('assistant:test-voice')?.({ sender: { id: 1 } }, { text: 'Oi.', voice: 'cedar' })
    ).toEqual({
      ok: false,
      error: 'key-missing',
    })
    expect(() => handlers.get('assistant:test-voice')?.({}, { text: 'Oi.', voice: 'robot' })).toThrow()
    expect(() => handlers.get('assistant:test-voice')?.({}, { text: 'x'.repeat(201) })).toThrow()
  })

  it('answers key-missing for the assistant window when the person has no key', async () => {
    const { handlers, assistant } = register()
    expect(await handlers.get('assistant:tts')?.({ sender: assistant }, { text: 'Oi.' })).toEqual({
      ok: false,
      error: 'key-missing',
    })
  })
})
