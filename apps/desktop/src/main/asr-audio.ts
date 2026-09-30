/** Pure audio helpers for the dictation worker: PCM conversion, speech span trimming, transcript cleanup. */

/** A speech segment from whisper.cpp VAD, in centiseconds. */
export interface SpeechSegment {
  t0: number
  t1: number
}

const SAMPLES_PER_MS = 16 // 16 kHz mono

/** Convert Float32 samples in [-1, 1] to signed 16-bit PCM, the format whisper.cpp's transcribeData expects. */
export function floatToPcm16(samples: Float32Array): ArrayBuffer {
  const pcm = new Int16Array(samples.length)
  for (let i = 0; i < samples.length; i++) {
    const x = Math.max(-1, Math.min(1, samples[i]))
    pcm[i] = Math.round(x < 0 ? x * 32768 : x * 32767)
  }
  return pcm.buffer
}

/** Sample range covering every speech segment plus padding, or null when there is no speech in the recording. */
export function speechSpan(
  segments: readonly SpeechSegment[],
  totalSamples: number,
  padMs = 300
): { start: number; end: number } | null {
  if (segments.length === 0) return null
  const firstMs = Math.min(...segments.map((segment) => segment.t0)) * 10
  const lastMs = Math.max(...segments.map((segment) => segment.t1)) * 10
  const start = Math.max(0, Math.round((firstMs - padMs) * SAMPLES_PER_MS))
  const end = Math.min(totalSamples, Math.round((lastMs + padMs) * SAMPLES_PER_MS))
  return end > start ? { start, end } : null
}

/**
 * Clean Whisper output by removing special tokens and non-speech/silence markers such as [S],
 * [BLANK_AUDIO], [Music], or [Silence]. Return empty text for empty results or degenerate repetitions
 * of one short token.
 */
export function cleanTranscript(raw: string): string {
  let t = (raw ?? '').replace(/<\|[^|]*\|>/g, ' ').replace(/\[[^\]\n]{0,40}\]/g, ' ')
  t = t.replace(/\s+/g, ' ').trim()
  const words = t.split(' ').filter(Boolean)
  if (words.length >= 6) {
    const uniq = new Set(words.map((w) => w.toLowerCase().replace(/[.,!?;:]+$/, '')))
    if (uniq.size <= 2 && [...uniq].every((w) => w.length <= 3)) return '' // ex.: "S S S" / "you you you"
  }
  return t
}
