import { describe, expect, it } from 'vitest'
import { cleanTranscript, floatToPcm16, speechSpan } from '../../src/main/asr-audio'

describe('speech audio helpers', () => {
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
