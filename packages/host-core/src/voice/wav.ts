import { VOICE_AUDIO, VOICE_LIMITS } from '@maestrly/host-protocol'
import { HostError } from '../errors.js'

/**
 * The single audio format this Host accepts, and the only place that decides what a byte
 * stream is. The application converts its own recording to canonical WAV before uploading,
 * so the Host never has to probe, sniff or transcode anything a browser produced.
 *
 * Every field is checked against the bytes that are actually present. A declared duration, a
 * declared size or a declared MIME type prove nothing: a header that disagrees with the file
 * is exactly how a "five second note" turns into an hour of inference.
 */
export const WAV_HEADER_BYTES = 44
const BYTES_PER_SAMPLE = VOICE_AUDIO.bitsPerSample / 8
const BYTE_RATE = VOICE_AUDIO.sampleRate * VOICE_AUDIO.channels * BYTES_PER_SAMPLE

export interface CanonicalWav {
  dataBytes: number
  durationMs: number
}

const fail = (message: string): never => {
  throw new HostError('VOICE_FORMAT_INVALID', message)
}

/**
 * Validates a complete canonical WAV. It accepts exactly one layout — RIFF/WAVE, a 16 byte
 * PCM `fmt ` chunk and a `data` chunk that ends the file — because anything else is either a
 * different format or a file with room for something nobody asked for.
 */
export function parseCanonicalWav(buffer: Buffer): CanonicalWav {
  if (buffer.length < WAV_HEADER_BYTES) fail('A gravação está incompleta.')
  if (buffer.length > VOICE_LIMITS.maxWavBytes) fail('A gravação é maior que o limite permitido.')
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') fail('Este arquivo não é um áudio no formato esperado.')
  const riffSize = buffer.readUInt32LE(4)
  if (riffSize !== buffer.length - 8) fail('O cabeçalho do áudio não corresponde ao arquivo enviado.')
  if (buffer.toString('ascii', 12, 16) !== 'fmt ') fail('O cabeçalho do áudio não está no formato esperado.')
  if (buffer.readUInt32LE(16) !== 16) fail('O cabeçalho do áudio não está no formato esperado.')
  if (buffer.readUInt16LE(20) !== 1) fail('Só áudio PCM sem compressão é aceito.')
  if (buffer.readUInt16LE(22) !== VOICE_AUDIO.channels) fail('O áudio precisa ser mono.')
  if (buffer.readUInt32LE(24) !== VOICE_AUDIO.sampleRate) fail(`O áudio precisa estar a ${VOICE_AUDIO.sampleRate} Hz.`)
  if (buffer.readUInt32LE(28) !== BYTE_RATE) fail('A taxa declarada do áudio não corresponde ao formato.')
  if (buffer.readUInt16LE(32) !== VOICE_AUDIO.channels * BYTES_PER_SAMPLE) fail('O alinhamento declarado do áudio não corresponde ao formato.')
  if (buffer.readUInt16LE(34) !== VOICE_AUDIO.bitsPerSample) fail(`O áudio precisa ter ${VOICE_AUDIO.bitsPerSample} bits por amostra.`)
  if (buffer.toString('ascii', 36, 40) !== 'data') fail('O áudio traz dados adicionais que não são aceitos.')
  const dataBytes = buffer.readUInt32LE(40)
  // Exact, not "at least": trailing bytes after the audio are refused outright.
  if (dataBytes !== buffer.length - WAV_HEADER_BYTES) fail('O tamanho declarado do áudio não corresponde ao conteúdo.')
  if (dataBytes % (VOICE_AUDIO.channels * BYTES_PER_SAMPLE) !== 0) fail('O áudio termina no meio de uma amostra.')
  const durationMs = Math.round((dataBytes / BYTE_RATE) * 1000)
  if (dataBytes === 0) fail('A gravação está vazia.')
  if (durationMs > VOICE_LIMITS.maxDurationMs) fail('A gravação passa do tempo máximo permitido.')
  return { dataBytes, durationMs }
}

/** Duration implied by a declared size, used to refuse an upload before a byte is written. */
export function durationForSize(sizeBytes: number): number {
  return Math.round(((sizeBytes - WAV_HEADER_BYTES) / BYTE_RATE) * 1000)
}

/** Builds a canonical WAV from 16-bit mono samples. Used by the worker contract and by tests. */
export function encodeCanonicalWav(samples: Buffer): Buffer {
  const header = Buffer.alloc(WAV_HEADER_BYTES)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(WAV_HEADER_BYTES - 8 + samples.length, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(VOICE_AUDIO.channels, 22)
  header.writeUInt32LE(VOICE_AUDIO.sampleRate, 24)
  header.writeUInt32LE(BYTE_RATE, 28)
  header.writeUInt16LE(VOICE_AUDIO.channels * BYTES_PER_SAMPLE, 32)
  header.writeUInt16LE(VOICE_AUDIO.bitsPerSample, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(samples.length, 40)
  return Buffer.concat([header, samples])
}

/** Float samples in [-1, 1] for the inference runtime; the worker never parses WAV itself. */
export function decodePcm(buffer: Buffer): Float32Array {
  parseCanonicalWav(buffer)
  const count = (buffer.length - WAV_HEADER_BYTES) / BYTES_PER_SAMPLE
  const samples = new Float32Array(count)
  for (let index = 0; index < count; index++) samples[index] = buffer.readInt16LE(WAV_HEADER_BYTES + index * BYTES_PER_SAMPLE) / 32768
  return samples
}

/**
 * True when the recording carries no speech worth transcribing. Checked before a model is
 * ever loaded, and reported as "no speech" rather than as invented text: a silent note must
 * never come back as a plausible sentence.
 */
export function isSilent(samples: Float32Array, threshold = 0.005): boolean {
  if (!samples.length) return true
  let sum = 0
  let peak = 0
  for (const sample of samples) {
    sum += sample * sample
    peak = Math.max(peak, Math.abs(sample))
  }
  return Math.sqrt(sum / samples.length) < threshold && peak < threshold * 8
}
