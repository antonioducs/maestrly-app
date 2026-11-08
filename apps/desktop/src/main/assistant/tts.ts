/**
 * The assistant reads answers aloud with OpenAI's speech model, with the person's own key: the dictation key, else
 * a BYOK provider on api.openai.com. The key stays here; the window only gets the audio.
 */
import { net } from 'electron'
import type { AssistantTtsError, AssistantTtsResult } from '../../shared/assistant'

export const OPENAI_SPEECH_URL = 'https://api.openai.com/v1/audio/speech'
export const OPENAI_SPEECH_MODEL = 'gpt-4o-mini-tts'
/** The endpoint's own limit on `input`; the sentence chunker keeps well under it. */
export const OPENAI_SPEECH_MAX_CHARS = 4000

export type TtsError = AssistantTtsError
export type TtsResult = AssistantTtsResult

const INSTRUCTIONS: Record<string, string> = {
  'pt-BR': 'Fale em português do Brasil, de forma natural e direta.',
  en: 'Speak in natural, direct English.',
}

/** The person's OpenAI key: the one dictation uses, else a BYOK provider that talks to api.openai.com. */
export async function openAiSpeechKey(): Promise<string | null> {
  const [{ getDictationKey }, { listProviders }, { getApiKey }] = await Promise.all([
    import('../dictation/settings'),
    import('../chat/catalog'),
    import('../chat/credentials'),
  ])
  const dictation = getDictationKey('openai')
  if (dictation) return dictation
  for (const provider of listProviders()) {
    let host: string | null = null
    try {
      host = new URL(provider.baseURL).host
    } catch {
      host = null
    }
    if (host !== 'api.openai.com') continue
    const key = getApiKey(provider.id)
    if (key) return key
  }
  return null
}

export async function synthesizeOpenAiSpeech(
  text: string,
  opts: { voice: string; speed: number; locale: string; signal: AbortSignal },
  deps: { fetch?: typeof fetch; apiKey?: () => string | null | Promise<string | null> } = {}
): Promise<TtsResult> {
  const input = text.trim()
  if (input.length > OPENAI_SPEECH_MAX_CHARS) return { ok: false, error: 'too-long' }
  if (opts.signal.aborted) return { ok: false, error: 'cancelled' }
  const key = await (deps.apiKey ?? openAiSpeechKey)()
  if (!key) return { ok: false, error: 'key-missing' }
  const doFetch = deps.fetch ?? (net.fetch as unknown as typeof fetch)
  try {
    const response = await doFetch(OPENAI_SPEECH_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: OPENAI_SPEECH_MODEL,
        voice: opts.voice,
        input,
        speed: opts.speed,
        response_format: 'mp3',
        instructions: INSTRUCTIONS[opts.locale] ?? INSTRUCTIONS.en,
      }),
      signal: opts.signal,
    })
    if (response.status === 401 || response.status === 403) return { ok: false, error: 'key-rejected' }
    if (!response.ok) return { ok: false, error: 'network' }
    return { ok: true, audio: await response.arrayBuffer(), mime: 'audio/mpeg' }
  } catch {
    return { ok: false, error: opts.signal.aborted ? 'cancelled' : 'network' }
  }
}

/** Speech requests of the assistant window in flight; cancelling the reading stops them all. */
export function createSpeechRequests() {
  const inFlight = new Set<AbortController>()
  return {
    async speak(
      text: string,
      opts: { voice: string; speed: number; locale: string },
      deps?: Parameters<typeof synthesizeOpenAiSpeech>[2]
    ): Promise<TtsResult> {
      const controller = new AbortController()
      inFlight.add(controller)
      try {
        return await synthesizeOpenAiSpeech(text, { ...opts, signal: controller.signal }, deps)
      } finally {
        inFlight.delete(controller)
      }
    },
    cancel(): void {
      for (const controller of inFlight) controller.abort()
      inFlight.clear()
    },
    get pending(): number {
      return inFlight.size
    },
  }
}
