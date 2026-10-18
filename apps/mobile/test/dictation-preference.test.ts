import { describe, expect, it } from 'vitest'
import { dictationChoiceKey, effectiveDictationChoice } from '../src/dictation/preference'

const server = (configured: boolean | null, features: readonly string[] = ['dictation'], demo = false) => ({
  features,
  configured,
  demo,
})

describe('dictation engine choice', () => {
  it("uses the server's engine by default once it has a key", () => {
    expect(effectiveDictationChoice(null, server(true))).toBe('server')
    expect(effectiveDictationChoice(null, server(false))).toBe('phone')
    expect(effectiveDictationChoice(null, server(null))).toBe('phone')
  })

  it('keeps the phone when the person chose it', () => {
    expect(effectiveDictationChoice('phone', server(true))).toBe('phone')
  })

  it('falls back to the phone where the server cannot transcribe', () => {
    expect(effectiveDictationChoice('server', server(true, ['phones']))).toBe('phone')
    expect(effectiveDictationChoice('server', server(false))).toBe('phone')
    expect(effectiveDictationChoice('server', server(true, ['dictation'], true))).toBe('phone')
  })

  it("keeps a stored choice of the server while the server's state loads", () => {
    expect(effectiveDictationChoice('server', server(null))).toBe('server')
  })

  it('keeps the choice per server', () => {
    expect(dictationChoiceKey('srv-1')).toBe('dictation.engine.srv-1')
  })
})
