/** One burst from the wake listener: no Whisper without speech, because it invents text from silence and noise. */
import { cleanTranscript, floatToPcm16, isSilentPcm, speechSpan } from './asr-audio'
import type { VadContextLike, WhisperContextLike } from './whisper-addon'

/** Wake detection runs all day next to everything else: two threads keep it light. */
const WAKE_THREADS = 2

export async function detectWakeText(
  engine: { whisper: WhisperContextLike; vad: VadContextLike },
  audio: Float32Array,
  language: 'pt' | 'en'
): Promise<{ text: string; silent: boolean }> {
  if (isSilentPcm(audio)) return { text: '', silent: true }
  const span = speechSpan(await engine.vad.detectSpeechData(floatToPcm16(audio)), audio.length)
  if (!span) return { text: '', silent: true }
  const out = await engine.whisper.transcribeData(floatToPcm16(audio.subarray(span.start, span.end)), {
    language,
    maxThreads: WAKE_THREADS,
  }).promise
  return { text: cleanTranscript(out?.result ?? ''), silent: false }
}
