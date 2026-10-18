import { z } from 'zod'

/**
 * Speech-to-text through OpenAI-compatible `/audio/transcriptions`; web-standard fetch/FormData/Blob only, so it runs in
 * Electron main and the gateway. The person's own key pays for it: the desktop keeps one, and a bot server keeps one
 * for the phones paired with it.
 */
export const DICTATION_PROVIDERS = {
  openai: { label: 'OpenAI', baseURL: 'https://api.openai.com/v1', model: 'gpt-4o-transcribe' },
  groq: { label: 'Groq', baseURL: 'https://api.groq.com/openai/v1', model: 'whisper-large-v3-turbo' },
} as const

export const dictationProviderSchema = z.enum(['openai', 'groq'])
export type DictationProvider = z.infer<typeof dictationProviderSchema>

export const DICTATION_LIMITS = {
  /** Both providers refuse larger files. */
  fileBytesMax: 25 * 1024 * 1024,
  /** Recording stops by itself at this length with an API engine. */
  durationMsMax: 10 * 60_000,
  timeoutMs: 60_000,
  keyCheckTimeoutMs: 15_000,
  /** Transcriptions a gateway runs at once; more answer `busy`. */
  gatewayConcurrency: 4,
} as const

/** The largest transcription request a gateway reads: base64 M4A at 32 kbit/s, well over ten minutes. */
export const FLEET_DICTATION_BODY_MAX = 8 * 1024 * 1024

export const dictationErrorSchema = z.enum([
  'key-rejected',
  'quota',
  'too-long',
  'unavailable',
  'busy',
  'not-configured',
])
export type DictationError = z.infer<typeof dictationErrorSchema>

export class DictationFailure extends Error {
  constructor(
    readonly code: DictationError,
    message: string = code
  ) {
    super(message)
    this.name = 'DictationFailure'
  }
}

/** What a server says of its key: the last four characters only, never the key. */
export function dictationKeyHint(key: string): string {
  return key.trim().slice(-4)
}

export function dictationErrorForStatus(status: number): DictationError {
  if (status === 401 || status === 403) return 'key-rejected'
  if (status === 429) return 'quota'
  if (status === 413) return 'too-long'
  return 'unavailable'
}

function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

/** Transcribes one recording and returns its text, trimmed. Throws `DictationFailure`, or the abort of `signal`. */
export async function transcribeWithProvider(input: {
  provider: DictationProvider
  key: string
  file: Blob
  fileName: string
  /** Two-letter language code; null lets the provider detect it. */
  language: string | null
  prompt?: string
  signal?: AbortSignal
  fetch?: typeof fetch
}): Promise<string> {
  const spec = DICTATION_PROVIDERS[input.provider]
  if (input.file.size > DICTATION_LIMITS.fileBytesMax) throw new DictationFailure('too-long')
  const form = new FormData()
  form.append('file', input.file, input.fileName)
  form.append('model', spec.model)
  form.append('response_format', 'json')
  if (input.language) form.append('language', input.language)
  if (input.prompt) form.append('prompt', input.prompt)
  let response: Response
  try {
    response = await (input.fetch ?? fetch)(`${spec.baseURL}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${input.key}` },
      body: form,
      signal: withTimeout(input.signal, DICTATION_LIMITS.timeoutMs),
    })
  } catch (error) {
    if (input.signal?.aborted) throw error
    throw new DictationFailure('unavailable', 'network')
  }
  if (!response.ok) throw new DictationFailure(dictationErrorForStatus(response.status), `HTTP ${response.status}`)
  const body = (await response.json().catch(() => null)) as { text?: unknown } | null
  if (typeof body?.text !== 'string') throw new DictationFailure('unavailable', 'Unexpected response')
  return body.text.trim()
}

/** Whether the provider takes the key, by listing its models: a key is never stored unchecked. */
export async function checkDictationKey(input: {
  provider: DictationProvider
  key: string
  signal?: AbortSignal
  fetch?: typeof fetch
}): Promise<'ok' | 'key-rejected' | 'unchecked'> {
  try {
    const response = await (input.fetch ?? fetch)(`${DICTATION_PROVIDERS[input.provider].baseURL}/models`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${input.key}` },
      signal: withTimeout(input.signal, DICTATION_LIMITS.keyCheckTimeoutMs),
    })
    if (response.ok) return 'ok'
    return response.status === 401 || response.status === 403 ? 'key-rejected' : 'unchecked'
  } catch {
    return 'unchecked'
  }
}

export const fleetDictationStatusSchema = z.object({
  configured: z.boolean(),
  provider: dictationProviderSchema.nullable(),
  keyHint: z.string().max(8).nullable(),
})
export type FleetDictationStatus = z.infer<typeof fleetDictationStatusSchema>

export const fleetDictationKeyRequestSchema = z
  .object({ provider: dictationProviderSchema, key: z.string().trim().min(1).max(512) })
  .strict()
export type FleetDictationKeyRequest = z.infer<typeof fleetDictationKeyRequestSchema>
export const fleetDictationKeyResponseSchema = z.union([
  z.object({ provider: dictationProviderSchema, keyHint: z.string().max(8) }),
  z.object({ error: z.enum(['key-rejected', 'unchecked']) }),
])
export type FleetDictationKeyResponse = z.infer<typeof fleetDictationKeyResponseSchema>

export const fleetDictationTranscribeRequestSchema = z
  .object({
    audio: z.base64().min(1),
    mediaType: z.enum(['audio/mp4', 'audio/wav']),
    language: z
      .string()
      .regex(/^[a-z]{2}$/)
      .nullable(),
  })
  .strict()
export type FleetDictationTranscribeRequest = z.infer<typeof fleetDictationTranscribeRequestSchema>
/** Always HTTP 200: the provider's outcome is in the body, so the gateway's closed error codes do not grow. */
export const fleetDictationTranscribeResponseSchema = z.union([
  z.object({ text: z.string() }),
  z.object({ error: dictationErrorSchema }),
])
export type FleetDictationTranscribeResponse = z.infer<typeof fleetDictationTranscribeResponseSchema>
