/**
 * Dictation through OpenAI or Groq with this computer's key. The renderer's 16 kHz PCM is wrapped in WAV here, in
 * main, so the key never reaches the renderer. Recordings that are effectively silent are not sent: Whisper invents
 * text from silence, and the local engine's voice-activity check is not there to stop it.
 */
import { net } from 'electron'
import { DictationFailure, transcribeWithProvider } from '@maestrly/bot-fleet-protocol'
import { cleanTranscript, isSilentPcm, pcm16Wav } from '../asr-audio'
import type { AsrLanguage, TranscribeError } from '../../shared/asr'
import { DICTATION_API_MAX_MS, type DictationApiProvider } from '../../shared/dictation'
import { getDictationKey } from './settings'

const SAMPLES_PER_MS = 16
/**
 * The recorder stops at the limit, but its last chunk can run slightly past it; the provider's 25 MB still holds
 * well over ten minutes of WAV.
 */
const LIMIT_GRACE_MS = 30_000

export async function transcribeWithApi(
  audio: Float32Array,
  provider: DictationApiProvider,
  language: AsrLanguage,
  deps: { fetch?: typeof fetch; key?: (provider: DictationApiProvider) => string | null } = {}
): Promise<{ text: string } | { error: TranscribeError }> {
  const key = (deps.key ?? getDictationKey)(provider)
  if (!key) return { error: 'key-missing' }
  if (audio.length > SAMPLES_PER_MS * (DICTATION_API_MAX_MS + LIMIT_GRACE_MS)) return { error: 'too-long' }
  if (isSilentPcm(audio)) return { error: 'silent' }
  try {
    const raw = await transcribeWithProvider({
      provider,
      key,
      file: new Blob([pcm16Wav(audio)], { type: 'audio/wav' }),
      fileName: 'dictation.wav',
      language: language === 'auto' ? null : language,
      fetch: deps.fetch ?? (net.fetch as unknown as typeof fetch),
    })
    const text = cleanTranscript(raw)
    return text ? { text } : { error: 'silent' }
  } catch (error) {
    if (error instanceof DictationFailure) {
      const code = error.code
      if (code === 'key-rejected' || code === 'quota' || code === 'too-long' || code === 'unavailable')
        return { error: code }
    } else {
      console.error('[dictation] API transcription failed:', (error as Error)?.message ?? error)
    }
    return { error: 'unavailable' }
  }
}
