/**
 * Starts an OpenAI Realtime call for the assistant window over WebRTC: the window makes the SDP offer, this process
 * adds the session and the person's key and returns the answer. The key never leaves the main process.
 */
import { net } from 'electron'
import type { AssistantRealtimeError, AssistantRealtimeStart } from '../../../shared/assistant'
import { openAiSpeechKey } from '../tts'
import { realtimeInstructions } from './instructions'

export const REALTIME_CALLS_URL = 'https://api.openai.com/v1/realtime/calls'
/** Transcribes each turn of the person once it ends: the bridge sends their own words to the assistant. */
export const REALTIME_TRANSCRIPTION_MODEL = 'gpt-transcribe'
const MAX_OFFER = 64 * 1024
const START_TIMEOUT_MS = 15_000

export type RealtimeStartError = AssistantRealtimeError
export type RealtimeStartResult = AssistantRealtimeStart

export type RealtimeToolName = 'maestrly_overview' | 'ask_assistant' | 'answer_confirmation'

export const REALTIME_TOOLS: readonly { name: RealtimeToolName; description: string; parameters: object }[] = [
  {
    name: 'maestrly_overview',
    description:
      'What needs the person, what is running and how their bots are, across this computer, remote computers and bot servers. Call it for status questions.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'ask_assistant',
    description:
      "Hands the person's request to the Maestrly assistant, which reads and acts on their conversations, remote computers and bots, and waits for its answer. The assistant receives what the person said; request is only your one-line summary of it.",
    parameters: {
      type: 'object',
      properties: { request: { type: 'string', description: "One-line summary of the person's request." } },
      required: ['request'],
      additionalProperties: false,
    },
  },
  {
    name: 'answer_confirmation',
    description:
      'Answers the confirmation the assistant asked for (needsConfirmation), with the option the person just said aloud. Never call it on your own.',
    parameters: {
      type: 'object',
      properties: { option: { type: 'string', description: 'The option the person said, as they said it.' } },
      required: ['option'],
      additionalProperties: false,
    },
  },
]

export interface RealtimeCallOptions {
  model: string
  voice: string
  locale: string
  /** The voice settings' speed; Realtime takes 0.25–1.5. */
  speed?: number
}

export function realtimeSessionConfig(opts: RealtimeCallOptions) {
  return {
    type: 'realtime',
    model: opts.model,
    instructions: realtimeInstructions(opts.locale),
    output_modalities: ['audio'],
    audio: {
      input: {
        transcription: { model: REALTIME_TRANSCRIPTION_MODEL, language: opts.locale.slice(0, 2).toLowerCase() },
        turn_detection: { type: 'semantic_vad', create_response: true },
      },
      output: { voice: opts.voice, speed: Math.min(1.5, Math.max(0.25, opts.speed ?? 1)) },
    },
    tools: REALTIME_TOOLS.map((tool) => ({ type: 'function', ...tool })),
    tool_choice: 'auto',
  }
}

/** The call's id, the last segment of the `Location` the API answers with (`/v1/realtime/calls/rtc_…`). */
function callIdOf(location: string | null): string | null {
  const id = location?.split('?')[0].split('/').filter(Boolean).pop()
  return id && /^[\w-]{1,200}$/.test(id) ? id : null
}

type Deps = { fetch?: typeof fetch; apiKey?: () => string | null | Promise<string | null> }

export async function startRealtimeCall(
  offerSdp: string,
  opts: RealtimeCallOptions,
  deps: Deps = {}
): Promise<RealtimeStartResult> {
  if (typeof offerSdp !== 'string' || !offerSdp.startsWith('v=') || offerSdp.length > MAX_OFFER)
    return { ok: false, error: 'bad-offer' }
  const key = await (deps.apiKey ?? openAiSpeechKey)()
  if (!key) return { ok: false, error: 'key-missing' }
  const form = new FormData()
  form.set('sdp', offerSdp)
  form.set('session', JSON.stringify(realtimeSessionConfig(opts)))
  const doFetch = deps.fetch ?? (net.fetch as unknown as typeof fetch)
  try {
    const response = await doFetch(REALTIME_CALLS_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}` },
      body: form,
      signal: AbortSignal.timeout(START_TIMEOUT_MS),
    })
    if (response.status === 401 || response.status === 403) return { ok: false, error: 'key-rejected' }
    if (response.status === 400 || response.status === 422) return { ok: false, error: 'bad-offer' }
    if (!response.ok) return { ok: false, error: 'network' }
    const answerSdp = await response.text()
    if (!answerSdp.startsWith('v=')) return { ok: false, error: 'network' }
    return { ok: true, answerSdp, callId: callIdOf(response.headers.get('location')) }
  } catch {
    return { ok: false, error: 'network' }
  }
}

/** Ends the call on OpenAI's side too, so it stops counting minutes even if the window's connection lingers. */
export async function hangUpRealtimeCall(callId: string, deps: Deps = {}): Promise<void> {
  const key = await (deps.apiKey ?? openAiSpeechKey)()
  if (!key) return
  const doFetch = deps.fetch ?? (net.fetch as unknown as typeof fetch)
  await doFetch(`${REALTIME_CALLS_URL}/${encodeURIComponent(callId)}/hangup`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(START_TIMEOUT_MS),
  }).catch(() => undefined)
}
