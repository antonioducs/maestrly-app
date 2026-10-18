import { describe, expect, it } from 'vitest'
import { cleanTranscript, floatToPcm16, isSilentPcm, pcm16Wav, speechSpan } from '../../src/main/asr-audio'

describe('speech audio helpers', () => {
  it('wraps PCM in a mono 16 kHz WAV header', () => {
    const wav = pcm16Wav(new Float32Array([0, 1, -1]))
    expect(wav.byteLength).toBe(50)
    const view = new DataView(wav)
    const text = (offset: number) => String.fromCharCode(...new Uint8Array(wav, offset, 4))
    expect(text(0)).toBe('RIFF')
    expect(view.getUint32(4, true)).toBe(42)
    expect(text(8)).toBe('WAVE')
    expect(view.getUint16(22, true)).toBe(1)
    expect(view.getUint32(24, true)).toBe(16000)
    expect(view.getUint16(34, true)).toBe(16)
    expect(text(36)).toBe('data')
    expect(view.getUint32(40, true)).toBe(6)
    expect([...new Int16Array(wav, 44)]).toEqual([0, 32767, -32768])
  })

  it('treats very short or zero recordings as silent', () => {
    expect(isSilentPcm(new Float32Array(1000).fill(0.5))).toBe(true)
    expect(isSilentPcm(new Float32Array(16000))).toBe(true)
    const tone = new Float32Array(16000).map((_, i) => 0.1 * Math.sin((2 * Math.PI * 440 * i) / 16000))
    expect(isSilentPcm(tone)).toBe(false)
  })

  it('converts float samples to clamped signed 16-bit PCM', () => {
    const pcm = new Int16Array(floatToPcm16(new Float32Array([0, 0.5, -1, 1.5, -2])))
    expect([...pcm]).toEqual([0, 16384, -32768, 32767, -32768])
    expect(floatToPcm16(new Float32Array(3)).byteLength).toBe(6)
  })

  it('spans all detected speech with padding and clamps to the recording', () => {
    expect(speechSpan([], 32000)).toBeNull()
    expect(
      speechSpan(
        [
          { t0: 100, t1: 150 },
          { t0: 200, t1: 250 },
        ],
        64000
      )
    ).toEqual({ start: 11200, end: 44800 }) // ±300 ms
    expect(speechSpan([{ t0: 5, t1: 390 }], 64000)).toEqual({ start: 0, end: 64000 })
    expect(speechSpan([{ t0: 100, t1: 150 }], 64000, 0)).toEqual({ start: 16000, end: 24000 })
    expect(speechSpan([{ t0: 500, t1: 600 }], 1000)).toBeNull()
  })

  it('strips Whisper special tokens, non-speech markers and degenerate repetitions', () => {
    expect(cleanTranscript('<|pt|> Olá [BLANK_AUDIO] mundo')).toBe('Olá mundo')
    expect(cleanTranscript('S S S S S S')).toBe('')
    expect(cleanTranscript('  Cria uma branch nova.  ')).toBe('Cria uma branch nova.')
  })
})
