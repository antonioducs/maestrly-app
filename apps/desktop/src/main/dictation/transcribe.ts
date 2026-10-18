import { transcribe } from '../asr-service'
import type { AsrLanguage, TranscribeError } from '../../shared/asr'
import { transcribeWithApi } from './api-engine'
import { getDictationEngine } from './settings'

/** One dictation, through the engine chosen in Settings: local Whisper, or OpenAI or Groq with this computer's key. */
export async function transcribeDictation(
  audio: Float32Array,
  language: AsrLanguage
): Promise<{ text: string } | { error: TranscribeError }> {
  const engine = getDictationEngine()
  if (engine !== 'local') return transcribeWithApi(audio, engine, language)
  const r = await transcribe(audio, { language })
  if (r.modelMissing) return { error: 'model-missing' }
  if (r.text == null) return { error: 'unavailable' }
  // Silent audio (missing microphone permission or no speech): the renderer tells the user.
  if (r.silent) return { error: 'silent' }
  return { text: r.text }
}
