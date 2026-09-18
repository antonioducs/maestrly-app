/**
 * Turns one local recording into the single format the Host accepts: 16 kHz, mono, 16-bit PCM
 * in a canonical WAV container.
 *
 * Doing the conversion here, before anything leaves this window, is what lets the Host refuse
 * everything else. It never has to sniff a container, guess a codec or run a decoder over bytes
 * somebody else produced — which is exactly the kind of surface that turns a voice note into a
 * security problem.
 */
export const TARGET_SAMPLE_RATE = 16_000
export const WAV_HEADER_BYTES = 44
/** Five minutes at the canonical rate, plus the header. Mirrors the Host's own ceiling. */
export const MAX_DURATION_MS = 5 * 60_000
export const MAX_COMPRESSED_BYTES = 20 * 1024 * 1024
export const MAX_WAV_BYTES = WAV_HEADER_BYTES + (MAX_DURATION_MS / 1000) * TARGET_SAMPLE_RATE * 2

export class RecordingTooLarge extends Error {
  constructor() {
    super('A gravação passou do limite de cinco minutos.')
  }
}

/** Mixes every channel down to one, so a stereo microphone does not double the payload. */
export function toMono(buffer: AudioBuffer): Float32Array {
  if (buffer.numberOfChannels === 1) return buffer.getChannelData(0).slice()
  const mixed = new Float32Array(buffer.length)
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const data = buffer.getChannelData(channel)
    for (let index = 0; index < data.length; index++) mixed[index] += data[index] / buffer.numberOfChannels
  }
  return mixed
}

/**
 * Linear resampling to the canonical rate. It is deliberately simple: speech recognition is
 * robust to it, and a heavier filter here would only add a dependency to the renderer.
 */
export function resample(samples: Float32Array, from: number, to = TARGET_SAMPLE_RATE): Float32Array {
  if (from === to) return samples
  const ratio = from / to
  const length = Math.max(1, Math.floor(samples.length / ratio))
  const output = new Float32Array(length)
  for (let index = 0; index < length; index++) {
    const position = index * ratio
    const lower = Math.floor(position)
    const upper = Math.min(lower + 1, samples.length - 1)
    const weight = position - lower
    output[index] = samples[lower] * (1 - weight) + samples[upper] * weight
  }
  return output
}

/** Canonical WAV bytes: exactly the layout the Host parses, with nothing appended. */
export function encodeWav(samples: Float32Array, sampleRate = TARGET_SAMPLE_RATE): Uint8Array {
  const bytes = new Uint8Array(WAV_HEADER_BYTES + samples.length * 2)
  const view = new DataView(bytes.buffer)
  const ascii = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index++) view.setUint8(offset + index, text.charCodeAt(index))
  }
  ascii(0, 'RIFF')
  view.setUint32(4, WAV_HEADER_BYTES - 8 + samples.length * 2, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  ascii(36, 'data')
  view.setUint32(40, samples.length * 2, true)
  for (let index = 0; index < samples.length; index++) {
    const clamped = Math.max(-1, Math.min(1, samples[index]))
    view.setInt16(WAV_HEADER_BYTES + index * 2, Math.round(clamped * 32767), true)
  }
  return bytes
}

export interface DecodedRecording {
  wav: Uint8Array
  durationMs: number
}
/**
 * Decodes the recording this window just made, and nothing else. The size is checked before the
 * decoder runs and the duration after it, because a compressed file can be small and still
 * expand into hours of audio.
 */
export async function toCanonicalWav(blob: Blob, decode: (data: ArrayBuffer) => Promise<AudioBuffer>): Promise<DecodedRecording> {
  if (blob.size > MAX_COMPRESSED_BYTES) throw new RecordingTooLarge()
  const buffer = await decode(await blob.arrayBuffer())
  const durationMs = Math.round((buffer.length / buffer.sampleRate) * 1000)
  if (durationMs > MAX_DURATION_MS) throw new RecordingTooLarge()
  const samples = resample(toMono(buffer), buffer.sampleRate)
  const wav = encodeWav(samples)
  if (wav.length > MAX_WAV_BYTES) throw new RecordingTooLarge()
  return { wav, durationMs: Math.round((samples.length / TARGET_SAMPLE_RATE) * 1000) }
}

/** Browser decoder, kept behind a seam so the conversion itself is testable without a DOM. */
export const browserDecoder = (data: ArrayBuffer): Promise<AudioBuffer> => {
  const Context = (globalThis as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext
  if (!Context) return Promise.reject(new Error('Este computador não consegue processar áudio.'))
  const context = new Context()
  return context.decodeAudioData(data).finally(() => void context.close())
}

export const base64 = (bytes: Uint8Array): string => {
  let binary = ''
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  return btoa(binary)
}
export const fromBase64 = (value: string): Uint8Array => Uint8Array.from(atob(value), (character) => character.charCodeAt(0))
