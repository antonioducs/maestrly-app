/**
 * When the person stopped talking, from the microphone's loudness: the threshold starts at the noise heard in the
 * first 300 ms and follows it while nobody speaks, a sound counts as speech once it stays above for 150 ms, and the
 * recording ends after a silence that follows speech, or when nobody spoke, or at its length limit.
 */
export type EndOfSpeech = 'continue' | 'end' | 'no-speech' | 'max'

const CALIBRATION_MS = 300
const NOISE_FACTOR = 2.5
const MIN_THRESHOLD = 0.01
const SPEECH_HOLD_MS = 150
/** How fast the threshold follows the noise between words. */
const NOISE_ADAPT = 0.05

export function createEndOfSpeechDetector(
  opts: { silenceMs?: number; noSpeechMs?: number; maxMs?: number; threshold?: number } = {}
): { feed(rms: number, atMs: number): EndOfSpeech; readonly threshold: number; readonly spoke: boolean } {
  const silenceMs = opts.silenceMs ?? 900
  const noSpeechMs = opts.noSpeechMs ?? 6000
  const maxMs = opts.maxMs ?? 60_000
  let startedAt: number | null = null
  let noiseSum = 0
  let noiseCount = 0
  let noise: number | null = null
  let threshold = opts.threshold ?? MIN_THRESHOLD
  let aboveSince: number | null = null
  let spoke = false
  let lastSpeechAt = 0

  return {
    get threshold() {
      return threshold
    },
    get spoke() {
      return spoke
    },
    feed(rms, atMs) {
      startedAt ??= atMs
      const elapsed = atMs - startedAt
      if (elapsed >= maxMs) return 'max'
      if (opts.threshold === undefined) {
        if (elapsed < CALIBRATION_MS) {
          noiseSum += rms
          noiseCount++
          return 'continue'
        }
        if (noise === null) {
          noise = noiseCount ? noiseSum / noiseCount : 0
          threshold = Math.max(MIN_THRESHOLD, noise * NOISE_FACTOR)
        }
      }
      if (rms > threshold) {
        aboveSince ??= atMs
        if (atMs - aboveSince >= SPEECH_HOLD_MS) {
          spoke = true
          lastSpeechAt = atMs
        }
      } else {
        aboveSince = null
        if (noise !== null && opts.threshold === undefined) {
          noise = noise * (1 - NOISE_ADAPT) + rms * NOISE_ADAPT
          threshold = Math.max(MIN_THRESHOLD, noise * NOISE_FACTOR)
        }
        if (spoke && atMs - lastSpeechAt >= silenceMs) return 'end'
      }
      if (!spoke && elapsed >= noSpeechMs) return 'no-speech'
      return 'continue'
    },
  }
}
