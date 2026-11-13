import { describe, expect, it, vi } from 'vitest'
import { detectWakeText } from '../../src/main/wake-detect'

const speech = () => Float32Array.from({ length: 16000 }, (_, i) => Math.sin(i / 5) * 0.3)
function engine(segments: Array<{ t0: number; t1: number }>, text = ' Oi, Maestro.') {
  return {
    vad: { detectSpeechData: vi.fn(async () => segments), release: vi.fn() },
    whisper: { transcribeData: vi.fn(() => ({ promise: Promise.resolve({ result: text }) })), release: vi.fn() },
  }
}

describe('wake detection on one burst', () => {
  it('skips Whisper on digital silence', async () => {
    const e = engine([{ t0: 0, t1: 50 }])
    expect(await detectWakeText(e, new Float32Array(16000), 'pt')).toEqual({ text: '', silent: true })
    expect(e.whisper.transcribeData).not.toHaveBeenCalled()
  })

  it('skips Whisper when the VAD finds no speech', async () => {
    const e = engine([])
    expect(await detectWakeText(e, speech(), 'pt')).toEqual({ text: '', silent: true })
    expect(e.whisper.transcribeData).not.toHaveBeenCalled()
  })

  it('transcribes the speech in the given language with two threads', async () => {
    const e = engine([{ t0: 10, t1: 60 }])
    expect(await detectWakeText(e, speech(), 'pt')).toEqual({ text: 'Oi, Maestro.', silent: false })
    expect(e.whisper.transcribeData).toHaveBeenCalledWith(expect.any(ArrayBuffer), { language: 'pt', maxThreads: 2 })
  })
})
