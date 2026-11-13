/**
 * Cuts short speech bursts out of a continuous 16 kHz microphone stream, keeping a pre-roll before speech starts
 * and capping long utterances so the wake-word worker only sees short bursts.
 */
const NOISE_FACTOR = 2.5
const MIN_THRESHOLD = 0.01
const NOISE_ADAPT = 0.05
const CALIBRATION_MS = 300

export interface BurstGateOptions {
  sampleRate?: number
  frameMs?: number
  preRollMs?: number
  silenceMs?: number
  minSpeechMs?: number
  maxMs?: number
}

function frameRms(frame: Float32Array): number {
  if (frame.length === 0) return 0
  let sum = 0
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i]
  return Math.sqrt(sum / frame.length)
}

function concatFrames(frames: Float32Array[]): Float32Array {
  let total = 0
  for (const f of frames) total += f.length
  const out = new Float32Array(total)
  let offset = 0
  for (const f of frames) {
    out.set(f, offset)
    offset += f.length
  }
  return out
}

export function createBurstGate(opts: BurstGateOptions = {}): { push(frame: Float32Array): Float32Array | null } {
  const frameMs = opts.frameMs ?? 20
  const calibrationFrames = Math.max(1, Math.round(CALIBRATION_MS / frameMs))
  const preRollFrames = Math.max(0, Math.round((opts.preRollMs ?? 300) / frameMs))
  const silenceFrames = Math.max(1, Math.round((opts.silenceMs ?? 400) / frameMs))
  const minSpeechFrames = Math.max(1, Math.round((opts.minSpeechMs ?? 200) / frameMs))
  const maxFrames = Math.max(1, Math.round((opts.maxMs ?? 2500) / frameMs))

  let state: 'idle' | 'speaking' | 'draining' = 'idle'
  let noiseSum = 0
  let noiseCount = 0
  let noise: number | null = null
  let threshold = MIN_THRESHOLD

  const preRoll: Float32Array[] = []
  let burst: Float32Array[] = []
  let speechFrames = 0
  let quietFrames = 0

  function pushPreRoll(frame: Float32Array): void {
    if (preRollFrames === 0) return
    preRoll.push(frame)
    if (preRoll.length > preRollFrames) preRoll.shift()
  }

  function adaptNoise(rms: number): void {
    if (noise === null) return
    noise = noise * (1 - NOISE_ADAPT) + rms * NOISE_ADAPT
    threshold = Math.max(MIN_THRESHOLD, noise * NOISE_FACTOR)
  }

  return {
    push(frame: Float32Array): Float32Array | null {
      const rms = frameRms(frame)

      if (noise === null) {
        noiseSum += rms
        noiseCount++
        pushPreRoll(frame)
        if (noiseCount >= calibrationFrames) {
          noise = noiseSum / noiseCount
          threshold = Math.max(MIN_THRESHOLD, noise * NOISE_FACTOR)
        }
        return null
      }

      const loud = rms > threshold

      if (state === 'draining') {
        if (loud) {
          quietFrames = 0
          preRoll.length = 0
        } else {
          adaptNoise(rms)
          pushPreRoll(frame)
          quietFrames++
          if (quietFrames >= silenceFrames) state = 'idle'
        }
        return null
      }

      if (state === 'idle') {
        if (loud) {
          state = 'speaking'
          burst = [...preRoll, frame]
          preRoll.length = 0
          speechFrames = 1
          quietFrames = 0
          if (burst.length >= maxFrames) {
            const out = speechFrames >= minSpeechFrames ? concatFrames(burst) : null
            burst = []
            state = 'draining'
            return out
          }
          return null
        }
        adaptNoise(rms)
        pushPreRoll(frame)
        return null
      }

      // state === 'speaking'
      burst.push(frame)
      if (loud) {
        speechFrames++
        quietFrames = 0
      } else {
        quietFrames++
      }

      if (burst.length >= maxFrames) {
        const out = speechFrames >= minSpeechFrames ? concatFrames(burst) : null
        burst = []
        quietFrames = 0
        state = 'draining'
        return out
      }

      if (quietFrames >= silenceFrames) {
        const out = speechFrames >= minSpeechFrames ? concatFrames(burst) : null
        burst = []
        quietFrames = 0
        state = 'idle'
        return out
      }

      return null
    },
  }
}
