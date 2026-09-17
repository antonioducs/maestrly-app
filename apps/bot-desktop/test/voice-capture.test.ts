import { expect, it } from 'vitest'
import {
  MAX_DURATION_MS,
  RecordingTooLarge,
  TARGET_SAMPLE_RATE,
  WAV_HEADER_BYTES,
  base64,
  encodeWav,
  fromBase64,
  resample,
  toCanonicalWav,
  toMono,
} from '../src/renderer/features/voice/pcm'

/** A minimal AudioBuffer stand-in: the conversion is pure and does not need a browser. */
function buffer(channels: Float32Array[], sampleRate: number): AudioBuffer {
  return {
    numberOfChannels: channels.length,
    length: channels[0].length,
    sampleRate,
    duration: channels[0].length / sampleRate,
    getChannelData: (index: number) => channels[index],
  } as unknown as AudioBuffer
}
const tone = (samples: number, value = 0.5) => Float32Array.from({ length: samples }, (_, index) => Math.sin(index / 10) * value)

it('mixes every channel into one, so a stereo microphone does not double the payload', () => {
  const left = Float32Array.from([1, 1, 1, 1])
  const right = Float32Array.from([-1, -1, 1, 1])
  expect([...toMono(buffer([left, right], 48_000))]).toEqual([0, 0, 1, 1])
  // A mono recording is passed through untouched.
  expect([...toMono(buffer([left], 16_000))]).toEqual([1, 1, 1, 1])
})

it('resamples 44.1 kHz and 48 kHz down to the one rate the Host accepts', () => {
  for (const rate of [44_100, 48_000]) {
    const seconds = 2
    const resampled = resample(tone(rate * seconds), rate)
    // Within one sample of the exact target length.
    expect(Math.abs(resampled.length - TARGET_SAMPLE_RATE * seconds)).toBeLessThanOrEqual(1)
  }
  // Already canonical: nothing is done at all.
  const already = tone(TARGET_SAMPLE_RATE)
  expect(resample(already, TARGET_SAMPLE_RATE)).toBe(already)
})

it('writes exactly the canonical layout the Host parses, with nothing appended', () => {
  const wav = encodeWav(tone(TARGET_SAMPLE_RATE))
  const view = new DataView(wav.buffer)
  const ascii = (offset: number, length: number) => String.fromCharCode(...wav.subarray(offset, offset + length))
  expect(ascii(0, 4)).toBe('RIFF')
  expect(ascii(8, 4)).toBe('WAVE')
  expect(ascii(12, 4)).toBe('fmt ')
  expect(view.getUint32(16, true)).toBe(16)
  expect(view.getUint16(20, true)).toBe(1)
  expect(view.getUint16(22, true)).toBe(1)
  expect(view.getUint32(24, true)).toBe(TARGET_SAMPLE_RATE)
  expect(view.getUint32(28, true)).toBe(TARGET_SAMPLE_RATE * 2)
  expect(view.getUint16(32, true)).toBe(2)
  expect(view.getUint16(34, true)).toBe(16)
  expect(ascii(36, 4)).toBe('data')
  expect(view.getUint32(40, true)).toBe(TARGET_SAMPLE_RATE * 2)
  expect(wav.length).toBe(WAV_HEADER_BYTES + TARGET_SAMPLE_RATE * 2)
  // The declared size and the real size agree, which is exactly what the Host re-checks.
  expect(view.getUint32(4, true)).toBe(wav.length - 8)
})

it('converts one local recording end to end, at both common capture rates', async () => {
  for (const rate of [44_100, 48_000]) {
    const seconds = 3
    const blob = { size: 1024, arrayBuffer: async () => new ArrayBuffer(8) } as unknown as Blob
    const decoded = buffer([tone(rate * seconds), tone(rate * seconds, 0.2)], rate)
    const { wav, durationMs } = await toCanonicalWav(blob, async () => decoded)
    expect(Math.abs(durationMs - seconds * 1000)).toBeLessThanOrEqual(2)
    expect(new DataView(wav.buffer).getUint32(24, true)).toBe(TARGET_SAMPLE_RATE)
  }
})

it('refuses a recording longer than the limit, before and after decoding', async () => {
  const huge = { size: 25 * 1024 * 1024, arrayBuffer: async () => new ArrayBuffer(8) } as unknown as Blob
  // Refused on size alone: the decoder never runs.
  let decoded = false
  await expect(
    toCanonicalWav(huge, async () => {
      decoded = true
      return buffer([tone(10)], 16_000)
    })
  ).rejects.toBeInstanceOf(RecordingTooLarge)
  expect(decoded).toBe(false)

  // A small compressed file can still expand into far too much audio.
  const small = { size: 2048, arrayBuffer: async () => new ArrayBuffer(8) } as unknown as Blob
  const long = buffer([new Float32Array(Math.round((MAX_DURATION_MS / 1000 + 30) * 16_000))], 16_000)
  await expect(toCanonicalWav(small, async () => long)).rejects.toBeInstanceOf(RecordingTooLarge)
})

it('round-trips the base64 hop without changing a byte', () => {
  const wav = encodeWav(tone(1_000))
  expect(fromBase64(base64(wav))).toEqual(wav)
})

it('asks for exactly the chosen microphone, and for the default one when nothing was chosen', async () => {
  const { microphoneConstraints, isDeviceLost } = await import('../src/renderer/features/voice/useVoiceDraft')
  expect(microphoneConstraints('mic-2')).toEqual({ audio: { deviceId: { exact: 'mic-2' } }, video: false })
  expect(microphoneConstraints(undefined)).toEqual({ audio: true, video: false })
  // An unplugged device is the one failure that falls back instead of stopping the note.
  expect(isDeviceLost({ name: 'OverconstrainedError' })).toBe(true)
  expect(isDeviceLost({ name: 'NotFoundError' })).toBe(true)
  expect(isDeviceLost({ name: 'NotAllowedError' })).toBe(false)
  expect(isDeviceLost(null)).toBe(false)
})
