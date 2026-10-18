import { describe, expect, it } from 'vitest'
import { checkDictationKey, transcribeWithProvider, type DictationProvider } from '../src/index.js'

/**
 * Opt-in checks against the real providers: `MAESTRLY_LIVE_DICTATION=1` with `OPENAI_API_KEY` and/or `GROQ_API_KEY`.
 * They confirm the request the client builds is the one each API takes; standard runs skip them.
 */
const live = process.env.MAESTRLY_LIVE_DICTATION === '1'
const keys: Array<[DictationProvider, string | undefined]> = [
  ['openai', process.env.OPENAI_API_KEY],
  ['groq', process.env.GROQ_API_KEY],
]

/** One second of 16 kHz mono 16-bit silence as WAV. */
function silentWav(): Blob {
  const samples = 16000
  const out = new ArrayBuffer(44 + samples * 2)
  const view = new DataView(out)
  const text = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i))
  }
  text(0, 'RIFF')
  view.setUint32(4, 36 + samples * 2, true)
  text(8, 'WAVE')
  text(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, 16000, true)
  view.setUint32(28, 32000, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  text(36, 'data')
  view.setUint32(40, samples * 2, true)
  return new Blob([out], { type: 'audio/wav' })
}

describe.skipIf(!live)('live speech-to-text providers', () => {
  for (const [provider, key] of keys) {
    it.skipIf(!key)(`${provider} takes its key and a WAV recording`, { timeout: 90_000 }, async () => {
      expect(await checkDictationKey({ provider, key: key! })).toBe('ok')
      expect(await checkDictationKey({ provider, key: 'not-a-real-key' })).toBe('key-rejected')
      const text = await transcribeWithProvider({
        provider,
        key: key!,
        file: silentWav(),
        fileName: 'dictation.wav',
        language: 'en',
      })
      expect(typeof text).toBe('string')
    })
  }
})
